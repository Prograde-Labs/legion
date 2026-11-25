import type {
  MCPServerConfig,
  ProviderConfig,
  ProviderModel,
  RoutingConfig,
  ToolResult,
} from '@legion-collective/types';
import type { Tool, SystemProviderStore } from '@legion-collective/core';
import type { AuthEngine, PendingApprovalRegistry, CodexAuthStore } from '@legion-collective/core';
import { CodexLoginManager, providerRetrySchema } from '@legion-collective/core';

// Only provider types that can be constructed and are suitable for new saves.
const SUPPORTED_PROVIDER_TYPES = new Set<ProviderConfig['type']>([
  'openai-compatible',
  'openai-responses',
  'codex',
]);

interface RuntimeToolDeps {
  systemStore: SystemProviderStore;
  systemRouting: RoutingConfig;
  workspaceRouting: RoutingConfig;
  saveSystemRouting: (routing: RoutingConfig) => Promise<void>;
  saveWorkspaceRouting: (routing: RoutingConfig) => Promise<void>;
  pendingApprovalRegistry: PendingApprovalRegistry;
  authEngine: AuthEngine;
  getMCPServers: () => Promise<MCPServerConfig[]>;
  saveMCPServers: (servers: MCPServerConfig[]) => Promise<void>;
  codexAuth?: CodexAuthStore;
}

export function createRuntimeTools(deps: RuntimeToolDeps): Tool[] {
  const {
    systemStore,
    systemRouting,
    workspaceRouting,
    saveSystemRouting,
    saveWorkspaceRouting,
    pendingApprovalRegistry,
    authEngine,
    getMCPServers,
    saveMCPServers,
    codexAuth,
  } = deps;
  const codexLogin = codexAuth ? new CodexLoginManager(codexAuth) : null;

  return [
    {
      name: 'list_providers',
      description: 'List all configured system LLM providers.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          return { status: 'success', data: await systemStore.list() };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'save_provider',
      description: 'Create or update a system provider.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: {
            type: 'string',
            enum: ['openai-compatible', 'openai-responses', 'codex'],
          },
          baseUrl: { type: 'string' },
          apiKey: { type: 'string' },
          priority: { type: 'number' },
          retry: providerRetrySchema,
        },
        required: ['name', 'type', 'priority'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as ProviderConfig;
          if (!SUPPORTED_PROVIDER_TYPES.has(args.type)) {
            throw new Error(`Provider type '${String(args.type)}' is not supported`);
          }
          if (args.baseUrl !== undefined && !/^https?:\/\//.test(args.baseUrl)) {
            return { status: 'error', error: 'baseUrl must be http(s)' };
          }
          // Omitted retry preserves the stored policy inside the store's per-key lock.
          return { status: 'success', data: await systemStore.save(args) };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'delete_provider',
      description: 'Delete a system provider.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const { name } = rawArgs as { name: string };
          await systemStore.delete(name);
          return { status: 'success', data: { name } };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'list_models',
      description: 'List discoverable models from configured system providers.',
      parameters: {
        type: 'object',
        properties: { providerName: { type: 'string' } },
        required: [],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const { providerName } = (rawArgs ?? {}) as { providerName?: string };
          const configs = (await systemStore.list()).filter(
            (config) => !providerName || config.name === providerName,
          );
          const data: { provider: string; model: ProviderModel }[] = [];

          for (const config of configs) {
            try {
              const provider = await systemStore.get(config.name);
              if (!provider?.listModels) continue;
              const models = await provider.listModels();
              for (const model of models) data.push({ provider: config.name, model });
            } catch {
              // Discovery best-effort: one bad provider must not fail whole tool.
            }
          }

          return { status: 'success', data };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'get_routing',
      description: 'Return system and workspace routing configuration.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        return { status: 'success', data: { system: systemRouting, workspace: workspaceRouting } };
      },
    },

    {
      name: 'save_routing',
      description: 'Save routing configuration to system or workspace-local scope.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['system', 'workspace'] },
          routing: { type: 'object' },
        },
        required: ['scope', 'routing'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const { scope, routing } = rawArgs as {
            scope: 'system' | 'workspace';
            routing: RoutingConfig;
          };
          if (scope === 'system') {
            await saveSystemRouting(routing);
            replaceRouting(systemRouting, routing);
          } else if (scope === 'workspace') {
            await saveWorkspaceRouting(routing);
            replaceRouting(workspaceRouting, routing);
          } else {
            throw new Error(`Invalid routing scope: ${String(scope)}`);
          }
          return { status: 'success', data: { scope } };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'list_pending_approvals',
      description:
        'List pending approval requests, optionally scoped to one conversation. ' +
        'Drives the global pending-approvals badge.',
      parameters: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'Scope to one conversation.' },
        },
        required: [],
      },
      execute: async (rawArgs: unknown, context): Promise<ToolResult> => {
        try {
          const { conversationId } = (rawArgs ?? {}) as { conversationId?: string };
          const pending = pendingApprovalRegistry
            .listPending(conversationId)
            .filter((record) =>
              authEngine.hasAuthority(
                context.participant.approvalAuthority,
                record.requesterId,
                record.tool,
                record.args,
              ),
            );
          return { status: 'success', data: pending };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'list_mcp_sources',
      description:
        'List MCP server declarations the process was started with (from workspace config).',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          return { status: 'success', data: await getMCPServers() };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'save_mcp_sources',
      description:
        'Replace ALL MCP server declarations in the workspace config. Takes effect after restart.',
      parameters: {
        type: 'object',
        properties: {
          servers: {
            type: 'array',
            description:
              'Full replacement list of MCPServerConfig entries (name required; command for stdio or url for HTTP).',
            items: { type: 'object' },
          },
        },
        required: ['servers'],
      },
      execute: async (rawArgs: unknown, context): Promise<ToolResult> => {
        // MCP server declarations can spawn arbitrary commands as the Legion
        // user on next boot, so saving them is operator-only.
        if (context.participant.operator !== true) {
          return {
            status: 'error',
            error: 'Only an operator can change MCP sources',
          };
        }
        try {
          const { servers } = rawArgs as { servers: unknown };
          if (!Array.isArray(servers)) throw new Error('servers must be an array');
          const seen = new Set<string>();
          const validated: MCPServerConfig[] = servers.map((entry, index) => {
            const server = entry as Partial<MCPServerConfig>;
            if (typeof server.name !== 'string' || server.name.trim().length === 0) {
              throw new Error(`servers[${index}].name must be a non-empty string`);
            }
            if (seen.has(server.name)) {
              throw new Error(`duplicate MCP server name: ${server.name}`);
            }
            seen.add(server.name);
            if (server.command !== undefined && server.url !== undefined) {
              throw new Error(
                `servers[${index}] (${server.name}): command and url are mutually exclusive`,
              );
            }
            if (server.command === undefined && server.url === undefined) {
              throw new Error(
                `servers[${index}] (${server.name}): needs either command (stdio) or url (HTTP)`,
              );
            }
            return server as MCPServerConfig;
          });
          await saveMCPServers(validated);
          return { status: 'success', data: { saved: validated.length } };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },
    {
      name: 'openai_login_start',
      description: 'Start an OpenAI Codex device-code login for a provider.',
      parameters: {
        type: 'object',
        properties: {
          providerName: { type: 'string' },
          priority: { type: 'number' },
        },
        required: ['providerName'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          if (!codexLogin) throw new Error('Codex auth store not configured');
          const { providerName, priority } = rawArgs as {
            providerName: string;
            priority?: number;
          };
          return {
            status: 'success',
            data: await codexLogin.start(providerName, priority ?? 10),
          };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'openai_login_poll',
      description: 'Poll an in-progress OpenAI Codex device-code login.',
      parameters: {
        type: 'object',
        properties: { flowId: { type: 'string' } },
        required: ['flowId'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          if (!codexLogin) throw new Error('Codex auth store not configured');
          const { flowId } = rawArgs as { flowId: string };
          const result = await codexLogin.poll(flowId);

          if (result.status === 'complete') {
            const existing = (await systemStore.list()).find(
              (config) => config.name === result.providerName,
            );
            if (!existing) {
              await systemStore.save({
                name: result.providerName,
                type: 'codex',
                priority: result.priority,
              });
            }
          }

          return { status: 'success', data: result };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'openai_auth_status',
      description: 'Report whether a Codex provider is signed in, without exposing tokens.',
      parameters: {
        type: 'object',
        properties: { providerName: { type: 'string' } },
        required: ['providerName'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          if (!codexAuth) throw new Error('Codex auth store not configured');
          const { providerName } = rawArgs as { providerName: string };
          const auth = await codexAuth.read(providerName);
          if (!auth) return { status: 'success', data: { signedIn: false } };

          return {
            status: 'success',
            data: {
              signedIn: true,
              email: auth.email,
              plan: auth.plan,
              accountId: auth.accountId,
              expiresAt: auth.expiresAt,
              expired: auth.expiresAt <= Math.floor(Date.now() / 1000),
            },
          };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'openai_logout',
      description: 'Revoke and delete stored OpenAI Codex credentials for a provider.',
      parameters: {
        type: 'object',
        properties: { providerName: { type: 'string' } },
        required: ['providerName'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          if (!codexAuth) throw new Error('Codex auth store not configured');
          const { providerName } = rawArgs as { providerName: string };
          codexLogin?.cancel(providerName);
          return { status: 'success', data: await codexAuth.logout(providerName) };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'openai_usage',
      description: 'Return the ChatGPT plan usage windows for a Codex provider.',
      parameters: {
        type: 'object',
        properties: { providerName: { type: 'string' } },
        required: ['providerName'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const { providerName } = rawArgs as { providerName: string };
          const provider = await systemStore.get(providerName);
          if (!provider) throw new Error(`Provider '${providerName}' not found`);
          if (!provider.usage) {
            throw new Error(`Provider '${providerName}' does not expose usage`);
          }
          return { status: 'success', data: await provider.usage() };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },
  ] satisfies Tool[];
}

function replaceRouting(target: RoutingConfig, source: RoutingConfig): void {
  for (const key of Object.keys(target) as (keyof RoutingConfig)[]) {
    delete target[key];
  }
  Object.assign(target, source);
}

function toErrorResult(err: unknown): ToolResult {
  return { status: 'error', error: err instanceof Error ? err.message : String(err) };
}
