import type {
  MessageDraft,
  MiddlewareDefinition,
  MiddlewareInstanceConfig,
  MiddlewareLogger,
  ParticipantConfig,
} from '@legion/types';
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
});
