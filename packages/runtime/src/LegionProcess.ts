import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
  ProcessManager,
  ConnectorRegistry,
  UserDeliveryRuntime,
  AgentRuntime,
  MockRuntime,
  ServiceManager,
  SystemProviderStore,
  ModelRouter,
  ModelsDevPricingSource,
  UsageCalculator,
  MiddlewareRegistry,
  MiddlewareRunner,
  MiddlewareLifecycle,
  loadWorkspaceMiddleware,
  // Global tools
  communicateTool,
  approvalResponseTool,
  managementTools,
  fileTools,
  processTools,
  // Streaming / subscription tools
  cancelStreamTool,
  watchConversationsTool,
  watchParticipantsTool,
  watchActivityTool,
  watchConversationTool,
  watchProcessTool,
  createListMiddlewareTool,
  // MCP
  loadMCPSources,
  type ToolSource,
  // Types
  type WorkspaceConfig,
  type ToolContext,
  type ConnectorContext,
  type MiddlewareLogger,
  BOOTSTRAP_OPERATOR_ID,
} from '@legion/core';
import type {
  ConversationData,
  LocalConfig,
  RoutingConfig,
  SystemConfig,
  ToolResult,
  MiddlewareDiagnostic,
} from '@legion/types';
import { WebConnector } from './server/WebConnector.js';
import { createRuntimeTools } from './server/runtime-tools.js';

export interface StartOptions {
  dev?: boolean;
}

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
    readonly middlewareRegistry: MiddlewareRegistry,
    readonly middlewareDiagnostics: readonly MiddlewareDiagnostic[],
    private readonly mcpSources: ToolSource[],
    private readonly processManager: ProcessManager,
  ) {}

  /**
   * Start the Legion process from `workspaceRoot`.
   * Follows the 11-step startup sequence from spec §8.
   */
  static async start(workspaceRoot: string, options: StartOptions = {}): Promise<LegionProcess> {
    // ── Step 1: Read system, workspace, and workspace-local config ───────────
    const systemConfigDir = join(homedir(), '.config', 'legion');
    const systemConfig = await loadSystemConfig();
    const workspaceConfig = await loadWorkspaceConfig(workspaceRoot);
    const localConfig = await loadLocalConfig(workspaceRoot);
    const { routing: localRouting, ...localWorkspaceConfig } = localConfig;
    const mergedConfig = deepMerge(workspaceConfig, localWorkspaceConfig) as WorkspaceConfig;
    const legionRoot = join(workspaceRoot, '.legion');
    await ensureGitignored(legionRoot, 'config.local.json');

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
    await ensureBootstrapRuntimeToolPolicies(collective);

    // ── Step 3: Initialise event bus, ConversationStore, and CredentialStore ─
    const eventBus = new EventBus();
    const store = new FileConversationStore(storage, eventBus);

    // ── Step 4: Register runtime factories ───────────────────────────────────
    const connectorRegistry = new ConnectorRegistry();
    const runtimeRegistry = new RuntimeRegistry();
    runtimeRegistry.registerFactory('user', (id) => new UserDeliveryRuntime(id, connectorRegistry));
    runtimeRegistry.registerFactory('mock', (id) => new MockRuntime(id));
    // agent and service factories registered after their dependencies are created (steps 5–8)

    // ── Step 5: Create core engine components ────────────────────────────────
    collective.eventBus = eventBus;
    const toolRegistry = new ToolRegistry();
    const authEngine = new AuthEngine();
    const pendingApprovalRegistry = await PendingApprovalRegistry.load(storage);
    await pendingApprovalRegistry.reconcileAutomationHelpers(store);

    const middlewareRegistry = new MiddlewareRegistry();
    const middlewareDiagnostics = await loadWorkspaceMiddleware(
      workspaceRoot,
      mergedConfig.middlewareModules ?? [],
      middlewareRegistry,
    );
    validateMiddlewareConfiguration(collective, middlewareRegistry, middlewareDiagnostics);

    let router!: MessageRouter;
    const middlewareRunner = new MiddlewareRunner({
      registry: middlewareRegistry,
      authEngine,
      toolRegistry,
      pendingApprovals: pendingApprovalRegistry,
      eventBus,
      logger: middlewareLogger,
      conversationStore: store,
      collective,
      buildToolContext: (participant, conversation, signal) =>
        buildMiddlewareToolContext({
          participant,
          conversation,
          collective,
          toolRegistry,
          config: mergedConfig,
          eventBus,
          storage,
          workspaceRoot,
          authEngine,
          pendingApprovalRegistry,
          messageRouter: router,
          conversationStore: store,
          middlewareValidator: middlewareRegistry,
          signal,
        }),
    });
    const middlewareLifecycle = new MiddlewareLifecycle(middlewareRunner, eventBus);
    router = new MessageRouter(
      store,
      runtimeRegistry,
      collective,
      eventBus,
      middlewareLifecycle,
      middlewareRunner,
    );

    // ── Step 5b: Create system provider store + model router ─────────────────
    const systemStorage = new FileStorage(systemConfigDir);
    const systemStore = new SystemProviderStore(systemStorage);
    const systemRouting = deepMerge({}, systemConfig.routing ?? {}) as RoutingConfig;
    const workspaceRouting = deepMerge({}, localConfig.routing ?? {}) as RoutingConfig;
    const modelRouter = new ModelRouter(systemStore, systemRouting, workspaceRouting);
    const saveSystemRouting = async (routing: RoutingConfig): Promise<void> => {
      const current = await loadSystemConfig();
      await writeJsonFile(join(systemConfigDir, 'config.json'), deepMerge(current, { routing }));
    };
    const saveWorkspaceRouting = async (routing: RoutingConfig): Promise<void> => {
      const current = await loadLocalConfig(workspaceRoot);
      await writeJsonFile(join(legionRoot, 'config.local.json'), deepMerge(current, { routing }));
    };

    // ── Step 5c: Create ProcessManager and reconcile stale processes ──────────
    const processManager = new ProcessManager({ storage, workspaceRoot });
    await processManager.reconcileOnStartup();

    // ── Step 6: Register global tools ────────────────────────────────────────
    toolRegistry.register(communicateTool);
    toolRegistry.register(approvalResponseTool);
    for (const tool of managementTools) {
      toolRegistry.register(tool);
    }
    for (const tool of fileTools) {
      toolRegistry.register(tool);
    }
    for (const tool of processTools) {
      toolRegistry.register(tool);
    }
    // Streaming / subscription tools
    toolRegistry.register(cancelStreamTool);
    toolRegistry.register(watchConversationsTool);
    toolRegistry.register(watchParticipantsTool);
    toolRegistry.register(watchActivityTool);
    toolRegistry.register(watchConversationTool);
    toolRegistry.register(watchProcessTool);
    toolRegistry.register(
      createListMiddlewareTool({
        definitions: middlewareRegistry.list(),
        diagnostics: middlewareDiagnostics,
      }),
    );
    const runtimeTools = createRuntimeTools({
      systemStore,
      systemRouting,
      workspaceRouting,
      saveSystemRouting,
      saveWorkspaceRouting,
    });
    for (const tool of runtimeTools) {
      toolRegistry.register(tool);
    }

    // ── Step 7: Load MCP tool sources ────────────────────────────────────────
    const mcpSources = await loadMCPSources(mergedConfig.mcpServers ?? [], toolRegistry);

    // ── Step 8: Create ServiceManager + register service runtime factory ─────
    const serviceManager = new ServiceManager({
      collective,
      store,
      toolRegistry,
      authEngine,
      pendingApprovalRegistry,
      middlewareConfigurationValidator: middlewareRegistry,
      messageRouter: router,
      eventBus,
      storage,
      workspaceConfig: mergedConfig,
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

    // Register agent factory
    const pricingSource = new ModelsDevPricingSource(join(systemConfigDir, 'cache', 'models-dev'));
    const usageCalculator = new UsageCalculator(pricingSource, (providerId: string) =>
      systemStore.get(providerId).then((p) => p ?? undefined),
    );
    runtimeRegistry.registerFactory('agent', (id) => {
      return new AgentRuntime(id, modelRouter, usageCalculator);
    });

    // ── Step 9: Initialise web connector ─────────────────────────────────────
    const port = process.env.PORT
      ? parseInt(process.env.PORT, 10)
      : (mergedConfig.server?.port ?? 3000);
    if (isNaN(port)) {
      throw new Error(`Invalid PORT env var: "${process.env.PORT}" — must be a number`);
    }
    const webConnectorConfig = { ...(mergedConfig.server ?? {}), port };
    const _dirname = fileURLToPath(new URL('.', import.meta.url));

    const dev = options.dev ?? false;
    // In dev mode, point Vite at the web package source root (contains index.html + src/).
    // In production, serve the pre-built static files from web/dist/.
    const webSrcPath = dev
      ? join(_dirname, '..', '..', 'web') // packages/runtime/src/ → packages/web/
      : undefined;
    const webDistPath = dev ? undefined : join(_dirname, '..', '..', 'web', 'dist'); // packages/runtime/dist/ → packages/web/dist/

    const webConnector = new WebConnector({
      collective,
      credentials,
      eventBus,
      processManager,
      serverConfig: webConnectorConfig,
      webDistPath,
      webSrcPath,
      dev,
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
      config: mergedConfig,
      workspaceRoot,
      serviceManager,
      processManager,
      middlewareRegistry,
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
      middlewareRegistry,
      middlewareDiagnostics,
      mcpSources,
      processManager,
    );
  }

  /** Graceful shutdown: stop all services, connectors, and MCP sources. */
  async stop(): Promise<void> {
    // Kill all running processes
    await this.processManager.shutdown().catch(() => undefined);
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

const RUNTIME_TOOL_NAMES = [
  'list_providers',
  'save_provider',
  'delete_provider',
  'list_models',
  'get_routing',
  'save_routing',
  'list_middleware',
] as const;

const SUBSCRIPTION_TOOL_NAMES = [
  'cancel_stream',
  'watch_conversations',
  'watch_participants',
  'watch_activity',
  'watch_conversation',
  'watch_process',
] as const;

const OLD_RUNTIME_TOOL_NAMES = [
  'configure_provider',
  'list_credentials',
  'set_credential_with_meta',
] as const;

async function ensureBootstrapRuntimeToolPolicies(collective: Collective): Promise<void> {
  const operator = collective.get(BOOTSTRAP_OPERATOR_ID);
  if (!operator) return;

  const tools = { ...operator.tools };
  let changed = false;
  for (const name of RUNTIME_TOOL_NAMES) {
    if (!(name in tools)) {
      tools[name] = 'auto';
      changed = true;
    }
  }
  for (const name of SUBSCRIPTION_TOOL_NAMES) {
    if (!(name in tools)) {
      tools[name] = 'auto';
      changed = true;
    }
  }
  for (const name of OLD_RUNTIME_TOOL_NAMES) {
    if (name in tools) {
      delete tools[name];
      changed = true;
    }
  }

  if (changed) await collective.update(BOOTSTRAP_OPERATOR_ID, { tools });
}

function validateMiddlewareConfiguration(
  collective: Collective,
  registry: MiddlewareRegistry,
  diagnostics: MiddlewareDiagnostic[],
): void {
  for (const participant of collective.list()) {
    const ids = new Set<string>();
    for (const instance of participant.middleware ?? []) {
      const errors: string[] = [];
      if (ids.has(instance.id)) errors.push('duplicate middleware instance id');
      ids.add(instance.id);
      errors.push(...registry.validateConfig(instance.type, instance.config));
      if (errors.length === 0) continue;

      let diagnostic = diagnostics.find((entry) => entry.type === instance.type);
      if (!diagnostic) {
        diagnostic = {
          type: instance.type,
          source: 'workspace:<unavailable>',
          status: 'error',
          error: 'Middleware type unavailable',
          configurationErrors: [],
        };
        diagnostics.push(diagnostic);
      }
      diagnostic.configurationErrors.push({
        participantId: participant.id,
        instanceId: instance.id,
        errors: [...errors],
      });
      if (instance.enabled !== false) {
        throw new Error(
          `Invalid middleware '${instance.id}' on '${participant.id}': ${errors.join('; ')}`,
        );
      }
    }
  }
}

interface MiddlewareToolContextDeps {
  participant: ToolContext['participant'];
  conversation: ConversationThread;
  collective: Collective;
  toolRegistry: ToolRegistry;
  config: WorkspaceConfig;
  eventBus: EventBus;
  storage: FileStorage;
  workspaceRoot: string;
  authEngine: AuthEngine;
  pendingApprovalRegistry: PendingApprovalRegistry;
  messageRouter: MessageRouter;
  conversationStore: FileConversationStore;
  middlewareValidator: MiddlewareRegistry;
  signal: AbortSignal;
}

function buildMiddlewareToolContext(deps: MiddlewareToolContextDeps): ToolContext {
  return {
    participant: deps.participant,
    conversationId: deps.conversation.id,
    conversation: deps.conversation,
    collective: deps.collective,
    communicationDepth: 0,
    toolRegistry: deps.toolRegistry,
    config: deps.config,
    eventBus: deps.eventBus,
    storage: deps.storage,
    workspaceRoot: deps.workspaceRoot,
    authEngine: deps.authEngine,
    pendingApprovalRegistry: deps.pendingApprovalRegistry,
    messageRouter: deps.messageRouter,
    conversationStore: deps.conversationStore,
    middlewareValidator: deps.middlewareValidator,
    signal: deps.signal,
  };
}

const middlewareLogger: MiddlewareLogger = {
  debug: (message, fields) => console.debug(message, safeMiddlewareLogFields(fields)),
  info: (message, fields) => console.info(message, safeMiddlewareLogFields(fields)),
  warn: (message, fields) => console.warn(message, safeMiddlewareLogFields(fields)),
  error: (message, fields) => console.error(message, safeMiddlewareLogFields(fields)),
};

function safeMiddlewareLogFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const allowed = new Set([
    'operationId',
    'conversationId',
    'participantId',
    'instanceId',
    'middlewareType',
    'phase',
    'tool',
    'requestId',
    'approvalId',
    'checkpointId',
    'duration',
    'status',
    'failureMode',
  ]);
  return Object.fromEntries(
    Object.entries(fields ?? {}).filter(
      ([key, value]) =>
        allowed.has(key) &&
        (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'),
    ),
  );
}

/** Read and parse `~/.config/legion/config.json`. Returns empty config on errors. */
async function loadSystemConfig(): Promise<SystemConfig> {
  const configPath = join(homedir(), '.config', 'legion', 'config.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as SystemConfig;
  } catch {
    return {};
  }
}

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

/** Read and parse `.legion/config.local.json`. Returns empty config on errors. */
async function loadLocalConfig(workspaceRoot: string): Promise<LocalConfig> {
  const configPath = join(workspaceRoot, '.legion', 'config.local.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as LocalConfig;
  } catch {
    return {};
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function deepMerge<T extends object>(base: T, override: object): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function ensureGitignored(legionRoot: string, filename: string): Promise<void> {
  await mkdir(legionRoot, { recursive: true });
  const gitignorePath = join(legionRoot, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf-8');
  } catch {
    // Missing or unreadable .gitignore gets appended to with required local ignore.
  }

  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(filename)) return;

  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await writeFile(gitignorePath, `${prefix}${filename}\n`, 'utf-8');
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
  processManager: ProcessManager;
  middlewareRegistry: MiddlewareRegistry;
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
    processManager,
    middlewareRegistry,
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
        conversationStore: store,
        processManager,
        middlewareValidator: middlewareRegistry,
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
      if (opts && opts.conversationId !== '' && opts.conversationId !== undefined) {
        const existing = await store.load(opts.conversationId);
        if (!existing) {
          return {
            result: { status: 'error', error: `Conversation not found: ${opts.conversationId}` },
            conversationId: opts.conversationId,
          };
        }
        conversationId = opts.conversationId;
        thread = new ConversationThread(existing, store);
      } else if (opts && opts.conversationId === '') {
        // Management tools called without a conversationId — use ephemeral thread (no persistence)
        const now = new Date().toISOString();
        const data: ConversationData = {
          id: '',
          schemaVersion: '2.0',
          createdAt: now,
          updatedAt: now,
          activeBranchHead: '',
          messages: {},
        };
        conversationId = '';
        thread = new ConversationThread(data, store);
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
        conversationStore: store,
        processManager,
        middlewareValidator: middlewareRegistry,
      };

      const result = (await toolRegistry.execute(toolName, args, toolCtx)) as ToolResult;
      return { result, conversationId };
    },

    async streamTool(participantId, toolName, args, opts) {
      const participant = collective.get(participantId);
      if (!participant) {
        const gen = (async function* () {
          yield { type: 'stream:error', error: `Participant not found: ${participantId}` } as const;
        })();
        return { gen, conversationId: '' };
      }

      const authResult = authEngine.authorize(participantId, toolName, args, participant.tools);
      if (!authResult.authorized) {
        const gen = (async function* () {
          yield {
            type: 'stream:error',
            error: authResult.reason ?? 'Not authorized',
          } as const;
        })();
        return { gen, conversationId: '' };
      }

      // Conversation thread setup (mirrors callTool logic)
      let thread: ConversationThread;
      let conversationId: string;
      const reqConvId = opts?.conversationId;
      if (reqConvId && reqConvId !== '') {
        const existing = await store.load(reqConvId);
        if (!existing) {
          const gen = (async function* () {
            yield {
              type: 'stream:error',
              error: `Conversation not found: ${reqConvId}`,
            } as const;
          })();
          return { gen, conversationId: reqConvId };
        }
        conversationId = reqConvId;
        thread = new ConversationThread(existing, store);
      } else if (reqConvId === '') {
        const now = new Date().toISOString();
        const data: ConversationData = {
          id: '',
          schemaVersion: '2.0',
          createdAt: now,
          updatedAt: now,
          activeBranchHead: '',
          messages: {},
        };
        conversationId = '';
        thread = new ConversationThread(data, store);
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
        conversationStore: store,
        processManager,
        middlewareValidator: middlewareRegistry,
        signal: opts?.signal,
        cancelStream: opts?.cancelStream,
      };

      const gen = toolRegistry.stream(toolName, args, toolCtx);
      return { gen, conversationId };
    },

    registry: connectorRegistry,
  };
}
