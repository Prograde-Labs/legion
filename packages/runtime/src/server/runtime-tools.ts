import type {
  MCPServerConfig,
  ProviderConfig,
  ProviderModel,
  RoutingConfig,
  ToolResult,
} from '@legion-collective/types';
import type { Tool, SystemProviderStore } from '@legion-collective/core';
import type { PendingApprovalRegistry } from '@legion-collective/core';

interface RuntimeToolDeps {
  systemStore: SystemProviderStore;
  systemRouting: RoutingConfig;
  workspaceRouting: RoutingConfig;
  saveSystemRouting: (routing: RoutingConfig) => Promise<void>;
  saveWorkspaceRouting: (routing: RoutingConfig) => Promise<void>;
  pendingApprovalRegistry: PendingApprovalRegistry;
  getMCPServers: () => Promise<MCPServerConfig[]>;
}

export function createRuntimeTools(deps: RuntimeToolDeps): Tool[] {
  const {
    systemStore,
    systemRouting,
    workspaceRouting,
    saveSystemRouting,
    saveWorkspaceRouting,
    pendingApprovalRegistry,
    getMCPServers,
  } = deps;

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
          type: { type: 'string', enum: ['openai-compatible', 'anthropic', 'copilot', 'codex'] },
          baseUrl: { type: 'string' },
          apiKey: { type: 'string' },
          priority: { type: 'number' },
        },
        required: ['name', 'type', 'priority'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as ProviderConfig;
          await systemStore.save(args);
          return { status: 'success', data: args };
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
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const { conversationId } = (rawArgs ?? {}) as { conversationId?: string };
          const pending = pendingApprovalRegistry.listPending(conversationId);
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
