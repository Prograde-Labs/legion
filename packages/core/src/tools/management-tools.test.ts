import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileCredentialStore } from '../credentials/FileCredentialStore.js';
import {
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getConversationTool,
  setToolPolicyTool,
  setCredentialTool,
  managementTools,
} from './management-tools.js';
import type { ToolContext } from './Tool.js';
import { ToolRegistry } from './ToolRegistry.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { RuntimeRegistry } from '../runtime/RuntimeRegistry.js';

async function makeContext() {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const conversationStore = new FileConversationStore(storage);
  const context = {
    participant: collective.getOrThrow('operator'),
    collective,
    conversationStore,
    workspaceRoot: '/tmp',
  } as unknown as ToolContext;
  return { context, collective, conversationStore };
}

interface TestDeps {
  storage: MemoryStorage;
  collective: Collective;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  runtimeRegistry: RuntimeRegistry;
}

async function buildTestDeps(options: { storage?: MemoryStorage } = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const toolRegistry = new ToolRegistry();
  for (const tool of managementTools) {
    toolRegistry.register(tool);
  }
  return {
    storage,
    collective,
    toolRegistry,
    providerRegistry: new ProviderRegistry(),
    runtimeRegistry: new RuntimeRegistry(),
  };
}

async function invokeManagementTool(
  name: string,
  args: unknown,
  deps: TestDeps,
): Promise<unknown> {
  const tool = deps.toolRegistry.get(name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  const context = {
    participant: deps.collective.getOrThrow('operator'),
    collective: deps.collective,
    workspaceRoot: '/tmp',
    storage: deps.storage,
    toolRegistry: deps.toolRegistry,
    providerRegistry: deps.providerRegistry,
    runtimeRegistry: deps.runtimeRegistry,
  } as unknown as ToolContext;
  return await tool.execute(args, context);
}

describe('management tools', () => {
  it('create_agent adds a new agent participant', async () => {
    const { context, collective } = await makeContext();
    const result = await createAgentTool.execute(
      {
        id: 'agent-x',
        name: 'X',
        systemPrompt: 'be helpful',
        model: { provider: 'openai-compatible', model: 'gpt-4o-mini' },
        tools: { communicate: 'auto' },
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(collective.get('agent-x')?.type).toBe('agent');
  });

  it('list_participants returns the roster', async () => {
    const { context } = await makeContext();
    const result = await listParticipantsTool.execute({}, context);
    expect(result.status).toBe('success');
    expect((result.data as { id: string }[]).some((p) => p.id === 'operator')).toBe(true);
  });

  it('retire_agent retires an agent', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      {
        id: 'agent-x',
        name: 'X',
        systemPrompt: 's',
        model: { provider: 'openai-compatible', model: 'm' },
        tools: {},
      },
      context,
    );
    const result = await retireAgentTool.execute({ id: 'agent-x' }, context);
    expect(result.status).toBe('success');
    expect(collective.get('agent-x')?.status).toBe('retired');
  });

  it('set_tool_policy updates a participant policy', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      {
        id: 'agent-x',
        name: 'X',
        systemPrompt: 's',
        model: { provider: 'openai-compatible', model: 'm' },
        tools: {},
      },
      context,
    );
    const result = await setToolPolicyTool.execute(
      { participantId: 'agent-x', tool: 'file_read', policy: 'auto' },
      context,
    );
    expect(result.status).toBe('success');
    expect(collective.get('agent-x')?.tools['file_read']).toBe('auto');
  });

  it('get_conversation returns the active chain of a conversation', async () => {
    const { context, conversationStore } = await makeContext();
    const conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await conversationStore.appendMessage(conv.id, {
      id: 'm1',
      parentId: null,
      conversationId: conv.id,
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    await conversationStore.updateHead(conv.id, 'm1');
    const result = await getConversationTool.execute({ conversationId: conv.id }, context);
    expect(result.status).toBe('success');
    expect((result.data as { messages: unknown[] }).messages.length).toBe(1);
  });

  it('create_agent rejects a duplicate id with a tool error', async () => {
    const { context } = await makeContext();
    const args = {
      id: 'operator',
      name: 'dup',
      systemPrompt: 's',
      model: { provider: 'p', model: 'm' },
      tools: {},
    };
    const result = await createAgentTool.execute(args, context);
    expect(result.status).toBe('error');
  });

  it('set_credential hashes and stores a participant secret', async () => {
    const { context } = await makeContext();
    const credentialStore = new FileCredentialStore(new MemoryStorage());
    const ctx = { ...context, credentialStore } as unknown as ToolContext;
    const result = await setCredentialTool.execute(
      { participantId: 'operator', secret: 'hunter2' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(await credentialStore.verify('operator', 'hunter2')).toBe(true);
  });

  it('set_credential errors when no credentialStore is in context', async () => {
    const { context } = await makeContext();
    const result = await setCredentialTool.execute(
      { participantId: 'operator', secret: 'x' },
      context,
    );
    expect(result.status).toBe('error');
  });

  it('create_agent writes agent config to storage', async () => {
    const storage = new MemoryStorage();
    const collective = await Collective.load(storage);
    await collective.seedDefaultsIfEmpty();
    const conversationStore = new FileConversationStore(storage);
    const context = {
      participant: collective.getOrThrow('operator'),
      collective,
      conversationStore,
      workspaceRoot: '/tmp',
    } as unknown as ToolContext;
    await createAgentTool.execute(
      {
        id: 'bot-1',
        name: 'bot-1',
        model: { provider: 'openai', model: 'gpt-4o' },
        systemPrompt: '',
        tools: {},
      },
      context,
    );
    const ids = await storage.list('agents/');
    expect(ids.length).toBe(1);
    const config = await storage.readJson<{ model: string }>(`agents/${ids[0]}`);
    expect(config?.model).toBe('gpt-4o');
  });
});

describe('modify_agent', () => {
  it('updates model and systemPrompt in storage', async () => {
    const storage = new MemoryStorage();
    const deps = await buildTestDeps({ storage });
    const createResult = (await invokeManagementTool(
      'create_agent',
      {
        id: 'bot-1',
        name: 'bot-1',
        model: { provider: 'openai', model: 'gpt-4o' },
        systemPrompt: '',
        tools: {},
      },
      deps,
    )) as { status: string; data: { id: string } };
    const { id } = createResult.data;
    await invokeManagementTool(
      'modify_agent',
      {
        id,
        model: 'gpt-4o-mini',
        systemPrompt: 'Be concise.',
      },
      deps,
    );
    const config = await storage.readJson<{ model: { provider: string; model: string }; systemPrompt: string }>(
      `agents/${id}.json`,
    );
    expect(config?.model).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(config?.systemPrompt).toBe('Be concise.');
  });

  it('updates name in Collective', async () => {
    const deps = await buildTestDeps({});
    const createResult = (await invokeManagementTool(
      'create_agent',
      {
        id: 'bot-2',
        name: 'bot-1',
        model: { provider: 'openai', model: 'gpt-4o' },
        systemPrompt: '',
        tools: {},
      },
      deps,
    )) as { status: string; data: { id: string } };
    const { id } = createResult.data;
    const updated = (await invokeManagementTool('modify_agent', { id, name: 'renamed' }, deps)) as {
      status: string;
      data: { name: string };
    };
    expect(updated.status).toBe('success');
    expect(updated.data.name).toBe('renamed');
  });

  it('returns error status if participant id not found', async () => {
    const deps = await buildTestDeps({});
    const result = await invokeManagementTool('modify_agent', { id: 'no-such' }, deps);
    expect((result as { status: string }).status).toBe('error');
  });
});

describe('list_tools', () => {
  it('returns registered tool names', async () => {
    const deps = await buildTestDeps({});
    const result = await invokeManagementTool('list_tools', {}, deps);
    const tools = (result as { status: string; data: string[] }).data;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toContain('list_tools');
  });
});

describe('list_conversations', () => {
  it('returns empty array when no conversations exist', async () => {
    const storage = new MemoryStorage();
    const deps = await buildTestDeps({ storage });
    const result = await invokeManagementTool('list_conversations', {}, deps);
    expect((result as { status: string; data: unknown[] }).data).toEqual([]);
  });

  it('returns summaries for stored conversations', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('conversations/conv-1.json', {
      id: 'conv-1',
      participantIds: ['a', 'b'],
      status: 'active',
      messageCount: 3,
      createdAt: 1000,
      updatedAt: 2000,
    });
    const deps = await buildTestDeps({ storage });
    const result = await invokeManagementTool('list_conversations', {}, deps);
    expect((result as { status: string; data: { id: string }[] }).data[0]?.id).toBe('conv-1');
  });
});
