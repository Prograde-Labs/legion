import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  // Core engine
  Collective,
  ConversationThread,
  EventBus,
  FileConversationStore,
  FileCredentialStore,
  FileStorage,
  RuntimeRegistry,
  MessageRouter,
  ToolRegistry,
  AuthEngine,
  PendingApprovalRegistry,
  ConnectorRegistry,
  UserDeliveryRuntime,
  AgentRuntime,
  MockRuntime,
  ServiceManager,
  ProviderRegistry,
  OpenAICompatibleProvider,
  // Global tools
  communicateTool,
  approvalResponseTool,
  managementTools,
  // MCP
  loadMCPSources,
  type ToolSource,
  // Types
  type WorkspaceConfig,
  type ToolContext,
  type ConnectorContext,
  BOOTSTRAP_OPERATOR_ID,
} from '@legion/core';
import type { ToolResult } from '@legion/types';
import { WebConnector } from './server/WebConnector.js';
import { createRuntimeTools } from './server/runtime-tools.js';

/** The assembled Legion runtime. Returned by `LegionProcess.start()`. */
export class LegionProcess {
  private constructor(
    readonly router: MessageRouter,
    readonly collective: Collective,
    readonly store: FileConversationStore,
    readonly credentials: FileCredentialStore,
    readonly services: ServiceManager,
    readonly connectors: ConnectorRegistry,
    readonly eventBus: EventBus,
    private readonly mcpSources: ToolSource[],
  ) {}

  /**
   * Start the Legion process from `workspaceRoot`.
   * Follows the 11-step startup sequence from spec §8.
   */
  static async start(workspaceRoot: string): Promise<LegionProcess> {
    // ── Step 1: Read workspace config ────────────────────────────────────────
    const workspaceConfig = await loadWorkspaceConfig(workspaceRoot);
    const legionRoot = join(workspaceRoot, '.legion');

    // ── Step 2: Load collective; seed bootstrap operator if empty ────────────
    const storage = new FileStorage(legionRoot);
    const collective = await Collective.load(storage);
    const credentials = new FileCredentialStore(storage);
    const seeded = await collective.seedDefaultsIfEmpty();
    if (seeded.length > 0) {
      const password = process.env.LEGION_BOOTSTRAP_PASSWORD ?? randomUUID();
      await credentials.setCredential(BOOTSTRAP_OPERATOR_ID, password);
      console.log(
        '\n  ┌─ Legion bootstrap ──────────────────────────────────────────────┐' +
          '\n  │  Username: ' +
          BOOTSTRAP_OPERATOR_ID +
          '                                          │' +
          '\n  │  Password: ' +
          password +
          '                                         │' +
          '\n  │  Store this password — it will not be shown again.              │' +
          '\n  └─────────────────────────────────────────────────────────────────┘\n',
      );
    }

    // ── Step 3: Initialise ConversationStore and CredentialStore ─────────────
    const store = new FileConversationStore(storage);

    // ── Step 4: Register runtime factories ───────────────────────────────────
    const connectorRegistry = new ConnectorRegistry();
    const runtimeRegistry = new RuntimeRegistry();
    runtimeRegistry.registerFactory('user', (id) => new UserDeliveryRuntime(id, connectorRegistry));
    runtimeRegistry.registerFactory('mock', (id) => new MockRuntime(id));
    // agent and service factories registered after their dependencies are created (steps 5–8)

    // ── Step 5: Create core engine components ────────────────────────────────
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const authEngine = new AuthEngine();
    const pendingApprovalRegistry = await PendingApprovalRegistry.load(storage);

    const router = new MessageRouter(store, runtimeRegistry, collective, eventBus);

    // ── Step 6: Register global tools ────────────────────────────────────────
    toolRegistry.register(communicateTool);
    toolRegistry.register(approvalResponseTool);
    for (const tool of managementTools) {
      toolRegistry.register(tool);
    }
    const runtimeTools = createRuntimeTools({ storage, credStore: credentials });
    for (const tool of runtimeTools) {
      toolRegistry.register(tool);
    }

    // ── Step 7: Load MCP tool sources ────────────────────────────────────────
    const mcpSources = await loadMCPSources(workspaceConfig.mcpServers ?? [], toolRegistry);

    // ── Step 8: Create ServiceManager + register service runtime factory ─────
    const serviceManager = new ServiceManager({
      collective,
      store,
      toolRegistry,
      authEngine,
      pendingApprovalRegistry,
      messageRouter: router,
      eventBus,
      storage,
      workspaceConfig,
      workspaceRoot,
    });

    // Load all service participants
    for (const participant of collective.listActive()) {
      if (participant.type === 'service') {
        await serviceManager.loadService(participant);
      }
    }

    // Register service runtime factory using the cached ServiceRuntime instances
    runtimeRegistry.registerFactory('service', (id) => serviceManager.getRuntime(id));

    // Build provider registry from workspace config
    const providerRegistry = new ProviderRegistry();
    if (workspaceConfig.providers) {
      for (const [name, config] of Object.entries(workspaceConfig.providers)) {
        const provider = new OpenAICompatibleProvider(config.baseUrl, config.apiKeyEnv ?? config.credentialKey);
        providerRegistry.register(name, provider);
      }
    }

    // Register agent factory
    runtimeRegistry.registerFactory('agent', (id) => {
      return new AgentRuntime(id, providerRegistry);
    });

    // ── Step 9: Initialise web connector ─────────────────────────────────────
    const port = process.env.PORT
      ? parseInt(process.env.PORT, 10)
      : (workspaceConfig.server?.port ?? 3000);
    if (isNaN(port)) {
      throw new Error(`Invalid PORT env var: "${process.env.PORT}" — must be a number`);
    }
    const webConnectorConfig = { ...(workspaceConfig.server ?? {}), port };
    // Derive web dist path from this file's compiled location, not from workspaceRoot.
    // Compiled location: packages/runtime/dist/LegionProcess.js
    // Web dist:          packages/web/dist/
    const _dirname = fileURLToPath(new URL('.', import.meta.url));
    const webDistPath = join(_dirname, '..', '..', 'web', 'dist');
    const webConnector = new WebConnector({
      collective,
      credentials,
      eventBus,
      serverConfig: webConnectorConfig,
      webDistPath,
    });

    connectorRegistry.register(webConnector);

    const connectorContext: ConnectorContext = buildConnectorContext({
      router,
      toolRegistry,
      authEngine,
      connectorRegistry,
      collective,
      store,
      pendingApprovalRegistry,
      eventBus,
      storage,
      config: workspaceConfig,
      workspaceRoot,
      serviceManager,
    });

    await webConnector.start(connectorContext);

    // ── Step 10: Auto-start services ─────────────────────────────────────────
    await serviceManager.autoStart();

    // ── Step 11: Emit process:ready ───────────────────────────────────────────
    eventBus.emit('process:ready', { workspaceRoot });

    return new LegionProcess(
      router,
      collective,
      store,
      credentials,
      serviceManager,
      connectorRegistry,
      eventBus,
      mcpSources,
    );
  }

  /** Graceful shutdown: stop all services, connectors, and MCP sources. */
  async stop(): Promise<void> {
    // Stop all running services
    for (const { participantId } of this.services.getAll()) {
      try {
        await this.services.stopService(participantId);
      } catch {
        // Best-effort; log but don't prevent other shutdowns.
      }
    }
    // Stop all connectors
    for (const connector of this.connectors.getAll()) {
      try {
        await connector.stop();
      } catch {
        // Best-effort.
      }
    }
    // Unload MCP sources
    for (const source of this.mcpSources) {
      try {
        await source.unload?.();
      } catch {
        // Best-effort.
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read and parse `.legion/config.json`. Returns a default config if the file is absent. */
async function loadWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig> {
  const configPath = join(workspaceRoot, '.legion', 'config.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as WorkspaceConfig;
  } catch {
    return { version: '2' };
  }
}

interface ConnectorContextDeps {
  router: MessageRouter;
  toolRegistry: ToolRegistry;
  authEngine: AuthEngine;
  connectorRegistry: ConnectorRegistry;
  collective: Collective;
  store: FileConversationStore;
  pendingApprovalRegistry: PendingApprovalRegistry;
  eventBus: EventBus;
  storage: FileStorage;
  config: WorkspaceConfig;
  workspaceRoot: string;
  serviceManager: ServiceManager;
}

/** Build the `ConnectorContext` passed to every connector's `start()`. */
function buildConnectorContext(deps: ConnectorContextDeps): ConnectorContext {
  const {
    router,
    toolRegistry,
    authEngine,
    connectorRegistry,
    collective,
    store,
    pendingApprovalRegistry,
    eventBus,
    storage,
    config,
    workspaceRoot,
    serviceManager,
  } = deps;

  return {
    async submit(msg) {
      const baseCtx: ToolContext = {
        participant: collective.getOrThrow(msg.senderId),
        conversationId: msg.conversationId ?? '',
        conversation: undefined as any, // router creates/loads the thread
        collective,
        communicationDepth: 0,
        toolRegistry,
        config,
        eventBus,
        storage,
        workspaceRoot,
        authEngine,
        pendingApprovalRegistry,
        messageRouter: router,
        serviceManager,
      };
      return router.send({
        senderId: msg.senderId,
        recipientId: msg.recipientId,
        message: msg.content,
        conversationId: msg.conversationId,
        replyTo: msg.replyTo,
        context: baseCtx,
      });
    },

    async callTool(participantId, toolName, args, opts) {
      const participant = collective.get(participantId);
      if (!participant) {
        return {
          result: { status: 'error', error: `Participant not found: ${participantId}` },
          conversationId: '',
        };
      }

      const authResult = authEngine.authorize(participantId, toolName, args, participant.tools);
      if (!authResult.authorized) {
        return {
          result: { status: 'error', error: authResult.reason ?? 'Not authorized' },
          conversationId: '',
        };
      }

      const tool = toolRegistry.get(toolName);
      if (!tool) {
        return {
          result: { status: 'error', error: `Tool not found: ${toolName}` },
          conversationId: '',
        };
      }

      // Create or load conversation for this tool call
      let thread: ConversationThread;
      let conversationId: string;
      if (opts?.conversationId) {
        const existing = await store.load(opts.conversationId);
        if (!existing) {
          return {
            result: { status: 'error', error: `Conversation not found: ${opts.conversationId}` },
            conversationId: opts.conversationId,
          };
        }
        conversationId = opts.conversationId;
        thread = new ConversationThread(existing, store);
      } else {
        const data = await store.create({
          schemaVersion: '2.0',
          activeBranchHead: '',
          messages: {},
        });
        conversationId = data.id;
        thread = new ConversationThread(data, store);
      }

      const toolCtx: ToolContext = {
        participant,
        conversationId,
        conversation: thread,
        collective,
        communicationDepth: 0,
        toolRegistry,
        config,
        eventBus,
        storage,
        workspaceRoot,
        authEngine,
        pendingApprovalRegistry,
        messageRouter: router,
        serviceManager,
      };

      const result = await tool.execute(args, toolCtx) as ToolResult;
      return { result, conversationId };
    },

    registry: connectorRegistry,
  };
}
