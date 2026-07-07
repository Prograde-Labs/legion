import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { appendMessage, compactRange, editMessage } from '../conversation/conversation-ops.js';
import { FileCredentialStore } from '../credentials/FileCredentialStore.js';
import {
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  editMessageTool,
  switchBranchTool,
  pruneMessageTool,
  compactConversationTool,
  generateTool,
  getConversationTool,
  setToolPolicyTool,
  removeToolPolicyTool,
  setCredentialTool,
  modifyAgentTool,
  listConversationsTool,
  deleteConversationTool,
  queryUsageTool,
  listModelsTool,
  managementTools,
} from './management-tools.js';
import type { MessageUsage } from '@legion/types';
import type { ToolContext } from './Tool.js';
import { ToolRegistry } from './ToolRegistry.js';
import { RuntimeRegistry } from '../runtime/RuntimeRegistry.js';

async function makeContext() {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const conversationStore = new FileConversationStore(storage);
  const toolRegistry = new ToolRegistry();
  // Register mock tools in the registry
  for (const name of [
    'communicate',
    'list_participants',
    'list_tools',
    'get_participant',
    'list_conversations',
    'get_conversation',
  ]) {
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
    runtimeRegistry: new RuntimeRegistry(),
  };
}

async function invokeManagementTool(name: string, args: unknown, deps: TestDeps): Promise<unknown> {
  const tool = deps.toolRegistry.get(name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  const conversationStore = new FileConversationStore(deps.storage);
  const context = {
    participant: deps.collective.getOrThrow('operator'),
    collective: deps.collective,
    workspaceRoot: '/tmp',
    storage: deps.storage,
    toolRegistry: deps.toolRegistry,
    runtimeRegistry: deps.runtimeRegistry,
    conversationStore,
  } as unknown as ToolContext;
  return await tool.execute(args, context);
}

describe('management tools', () => {
  it('registers conversation editing tools', () => {
    const names = managementTools.map((tool) => tool.name);
    const conversationEditingTools = [
      'edit_message',
      'prune_message',
      'compact_conversation',
      'generate',
      'switch_branch',
    ];

    expect(names).toEqual(expect.arrayContaining(conversationEditingTools));
    for (const name of conversationEditingTools) {
      expect(names.filter((toolName) => toolName === name)).toHaveLength(1);
    }
  });

  it('create_agent adds a new agent participant', async () => {
    const { context, collective } = await makeContext();
    const result = await createAgentTool.execute(
      {
        id: 'agent-x',
        name: 'X',
        systemPrompt: 'be helpful',
        model: { model: 'gpt-4o-mini' },
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
        model: { model: 'm' },
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
        model: { model: 'm' },
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

  it('get_conversation returns superseded siblings as alternates', async () => {
    const { context, conversationStore } = await makeContext();
    let conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    conv = appendMessage(conv, {
      id: 'm1',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'original',
    });
    conv = editMessage(conv, 'm1', 'edited');
    await conversationStore.save(conv);

    const result = await getConversationTool.execute({ conversationId: conv.id }, context);

    expect(result.status).toBe('success');
    const messages = (
      result.data as { messages: Array<{ content: string; alternates?: unknown[] }> }
    ).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('edited');
    expect(messages[0].alternates).toEqual([
      {
        id: 'm1',
        content: 'original',
        timestamp: conv.messages['m1'].timestamp,
        status: 'superseded',
      },
    ]);
  });

  it('edit_message creates edited branch and saves it', async () => {
    const { context, conversationStore } = await makeContext();
    let conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    conv = appendMessage(conv, {
      id: 'm1',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'before',
    });
    await conversationStore.save(conv);

    const result = await editMessageTool.execute(
      { conversationId: conv.id, messageId: 'm1', newContent: 'after' },
      context,
    );

    expect(result.status).toBe('success');
    const data = result.data as { newMessageId: string; activeBranchHead: string };
    expect(data.activeBranchHead).toBe(data.newMessageId);
    const saved = await conversationStore.load(conv.id);
    expect(saved?.messages['m1'].status).toBe('superseded');
    expect(saved?.messages[data.newMessageId].content).toBe('after');
    expect(saved?.messages[data.newMessageId].editOf).toBe('m1');
  });

  it('edit_message rejects invalid args', async () => {
    const { context } = await makeContext();

    const result = await editMessageTool.execute(
      { conversationId: 123, messageId: 'm1', newContent: 'after' },
      context,
    );

    expect(result).toEqual({
      status: 'error',
      error: 'conversationId, messageId, and newContent must be strings',
    });
  });

  it('switch_branch activates an edited sibling and its active descendants', async () => {
    const { context, conversationStore } = await makeContext();
    let conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    conv = appendMessage(conv, {
      id: 'm1',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'original',
    });
    conv = appendMessage(conv, {
      id: 'm2',
      senderId: 'agent-x',
      recipientId: 'operator',
      role: 'assistant',
      content: 'original response',
    });
    conv = editMessage(conv, 'm1', 'edited');
    const editedId = conv.activeBranchHead;
    conv = appendMessage(conv, {
      id: 'm3',
      senderId: 'agent-x',
      recipientId: 'operator',
      role: 'assistant',
      content: 'edited response',
    });
    await conversationStore.save(conv);

    const result = await switchBranchTool.execute(
      { conversationId: conv.id, messageId: 'm1' },
      context,
    );

    expect(result.status).toBe('success');
    const saved = await conversationStore.load(conv.id);
    expect(saved?.messages['m1'].status).toBe('active');
    expect(saved?.messages['m2'].status).toBe('active');
    expect(saved?.messages[editedId].status).toBe('superseded');
    expect(saved?.activeBranchHead).toBe('m2');
  });

  it('switch_branch restores compacted messages when selecting summary alternate', async () => {
    const { context, conversationStore } = await makeContext();
    let conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    conv = appendMessage(conv, {
      id: 'm1',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'start',
    });
    conv = appendMessage(conv, {
      id: 'm2',
      senderId: 'agent-x',
      recipientId: 'operator',
      role: 'assistant',
      content: 'reply',
    });
    conv = appendMessage(conv, {
      id: 'm3',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'after',
    });
    conv = compactRange(conv, ['m1', 'm2'], 'summary');
    const summary = Object.values(conv.messages).find((m) => m.type === 'summary');
    await conversationStore.save(conv);

    const result = await switchBranchTool.execute(
      { conversationId: conv.id, messageId: 'm1' },
      context,
    );

    expect(result.status).toBe('success');
    const saved = await conversationStore.load(conv.id);
    expect(saved?.messages['m1'].status).toBe('active');
    expect(saved?.messages['m2'].status).toBe('active');
    expect(saved?.messages[summary!.id].status).toBe('superseded');
    expect(saved?.messages['m3'].parentId).toBe('m2');
    expect(saved?.activeBranchHead).toBe('m3');
  });

  it('switch_branch rejects invalid args', async () => {
    const { context } = await makeContext();

    const result = await switchBranchTool.execute(
      { conversationId: 123, messageId: 'm1' },
      context,
    );

    expect(result).toEqual({
      status: 'error',
      error: 'conversationId and messageId must be strings',
    });
  });

  it('prune_message prunes a message and saves the new head', async () => {
    const { context, conversationStore } = await makeContext();
    let conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    conv = appendMessage(conv, {
      id: 'm1',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'prompt',
    });
    conv = appendMessage(conv, {
      id: 'm2',
      senderId: 'agent-x',
      recipientId: 'operator',
      role: 'assistant',
      content: 'answer',
    });
    await conversationStore.save(conv);

    const result = await pruneMessageTool.execute(
      { conversationId: conv.id, messageId: 'm2' },
      context,
    );

    expect(result.status).toBe('success');
    expect(result.data).toEqual({ activeBranchHead: 'm1' });
    const saved = await conversationStore.load(conv.id);
    expect(saved?.activeBranchHead).toBe('m1');
    expect(saved?.messages['m2'].status).toBe('pruned');
    expect(saved?.messages['m2'].prunedBy).toBe('operator');
  });

  it('prune_message cascade-prunes descendants when pruning a middle message', async () => {
    const { context, conversationStore } = await makeContext();
    let conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    conv = appendMessage(conv, {
      id: 'm1',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'hello',
    });
    conv = appendMessage(conv, {
      id: 'm2',
      senderId: 'agent-x',
      recipientId: 'operator',
      role: 'assistant',
      content: 'hi',
    });
    conv = appendMessage(conv, {
      id: 'm3',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'follow-up',
    });
    await conversationStore.save(conv);

    // Prune m2 (middle of chain) — m3 should also be pruned
    const result = await pruneMessageTool.execute(
      { conversationId: conv.id, messageId: 'm2' },
      context,
    );

    expect(result.status).toBe('success');
    expect(result.data).toEqual({ activeBranchHead: 'm1' });
    const saved = await conversationStore.load(conv.id);
    expect(saved?.activeBranchHead).toBe('m1');
    expect(saved?.messages['m2'].status).toBe('pruned');
    expect(saved?.messages['m3'].status).toBe('pruned');
  });

  it('prune_message rejects invalid args', async () => {
    const { context } = await makeContext();

    const result = await pruneMessageTool.execute(
      { conversationId: 123, messageId: 'm2' },
      context,
    );

    expect(result).toEqual({
      status: 'error',
      error: 'conversationId and messageId must be strings',
    });
  });

  it('compact_conversation summarizes through messageRouter and compacts messages', async () => {
    const { context, conversationStore } = await makeContext();
    const send = vi.fn().mockResolvedValue({
      conversationId: 'conv-summary',
      status: 'success',
      response: 'short summary',
    });
    const ctx = {
      ...context,
      messageRouter: { send, resume: vi.fn(), generate: vi.fn() },
    } as unknown as ToolContext;
    let conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    conv = appendMessage(conv, {
      id: 'm1',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'hello',
    });
    conv = appendMessage(conv, {
      id: 'm2',
      senderId: 'agent-x',
      recipientId: 'operator',
      role: 'assistant',
      content: 'hi',
    });
    conv = appendMessage(conv, {
      id: 'old-summary',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'assistant',
      content: 'stale summary',
      type: 'summary',
    });
    conv = {
      ...conv,
      activeBranchHead: 'm2',
      messages: {
        ...conv.messages,
        'old-summary': { ...conv.messages['old-summary'], compacts: ['m1', 'm2'] },
      },
    };
    await conversationStore.save(conv);

    const result = await compactConversationTool.execute(
      { conversationId: conv.id, messageIds: ['m1', 'm2'], agentId: 'agent-x' },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: 'operator',
        recipientId: 'agent-x',
        replyTo: undefined,
      }),
    );
    expect(send).toHaveBeenCalledWith(expect.not.objectContaining({ conversationId: conv.id }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Summarize the following conversation segment concisely.'),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('user: hello') }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('assistant: hi') }),
    );
    const saved = await conversationStore.load(conv.id);
    const summary = Object.values(saved!.messages).find(
      (m) => m.type === 'summary' && m.content === 'short summary',
    );
    expect(summary?.content).toBe('short summary');
    expect(summary?.compacts).toEqual(['m1', 'm2']);
    expect(result.data).toEqual({
      summaryMessageId: summary?.id,
      activeBranchHead: saved?.activeBranchHead,
    });
  });

  it('compact_conversation rejects invalid args', async () => {
    const { context } = await makeContext();

    const result = await compactConversationTool.execute(
      { conversationId: 123, messageIds: [], agentId: '', instruction: 42 },
      context,
    );

    expect(result).toEqual({
      status: 'error',
      error:
        'conversationId must be a string, messageIds must be a non-empty string array, agentId must be a string, and instruction must be a string when provided',
    });
  });

  it('generate delegates to messageRouter.generate', async () => {
    const { context } = await makeContext();
    await createAgentTool.execute(
      {
        id: 'agent-x',
        name: 'X',
        systemPrompt: 's',
        model: { model: 'm' },
        tools: {},
      },
      context,
    );
    const generate = vi.fn().mockResolvedValue({ conversationId: 'c1', status: 'dispatched' });
    const ctx = {
      ...context,
      messageRouter: { send: vi.fn(), resume: vi.fn(), generate },
    } as unknown as ToolContext;

    const result = await generateTool.execute({ conversationId: 'c1', agentId: 'agent-x' }, ctx);

    expect(result.status).toBe('success');
    expect(result.data).toEqual({ status: 'success' });
    expect(generate).toHaveBeenCalledWith('c1', 'agent-x', ctx);
  });

  it('generate rejects invalid args', async () => {
    const { context } = await makeContext();

    const result = await generateTool.execute({ conversationId: 123, agentId: null }, context);

    expect(result).toEqual({
      status: 'error',
      error: 'conversationId and agentId must be strings',
    });
  });

  it('get_conversation returns first compacted message as summary alternate', async () => {
    const { context, conversationStore } = await makeContext();
    let conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    conv = appendMessage(conv, {
      id: 'm1',
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'start',
    });
    conv = appendMessage(conv, {
      id: 'm2',
      senderId: 'agent-x',
      recipientId: 'operator',
      role: 'assistant',
      content: 'reply',
    });
    conv = compactRange(conv, ['m1', 'm2'], 'summary');
    await conversationStore.save(conv);

    const result = await getConversationTool.execute({ conversationId: conv.id }, context);

    expect(result.status).toBe('success');
    const messages = (result.data as { messages: Array<{ type?: string; alternates?: unknown[] }> })
      .messages;
    expect(messages[0].type).toBe('summary');
    expect(messages[0].alternates).toEqual([
      { id: 'm1', content: 'start', timestamp: conv.messages['m1'].timestamp, status: 'compacted' },
    ]);
  });

  it('create_agent rejects a duplicate id with a tool error', async () => {
    const { context } = await makeContext();
    const args = {
      id: 'operator',
      name: 'dup',
      systemPrompt: 's',
      model: { model: 'm' },
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
        model: { model: 'gpt-4o' },
        tools: { communicate: 'auto' },
      },
      context,
    );

    const result = await getParticipantTool.execute({ id: 'test-agent' }, context);
    expect(result.status).toBe('success');
    const data = result.data as Record<string, unknown>;
    expect(data.id).toBe('test-agent');
    expect(data.name).toBe('Test Agent');
    expect(data.type).toBe('agent');
    expect((data as any).model).toEqual({ model: 'gpt-4o' });
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
        model: { model: 'gpt-4o' },
        systemPrompt: '',
        tools: {},
      },
      context,
    );
    // Collective record should exist with full config
    const p = collective.get('bot-1') as any;
    expect(p).toBeDefined();
    expect(p.model).toEqual({ model: 'gpt-4o' });
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
        model: { model: 'gpt-4o' },
        tools: { communicate: 'auto' },
      },
      context,
    );
    expect(result.status).toBe('success');

    // Collective record exists
    const p = collective.get('src-agent');
    expect(p).toBeDefined();
    expect(p!.name).toBe('Source Agent');
    expect((p as any).model).toEqual({ model: 'gpt-4o' });

    // No agents/ file should be written
    const agentsFile = await storage.readJson('agents/src-agent.json').catch(() => null);
    expect(agentsFile).toBeNull();
  });

  it('create_agent ignores stale extra model fields', async () => {
    const { context, collective } = await makeContext();
    const result = await createAgentTool.execute(
      {
        id: 'clean-model-agent',
        name: 'Clean Model Agent',
        systemPrompt: 'You are helpful.',
        model: {
          model: 'gpt-4o',
          temperature: 0.2,
          maxTokens: 100,
          provider: 'openai',
          defaultModel: 'gpt-3.5',
        },
      },
      context,
    );

    expect(result.status).toBe('success');
    expect((collective.get('clean-model-agent') as any).model).toEqual({
      model: 'gpt-4o',
      temperature: 0.2,
      maxTokens: 100,
    });
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
        model: { model: 'gpt-4o' },
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
        model: { model: 'gpt-4o-mini' },
        systemPrompt: 'Be concise.',
      },
      deps,
    );
    const p = deps.collective.get(id) as any;
    expect(p.model).toEqual({ model: 'gpt-4o-mini' });
    expect(p.systemPrompt).toBe('Be concise.');
  });

  it('modify_agent replaces tools map when tools arg is provided', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      {
        id: 'mod-agent',
        name: 'Before',
        systemPrompt: 'Original prompt.',
        model: { model: 'gpt-4o' },
        tools: { communicate: 'auto', list_participants: 'auto' },
      },
      context,
    );
    const result = await modifyAgentTool.execute(
      {
        id: 'mod-agent',
        name: 'After',
        model: { model: 'claude-3' },
        systemPrompt: 'Updated prompt.',
        maxIterations: 10,
        tools: { communicate: 'requires_approval' },
      },
      context,
    );
    expect(result.status).toBe('success');

    const p = collective.get('mod-agent') as any;
    expect(p.name).toBe('After');
    expect(p.model).toEqual({ model: 'claude-3' });
    expect(p.systemPrompt).toBe('Updated prompt.');
    expect(p.maxIterations).toBe(10);
    expect(p.tools['communicate']).toBe('requires_approval');
    expect(p.tools['list_participants']).toBeUndefined(); // replaced, not merged
  });

  it('updates name in Collective', async () => {
    const deps = await buildTestDeps({});
    const createResult = (await invokeManagementTool(
      'create_agent',
      {
        id: 'bot-2',
        name: 'bot-1',
        model: { model: 'gpt-4o' },
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

  it('modify_agent string shorthand removes stale extra model fields', async () => {
    const deps = await buildTestDeps({});
    await deps.collective.add({
      id: 'stale-model-agent',
      name: 'Stale Model Agent',
      type: 'agent',
      systemPrompt: 'Original prompt.',
      model: {
        model: 'old-model',
        temperature: 0.4,
        maxTokens: 200,
        provider: 'old-provider',
        defaultModel: 'old-default',
      } as any,
      tools: {},
      maxIterations: 20,
      status: 'active',
    });

    const result = await invokeManagementTool(
      'modify_agent',
      { id: 'stale-model-agent', model: 'new-model' },
      deps,
    );

    expect((result as { status: string }).status).toBe('success');
    expect((deps.collective.get('stale-model-agent') as any).model).toEqual({
      model: 'new-model',
      temperature: 0.4,
      maxTokens: 200,
    });
  });
});

describe('remove_tool_policy', () => {
  it('removes a tool entry from the participant tools map', async () => {
    const deps = await buildTestDeps({});
    await invokeManagementTool(
      'create_agent',
      {
        id: 'policy-bot',
        name: 'Policy Bot',
        systemPrompt: 'test',
        model: { model: 'gpt-4o' },
        tools: { communicate: 'auto', list_participants: 'requires_approval' },
      },
      deps,
    );
    const result = await invokeManagementTool(
      'remove_tool_policy',
      { participantId: 'policy-bot', tool: 'communicate' },
      deps,
    );
    expect((result as { status: string }).status).toBe('success');
    const p = deps.collective.get('policy-bot') as any;
    expect(p.tools['communicate']).toBeUndefined();
    expect(p.tools['list_participants']).toBe('requires_approval'); // untouched
  });

  it('removing a non-existent tool entry is a no-op (succeeds)', async () => {
    const deps = await buildTestDeps({});
    await invokeManagementTool(
      'create_agent',
      {
        id: 'policy-bot-2',
        name: 'Policy Bot 2',
        systemPrompt: 'test',
        model: { model: 'gpt-4o' },
        tools: {},
      },
      deps,
    );
    const result = await invokeManagementTool(
      'remove_tool_policy',
      { participantId: 'policy-bot-2', tool: 'nonexistent' },
      deps,
    );
    expect((result as { status: string }).status).toBe('success');
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
    expect(
      (result as { status: string; data: { conversations: unknown[] } }).data.conversations,
    ).toEqual([]);
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
    expect(
      (result as { status: string; data: { conversations: { id: string }[] } }).data
        .conversations[0]?.id,
    ).toBe(conv.id);
  });

  it('get_conversation includes subThreads keyed by parentToolCallId', async () => {
    const { context, conversationStore } = await makeContext();
    // Create a parent conversation with a message
    const parent = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await conversationStore.appendMessage(parent.id, {
      id: 'msg-1',
      parentId: null,
      conversationId: parent.id,
      senderId: 'op',
      recipientId: 'agent-a',
      role: 'user',
      content: 'hello',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    await conversationStore.updateHead(parent.id, 'msg-1');

    // Create a child sub-thread
    const child = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: parent.id,
      parentToolCallId: 'tc-delegate',
    });
    await conversationStore.appendMessage(child.id, {
      id: 'child-msg-1',
      parentId: null,
      conversationId: child.id,
      senderId: 'agent-a',
      recipientId: 'agent-b',
      role: 'user',
      content: 'delegated question',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    await conversationStore.updateHead(child.id, 'child-msg-1');

    const result = await getConversationTool.execute({ conversationId: parent.id }, context);
    expect(result.status).toBe('success');
    const data = result.data as {
      id: string;
      subThreads: Record<string, { id: string; messages: unknown[] }>;
    };
    expect(data.id).toBe(parent.id);
    expect(data.subThreads).toBeDefined();
    expect(data.subThreads['tc-delegate']).toBeDefined();
    expect(data.subThreads['tc-delegate'].id).toBe(child.id);
    expect(data.subThreads['tc-delegate'].messages).toHaveLength(1);
  });

  it('list_conversations excludes sub-threads', async () => {
    const { context, conversationStore } = await makeContext();
    const parent = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: parent.id,
      parentToolCallId: 'tc-1',
    });

    const result = await listConversationsTool.execute({}, context);
    expect(result.status).toBe('success');
    const data = result.data as { conversations: { id: string }[] };
    const ids = data.conversations.map((c) => c.id);
    expect(ids).toContain(parent.id);
    // The child should not appear
    expect(ids).toHaveLength(1);
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
    const result = await invokeManagementTool(
      'list_conversations',
      { participantId: 'operator' },
      deps,
    );
    expect(result.status).toBe('success');
    const conversations = (
      result as {
        status: string;
        data: { conversations: { id: string; participants: string[] }[] };
      }
    ).data.conversations;
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(conv1.id);
    expect(conversations[0].participants).toContain('operator');
  });
});

describe('delete_conversation', () => {
  it('removes a conversation from the store', async () => {
    const { context, conversationStore } = await makeContext();
    const conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const result = await deleteConversationTool.execute({ conversationId: conv.id }, context);
    expect(result.status).toBe('success');
    expect(await conversationStore.exists(conv.id)).toBe(false);
  });

  it('cascades to sub-threads', async () => {
    const { context, conversationStore } = await makeContext();
    const parent = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const child = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: parent.id,
      parentToolCallId: 'tc-1',
    });
    const result = await deleteConversationTool.execute({ conversationId: parent.id }, context);
    expect(result.status).toBe('success');
    expect(await conversationStore.exists(parent.id)).toBe(false);
    expect(await conversationStore.exists(child.id)).toBe(false);
    const all = await conversationStore.list({ includeSubThreads: true });
    expect(all.map((c) => c.id)).not.toContain(child.id);
  });

  it('returns success when the id does not exist', async () => {
    const { context } = await makeContext();
    const result = await deleteConversationTool.execute(
      { conversationId: 'conv-missing' },
      context,
    );
    expect(result.status).toBe('success');
  });

  it('returns success data shape { deleted: true }', async () => {
    const { context, conversationStore } = await makeContext();
    const conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const result = await deleteConversationTool.execute({ conversationId: conv.id }, context);
    expect(result.status).toBe('success');
    expect((result as { data: { deleted: boolean } }).data).toEqual({ deleted: true });
  });
});

describe('query_usage tool', () => {
  it('returns zero totals when no conversations exist', async () => {
    const context = await makeContext();
    const result = await queryUsageTool.execute({}, context);
    expect(result).toEqual({
      status: 'success',
      data: {
        totals: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          cost: 0,
          messageCount: 0,
        },
      },
    });
  });

  it('sums usage across conversations', async () => {
    const context = await makeContext();
    const usage: MessageUsage = {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      cost: 0.001,
      modelId: 'gpt-4o',
      providerId: 'openai',
    };
    const conv = await context.conversationStore!.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-1',
      parentId: null,
      conversationId: conv.id,
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-2',
      parentId: 'msg-1',
      conversationId: conv.id,
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'hello',
      status: 'active',
      timestamp: new Date().toISOString(),
      usage,
    });

    const result = await queryUsageTool.execute({}, context);
    expect(result.status).toBe('success');
    const data = (result as { data: { totals: { messageCount: number; input: number } } }).data;
    expect(data.totals.messageCount).toBe(1);
    expect(data.totals.input).toBe(100);
  });

  it('groups by model', async () => {
    const context = await makeContext();
    const usage1: MessageUsage = {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      cost: 0.001,
      modelId: 'gpt-4o',
      providerId: 'openai',
    };
    const usage2: MessageUsage = {
      input: 200,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      cost: 0.005,
      modelId: 'claude-sonnet-4-5',
      providerId: 'anthropic',
    };
    const conv = await context.conversationStore!.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-1',
      parentId: null,
      conversationId: conv.id,
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-2',
      parentId: 'msg-1',
      conversationId: conv.id,
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'r1',
      status: 'active',
      timestamp: new Date().toISOString(),
      usage: usage1,
    });
    await context.conversationStore!.updateMessage(conv.id, 'msg-2', {
      status: 'superseded',
    });
    await context.conversationStore!.updateHead(conv.id, 'msg-1');
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-3',
      parentId: 'msg-1',
      conversationId: conv.id,
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'r2',
      status: 'active',
      timestamp: new Date().toISOString(),
      usage: usage2,
    });

    const result = await queryUsageTool.execute({ groupBy: 'model' }, context);
    expect(result.status).toBe('success');
    const data = (result as { data: { groups: Array<{ key: string; totals: { input: number } }> } })
      .data;
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].key).toBe('claude-sonnet-4-5');
  });
});

describe('list_models tool', () => {
  it('returns an empty array when no providers are available', async () => {
    const context = await makeContext();
    const result = await listModelsTool.execute({}, context);
    expect(result.status).toBe('success');
    expect((result as { data: unknown }).data).toEqual([]);
  });
});
