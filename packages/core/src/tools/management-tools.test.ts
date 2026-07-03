import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileCredentialStore } from '../credentials/FileCredentialStore.js';
import {
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  getConversationTool,
  setToolPolicyTool,
  setCredentialTool,
  modifyAgentTool,
  listConversationsTool,
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
  const toolRegistry = new ToolRegistry();
  // Register mock tools so composeTools has tool names to work with
  for (const name of ['communicate', 'list_participants', 'list_tools', 'get_participant', 'list_conversations', 'get_conversation']) {
    toolRegistry.register({
      name,
      description: `mock ${name}`,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ status: 'success', data: null }),
    });
  }
  const context = {
    participant: collective.getOrThrow('operator'),
    collective,
    conversationStore,
    storage,
    toolRegistry,
    workspaceRoot: '/tmp',
  } as unknown as ToolContext;
  return { context, collective, conversationStore, storage, toolRegistry };
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
  const conversationStore = new FileConversationStore(deps.storage);
  const context = {
    participant: deps.collective.getOrThrow('operator'),
    collective: deps.collective,
    workspaceRoot: '/tmp',
    storage: deps.storage,
    toolRegistry: deps.toolRegistry,
    providerRegistry: deps.providerRegistry,
    runtimeRegistry: deps.runtimeRegistry,
    conversationStore,
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

  it('get_participant returns full config for an agent', async () => {
    const { context } = await makeContext();
    // Create an agent via the tool
    await createAgentTool.execute(
      {
        id: 'test-agent',
        name: 'Test Agent',
        systemPrompt: 'You are a test agent.',
        model: { provider: 'openai-compatible', model: 'gpt-4o' },
        toolPolicies: { communicate: 'auto' },
        defaultPolicy: 'auto',
      },
      context,
    );

    const result = await getParticipantTool.execute({ id: 'test-agent' }, context);
    expect(result.status).toBe('success');
    const data = result.data as Record<string, unknown>;
    expect(data.id).toBe('test-agent');
    expect(data.name).toBe('Test Agent');
    expect(data.type).toBe('agent');
    expect((data as any).model).toEqual({ provider: 'openai-compatible', model: 'gpt-4o' });
    expect((data as any).systemPrompt).toBe('You are a test agent.');
  });

  it('get_participant returns error for unknown id', async () => {
    const { context } = await makeContext();
    const result = await getParticipantTool.execute({ id: 'nonexistent' }, context);
    expect(result.status).toBe('error');
  });

  it('create_agent persists agent config to collective (not agents/ file)', async () => {
    const { context, collective, storage } = await makeContext();
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
    // Collective record should exist with full config
    const p = collective.get('bot-1') as any;
    expect(p).toBeDefined();
    expect(p.model).toEqual({ provider: 'openai', model: 'gpt-4o' });
    // No agents/ file should be written
    const agentsFiles = await storage.list('agents/');
    expect(agentsFiles).toHaveLength(0);
  });

  it('create_agent persists to collective only (no agents/ file)', async () => {
    const { context, collective, storage } = await makeContext();
    const result = await createAgentTool.execute(
      {
        id: 'src-agent',
        name: 'Source Agent',
        systemPrompt: 'You are helpful.',
        model: { provider: 'openai-compatible', model: 'gpt-4o' },
        defaultPolicy: 'auto',
        toolPolicies: { communicate: 'auto' },
      },
      context,
    );
    expect(result.status).toBe('success');

    // Collective record exists
    const p = collective.get('src-agent');
    expect(p).toBeDefined();
    expect(p!.name).toBe('Source Agent');
    expect((p as any).model).toEqual({ provider: 'openai-compatible', model: 'gpt-4o' });

    // No agents/ file should be written
    const agentsFile = await storage.readJson('agents/src-agent.json').catch(() => null);
    expect(agentsFile).toBeNull();
  });

  it('create_agent composes tools from defaultPolicy + toolPolicies', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      {
        id: 'policy-agent',
        name: 'Policy Agent',
        systemPrompt: 'You are helpful.',
        model: { provider: 'openai-compatible', model: 'gpt-4o' },
        defaultPolicy: 'require-approval',
        toolPolicies: { communicate: 'allow' },
      },
      context,
    );
    const p = collective.get('policy-agent') as any;
    // communicate should be 'auto' (allow → auto mapping)
    expect(p.tools['communicate']).toBe('auto');
    // Other tools should default to 'requires_approval'
    expect(p.tools['list_participants']).toBe('requires_approval');
  });
});

describe('modify_agent', () => {
  it('updates model and systemPrompt in collective record', async () => {
    const deps = await buildTestDeps({});
    const createResult = (await invokeManagementTool(
      'create_agent',
      {
        id: 'bot-1',
        name: 'bot-1',
        model: { provider: 'openai', model: 'gpt-4o' },
        systemPrompt: '',
        defaultPolicy: 'auto',
      },
      deps,
    )) as { status: string; data: { id: string } };
    const { id } = createResult.data;
    await invokeManagementTool(
      'modify_agent',
      {
        id,
        model: { provider: 'openai', model: 'gpt-4o-mini' },
        systemPrompt: 'Be concise.',
      },
      deps,
    );
    const p = deps.collective.get(id) as any;
    expect(p.model).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(p.systemPrompt).toBe('Be concise.');
  });

  it('modify_agent updates the collective record (not agents/ file)', async () => {
    const { context, collective } = await makeContext();
    // Create first
    await createAgentTool.execute(
      {
        id: 'mod-agent',
        name: 'Before',
        systemPrompt: 'Original prompt.',
        model: { provider: 'openai-compatible', model: 'gpt-4o' },
        defaultPolicy: 'auto',
      },
      context,
    );
    // Modify
    const result = await modifyAgentTool.execute(
      {
        id: 'mod-agent',
        name: 'After',
        model: { provider: 'anthropic', model: 'claude-3' },
        systemPrompt: 'Updated prompt.',
        maxIterations: 10,
        defaultPolicy: 'deny',
        toolPolicies: { communicate: 'allow' },
      },
      context,
    );
    expect(result.status).toBe('success');

    const p = collective.get('mod-agent') as any;
    expect(p.name).toBe('After');
    expect(p.model).toEqual({ provider: 'anthropic', model: 'claude-3' });
    expect(p.systemPrompt).toBe('Updated prompt.');
    expect(p.maxIterations).toBe(10);
    expect(p.tools['communicate']).toBe('auto'); // override
    expect(p.tools['list_participants']).toBe('deny'); // default
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

  it('modify_agent with new defaultPolicy re-baselines all non-overridden tools', async () => {
    const { context, collective } = await makeContext();
    // Create with defaultPolicy 'auto'
    await createAgentTool.execute(
      {
        id: 'rebase-agent',
        name: 'Rebase Agent',
        systemPrompt: 'Test.',
        model: { provider: 'openai-compatible', model: 'gpt-4o' },
        defaultPolicy: 'auto',
      },
      context,
    );
    // All tools should be 'auto'
    let p = collective.get('rebase-agent') as any;
    expect(p.tools['communicate']).toBe('auto');
    expect(p.tools['list_participants']).toBe('auto');

    // Modify with new defaultPolicy 'deny' — should re-baseline
    await modifyAgentTool.execute(
      {
        id: 'rebase-agent',
        defaultPolicy: 'deny',
      },
      context,
    );
    p = collective.get('rebase-agent') as any;
    expect(p.tools['communicate']).toBe('deny');
    expect(p.tools['list_participants']).toBe('deny');
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
    expect((result as { status: string; data: { conversations: unknown[] } }).data.conversations).toEqual([]);
  });

  it('returns summaries for stored conversations', async () => {
    const storage = new MemoryStorage();
    const conversationStore = new FileConversationStore(storage);
    const conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {
        m1: {
          id: 'm1',
          parentId: null,
          conversationId: '',
          senderId: 'a',
          recipientId: 'b',
          role: 'user',
          content: 'hi',
          status: 'active',
          timestamp: new Date().toISOString(),
        },
      },
    });
    const deps = await buildTestDeps({ storage });
    const result = await invokeManagementTool('list_conversations', {}, deps);
    expect((result as { status: string; data: { conversations: { id: string }[] } }).data.conversations[0]?.id).toBe(conv.id);
  });

  it('filters by participantId', async () => {
    const storage = new MemoryStorage();
    const conversationStore = new FileConversationStore(storage);

    const conv1 = await conversationStore.create();
    await conversationStore.appendMessage(conv1.id, {
      id: 'm1',
      parentId: null,
      conversationId: conv1.id,
      senderId: 'operator',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: new Date().toISOString(),
    });

    const conv2 = await conversationStore.create();
    await conversationStore.appendMessage(conv2.id, {
      id: 'm2',
      parentId: null,
      conversationId: conv2.id,
      senderId: 'agent-1',
      recipientId: 'agent-2',
      role: 'user',
      content: 'internal',
      status: 'active',
      timestamp: new Date().toISOString(),
    });

    const deps = await buildTestDeps({ storage });
    const result = await invokeManagementTool('list_conversations', { participantId: 'operator' }, deps);
    expect(result.status).toBe('success');
    const conversations = (result as { status: string; data: { conversations: { id: string; participants: string[] }[] } }).data.conversations;
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(conv1.id);
    expect(conversations[0].participants).toContain('operator');
  });
});
