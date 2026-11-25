import type { CodexAuthStore } from '@legion-collective/core';
import type { ProviderUsageSummary } from '@legion-collective/types';
import type { ProviderConfig, ProviderModel, RoutingConfig } from '@legion-collective/types';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthEngine,
  MemoryStorage,
  PendingApprovalRegistry,
  SystemProviderStore,
  type ToolContext,
} from '@legion-collective/core';
import { createRuntimeTools } from './runtime-tools.js';

function makeAuthEngine(
  canApprove: (requesterId: string, tool: string) => boolean = () => true,
): AuthEngine {
  return {
    hasAuthority: (_authority, requesterId, tool) => canApprove(requesterId, tool),
  } as unknown as AuthEngine;
}

type ProviderStub = {
  listModels?: () => Promise<ProviderModel[]>;
  usage?: () => Promise<ProviderUsageSummary>;
};

function makeSystemStore(
  initial: ProviderConfig[] = [],
  providers: Record<string, ProviderStub | Error | null> = {},
) {
  const store = new Map<string, ProviderConfig>(initial.map((c) => [c.name, c]));
  return {
    list: async () => Array.from(store.values()),
    save: async (config: ProviderConfig) => {
      store.set(config.name, config);
      return config;
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

function makeCodexAuth(
  overrides: Partial<
    Record<'read' | 'save' | 'saveIfActive' | 'delete' | 'ensureFresh' | 'logout', unknown>
  > = {},
): CodexAuthStore {
  return {
    read: async () => null,
    save: async () => undefined,
    saveIfActive: async (_name: string, _auth: unknown, active: () => boolean) => active(),
    delete: async () => undefined,
    logout: async () => ({ signedOut: true, revoked: false }),
    ensureFresh: async () => {
      throw new Error('not signed in');
    },
    ...overrides,
  } as unknown as CodexAuthStore;
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
    authEngine: makeAuthEngine(),
    getMCPServers: async () => [],
    saveMCPServers: async () => {},
    codexAuth: undefined,
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

function makeContext(overrides: Partial<ToolContext['participant']> = {}): ToolContext {
  // Give the default caller full authority so approval filtering is exercised
  // by authEngine stubs; operator tools (save_mcp_sources) also require the flag.
  return {
    participant: {
      id: 'operator',
      operator: true,
      approvalAuthority: { participants: '*', tools: '*' },
      ...overrides,
    },
  } as unknown as ToolContext;
}

describe('runtime tools', () => {
  it('cancels a pending login when that provider is logged out', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ device_auth_id: 'd1', user_code: 'CODE-1', interval: '5' }),
          ),
        ),
    );
    try {
      const tools = createRuntimeTools(makeDeps({ codexAuth: makeCodexAuth() }));
      const started = await tool(tools, 'openai_login_start').execute({ providerName: 'Codex' });
      const flowId = (started.data as { flowId: string }).flowId;
      await tool(tools, 'openai_logout').execute({ providerName: 'Codex' });
      await expect(tool(tools, 'openai_login_poll').execute({ flowId })).resolves.toEqual({
        status: 'success',
        data: { status: 'expired' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
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
      'openai_login_start',
      'openai_login_poll',
      'openai_auth_status',
      'openai_logout',
      'openai_usage',
    ]);
    expect(tools.some((t) => t.name === 'set_credential_with_meta')).toBe(false);
    expect(tools.some((t) => t.name === 'list_credentials')).toBe(false);
    expect(tools.some((t) => t.name === 'configure_provider')).toBe(false);
  });

  it('save_provider accepts codex without a base URL or API key', async () => {
    const systemStore = makeSystemStore();
    const tools = createRuntimeTools(makeDeps({ systemStore }));

    await expect(
      tool(tools, 'save_provider').execute({ name: 'Codex', type: 'codex', priority: 5 }),
    ).resolves.toEqual({
      status: 'success',
      data: { name: 'Codex', type: 'codex', priority: 5 },
    });
    expect(systemStore._store.get('Codex')).toEqual({
      name: 'Codex',
      type: 'codex',
      priority: 5,
    });
  });

  it('openai_login_start returns device-code display data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_auth_id: 'd1',
          user_code: 'CODE-1',
          interval: '5',
          expires_at: '2026-11-17T06:00:00Z',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tools = createRuntimeTools(makeDeps({ codexAuth: makeCodexAuth() }));

    try {
      const result = await tool(tools, 'openai_login_start').execute({ providerName: 'Codex' });
      expect(result.status).toBe('success');
      expect(result.data).toMatchObject({
        providerName: 'Codex',
        userCode: 'CODE-1',
        verificationUrl: 'https://auth.openai.com/codex/device',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('openai_login_poll creates the provider config on completion', async () => {
    const idToken = `x.${Buffer.from(
      JSON.stringify({
        email: 'user@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct', chatgpt_plan_type: 'plus' },
      }),
    ).toString('base64url')}.y`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ device_auth_id: 'd1', user_code: 'CODE-1', interval: '5' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorization_code: 'ac', code_verifier: 'cv' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', id_token: idToken }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const systemStore = makeSystemStore();
    const tools = createRuntimeTools(makeDeps({ systemStore, codexAuth: makeCodexAuth() }));

    try {
      const started = await tool(tools, 'openai_login_start').execute({ providerName: 'Codex' });
      const flowId = (started.data as { flowId: string }).flowId;
      const result = await tool(tools, 'openai_login_poll').execute({ flowId });

      expect(result).toMatchObject({
        status: 'success',
        data: { status: 'complete', providerName: 'Codex', priority: 10 },
      });
      expect(systemStore._store.get('Codex')).toEqual({
        name: 'Codex',
        type: 'codex',
        priority: 10,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('openai_login_poll preserves an existing provider config on completion', async () => {
    const idToken = `x.${Buffer.from(
      JSON.stringify({
        email: 'user@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct', chatgpt_plan_type: 'plus' },
      }),
    ).toString('base64url')}.y`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ device_auth_id: 'd1', user_code: 'CODE-1', interval: '5' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorization_code: 'ac', code_verifier: 'cv' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', id_token: idToken }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const systemStore = makeSystemStore([{ name: 'Codex', type: 'codex', priority: 42 }]);
    const tools = createRuntimeTools(makeDeps({ systemStore, codexAuth: makeCodexAuth() }));

    try {
      const started = await tool(tools, 'openai_login_start').execute({ providerName: 'Codex' });
      const flowId = (started.data as { flowId: string }).flowId;
      const result = await tool(tools, 'openai_login_poll').execute({ flowId });

      expect(result).toMatchObject({
        status: 'success',
        data: { status: 'complete', providerName: 'Codex', priority: 10 },
      });
      expect(systemStore._store.get('Codex')).toEqual({
        name: 'Codex',
        type: 'codex',
        priority: 42,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('openai_auth_status reports account metadata without tokens', async () => {
    const codexAuth = makeCodexAuth({
      read: async () => ({
        clientId: 'c',
        issuer: 'https://auth.openai.com',
        accountId: 'acct',
        email: 'user@example.com',
        plan: 'plus',
        accessToken: 'secret',
        refreshToken: 'secret',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        savedAt: '2026-11-17T05:00:00.000Z',
      }),
    });
    const tools = createRuntimeTools(makeDeps({ codexAuth }));

    const result = await tool(tools, 'openai_auth_status').execute({ providerName: 'Codex' });
    expect(result).toEqual({
      status: 'success',
      data: {
        signedIn: true,
        email: 'user@example.com',
        plan: 'plus',
        accountId: 'acct',
        expiresAt: expect.any(Number),
        expired: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('openai_auth_status reports signed out when no auth file exists', async () => {
    const tools = createRuntimeTools(makeDeps({ codexAuth: makeCodexAuth() }));
    await expect(
      tool(tools, 'openai_auth_status').execute({ providerName: 'Codex' }),
    ).resolves.toEqual({ status: 'success', data: { signedIn: false } });
  });

  it('openai_logout delegates to the auth store', async () => {
    const logout = vi.fn(async () => ({ signedOut: true, revoked: true }));
    const codexAuth = makeCodexAuth({
      logout,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    const tools = createRuntimeTools(makeDeps({ codexAuth }));

    try {
      await expect(
        tool(tools, 'openai_logout').execute({ providerName: 'Codex' }),
      ).resolves.toEqual({
        status: 'success',
        data: { signedOut: true, revoked: true },
      });
      expect(logout).toHaveBeenCalledWith('Codex');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('openai_logout succeeds when there is nothing to revoke', async () => {
    const tools = createRuntimeTools(makeDeps({ codexAuth: makeCodexAuth() }));
    await expect(tool(tools, 'openai_logout').execute({ providerName: 'Codex' })).resolves.toEqual({
      status: 'success',
      data: { signedOut: true, revoked: false },
    });
  });

  it('openai_usage delegates to the provider usage method', async () => {
    const summary = {
      planType: 'plus',
      windows: [
        {
          label: '5-hour',
          usedPercent: 12,
          remainingPercent: 88,
          windowSeconds: 18000,
          resetAt: 1790036132,
        },
      ],
      capturedAt: '2026-11-17T05:00:00.000Z',
    };
    const systemStore = makeSystemStore([{ name: 'Codex', type: 'codex', priority: 10 }], {
      Codex: { usage: async () => summary },
    });
    const tools = createRuntimeTools(makeDeps({ systemStore }));

    await expect(tool(tools, 'openai_usage').execute({ providerName: 'Codex' })).resolves.toEqual({
      status: 'success',
      data: summary,
    });
  });

  it('openai_usage errors for a provider without usage support', async () => {
    const systemStore = makeSystemStore(
      [{ name: 'local', type: 'openai-compatible', priority: 1 }],
      {
        local: {},
      },
    );
    const tools = createRuntimeTools(makeDeps({ systemStore }));

    await expect(tool(tools, 'openai_usage').execute({ providerName: 'local' })).resolves.toEqual({
      status: 'error',
      error: expect.stringContaining('does not expose usage'),
    });
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

  it('can save a provider independently of unreadable sibling configs', async () => {
    const storage = new MemoryStorage();
    await storage.write('providers/unrelated.json', 'invalid JSON');
    const tools = createRuntimeTools(makeDeps({ systemStore: new SystemProviderStore(storage) }));
    const config = { name: 'local', type: 'openai-compatible', priority: 10 };
    await expect(tool(tools, 'save_provider').execute(config)).resolves.toEqual({
      status: 'success',
      data: config,
    });
  });

  it('keeps the retry policy when editing other fields and replaces it when explicitly supplied', async () => {
    const tools = createRuntimeTools(
      makeDeps({ systemStore: new SystemProviderStore(new MemoryStorage()) }),
    );
    const save = tool(tools, 'save_provider');
    const config = { name: 'local', type: 'openai-compatible', priority: 10 };
    const retry = { maxRetries: 0, baseDelayMs: 75, maxDelayMs: 2000 };
    await expect(save.execute({ ...config, retry })).resolves.toMatchObject({ status: 'success' });

    // The web provider editor sends only the fields it exposes.
    const edited = { ...config, priority: 4 };
    await expect(save.execute(edited)).resolves.toEqual({
      status: 'success',
      data: { ...edited, retry },
    });
    const list = tool(tools, 'list_providers');
    await expect(list.execute({})).resolves.toEqual({
      status: 'success',
      data: [{ ...edited, retry }],
    });

    await save.execute({ ...edited, retry: {} });
    await expect(list.execute({})).resolves.toEqual({
      status: 'success',
      data: [{ ...edited, retry: {} }],
    });
  });

  it.each([
    null,
    [],
    { maxRetries: -1 },
    { maxRetries: 0.5 },
    { maxRetries: 11 },
    { baseDelayMs: '500' },
    { maxDelayMs: Infinity },
    { maxDelayMs: 2 ** 31 },
    { retries: 0 },
  ])('rejects invalid retry config %j without updating the provider', async (retry) => {
    const tools = createRuntimeTools(
      makeDeps({ systemStore: new SystemProviderStore(new MemoryStorage()) }),
    );
    const save = tool(tools, 'save_provider');
    const config = { name: 'local', type: 'codex', priority: 1, retry: { maxRetries: 1 } };
    await save.execute(config);
    await expect(save.execute({ ...config, retry })).resolves.toEqual({
      status: 'error',
      error: expect.stringMatching(/retry/i),
    });
    await expect(tool(tools, 'list_providers').execute({})).resolves.toEqual({
      status: 'success',
      data: [config],
    });
  });

  it('advertises the optional retry controls to save_provider callers', () => {
    const schema = tool(createRuntimeTools(makeDeps()), 'save_provider').parameters;
    expect(schema.properties?.retry).toMatchObject({
      type: 'object',
      properties: {
        maxRetries: { type: 'integer', minimum: 0 },
        baseDelayMs: { type: 'integer', minimum: 0 },
        maxDelayMs: { type: 'integer', minimum: 0 },
      },
    });
    expect(schema.required).not.toContain('retry');
  });

  it('save_provider advertises only the constructible provider types', () => {
    const tools = createRuntimeTools(makeDeps());
    const schema = tool(tools, 'save_provider').parameters as {
      properties?: { type?: { enum?: string[] } };
    };
    expect(schema.properties?.type?.enum).toEqual([
      'openai-compatible',
      'openai-responses',
      'codex',
    ]);
  });

  it('save_provider rejects unsupported provider types', async () => {
    const systemStore = makeSystemStore();
    const tools = createRuntimeTools(makeDeps({ systemStore }));

    await expect(
      tool(tools, 'save_provider').execute({ name: 'unsupported', type: 'copilot', priority: 1 }),
    ).resolves.toEqual({ status: 'error', error: expect.stringContaining('copilot') });
    expect(systemStore._store.has('unsupported')).toBe(false);

    // Legacy anthropic configs still construct through the store, but new saves
    // must be rejected so the UI cannot create an OpenAI-compatible mislabel.
    await expect(
      tool(tools, 'save_provider').execute({ name: 'legacy', type: 'anthropic', priority: 1 }),
    ).resolves.toEqual({ status: 'error', error: expect.stringContaining('anthropic') });
    expect(systemStore._store.has('legacy')).toBe(false);
  });

  it('save_provider rejects a non-http baseUrl', async () => {
    const systemStore = makeSystemStore();
    const tools = createRuntimeTools(makeDeps({ systemStore }));

    await expect(
      tool(tools, 'save_provider').execute({
        name: 'x',
        type: 'openai-compatible',
        baseUrl: 'file:///etc/passwd',
        priority: 1,
      }),
    ).resolves.toEqual({ status: 'error', error: 'baseUrl must be http(s)' });
    expect(systemStore._store.has('x')).toBe(false);
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

  it('omits records the caller has no authority over', async () => {
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
    const tools = createRuntimeTools(
      makeDeps({
        pendingApprovalRegistry: registry,
        authEngine: makeAuthEngine((requesterId) => requesterId === 'agent-a'),
      }),
    );
    const tool = tools.find((t) => t.name === 'list_pending_approvals')!;
    const result = await tool.execute({}, makeContext());
    expect(result.status).toBe('success');
    const data = result.data as Array<{ requesterId: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].requesterId).toBe('agent-a');
  });

  it('forwards the caller authority, requester, tool and args to hasAuthority', async () => {
    const registry = makeApprovalRegistry();
    await registry.create({
      conversationId: 'conv-1',
      requesterId: 'agent-a',
      tool: 'file_write',
      args: { path: '/x' },
    });
    const hasAuthority = vi.fn().mockReturnValue(true);
    const tools = createRuntimeTools(
      makeDeps({
        pendingApprovalRegistry: registry,
        authEngine: { hasAuthority } as unknown as AuthEngine,
      }),
    );
    const authority = { participants: ['agent-a'], tools: { file_write: true } };
    const context = {
      participant: { id: 'operator', approvalAuthority: authority },
    } as unknown as ToolContext;
    const tool = tools.find((t) => t.name === 'list_pending_approvals')!;
    await tool.execute({}, context);
    expect(hasAuthority).toHaveBeenCalledWith(authority, 'agent-a', 'file_write', { path: '/x' });
  });

  it('returns an empty list (fails closed) when the caller has no authority', async () => {
    const registry = makeApprovalRegistry();
    await registry.create({
      conversationId: 'conv-1',
      requesterId: 'agent-a',
      tool: 'file_write',
      args: { path: '/x' },
    });
    const tools = createRuntimeTools(
      makeDeps({ pendingApprovalRegistry: registry, authEngine: new AuthEngine() }),
    );
    const context = { participant: { id: 'operator' } } as unknown as ToolContext;
    const tool = tools.find((t) => t.name === 'list_pending_approvals')!;
    const result = await tool.execute({}, context);
    expect(result.status).toBe('success');
    expect(result.data).toEqual([]);
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

  it('save_mcp_sources rejects a non-operator caller', async () => {
    // Regression for the deferred M8 fix: any user with save_mcp_sources could
    // persist arbitrary commands that run as the Legion user on next boot.
    let saved = false;
    const tools = createRuntimeTools(makeDeps({ saveMCPServers: async () => void (saved = true) }));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute(
      { servers: [{ name: 'fs', command: 'npx' }] },
      makeContext({ operator: false }),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('operator');
    expect(saved).toBe(false);
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
