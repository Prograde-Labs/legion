import { Collective } from '../collective/Collective.js';
import { appendMessage, compactRange } from '../conversation/conversation-ops.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { MiddlewareCheckpoint } from '@legion/types';
import type { ToolContext } from './Tool.js';
import { createAutomationTools, createCompactConversationTool } from './automation-tools.js';

async function setup() {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  await collective.add({
    id: 'agent',
    name: 'Agent',
    type: 'agent',
    tools: {},
    systemPrompt: 'test',
    model: { model: 'test' },
    maxIterations: 20,
    middleware: [
      {
        id: 'auto-compaction',
        type: 'builtin:auto-compaction',
        config: { summarizerParticipantId: 'summarizer' },
      },
      { id: 'conversation-title', type: 'builtin:conversation-title', config: {} },
    ],
  });
  const conversationStore = new FileConversationStore(storage);
  let parent = await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  for (const [id, role, content] of [
    ['m1', 'user', 'first'],
    ['m2', 'assistant', 'second'],
    ['m3', 'user', 'recent'],
  ] as const) {
    parent = appendMessage(parent, {
      id,
      senderId: role === 'user' ? 'operator' : 'agent',
      recipientId: role === 'user' ? 'agent' : 'operator',
      role,
      content,
    });
  }
  await conversationStore.replaceForTesting(parent);
  const context = {
    participant: collective.getOrThrow('agent'),
    collective,
    conversationId: parent.id,
    conversationStore,
  } as ToolContext;
  const pendingApprovalRegistry = new PendingApprovalRegistry(storage);
  return { context, conversationStore, parent, pendingApprovalRegistry, storage };
}

const args = (conversationId: string, messageIds = ['m1', 'm2']) => ({
  conversationId,
  messageIds,
  middlewareInstanceId: 'auto-compaction',
  parentMessageId: messageIds[messageIds.length - 1],
});

describe('compact_conversation automation tool', () => {
  it('archives helper and compacts parent with its summary watermark', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'success',
      response: 'compressed context',
    });
    const tool = createCompactConversationTool();

    const result = await tool.execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result.status).toBe('success');
    const helperId = send.mock.calls[0][0].conversationId;
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: 'agent',
        recipientId: 'summarizer',
        conversationId: helperId,
        message: expect.stringContaining('user: first'),
      }),
    );
    const helper = await conversationStore.load(helperId);
    expect(helper).toEqual(
      expect.objectContaining({
        status: 'archived',
        tags: ['compaction'],
        origin: {
          kind: 'middleware',
          participantId: 'agent',
          middlewareInstanceId: 'auto-compaction',
          parentConversationId: parent.id,
          parentMessageId: 'm2',
        },
      }),
    );
    const saved = await conversationStore.load(parent.id);
    const summary = Object.values(saved!.messages).find(
      (message) => message.type === 'summary' && message.content === 'compressed context',
    );
    expect(summary?.compacts).toEqual(['m1', 'm2']);
    expect(saved?.middlewareState?.agent?.['auto-compaction']).toEqual({
      summaryMessageId: summary?.id,
    });
    expect(result.data).toEqual({ summaryMessageId: summary?.id });
  });

  it('archives helper without mutating parent when summarizer fails', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'error',
      error: 'summarizer failed',
    });

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result).toEqual({ status: 'error', error: 'summarizer failed' });
    expect((await conversationStore.load(parent.id))?.messages['m1'].status).toBe('active');
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });

  it('fails closed when pending summary lacks a durable continuation', async () => {
    const { context, conversationStore, parent } = await setup();
    const approvalRequests = [{ approvalId: 'appr-summary', tool: 'lookup' }];
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'pending_approval',
      approvalId: 'appr-summary',
      checkpointId: 'checkpoint-summary',
      pendingParticipantId: 'summarizer',
      approvalRequests,
    });

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    const helperId = send.mock.calls[0][0].conversationId;
    expect(result).toEqual({
      status: 'error',
      error: 'Durable middleware continuation unavailable',
    });
    expect((await conversationStore.load(helperId))?.status).toBe('archived');
    expect((await conversationStore.load(parent.id))?.messages['m1'].status).toBe('active');
  });

  it('persists automation continuation before returning helper approval', async () => {
    const { context, conversationStore, parent, pendingApprovalRegistry, storage } = await setup();
    const parentCheckpoint = {
      checkpointId: 'parent-checkpoint',
      operationId: 'parent-operation',
      conversationId: parent.id,
      phase: 'beforeSend',
      participantId: 'agent',
      instanceId: 'auto-compaction',
      middlewareType: 'builtin:auto-compaction',
      middlewareRevision: context.participant.middlewareRevision ?? 0,
      middlewareConfig: { summarizerParticipantId: 'summarizer' },
      nextHookIndex: 1,
      actionCursor: 0,
      draft: { senderId: 'agent', recipientId: 'operator', role: 'assistant', content: 'reply' },
      final: true,
      request: {
        requestId: 'compact-request',
        tool: 'compact_conversation',
        arguments: args(parent.id),
      },
      actions: [],
      observedHead: parent.activeBranchHead,
      createdAt: '2026-01-01T00:00:00.000Z',
    } satisfies MiddlewareCheckpoint;
    const send = vi.fn(
      async ({
        conversationId,
        context: sendContext,
      }: {
        conversationId: string;
        context: ToolContext;
      }) => {
        const helperCheckpoint = {
          ...parentCheckpoint,
          checkpointId: 'helper-checkpoint',
          conversationId,
          participantId: 'summarizer',
          instanceId: 'helper-gate',
          middlewareType: 'test:gate',
          middlewareConfig: {},
          request: { requestId: 'helper-request', tool: 'lookup', arguments: {} },
          observedHead: '',
        };
        const pending = await pendingApprovalRegistry.create(
          {
            conversationId,
            requesterId: 'summarizer',
            tool: 'lookup',
            args: {},
            continuation: { kind: 'middleware', checkpoint: helperCheckpoint },
          },
          sendContext.approvalContinuationSeed,
        );
        return {
          conversationId,
          status: 'pending_approval' as const,
          approvalId: pending.approvalId,
          checkpointId: helperCheckpoint.checkpointId,
          pendingParticipantId: 'summarizer',
        };
      },
    );
    const parentAction = {
      operationId: parentCheckpoint.operationId,
      conversationId: parentCheckpoint.conversationId,
      participantId: parentCheckpoint.participantId,
      instanceId: parentCheckpoint.instanceId,
      requestId: parentCheckpoint.request.requestId,
      tool: parentCheckpoint.request.tool,
      args: parentCheckpoint.request.arguments,
    };
    await pendingApprovalRegistry.claimMiddlewareAction(parentAction);

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
      pendingApprovalRegistry,
      middlewareCheckpoint: parentCheckpoint,
    } as ToolContext);

    expect(result.status).toBe('pending_approval');
    const record = pendingApprovalRegistry.getRecord(result.approvalId!);
    expect(record?.continuation).toMatchObject({
      kind: 'automation_compaction',
      parentConversationId: parent.id,
      helperConversationId: send.mock.calls[0][0].conversationId,
      participantId: 'agent',
      middlewareInstanceId: 'auto-compaction',
      observedParentHead: parent.activeBranchHead,
      selectedMessages: [{ id: 'm1' }, { id: 'm2' }],
      parentMessageId: 'm2',
      parentCheckpoint: { checkpointId: 'parent-checkpoint' },
      helperContinuation: { checkpoint: { checkpointId: 'helper-checkpoint' } },
    });
    const reloaded = await PendingApprovalRegistry.load(storage);
    await expect(reloaded.claimMiddlewareAction(parentAction)).resolves.toEqual({
      kind: 'in_progress',
    });
  });

  it('archives helper when summary router throws a terminal error', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockRejectedValue(new Error('router failed'));

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result).toEqual({ status: 'error', error: 'router failed' });
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });

  it('does not create helper when operation signal is already aborted', async () => {
    const { context, conversationStore, parent } = await setup();
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn();

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
      signal: controller.signal,
    } as ToolContext);

    expect(result.status).toBe('error');
    expect(send).not.toHaveBeenCalled();
    expect(await conversationStore.list({ status: 'all' })).toHaveLength(1);
  });

  it('rejects noncontiguous active prefix before creating helper or sending', async () => {
    const { context, parent } = await setup();
    const send = vi.fn();

    const result = await createCompactConversationTool().execute(args(parent.id, ['m1', 'm3']), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result.status).toBe('error');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not compact again when concurrent compaction keeps active head unchanged', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockImplementation(async () => {
      await conversationStore.mutate(parent.id, (current) =>
        compactRange(current, ['m1', 'm2'], 'concurrent summary'),
      );
      return { conversationId: 'ignored', status: 'success', response: 'stale summary' };
    });

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result.status).toBe('error');
    const saved = await conversationStore.load(parent.id);
    expect(
      Object.values(saved!.messages).filter((message) => message.type === 'summary'),
    ).toHaveLength(1);
    expect(saved?.middlewareState).toBeUndefined();
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });

  it('archives helper without compacting parent when signal aborts during summary', async () => {
    const { context, conversationStore, parent } = await setup();
    const controller = new AbortController();
    const send = vi.fn().mockImplementation(() => {
      controller.abort();
      return { conversationId: 'ignored', status: 'success', response: 'stale summary' };
    });

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
      signal: controller.signal,
    } as ToolContext);

    expect(result.status).toBe('error');
    expect((await conversationStore.load(parent.id))?.messages['m1'].status).toBe('active');
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });

  it('does not compact when selected message changes under unchanged active prefix', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockImplementation(async () => {
      await conversationStore.mutate(parent.id, (current) => ({
        ...current,
        messages: { ...current.messages, m1: { ...current.messages['m1'], content: 'changed' } },
      }));
      return { conversationId: 'ignored', status: 'success', response: 'stale summary' };
    });

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result.status).toBe('error');
    const saved = await conversationStore.load(parent.id);
    expect(saved?.messages['m1'].content).toBe('changed');
    expect(
      Object.values(saved!.messages).filter((message) => message.type === 'summary'),
    ).toHaveLength(0);
    expect(saved?.middlewareState).toBeUndefined();
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });

  it('includes provider-visible tool calls and results but not reasoning in transcript', async () => {
    const { context, conversationStore, parent } = await setup();
    const withToolTurn = {
      ...parent,
      messages: {
        ...parent.messages,
        m2: {
          ...parent.messages['m2'],
          reasoning: 'private chain of thought',
          toolCalls: [
            { id: 'call-1', name: 'lookup', arguments: { query: 'weather' } },
            { id: 'call-2', name: 'lookup', arguments: { query: 'traffic' } },
          ],
          toolResults: [
            { id: 'call-1', name: 'lookup', result: { status: 'success', data: { temp: 72 } } },
            { id: 'call-2', name: 'lookup', result: { status: 'success', data: { eta: 12 } } },
          ],
        },
      },
    };
    await conversationStore.replaceForTesting(withToolTurn);
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'success',
      response: 'compressed context',
    });

    await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    const prompt = send.mock.calls[0][0].message;
    expect(prompt).toContain('assistant: second');
    expect(prompt).toContain('tool_call id=call-1 name=lookup arguments={"query":"weather"}');
    expect(prompt).toContain(
      'tool_result id=call-1 name=lookup result={"status":"success","data":{"temp":72}}',
    );
    expect(prompt).toContain('tool_call id=call-2 name=lookup arguments={"query":"traffic"}');
    expect(prompt).toContain(
      'tool_result id=call-2 name=lookup result={"status":"success","data":{"eta":12}}',
    );
    expect(prompt).not.toContain('private chain of thought');
  });
});

const titleArgs = (
  conversationId: string,
  overrides: Partial<{
    namingParticipantId: string;
    middlewareInstanceId: string;
    parentMessageId: string;
    scope: 'participant' | 'shared';
    attachedParticipantId: string;
    maximumLength: number;
    guidance: string;
  }> = {},
) => ({
  conversationId,
  namingParticipantId: 'namer',
  middlewareInstanceId: 'conversation-title',
  parentMessageId: 'm3',
  scope: 'shared' as const,
  attachedParticipantId: 'agent',
  maximumLength: 80,
  guidance: 'Use concise task-oriented titles.',
  ...overrides,
});

describe('generate_conversation_title automation tool', () => {
  it('fails closed and archives helper when nested title approval is required', async () => {
    const { context, conversationStore, parent, pendingApprovalRegistry } = await setup();
    const parentCheckpoint = {
      checkpointId: 'title-parent-checkpoint',
      operationId: 'title-parent-operation',
      conversationId: parent.id,
      phase: 'beforeSend' as const,
      participantId: 'agent',
      instanceId: 'conversation-title',
      middlewareType: 'builtin:conversation-title',
      middlewareRevision: context.participant.middlewareRevision ?? 0,
      middlewareConfig: {},
      nextHookIndex: 1,
      actionCursor: 0,
      draft: {
        senderId: 'agent',
        recipientId: 'operator',
        role: 'assistant' as const,
        content: 'reply',
      },
      final: true,
      request: {
        requestId: 'title-request',
        tool: 'generate_conversation_title',
        arguments: titleArgs(parent.id),
      },
      actions: [],
      observedHead: parent.activeBranchHead,
      createdAt: '2026-01-01T00:00:00.000Z',
    } satisfies MiddlewareCheckpoint;
    let approvalId: string | undefined;
    const send = vi.fn(
      async ({
        conversationId,
        context: sendContext,
      }: {
        conversationId: string;
        context: ToolContext;
      }) => {
        const helperCheckpoint = {
          ...parentCheckpoint,
          checkpointId: 'title-helper-checkpoint',
          conversationId,
          participantId: 'namer',
          instanceId: 'helper-gate',
          middlewareType: 'test:gate',
          middlewareConfig: {},
          request: { requestId: 'helper-request', tool: 'lookup', arguments: {} },
          observedHead: '',
        };
        const pending = await pendingApprovalRegistry.create(
          {
            conversationId,
            requesterId: 'namer',
            tool: 'lookup',
            args: {},
            continuation: { kind: 'middleware', checkpoint: helperCheckpoint },
          },
          sendContext.approvalContinuationSeed,
        );
        approvalId = pending.approvalId;
        return {
          conversationId,
          status: 'pending_approval' as const,
          approvalId: pending.approvalId,
          checkpointId: helperCheckpoint.checkpointId,
          pendingParticipantId: 'namer',
        };
      },
    );
    await pendingApprovalRegistry.claimMiddlewareAction({
      operationId: parentCheckpoint.operationId,
      conversationId: parent.id,
      participantId: 'agent',
      instanceId: 'conversation-title',
      requestId: 'title-request',
      tool: 'generate_conversation_title',
      args: parentCheckpoint.request.arguments,
    });

    const result = await createAutomationTools().generateConversationTitle.execute(
      titleArgs(parent.id),
      {
        ...context,
        messageRouter: { send },
        pendingApprovalRegistry,
        middlewareCheckpoint: parentCheckpoint,
      } as ToolContext,
    );

    expect(result).toEqual({ status: 'error', error: 'Title generation requires approval' });
    const helperId = send.mock.calls[0][0].conversationId;
    expect((await conversationStore.load(helperId))?.status).toBe('archived');
    expect(approvalId).toBeDefined();
    expect(pendingApprovalRegistry.getRecord(approvalId!)).toMatchObject({
      lifecycle: 'acknowledged',
      decision: { approved: false, message: 'Title generation requires approval' },
      resumeResult: { status: 'rejected', message: 'Title generation requires approval' },
    });
    expect(pendingApprovalRegistry.getRecord(approvalId!)?.continuation).toBeUndefined();
    expect(pendingApprovalRegistry.listPending()).toEqual([]);
    expect((await conversationStore.load(parent.id))?.title).toBeUndefined();
  });

  it('rejects a different conversation before loading or mutating either conversation', async () => {
    const { context, conversationStore, parent } = await setup();
    const load = vi.spyOn(conversationStore, 'load');
    const create = vi.spyOn(conversationStore, 'create');
    const mutate = vi.spyOn(conversationStore, 'mutate');
    const send = vi.fn();

    const result = await createAutomationTools().generateConversationTitle.execute(
      titleArgs('other-conversation'),
      { ...context, messageRouter: { send } } as ToolContext,
    );

    expect(result).toEqual({
      status: 'error',
      error: 'Parent conversation does not match tool context',
    });
    expect(load).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(parent.title).toBeUndefined();
  });

  it('assembles automation tools and archives title helper after writing shared title', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'success',
      response: '  Project status  ',
    });
    const tools = createAutomationTools();

    const result = await tools.generateConversationTitle.execute(titleArgs(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(tools.compactConversation.name).toBe('compact_conversation');
    expect(tools.generateConversationTitle.name).toBe('generate_conversation_title');
    expect(result).toEqual({ status: 'success', data: { title: 'Project status', written: true } });
    const helperId = send.mock.calls[0][0].conversationId;
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: 'agent',
        recipientId: 'namer',
        conversationId: helperId,
        message: expect.stringContaining('user: first'),
      }),
    );
    expect(await conversationStore.load(helperId)).toEqual(
      expect.objectContaining({
        status: 'archived',
        tags: ['conversation-title'],
        origin: {
          kind: 'middleware',
          participantId: 'agent',
          middlewareInstanceId: 'conversation-title',
          parentConversationId: parent.id,
          parentMessageId: 'm3',
        },
      }),
    );
    expect((await conversationStore.load(parent.id))?.title).toBe('Project status');
  });

  it('does not change parent and archives helper for invalid title response', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'success',
      response: 'invalid\ntitle',
    });

    const result = await createAutomationTools().generateConversationTitle.execute(
      titleArgs(parent.id),
      {
        ...context,
        messageRouter: { send },
      } as ToolContext,
    );

    expect(result).toEqual({
      status: 'error',
      error: 'Generated title must be a single nonempty line',
    });
    expect((await conversationStore.load(parent.id))?.title).toBeUndefined();
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });

  it('writes participant title without changing shared title', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'success',
      response: 'Agent-specific title',
    });

    const result = await createAutomationTools().generateConversationTitle.execute(
      titleArgs(parent.id, { scope: 'participant', attachedParticipantId: 'operator' }),
      { ...context, messageRouter: { send } } as ToolContext,
    );

    expect(result).toEqual({
      status: 'success',
      data: { title: 'Agent-specific title', written: true },
    });
    const saved = await conversationStore.load(parent.id);
    expect(saved?.title).toBeUndefined();
    expect(saved?.titles).toEqual({ operator: 'Agent-specific title' });
  });

  it('keeps first concurrently generated title and returns effective title to both calls', async () => {
    const { context, conversationStore, parent } = await setup();
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstSend = true;
    const send = vi.fn().mockImplementation(async () => {
      if (firstSend) {
        firstSend = false;
        await firstStarted;
        return { conversationId: 'ignored', status: 'success', response: 'First title' };
      }
      return { conversationId: 'ignored', status: 'success', response: 'Second title' };
    });
    const tool = createAutomationTools().generateConversationTitle;
    const first = tool.execute(titleArgs(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const second = tool.execute(titleArgs(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(await conversationStore.load(parent.id)).toEqual(
      expect.objectContaining({ title: 'Second title' }),
    );
    expect([firstResult, secondResult]).toEqual(
      expect.arrayContaining([
        { status: 'success', data: { title: 'Second title', written: true } },
        { status: 'success', data: { title: 'Second title', written: false } },
      ]),
    );
  });

  it('returns clear dependency and router failures without title writes', async () => {
    const { context, conversationStore, parent } = await setup();
    const tool = createAutomationTools().generateConversationTitle;

    await expect(tool.execute(titleArgs(parent.id), context)).resolves.toEqual({
      status: 'error',
      error: 'messageRouter unavailable in context',
    });
    const send = vi.fn().mockRejectedValue(new Error('router failed'));
    await expect(
      tool.execute(titleArgs(parent.id), { ...context, messageRouter: { send } } as ToolContext),
    ).resolves.toEqual({ status: 'error', error: 'router failed' });
    expect((await conversationStore.load(parent.id))?.title).toBeUndefined();
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });
});
