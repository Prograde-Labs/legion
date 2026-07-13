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
  modifyConversationTool,
  listConversationsTool,
  deleteConversationTool,
  queryUsageTool,
  listModelsTool,
  setParticipantMiddlewareTool,
  managementTools,
} from './management-tools.js';
import type { AgentConfig, MessageUsage, MiddlewareInstanceConfig } from '@legion/types';
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
      'modify_conversation',
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

  it('create_agent validates enabled middleware and persists a cloned revision-zero list', async () => {
    const { context, collective, storage } = await makeContext();
    const validate = vi.fn().mockResolvedValue(undefined);
    const middleware: MiddlewareInstanceConfig[] = [
      { id: 'audit', type: 'audit-log', config: { nested: { value: 1 } } },
      { id: 'later', type: 'unavailable', enabled: false, config: {} },
    ];

    const result = await createAgentTool.execute(
      {
        id: 'middleware-agent',
        name: 'Middleware Agent',
        systemPrompt: 'test',
        model: { model: 'test-model' },
        middleware,
      },
      { ...context, middlewareValidator: { validate } } as ToolContext,
    );

    expect(result.status).toBe('success');
    expect(validate).toHaveBeenCalledWith([middleware[0]]);
    middleware[0].config.nested = { value: 2 };
    expect(collective.get('middleware-agent')).toEqual(
      expect.objectContaining({
        middleware: [
          { id: 'audit', type: 'audit-log', config: { nested: { value: 1 } } },
          { id: 'later', type: 'unavailable', enabled: false, config: {} },
        ],
        middlewareRevision: 0,
      }),
    );
    expect(await storage.readJson('collective/participants/middleware-agent.json')).toEqual(
      expect.objectContaining({ middlewareRevision: 0 }),
    );
  });

  it('create_agent rejects non-array middleware without adding a participant', async () => {
    const { context, collective } = await makeContext();

    const result = await createAgentTool.execute(
      {
        id: 'bad-middleware-agent',
        name: 'Bad Middleware Agent',
        systemPrompt: 'test',
        model: { model: 'test-model' },
        middleware: {},
      },
      context,
    );

    expect(result).toEqual({
      status: 'error',
      error: 'middleware must be an array when provided',
    });
    expect(collective.get('bad-middleware-agent')).toBeUndefined();
  });

  it('list_participants returns the roster', async () => {
    const { context } = await makeContext();
    const result = await listParticipantsTool.execute({}, context);
    expect(result.status).toBe('success');
    expect((result.data as { id: string }[]).some((p) => p.id === 'operator')).toBe(true);
  });

  it('list_participants exposes effective middleware defaults', async () => {
    const { context } = await makeContext();
    const result = await listParticipantsTool.execute({}, context);

    expect(result.status).toBe('success');
    expect(result.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'operator', middleware: [], middlewareRevision: 0 }),
      ]),
    );
  });

  it('list_participants returns detached full middleware configuration', async () => {
    const { context, collective } = await makeContext();
    await collective.add({
      id: 'listed-agent',
      name: 'Listed Agent',
      type: 'agent',
      tools: {},
      systemPrompt: 'test',
      model: { model: 'test' },
      maxIterations: 20,
      middleware: [
        { id: 'listed', type: 'audit', enabled: false, config: { nested: { value: 1 } } },
      ],
      middlewareRevision: 3,
    });

    const result = await listParticipantsTool.execute({}, context);
    const listed = (
      result.data as Array<{ id: string; middleware: MiddlewareInstanceConfig[] }>
    ).find(({ id }) => id === 'listed-agent')!;
    listed.middleware[0].config.nested = { value: 9 };

    expect(collective.get('listed-agent')?.middleware?.[0].config).toEqual({
      nested: { value: 1 },
    });
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

  it('modify_conversation atomically updates caller title, status, and tags', async () => {
    const { context, conversationStore } = await makeContext();
    const conversation = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      tags: ['keep', 'remove'],
    });

    const result = await modifyConversationTool.execute(
      {
        conversationId: conversation.id,
        title: 'Operator title',
        titleScope: 'participant',
        participantId: 'other',
        status: 'archived',
        addTags: ['added'],
        removeTags: ['remove'],
      },
      context,
    );

    expect(result.status).toBe('success');
    const updated = result.data as {
      title?: string;
      sharedTitle?: string;
      titles?: Record<string, string>;
      status?: string;
      tags?: string[];
    };
    expect(updated.title).toBe('Operator title');
    expect(updated.sharedTitle).toBeUndefined();
    expect(updated.titles).toEqual({ operator: 'Operator title' });
    expect(updated.status).toBe('archived');
    expect(updated.tags).toEqual(['keep', 'added']);
    expect(await conversationStore.load(conversation.id)).toEqual(
      expect.objectContaining({
        titles: { operator: 'Operator title' },
        status: 'archived',
        tags: ['keep', 'added'],
      }),
    );
  });

  it('modify_conversation returns metadata without messages or middleware state', async () => {
    const { context, conversationStore } = await makeContext();
    const conversation = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: 'secret-message',
      title: 'Shared title',
      titles: { operator: 'Operator title' },
      tags: ['private'],
      origin: { kind: 'participant', participantId: 'operator' },
      middlewareState: { operator: { secrets: { token: 'hidden' } } },
      messages: {
        'secret-message': {
          id: 'secret-message',
          parentId: null,
          conversationId: '',
          senderId: 'operator',
          recipientId: 'agent-x',
          role: 'user',
          content: 'secret content',
          status: 'active',
          timestamp: new Date().toISOString(),
        },
      },
    });

    const result = await modifyConversationTool.execute(
      { conversationId: conversation.id, status: 'archived' },
      context,
    );

    expect(result).toEqual({
      status: 'success',
      data: {
        id: conversation.id,
        title: 'Operator title',
        sharedTitle: 'Shared title',
        titles: { operator: 'Operator title' },
        status: 'archived',
        tags: ['private'],
        origin: { kind: 'participant', participantId: 'operator' },
      },
    });
    expect(result.data).not.toHaveProperty('messages');
    expect(result.data).not.toHaveProperty('middlewareState');
  });

  it('modify_conversation first-write-wins is atomic for concurrent shared titles', async () => {
    const { context, conversationStore } = await makeContext();
    const conversation = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    await Promise.all(
      ['Candidate A', 'Candidate B'].map((title) =>
        modifyConversationTool.execute(
          {
            conversationId: conversation.id,
            title,
            titleScope: 'shared',
            titleMode: 'first_write_wins',
          },
          context,
        ),
      ),
    );

    const stored = await conversationStore.load(conversation.id);
    expect(['Candidate A', 'Candidate B']).toContain(stored?.title);
    const winner = stored?.title;
    await modifyConversationTool.execute(
      {
        conversationId: conversation.id,
        title: 'Late candidate',
        titleMode: 'first_write_wins',
      },
      context,
    );
    expect((await conversationStore.load(conversation.id))?.title).toBe(winner);
  });

  it('modify_conversation rejects invalid args and missing store', async () => {
    const { context } = await makeContext();

    const invalid = await modifyConversationTool.execute(
      {
        conversationId: 42,
        title: null,
        titleScope: 'caller',
        titleMode: 'eventually',
        status: 'deleted',
        addTags: ['valid', 1],
        removeTags: 'tag',
      },
      context,
    );
    expect(invalid.status).toBe('error');
    expect(invalid.error).toContain('Invalid modify_conversation arguments');

    const missingStore = await modifyConversationTool.execute({ conversationId: 'conv-1' }, {
      ...context,
      conversationStore: undefined,
    } as unknown as ToolContext);
    expect(missingStore).toEqual({
      status: 'error',
      error: 'conversationStore unavailable in context',
    });
  });

  it('get_conversation returns detached middleware provenance, parent link, and state', async () => {
    const { context, conversationStore } = await makeContext();
    const parent = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const origin = {
      kind: 'middleware' as const,
      participantId: 'operator',
      middlewareInstanceId: 'audit',
      parentConversationId: 'origin-parent',
      parentMessageId: 'origin-message',
    };
    const middlewareState = { operator: { audit: { enabled: true } } };
    const conversation = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      title: 'Shared title',
      titles: { operator: 'Operator title', other: 'Other title' },
      status: 'archived',
      tags: ['important'],
      origin,
      parentConversationId: parent.id,
      middlewareState,
    });

    const result = await getConversationTool.execute({ conversationId: conversation.id }, context);

    expect(result.status).toBe('success');
    expect(result.data).toEqual(
      expect.objectContaining({
        title: 'Operator title',
        sharedTitle: 'Shared title',
        titles: { operator: 'Operator title', other: 'Other title' },
        status: 'archived',
        tags: ['important'],
        origin,
        parentConversationId: parent.id,
        middlewareState,
      }),
    );

    const data = result.data as {
      origin: { participantId?: string };
      middlewareState: { operator: { audit: { enabled: boolean } } };
    };
    data.origin.participantId = 'mutated';
    data.middlewareState.operator.audit.enabled = false;
    expect(await conversationStore.load(conversation.id)).toEqual(
      expect.objectContaining({ origin, middlewareState }),
    );
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
    await conversationStore.replaceForTesting(conv);

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
    await conversationStore.replaceForTesting(conv);

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
    await conversationStore.replaceForTesting(conv);

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
    await conversationStore.replaceForTesting(conv);

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
    await conversationStore.replaceForTesting(conv);

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
    await conversationStore.replaceForTesting(conv);

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
    await conversationStore.replaceForTesting(conv);

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

  it('compact_conversation identifies its summary after a concurrent same-head addition', async () => {
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
    await conversationStore.replaceForTesting(conv);
    const send = vi.fn().mockImplementation(async () => {
      await conversationStore.mutate(conv.id, (current) => ({
        ...current,
        messages: {
          ...current.messages,
          'concurrent-summary': {
            id: 'concurrent-summary',
            parentId: null,
            conversationId: conv.id,
            senderId: 'other',
            recipientId: 'operator',
            role: 'assistant',
            content: 'concurrent summary',
            type: 'summary',
            status: 'active',
            timestamp: new Date().toISOString(),
          },
        },
      }));
      return {
        conversationId: 'conv-summary',
        status: 'success',
        response: 'owned summary',
      };
    });
    const ctx = {
      ...context,
      messageRouter: { send, resume: vi.fn(), generate: vi.fn() },
    } as unknown as ToolContext;

    const result = await compactConversationTool.execute(
      { conversationId: conv.id, messageIds: ['m1', 'm2'], agentId: 'agent-x' },
      ctx,
    );
    const saved = await conversationStore.load(conv.id);
    const ownedSummary = Object.values(saved!.messages).find(
      (message) => message.type === 'summary' && message.content === 'owned summary',
    );

    expect(result.status).toBe('success');
    expect((result.data as { summaryMessageId: string }).summaryMessageId).toBe(ownedSummary?.id);
    expect(ownedSummary?.id).not.toBe('concurrent-summary');
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
    await conversationStore.replaceForTesting(conv);

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

  it('get_participant returns a detached participant snapshot', async () => {
    const { context, collective } = await makeContext();
    await collective.add({
      id: 'detached-agent',
      name: 'Detached Agent',
      type: 'agent',
      tools: { communicate: 'auto' },
      systemPrompt: 'test',
      model: { model: 'test' },
      maxIterations: 20,
    });

    const result = await getParticipantTool.execute({ id: 'detached-agent' }, context);
    const participant = result.data as AgentConfig;
    participant.name = 'Mutated';
    participant.tools.communicate = 'requires_approval';

    expect(collective.get('detached-agent')).toEqual(
      expect.objectContaining({ name: 'Detached Agent', tools: { communicate: 'auto' } }),
    );
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

describe('participant middleware management', () => {
  async function makeAgentContext() {
    const result = await makeContext();
    await result.collective.add({
      id: 'target-agent',
      name: 'Target Agent',
      type: 'agent',
      systemPrompt: 'test',
      model: { model: 'test-model' },
      tools: {},
      maxIterations: 20,
    });
    return result;
  }

  it('registers set_participant_middleware exactly once with its contract schema', () => {
    const matches = managementTools.filter((tool) => tool.name === 'set_participant_middleware');

    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(setParticipantMiddlewareTool);
    expect(matches[0].parameters).toEqual(
      expect.objectContaining({
        type: 'object',
        required: ['participantId', 'middleware'],
        properties: expect.objectContaining({
          participantId: { type: 'string' },
          middleware: expect.objectContaining({ type: 'array' }),
        }),
      }),
    );
    const schema = matches[0].parameters.properties?.middleware as {
      items: {
        additionalProperties?: boolean;
        properties: {
          id: { minLength?: number; pattern?: string };
          type: { minLength?: number; pattern?: string };
        };
      };
    };
    expect(schema.items.additionalProperties).toBe(false);
    expect(schema.items.properties.id.minLength).toBe(1);
    expect(schema.items.properties.type.minLength).toBe(1);
    expect(schema.items.properties.id.pattern).toBe('\\S');
    expect(schema.items.properties.type.pattern).toBe('\\S');
  });

  it('atomically replaces ordered middleware and increments an absent revision', async () => {
    const { context, collective } = await makeAgentContext();
    const middleware: MiddlewareInstanceConfig[] = [
      { id: 'second', type: 'known', config: { order: 2 } },
      { id: 'first', type: 'known', config: { order: 1 } },
    ];
    const validate = vi.fn().mockResolvedValue(undefined);

    const result = await setParticipantMiddlewareTool.execute(
      { participantId: 'target-agent', middleware },
      { ...context, middlewareValidator: { validate } } as ToolContext,
    );

    expect(result).toEqual({
      status: 'success',
      data: { participantId: 'target-agent', middleware, revision: 1 },
    });
    expect(collective.get('target-agent')).toEqual(
      expect.objectContaining({ middleware, middlewareRevision: 1 }),
    );
  });

  it('serializes concurrent replacements without losing revision increments', async () => {
    const { context, collective } = await makeAgentContext();
    const validator = { validate: vi.fn().mockResolvedValue(undefined) };
    const calls = ['one', 'two'].map((id) =>
      setParticipantMiddlewareTool.execute(
        {
          participantId: 'target-agent',
          middleware: [{ id, type: 'known', config: {} }],
        },
        { ...context, middlewareValidator: validator } as ToolContext,
      ),
    );

    const results = await Promise.all(calls);

    expect(results.map((result) => (result.data as { revision: number }).revision).sort()).toEqual([
      1, 2,
    ]);
    expect(collective.get('target-agent')?.middlewareRevision).toBe(2);
  });

  it('rejects duplicate instance ids before invoking validator', async () => {
    const { context } = await makeAgentContext();
    const validate = vi.fn();

    const result = await setParticipantMiddlewareTool.execute(
      {
        participantId: 'target-agent',
        middleware: [
          { id: 'duplicate', type: 'one', config: {} },
          { id: 'duplicate', type: 'two', config: {} },
        ],
      },
      { ...context, middlewareValidator: { validate } } as ToolContext,
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('duplicate');
    expect(validate).not.toHaveBeenCalled();
  });

  it('persists disabled unavailable middleware without a validator', async () => {
    const { context, collective } = await makeAgentContext();
    const middleware = [{ id: 'future', type: 'not-installed', enabled: false, config: {} }];

    const result = await setParticipantMiddlewareTool.execute(
      { participantId: 'target-agent', middleware },
      context,
    );

    expect(result.status).toBe('success');
    expect(collective.get('target-agent')?.middleware).toEqual(middleware);
  });

  it('fails closed when enabled middleware cannot be validated', async () => {
    const { context, collective } = await makeAgentContext();

    const result = await setParticipantMiddlewareTool.execute(
      {
        participantId: 'target-agent',
        middleware: [{ id: 'active', type: 'known', config: {} }],
      },
      context,
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('validator unavailable');
    expect(collective.get('target-agent')?.middleware).toBeUndefined();
  });

  it('rejects malformed entries and non-JSON config safely', async () => {
    const { context } = await makeAgentContext();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    class CustomConfig {
      value = true;
    }
    const invalidMiddleware: unknown[] = [
      null,
      { id: '', type: 'known', config: {} },
      { id: 'x', type: '', config: {} },
      { id: 'x', type: 'known', enabled: 'yes', config: {} },
      { id: 'x', type: 'known', failureMode: 'maybe', config: {} },
      { id: 'x', type: 'known', config: [] },
      { id: 'x', type: 'known', config: { value: undefined } },
      { id: 'x', type: 'known', config: { value: Number.POSITIVE_INFINITY } },
      { id: 'x', type: 'known', config: { value: 1n } },
      { id: 'x', type: 'known', config: cycle },
      { id: 'x', type: 'known', config: new CustomConfig() },
    ];

    for (const middleware of invalidMiddleware) {
      const result = await setParticipantMiddlewareTool.execute(
        { participantId: 'target-agent', middleware: [middleware] },
        context,
      );
      expect(result.status).toBe('error');
      expect(result.error).toBeTruthy();
    }
  });

  it('rejects sparse and custom-property arrays in middleware config', async () => {
    const { context } = await makeAgentContext();
    const sparse: unknown[] = [];
    sparse.length = 1;
    const withExtra: unknown[] = [];
    (withExtra as unknown as Record<string, unknown>).extra = true;
    const withSymbol: unknown[] = [];
    (withSymbol as unknown as Record<symbol, unknown>)[Symbol('extra')] = true;

    for (const value of [sparse, withExtra, withSymbol]) {
      const result = await setParticipantMiddlewareTool.execute(
        {
          participantId: 'target-agent',
          middleware: [{ id: 'array', type: 'known', enabled: false, config: { value } }],
        },
        context,
      );
      expect(result.status).toBe('error');
    }
  });

  it('rejects malformed top-level middleware arrays without invoking numeric accessors', async () => {
    const { context } = await makeAgentContext();
    const sparse: unknown[] = [];
    sparse.length = 1;
    const withExtra: unknown[] = [];
    (withExtra as unknown as Record<string, unknown>).extra = true;
    const withSymbol: unknown[] = [];
    (withSymbol as unknown as Record<symbol, unknown>)[Symbol('extra')] = true;
    const getter = vi.fn(() => ({ id: 'getter', type: 'known', enabled: false, config: {} }));
    const withAccessor: unknown[] = [];
    Object.defineProperty(withAccessor, '0', { enumerable: true, configurable: true, get: getter });

    for (const middleware of [sparse, withExtra, withSymbol, withAccessor]) {
      const result = await setParticipantMiddlewareTool.execute(
        { participantId: 'target-agent', middleware },
        context,
      );
      expect(result.status).toBe('error');
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('create_agent rejects malformed top-level middleware arrays without invoking getters', async () => {
    const { context, collective } = await makeContext();
    const getter = vi.fn(() => ({ id: 'getter', type: 'known', enabled: false, config: {} }));
    const middleware: unknown[] = [];
    Object.defineProperty(middleware, '0', {
      enumerable: true,
      configurable: true,
      get: getter,
    });

    const result = await createAgentTool.execute(
      {
        id: 'accessor-agent',
        name: 'Accessor Agent',
        systemPrompt: 'test',
        model: { model: 'test' },
        middleware,
      },
      context,
    );

    expect(result.status).toBe('error');
    expect(getter).not.toHaveBeenCalled();
    expect(collective.get('accessor-agent')).toBeUndefined();
  });

  it('rejects accessors without invoking middleware or nested config getters', async () => {
    const { context } = await makeAgentContext();
    const entryGetter = vi.fn(() => 'getter-id');
    const entry = { type: 'known', enabled: false, config: {} } as Record<string, unknown>;
    Object.defineProperty(entry, 'id', { enumerable: true, get: entryGetter });
    const configGetter = vi.fn(() => true);
    const config: Record<string, unknown> = {};
    Object.defineProperty(config, 'secret', { enumerable: true, get: configGetter });

    for (const middleware of [entry, { id: 'nested', type: 'known', enabled: false, config }]) {
      const result = await setParticipantMiddlewareTool.execute(
        { participantId: 'target-agent', middleware: [middleware] },
        context,
      );
      expect(result.status).toBe('error');
    }
    expect(entryGetter).not.toHaveBeenCalled();
    expect(configGetter).not.toHaveBeenCalled();
  });

  it('rejects inherited required fields and unknown string or symbol keys', async () => {
    const { context, collective } = await makeAgentContext();
    const inherited = Object.assign(Object.create({ id: 'inherited' }), {
      type: 'known',
      config: {},
    });
    const unknownCycle: Record<string, unknown> = {};
    unknownCycle.self = unknownCycle;
    const symbol = Symbol('unknown');
    const withSymbol: Record<PropertyKey, unknown> = {
      id: 'symbol',
      type: 'known',
      enabled: false,
      config: {},
      [symbol]: true,
    };

    for (const middleware of [
      inherited,
      { id: 'extra', type: 'known', enabled: false, config: {}, extra: unknownCycle },
      withSymbol,
    ]) {
      const result = await setParticipantMiddlewareTool.execute(
        { participantId: 'target-agent', middleware: [middleware] },
        context,
      );
      expect(result.status).toBe('error');
    }
    expect(collective.get('target-agent')?.middleware).toBeUndefined();
  });

  it('isolates stored middleware from validator and response mutations', async () => {
    const { context, collective } = await makeAgentContext();
    const middleware: MiddlewareInstanceConfig[] = [
      { id: 'isolated', type: 'known', config: { nested: { value: 1 } } },
    ];
    const validator = {
      validate: vi.fn(async (instances: readonly MiddlewareInstanceConfig[]) => {
        instances[0].config.nested = { value: 7 };
      }),
    };

    const result = await setParticipantMiddlewareTool.execute(
      { participantId: 'target-agent', middleware },
      { ...context, middlewareValidator: validator } as ToolContext,
    );
    middleware[0].config.nested = { value: 8 };
    const responseMiddleware = (result.data as { middleware: MiddlewareInstanceConfig[] })
      .middleware;
    responseMiddleware[0].config.nested = { value: 9 };

    expect(collective.get('target-agent')?.middleware?.[0].config).toEqual({
      nested: { value: 1 },
    });
  });

  it('clones replacement middleware before persistence', async () => {
    const { context, collective } = await makeAgentContext();
    const middleware: MiddlewareInstanceConfig[] = [
      { id: 'clone', type: 'known', enabled: false, config: { nested: { value: 1 } } },
    ];

    const result = await setParticipantMiddlewareTool.execute(
      { participantId: 'target-agent', middleware },
      context,
    );
    middleware[0].config.nested = { value: 9 };

    expect(result.status).toBe('success');
    expect(collective.get('target-agent')?.middleware?.[0].config).toEqual({
      nested: { value: 1 },
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

  it('rejects invalid filters and missing store', async () => {
    const { context } = await makeContext();
    const invalid = await listConversationsTool.execute(
      { participantId: 1, since: false, status: 'deleted', tags: ['valid', 2] },
      context,
    );
    expect(invalid.status).toBe('error');
    expect(invalid.error).toContain('Invalid list_conversations arguments');

    const missingStore = await listConversationsTool.execute({}, {
      ...context,
      conversationStore: undefined,
    } as unknown as ToolContext);
    expect(missingStore).toEqual({
      status: 'error',
      error: 'conversationStore unavailable in context',
    });
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

  it('defaults active, supports every-tag and all-status filters, and resolves caller title', async () => {
    const { context, conversationStore } = await makeContext();
    const active = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      title: 'Shared active',
      titles: { operator: 'My active' },
      tags: ['one', 'two'],
    });
    const archived = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      title: 'Shared archived',
      titles: { operator: 'My archived' },
      status: 'archived',
      tags: ['one', 'two'],
    });
    await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      tags: ['one'],
    });

    const defaultResult = await listConversationsTool.execute({}, context);
    const defaultIds = (
      defaultResult.data as { conversations: Array<{ id: string }> }
    ).conversations.map(({ id }) => id);
    expect(defaultIds).toContain(active.id);
    expect(defaultIds).not.toContain(archived.id);

    const filtered = await listConversationsTool.execute(
      { status: 'all', tags: ['one', 'two'] },
      context,
    );
    expect(filtered.status).toBe('success');
    expect(
      (filtered.data as { conversations: Array<{ id: string; title?: string }> }).conversations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: active.id, title: 'My active' }),
        expect.objectContaining({ id: archived.id, title: 'My archived' }),
      ]),
    );
    expect((filtered.data as { conversations: Array<{ id: string }> }).conversations).toHaveLength(
      2,
    );
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

  it('get_conversation resolves sub-thread titles for the caller', async () => {
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
      title: 'Shared child title',
      titles: { operator: 'Operator child title' },
      parentConversationId: parent.id,
      parentToolCallId: 'tc-titled',
    });

    const result = await getConversationTool.execute({ conversationId: parent.id }, context);

    expect(result.status).toBe('success');
    const subThreads = (result.data as { subThreads: Record<string, { title?: string }> })
      .subThreads;
    expect(subThreads['tc-titled'].title).toBe('Operator child title');
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
