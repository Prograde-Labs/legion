import type { ProviderConfig, ProviderModel, RoutingConfig } from '@legion-collective/types';
import { describe, expect, it } from 'vitest';
import { PendingApprovalRegistry, type ToolContext } from '@legion-collective/core';
import { createRuntimeTools } from './runtime-tools.js';

type ProviderStub = { listModels?: () => Promise<ProviderModel[]> };

function makeSystemStore(
  initial: ProviderConfig[] = [],
  providers: Record<string, ProviderStub | Error | null> = {},
) {
  const store = new Map<string, ProviderConfig>(initial.map((c) => [c.name, c]));
  return {
    list: async () => Array.from(store.values()),
    save: async (config: ProviderConfig) => {
      store.set(config.name, config);
    },
    delete: async (name: string) => {
      store.delete(name);
    },
    get: async (name: string) => {
      const provider = providers[name];
      if (provider instanceof Error) throw provider;
      return provider ?? null;
    },
    _store: store,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof createRuntimeTools>[0]> = {}) {
  const systemRouting: RoutingConfig = { models: { existing: ['system-provider'] } };
  const workspaceRouting: RoutingConfig = { models: { local: ['workspace-provider'] } };
  return {
    systemStore: makeSystemStore(),
    systemRouting,
    workspaceRouting,
    saveSystemRouting: async (routing: RoutingConfig) => {
      Object.keys(systemRouting).forEach((k) => delete systemRouting[k]);
      Object.assign(systemRouting, routing);
    },
    saveWorkspaceRouting: async (routing: RoutingConfig) => {
      Object.keys(workspaceRouting).forEach((k) => delete workspaceRouting[k]);
      Object.assign(workspaceRouting, routing);
    },
    pendingApprovalRegistry: makeApprovalRegistry(),
    getMCPServers: async () => [],
    saveMCPServers: async () => {},
    ...overrides,
  };
}

function tool(tools: ReturnType<typeof createRuntimeTools>, name: string) {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`Tool not found: ${name}`);
  return found;
}

function makeApprovalRegistry(): PendingApprovalRegistry {
  return new PendingApprovalRegistry();
}

function makeContext(): ToolContext {
  // Tools under test never read the context; a stub keeps the fixture light.
  return {} as unknown as ToolContext;
}

describe('runtime tools', () => {
  it('exposes only provider and routing tools', () => {
    const tools = createRuntimeTools(makeDeps());
    expect(tools.map((t) => t.name)).toEqual([
      'list_providers',
      'save_provider',
      'delete_provider',
      'list_models',
      'get_routing',
      'save_routing',
      'list_pending_approvals',
      'list_mcp_sources',
      'save_mcp_sources',
    ]);
    expect(tools.some((t) => t.name === 'set_credential_with_meta')).toBe(false);
    expect(tools.some((t) => t.name === 'list_credentials')).toBe(false);
    expect(tools.some((t) => t.name === 'configure_provider')).toBe(false);
  });

  it('list_providers returns system provider configs', async () => {
    const systemStore = makeSystemStore([
      {
        name: 'openai',
        type: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        priority: 1,
      },
    ]);
    const tools = createRuntimeTools(makeDeps({ systemStore }));
    await expect(tool(tools, 'list_providers').execute({})).resolves.toEqual({
      status: 'success',
      data: [
        {
          name: 'openai',
          type: 'openai-compatible',
          baseUrl: 'https://api.openai.com/v1',
          priority: 1,
        },
      ],
    });
  });

  it('save_provider saves and returns provider config', async () => {
    const systemStore = makeSystemStore();
    const tools = createRuntimeTools(makeDeps({ systemStore }));
    const config: ProviderConfig = {
      name: 'local',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'secret',
      priority: 10,
    };

    await expect(tool(tools, 'save_provider').execute(config)).resolves.toEqual({
      status: 'success',
      data: config,
    });
    expect(systemStore._store.get('local')).toEqual(config);
  });

  it('delete_provider deletes and returns provider name', async () => {
    const systemStore = makeSystemStore([
      { name: 'local', type: 'openai-compatible', priority: 10 },
    ]);
    const tools = createRuntimeTools(makeDeps({ systemStore }));

    await expect(tool(tools, 'delete_provider').execute({ name: 'local' })).resolves.toEqual({
      status: 'success',
      data: { name: 'local' },
    });
    expect(systemStore._store.has('local')).toBe(false);
  });

  it('list_models discovers models and skips throwing or non-discoverable providers', async () => {
    const systemStore = makeSystemStore(
      [
        { name: 'good', type: 'openai-compatible', priority: 1 },
        { name: 'throws-get', type: 'copilot', priority: 2 },
        { name: 'no-list', type: 'openai-compatible', priority: 3 },
        { name: 'throws-list', type: 'openai-compatible', priority: 4 },
      ],
      {
        good: { listModels: async () => [{ id: 'gpt-4o', name: 'GPT-4o' }] },
        'throws-get': new Error('not implemented'),
        'no-list': {},
        'throws-list': {
          listModels: async () => {
            throw new Error('network');
          },
        },
      },
    );
    const tools = createRuntimeTools(makeDeps({ systemStore }));

    await expect(tool(tools, 'list_models').execute({})).resolves.toEqual({
      status: 'success',
      data: [{ provider: 'good', model: { id: 'gpt-4o', name: 'GPT-4o' } }],
    });
  });

  it('list_models filters by providerName', async () => {
    const systemStore = makeSystemStore(
      [
        { name: 'one', type: 'openai-compatible', priority: 1 },
        { name: 'two', type: 'openai-compatible', priority: 2 },
      ],
      {
        one: { listModels: async () => [{ id: 'one-model' }] },
        two: { listModels: async () => [{ id: 'two-model' }] },
      },
    );
    const tools = createRuntimeTools(makeDeps({ systemStore }));

    await expect(tool(tools, 'list_models').execute({ providerName: 'two' })).resolves.toEqual({
      status: 'success',
      data: [{ provider: 'two', model: { id: 'two-model' } }],
    });
  });

  it('get_routing returns system and workspace routing objects', async () => {
    const deps = makeDeps();
    const tools = createRuntimeTools(deps);

    await expect(tool(tools, 'get_routing').execute({})).resolves.toEqual({
      status: 'success',
      data: { system: deps.systemRouting, workspace: deps.workspaceRouting },
    });
  });

  it('save_routing persists selected scope and updates in-memory get_routing refs', async () => {
    const saved: { system?: RoutingConfig; workspace?: RoutingConfig } = {};
    const deps = makeDeps({
      saveSystemRouting: async (routing: RoutingConfig) => {
        saved.system = routing;
      },
      saveWorkspaceRouting: async (routing: RoutingConfig) => {
        saved.workspace = routing;
      },
    });
    const tools = createRuntimeTools(deps);

    await expect(
      tool(tools, 'save_routing').execute({
        scope: 'workspace',
        routing: { models: { claude: ['anthropic'] } },
      }),
    ).resolves.toEqual({ status: 'success', data: { scope: 'workspace' } });

    expect(saved.workspace).toEqual({ models: { claude: ['anthropic'] } });
    await expect(tool(tools, 'get_routing').execute({})).resolves.toEqual({
      status: 'success',
      data: {
        system: { models: { existing: ['system-provider'] } },
        workspace: { models: { claude: ['anthropic'] } },
      },
    });
  });

  it('save_routing persists system scope and updates in-memory refs', async () => {
    const saved: { system?: RoutingConfig; workspace?: RoutingConfig } = {};
    const deps = makeDeps({
      saveSystemRouting: async (routing: RoutingConfig) => {
        saved.system = routing;
      },
      saveWorkspaceRouting: async (routing: RoutingConfig) => {
        saved.workspace = routing;
      },
    });
    const tools = createRuntimeTools(deps);

    await expect(
      tool(tools, 'save_routing').execute({
        scope: 'system',
        routing: { models: { gpt4o: ['openai'] } },
      }),
    ).resolves.toEqual({ status: 'success', data: { scope: 'system' } });

    expect(saved.system).toEqual({ models: { gpt4o: ['openai'] } });
    await expect(tool(tools, 'get_routing').execute({})).resolves.toEqual({
      status: 'success',
      data: {
        system: { models: { gpt4o: ['openai'] } },
        workspace: { models: { local: ['workspace-provider'] } },
      },
    });
  });
});

describe('list_pending_approvals', () => {
  it('returns pending approvals across conversations', async () => {
    const registry = makeApprovalRegistry(); // fixture helper you add, e.g. MemoryStorage-backed
    await registry.create({
      conversationId: 'conv-1',
      requesterId: 'agent-a',
      tool: 'file_write',
      args: { path: '/x' },
    });
    await registry.create({
      conversationId: 'conv-2',
      requesterId: 'agent-b',
      tool: 'shell',
      args: {},
    });
    const tools = createRuntimeTools(makeDeps({ pendingApprovalRegistry: registry }));
    const tool = tools.find((t) => t.name === 'list_pending_approvals')!;
    const result = await tool.execute({}, makeContext());
    expect(result.status).toBe('success');
    expect((result.data as unknown[]).length).toBe(2);
  });

  it('filters by conversationId', async () => {
    const registry = makeApprovalRegistry();
    await registry.create({
      conversationId: 'conv-1',
      requesterId: 'agent-a',
      tool: 'file_write',
      args: { path: '/x' },
    });
    await registry.create({
      conversationId: 'conv-2',
      requesterId: 'agent-b',
      tool: 'shell',
      args: {},
    });
    const tools = createRuntimeTools(makeDeps({ pendingApprovalRegistry: registry }));
    const tool = tools.find((t) => t.name === 'list_pending_approvals')!;
    const result = await tool.execute({ conversationId: 'conv-1' }, makeContext());
    expect(result.status).toBe('success');
    const data = result.data as Array<{ conversationId: string }>;
    expect(data.length).toBe(1);
    expect(data[0].conversationId).toBe('conv-1');
  });
});

describe('mcp source tools', () => {
  it('list_mcp_sources returns the configured servers', async () => {
    const servers = [{ name: 'fs', command: 'npx', args: ['-y', '@mcp/fs'] }];
    const tools = createRuntimeTools(makeDeps({ getMCPServers: async () => servers }));
    const tool = tools.find((t) => t.name === 'list_mcp_sources')!;
    const result = await tool.execute({}, makeContext());
    expect(result.status).toBe('success');
    expect(result.data).toEqual(servers);
  });

  it('save_mcp_sources persists a valid full list', async () => {
    let stored: unknown[] = [];
    const tools = createRuntimeTools(makeDeps({ saveMCPServers: async (s) => void (stored = s) }));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute(
      {
        servers: [
          { name: 'fs', command: 'npx' },
          { name: 'http-one', url: 'http://localhost:3000/mcp' },
        ],
      },
      makeContext(),
    );
    expect(result.status).toBe('success');
    expect(stored.length).toBe(2);
  });

  it('save_mcp_sources rejects entries without name', async () => {
    const tools = createRuntimeTools(makeDeps({}));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute({ servers: [{ command: 'npx' }] }, makeContext());
    expect(result.status).toBe('error');
    expect(result.error).toContain('name');
  });

  it('save_mcp_sources rejects entries with both command and url', async () => {
    const tools = createRuntimeTools(makeDeps({}));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute(
      { servers: [{ name: 'x', command: 'npx', url: 'http://x' }] },
      makeContext(),
    );
    expect(result.status).toBe('error');
  });

  it('save_mcp_sources rejects duplicate names', async () => {
    const tools = createRuntimeTools(makeDeps({}));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute(
      {
        servers: [
          { name: 'x', command: 'a' },
          { name: 'x', command: 'b' },
        ],
      },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('duplicate');
  });

  it('save_mcp_sources rejects non-array payloads', async () => {
    const tools = createRuntimeTools(makeDeps({}));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute({ servers: 'nope' }, makeContext());
    expect(result.status).toBe('error');
  });
});
