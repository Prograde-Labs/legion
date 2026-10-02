import type {
  LLMChunk,
  MessageDraft,
  MiddlewareDefinition,
  MiddlewareInstanceConfig,
  MiddlewareLogger,
  ParticipantConfig,
} from '@legion-collective/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { Collective } from '../collective/Collective.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { EventBus } from '../events/EventBus.js';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { MiddlewareLifecycle } from './MiddlewareLifecycle.js';
import { MiddlewareRegistry } from './MiddlewareRegistry.js';
import { MiddlewareRunner } from './MiddlewareRunner.js';

const schema = { type: 'object', additionalProperties: true } as const;

function participant(id: string, middleware: MiddlewareInstanceConfig[] = []): ParticipantConfig {
  return { id, name: id, type: 'mock', tools: {}, responses: [], middleware };
}

function instance(id: string): MiddlewareInstanceConfig {
  return { id, type: 'test:lifecycle', config: {} };
}

async function fixture(participants: ParticipantConfig[]) {
  const storage = new MemoryStorage();
  const eventBus = new EventBus();
  const store = new FileConversationStore(storage, eventBus);
  const data = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
  const thread = new ConversationThread(data, store);
  const collective = new Collective(storage, participants);
  const middlewareRegistry = new MiddlewareRegistry();
  const pendingApprovals = new PendingApprovalRegistry(storage);
  const tools = new ToolRegistry();
  const logger: MiddlewareLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const runner = new MiddlewareRunner({
    registry: middlewareRegistry,
    authEngine: new AuthEngine(),
    toolRegistry: tools,
    pendingApprovals,
    eventBus,
    logger,
    conversationStore: store,
    buildToolContext: (current, activeThread, signal) => ({
      participant: current,
      conversationId: activeThread.id,
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: '/workspace',
      communicationDepth: 0,
      toolRegistry: tools,
      conversation: activeThread,
      signal,
    }),
  });
  return {
    eventBus,
    lifecycle: new MiddlewareLifecycle(runner, eventBus),
    middlewareRegistry,
    pendingApprovals,
    store,
    thread,
    tools,
  };
}

function draft(overrides: Partial<MessageDraft> = {}): MessageDraft {
  return {
    senderId: 'sender',
    recipientId: 'recipient',
    role: 'user',
    content: 'message',
    ...overrides,
  };
}

describe('MiddlewareLifecycle', () => {
  it('runs buffered inbound and response phases in order with composed content', async () => {
    const sender = participant('sender', [instance('sender')]);
    const recipient = participant('recipient', [instance('recipient')]);
    const f = await fixture([sender, recipient]);
    const phases: string[] = [];
    f.eventBus.on('message:sent', ({ senderId }) => phases.push(`persist ${senderId}`));
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Lifecycle',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: {
          beforeSend: (context) => {
            phases.push(`${context.participant.id} beforeSend`);
            return {
              kind: 'continue',
              message: {
                ...context.message,
                content: `${context.message.content}:${context.participant.id}:send`,
              },
            };
          },
          beforeReceive: (context) => {
            phases.push(`${context.participant.id} beforeReceive`);
            return {
              kind: 'continue',
              message: {
                ...context.message,
                content: `${context.message.content}:${context.participant.id}:receive`,
              },
            };
          },
          afterSend: (context) => {
            phases.push(`${context.participant.id} afterSend`);
            return { kind: 'continue' };
          },
          afterReceive: (context) => {
            phases.push(`${context.participant.id} afterReceive ${context.mode}`);
            return { kind: 'continue' };
          },
        },
      } satisfies MiddlewareDefinition,
      'test',
    );

    const inbound = await f.lifecycle.receive({
      operationId: 'route-1',
      sender,
      recipient,
      thread: f.thread,
      draft: draft(),
      actions: [],
      mode: 'pre_runtime',
    });
    expect(inbound.kind).toBe('continue');
    if (inbound.kind !== 'continue') throw new Error('Expected inbound continuation');

    const response = await f.lifecycle.respond({
      operationId: 'route-1',
      sender: recipient,
      recipient: sender,
      thread: f.thread,
      draft: draft({
        senderId: 'recipient',
        recipientId: 'sender',
        role: 'assistant',
        content: 'response',
      }),
      actions: inbound.actions,
    });

    expect(response).toMatchObject({
      status: 'success',
      response: 'response:recipient:send:sender:receive',
    });
    expect(phases).toEqual([
      'sender beforeSend',
      'recipient beforeReceive',
      'persist sender',
      'sender afterSend',
      'recipient afterReceive pre_runtime',
      'recipient beforeSend',
      'sender beforeReceive',
      'persist recipient',
      'recipient afterSend',
      'sender afterReceive post_response',
    ]);
    expect(
      Object.values((await f.store.load(f.thread.id))!.messages).map((message) => message.content),
    ).toEqual(['message:sender:send:recipient:receive', 'response:recipient:send:sender:receive']);
  });

  it('does not append or emit when a before-persistence hook rejects', async () => {
    const sender = participant('sender', [instance('sender')]);
    const recipient = participant('recipient');
    const f = await fixture([sender, recipient]);
    let sent = 0;
    f.eventBus.on('message:sent', () => (sent += 1));
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Reject',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: { beforeSend: () => ({ kind: 'reject', error: 'blocked' }) },
      },
      'test',
    );

    await expect(
      f.lifecycle.receive({
        operationId: 'route-reject',
        sender,
        recipient,
        thread: f.thread,
        draft: draft(),
        actions: [],
        mode: 'pre_runtime',
      }),
    ).resolves.toMatchObject({ kind: 'error', error: 'blocked' });
    expect(sent).toBe(0);
    expect((await f.store.load(f.thread.id))!.messages).toEqual({});
  });

  it.each([
    ['senderId', 'forged-sender'],
    ['recipientId', 'forged-recipient'],
  ] as const)(
    'rejects forged draft %s before hooks, persistence, or events',
    async (field, value) => {
      const sender = participant('sender', [instance('sender')]);
      const recipient = participant('recipient', [instance('recipient')]);
      const f = await fixture([sender, recipient]);
      const beforeSend = vi.fn(() => ({ kind: 'continue' as const }));
      const beforeReceive = vi.fn(() => ({ kind: 'continue' as const }));
      let sent = 0;
      f.eventBus.on('message:sent', () => (sent += 1));
      f.middlewareRegistry.register(
        {
          type: 'test:lifecycle',
          displayName: 'Identity binding',
          defaultFailureMode: 'closed',
          configSchema: schema,
          hooks: { beforeSend, beforeReceive },
        },
        'test',
      );

      await expect(
        f.lifecycle.receive({
          operationId: 'route-forged',
          sender,
          recipient,
          thread: f.thread,
          draft: draft({ [field]: value }),
          actions: [],
          mode: 'pre_runtime',
        }),
      ).resolves.toMatchObject({ kind: 'error', error: expect.stringMatching(/draft.*identity/i) });
      expect(beforeSend).not.toHaveBeenCalled();
      expect(beforeReceive).not.toHaveBeenCalled();
      expect(sent).toBe(0);
      expect((await f.store.load(f.thread.id))!.messages).toEqual({});
    },
  );

  it('rejects forged response drafts before persistence or delivery', async () => {
    const sender = participant('sender');
    const recipient = participant('recipient');
    const f = await fixture([sender, recipient]);
    let delivered = 0;
    f.eventBus.on('message:delivered', () => (delivered += 1));

    await expect(
      f.lifecycle.respond({
        operationId: 'route-forged-response',
        sender: recipient,
        recipient: sender,
        thread: f.thread,
        draft: draft({ senderId: 'forged-sender', role: 'assistant' }),
        actions: [],
      }),
    ).resolves.toMatchObject({ status: 'error', error: expect.stringMatching(/draft.*identity/i) });
    expect(delivered).toBe(0);
    expect((await f.store.load(f.thread.id))!.messages).toEqual({});
  });

  it('reports closed post-append failures without deleting persisted message', async () => {
    const sender = participant('sender', [instance('sender')]);
    const recipient = participant('recipient');
    const f = await fixture([sender, recipient]);
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Abort',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: { afterSend: () => ({ kind: 'abort', error: 'after append' }) },
      },
      'test',
    );

    const result = await f.lifecycle.receive({
      operationId: 'route-abort',
      sender,
      recipient,
      thread: f.thread,
      draft: draft(),
      actions: [],
      mode: 'pre_runtime',
    });
    expect(result).toMatchObject({ kind: 'error', error: 'after append', partial: true });
    if (result.kind !== 'error') throw new Error('Expected lifecycle error');
    expect((await f.store.load(f.thread.id))!.messages[result.storedMessageId!]).toBeDefined();
  });

  it('selects beforeReceive middleware by recipient id rather than participant type', async () => {
    const sender = participant('sender');
    const recipientA = participant('recipient-a', [instance('a')]);
    const recipientB = participant('recipient-b', [instance('b')]);
    const f = await fixture([sender, recipientA, recipientB]);
    const observed: string[] = [];
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Identity',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: {
          beforeReceive: (context) => {
            observed.push(context.participant.id);
            return { kind: 'continue' };
          },
        },
      },
      'test',
    );

    await f.lifecycle.receive({
      operationId: 'route-identity',
      sender,
      recipient: recipientB,
      thread: f.thread,
      draft: draft({ recipientId: recipientB.id }),
      actions: [],
      mode: 'pre_runtime',
    });
    expect(observed).toEqual(['recipient-b']);
  });

  it('maps middleware approval suspension before persistence', async () => {
    const sender = participant('sender', [instance('sender')]);
    sender.tools = { risky: 'requires_approval' };
    const recipient = participant('recipient');
    const f = await fixture([sender, recipient]);
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Approval',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: {
          beforeSend: () => ({ kind: 'tool', requestId: 'risky-1', tool: 'risky', arguments: {} }),
        },
      },
      'test',
    );

    const result = await f.lifecycle.receive({
      operationId: 'route-approval',
      sender,
      recipient,
      thread: f.thread,
      draft: draft(),
      actions: [],
      mode: 'pre_runtime',
    });
    expect(result).toMatchObject({ kind: 'pending_approval', participantId: 'sender' });
    if (result.kind !== 'pending_approval') throw new Error('Expected pending approval');
    expect(f.pendingApprovals.get(result.approvalId)).toMatchObject({
      conversationId: f.thread.id,
      requesterId: 'sender',
    });
    expect((await f.store.load(f.thread.id))!.messages).toEqual({});
  });

  it('propagates auto-tool actions through supplied response lifecycle without duplicate execution', async () => {
    const sender = participant('sender', [instance('sender-request'), instance('sender-observe')]);
    sender.tools = { record: 'auto' };
    const recipient = participant('recipient', [instance('recipient')]);
    const f = await fixture([sender, recipient]);
    const observed: string[] = [];
    const execute = vi.fn(async () => ({ status: 'success' as const, data: { recorded: true } }));
    f.tools.register({ name: 'record', description: 'record', parameters: schema, execute });
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Action propagation',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: {
          beforeSend: (context) => {
            if (
              context.participant.id === 'sender' &&
              context.message.role === 'user' &&
              context.instance.id === 'sender-request'
            ) {
              return { kind: 'tool', requestId: 'record-1', tool: 'record', arguments: {} };
            }
            observed.push(`${context.participant.id}:beforeSend:${context.actions.length}`);
            return { kind: 'continue' };
          },
          beforeReceive: (context) => {
            if (context.participant.id === 'sender' && context.instance.id === 'sender-request') {
              return { kind: 'continue' };
            }
            observed.push(`${context.participant.id}:beforeReceive:${context.actions.length}`);
            return { kind: 'continue' };
          },
          afterSend: (context) => {
            if (context.participant.id === 'sender' && context.instance.id === 'sender-request') {
              return { kind: 'continue' };
            }
            observed.push(`${context.participant.id}:afterSend:${context.actions.length}`);
            return { kind: 'continue' };
          },
          afterReceive: (context) => {
            if (context.participant.id === 'sender' && context.instance.id === 'sender-request') {
              return { kind: 'continue' };
            }
            observed.push(`${context.participant.id}:afterReceive:${context.actions.length}`);
            return context.mode === 'pre_runtime'
              ? {
                  kind: 'respond',
                  message: {
                    senderId: 'recipient',
                    recipientId: 'sender',
                    role: 'assistant',
                    content: 'middleware response',
                  },
                }
              : { kind: 'continue' };
          },
        },
      },
      'test',
    );

    const inbound = await f.lifecycle.receive({
      operationId: 'route-actions',
      sender,
      recipient,
      thread: f.thread,
      draft: draft(),
      actions: [],
      mode: 'pre_runtime',
    });
    expect(inbound.kind).toBe('respond');
    if (inbound.kind !== 'respond') throw new Error('Expected middleware response');
    await f.lifecycle.respond({
      operationId: 'route-actions',
      sender: recipient,
      recipient: sender,
      thread: f.thread,
      draft: inbound.response,
      actions: inbound.actions,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(observed).toEqual([
      'sender:beforeSend:1',
      'recipient:beforeReceive:1',
      'sender:afterSend:1',
      'recipient:afterReceive:1',
      'recipient:beforeSend:1',
      'sender:beforeReceive:1',
      'recipient:afterSend:1',
      'sender:afterReceive:1',
    ]);
  });

  it('returns pre-runtime respond drafts without duplicate appends and routes them through response lifecycle', async () => {
    const sender = participant('sender', [instance('sender')]);
    const recipient = participant('recipient', [instance('recipient')]);
    const f = await fixture([sender, recipient]);
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Respond',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: {
          afterReceive: (context) =>
            context.mode === 'pre_runtime' && context.participant.id === 'recipient'
              ? {
                  kind: 'respond',
                  message: {
                    senderId: 'recipient',
                    recipientId: 'sender',
                    role: 'assistant',
                    content: 'short circuit',
                  },
                }
              : { kind: 'continue' },
        },
      },
      'test',
    );

    const inbound = await f.lifecycle.receive({
      operationId: 'route-respond',
      sender,
      recipient,
      thread: f.thread,
      draft: draft(),
      actions: [],
      mode: 'pre_runtime',
    });
    expect(inbound).toMatchObject({ kind: 'respond', response: { content: 'short circuit' } });
    expect(Object.keys((await f.store.load(f.thread.id))!.messages)).toHaveLength(1);
    if (inbound.kind !== 'respond') throw new Error('Expected response draft');

    await expect(
      f.lifecycle.respond({
        operationId: 'route-respond',
        sender: recipient,
        recipient: sender,
        thread: f.thread,
        draft: inbound.response,
        actions: inbound.actions,
      }),
    ).resolves.toMatchObject({ status: 'success', response: 'short circuit' });
    expect(Object.keys((await f.store.load(f.thread.id))!.messages)).toHaveLength(2);
  });

  it('delivers post-response complete outcomes without reactivating an archived conversation', async () => {
    const sender = participant('sender', [instance('sender')]);
    const recipient = participant('recipient');
    const f = await fixture([sender, recipient]);
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Complete response',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: {
          afterReceive: (context) =>
            context.mode === 'post_response' ? { kind: 'complete' } : { kind: 'continue' },
        },
      },
      'test',
    );

    const inbound = await f.lifecycle.receive({
      operationId: 'route-complete',
      sender,
      recipient,
      thread: f.thread,
      draft: draft(),
      actions: [],
      mode: 'pre_runtime',
    });
    expect(inbound.kind).toBe('continue');
    await f.store.mutate(f.thread.id, (conversation) => ({ ...conversation, status: 'archived' }));
    await f.thread.reload();

    await expect(
      f.lifecycle.respond({
        operationId: 'route-complete',
        sender: recipient,
        recipient: sender,
        thread: f.thread,
        draft: draft({ senderId: 'recipient', recipientId: 'sender', role: 'assistant' }),
        actions: inbound.kind === 'continue' ? inbound.actions : [],
      }),
    ).resolves.toMatchObject({ status: 'success' });
    expect((await f.store.load(f.thread.id))?.status).toBe('archived');
  });

  it('transforms provisional response drafts into minimal deltas and authoritative rewrites', async () => {
    const sender = participant('sender', [instance('sender')]);
    const recipient = participant('recipient', [instance('recipient')]);
    const f = await fixture([sender, recipient]);
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Stream transform',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: {
          beforeSend: (context) => ({
            kind: 'continue',
            message: {
              ...context.message,
              content: context.message.content.endsWith('rewrite')
                ? 'authoritative'
                : context.message.content,
              reasoning: context.message.reasoning?.toUpperCase(),
            },
          }),
        },
      } satisfies MiddlewareDefinition,
      'test',
    );
    const stream = f.lifecycle.createResponseStream({
      operationId: 'stream-1',
      sender: recipient,
      recipient: sender,
      thread: f.thread,
      actions: [],
    });

    await expect(stream.push({ type: 'iteration_start', iteration: 0 })).resolves.toEqual([
      { type: 'iteration_start', iteration: 0 },
    ]);
    await expect(stream.push({ type: 'reasoning_delta', delta: 'why' })).resolves.toEqual([
      { type: 'reasoning_delta', delta: 'WHY' },
    ]);
    await expect(stream.push({ type: 'text_delta', delta: 'answer' })).resolves.toEqual([
      { type: 'text_delta', delta: 'answer' },
    ]);
    await expect(stream.push({ type: 'text_delta', delta: '' })).resolves.toEqual([]);

    const rewritten = await stream.push({ type: 'text_delta', delta: 'rewrite' });
    expect(rewritten).toEqual([
      { type: 'message_snapshot', content: 'authoritative', reasoning: 'WHY' },
    ] satisfies LLMChunk[]);
  });

  it('resets provisional response drafts per iteration and passes control chunks through unchanged', async () => {
    const sender = participant('sender', [instance('sender')]);
    const recipient = participant('recipient', [instance('recipient')]);
    const f = await fixture([sender, recipient]);
    const beforeSend = vi.fn(() => ({ kind: 'continue' as const }));
    f.middlewareRegistry.register(
      {
        type: 'test:lifecycle',
        displayName: 'Stream reset',
        defaultFailureMode: 'closed',
        configSchema: schema,
        hooks: { beforeSend },
      } satisfies MiddlewareDefinition,
      'test',
    );
    const stream = f.lifecycle.createResponseStream({
      operationId: 'stream-reset',
      sender: recipient,
      recipient: sender,
      thread: f.thread,
      actions: [],
    });

    await stream.push({ type: 'text_delta', delta: 'old' });
    await stream.push({ type: 'iteration_start', iteration: 1 });
    await expect(stream.push({ type: 'text_delta', delta: 'new' })).resolves.toEqual([
      { type: 'text_delta', delta: 'new' },
    ]);
    await expect(
      stream.push({ type: 'tool_call_start', index: 0, id: 'call-1', name: 'tool' }),
    ).resolves.toEqual([{ type: 'tool_call_start', index: 0, id: 'call-1', name: 'tool' }]);
    expect(beforeSend).toHaveBeenCalledTimes(2);
  });
});
