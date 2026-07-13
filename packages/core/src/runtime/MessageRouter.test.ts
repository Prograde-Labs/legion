import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { Collective } from '../collective/Collective.js';
import { EventBus } from '../events/EventBus.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { MockRuntime } from './MockRuntime.js';
import { MessageRouter } from './MessageRouter.js';
import type {
  ConversationOrigin,
  LLMChunk,
  MiddlewareDefinition,
  MiddlewareLogger,
} from '@legion/types';
import type { ToolContext } from '../tools/Tool.js';
import { MiddlewareLifecycle } from '../middleware/MiddlewareLifecycle.js';
import { MiddlewareRegistry } from '../middleware/MiddlewareRegistry.js';
import { MiddlewareRunner } from '../middleware/MiddlewareRunner.js';

async function setup(dir: string) {
  const storage = new FileStorage(dir);
  await storage.writeJson('collective/participants/op.json', {
    id: 'op',
    name: 'Op',
    type: 'user',
    tools: {},
    status: 'active',
  });
  await storage.writeJson('collective/participants/mock-1.json', {
    id: 'mock-1',
    name: 'Mock',
    type: 'mock',
    tools: {},
    responses: ['hello back'],
    status: 'active',
  });
  await storage.writeJson('collective/participants/svc.json', {
    id: 'svc',
    name: 'Service',
    type: 'mock',
    tools: {},
    responses: [],
    status: 'active',
  });
  const collective = await Collective.load(storage);
  const eventBus = new EventBus();
  const store = new FileConversationStore(storage, eventBus);
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', (id) => new MockRuntime(id));
  const router = new MessageRouter(store, registry, collective, eventBus);

  const baseContext = {
    collective,
    config: { version: '2' },
    eventBus,
    storage,
    workspaceRoot: dir,
    communicationDepth: 0,
    toolRegistry: new ToolRegistry(),
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
  } as unknown as ToolContext;

  return { collective, store, eventBus, router, baseContext };
}

async function setupReasoningRouter(dir: string) {
  const base = await setup(dir);
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', () => ({
    async handle() {
      return { kind: 'response', content: 'answer', reasoning: 'analysis' } as const;
    },
    async *handleStream() {
      yield { type: 'iteration_start', iteration: 0 } as const;
      yield { type: 'reasoning_delta', delta: 'analysis' } as const;
      yield { type: 'text_delta', delta: 'answer' } as const;
      return { kind: 'response', content: 'answer', reasoning: 'analysis' } as const;
    },
  }));
  return {
    ...base,
    router: new MessageRouter(base.store, registry, base.collective, base.eventBus),
  };
}

async function setupMiddlewareRouter(dir: string, definition: MiddlewareDefinition) {
  const base = await setup(dir);
  await base.collective.update('op', {
    middleware: [{ id: 'op-middleware', type: 'test:router-middleware', config: {} }],
  });
  await base.collective.update('mock-1', {
    middleware: [{ id: 'mock-middleware', type: 'test:router-middleware', config: {} }],
  });
  const middlewareRegistry = new MiddlewareRegistry();
  middlewareRegistry.register(definition, 'test');
  const logger: MiddlewareLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const toolRegistry = base.baseContext.toolRegistry as ToolRegistry;
  const runner = new MiddlewareRunner({
    registry: middlewareRegistry,
    authEngine: base.baseContext.authEngine as AuthEngine,
    toolRegistry,
    pendingApprovals: base.baseContext.pendingApprovalRegistry as PendingApprovalRegistry,
    eventBus: base.eventBus,
    logger,
    conversationStore: base.store,
    buildToolContext: (participant, thread, signal) => ({
      ...(base.baseContext as ToolContext),
      participant,
      conversationId: thread.id,
      conversation: thread,
      signal,
    }),
  });
  const runtimeRegistry = new RuntimeRegistry();
  return {
    ...base,
    runtimeRegistry,
    router: new MessageRouter(
      base.store,
      runtimeRegistry,
      base.collective,
      base.eventBus,
      new MiddlewareLifecycle(runner, base.eventBus),
    ),
  };
}

describe('MessageRouter: synchronous send', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('routes a message to a mock and returns its response', async () => {
    const { router, baseContext, store, eventBus } = await setup(dir);
    const created: string[] = [];
    eventBus.on('conversation:created', ({ conversation }) => created.push(conversation.id));
    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });
    expect(result.status).toBe('success');
    expect(result.response).toBe('hello back');
    expect(result.conversationId).toMatch(/^conv-/);
    expect(created).toEqual([result.conversationId]);

    const conv = await store.load(result.conversationId);
    const contents = Object.values(conv!.messages)
      .map((m) => m.content)
      .sort();
    expect(contents).toEqual(['hello', 'hello back']);
  });

  it('continues an existing conversation when conversationId is supplied', async () => {
    const { router, baseContext } = await setup(dir);
    const first = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'one',
      context: baseContext,
    });
    const second = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'two',
      conversationId: first.conversationId,
      context: baseContext,
    });
    expect(second.conversationId).toBe(first.conversationId);
  });

  it('returns an error result for an unknown recipient', async () => {
    const { router, baseContext } = await setup(dir);
    const result = await router.send({
      senderId: 'op',
      recipientId: 'ghost',
      message: 'x',
      context: baseContext,
    });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/ghost/);
  });

  it('rejects unknown senders before creating or reactivating conversations', async () => {
    const { router, baseContext, store, eventBus } = await setup(dir);
    const archived = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      status: 'archived',
    });
    let created = 0;
    let updated = 0;
    let sent = 0;
    eventBus.on('conversation:created', () => (created += 1));
    eventBus.on('conversation:updated', () => (updated += 1));
    eventBus.on('message:sent', () => (sent += 1));

    await expect(
      router.send({
        senderId: 'ghost',
        recipientId: 'mock-1',
        message: 'nope',
        context: baseContext,
      }),
    ).resolves.toMatchObject({
      conversationId: '',
      status: 'error',
      error: expect.stringMatching(/ghost/),
    });
    const result = await router.send({
      senderId: 'ghost',
      recipientId: 'mock-1',
      message: 'nope',
      conversationId: archived.id,
      context: baseContext,
    });

    expect(result).toMatchObject({
      conversationId: archived.id,
      status: 'error',
      error: expect.stringMatching(/ghost/),
    });
    expect(created).toBe(0);
    expect(updated).toBe(0);
    expect(sent).toBe(0);
    expect((await store.load(archived.id))?.status).toBe('archived');
    expect((await store.load(archived.id))?.messages).toEqual({});
  });

  it('emits message:sent for inbound and message:delivered for response', async () => {
    const { router, baseContext, eventBus } = await setup(dir);
    let sent = 0;
    let delivered = 0;
    eventBus.on('message:sent', () => (sent += 1));
    eventBus.on('message:delivered', () => (delivered += 1));
    await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });
    expect(sent).toBe(1);
    expect(delivered).toBe(1);
  });

  it('stamps parentConversationId and parentToolCallId on child when caller has a conversation', async () => {
    const { router, baseContext, store } = await setup(dir);
    // First send creates a parent conversation
    const parent = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });
    // Second send with context.conversationId = parent, no explicit conversationId
    // (simulates an agent in the parent conversation calling communicate)
    const childContext = {
      ...baseContext,
      conversationId: parent.conversationId,
      toolCallId: 'tc-42',
    };
    const child = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'delegate',
      context: childContext,
    });
    expect(child.conversationId).not.toBe(parent.conversationId);

    const childConv = await store.load(child.conversationId);
    expect(childConv?.parentConversationId).toBe(parent.conversationId);
    expect(childConv?.parentToolCallId).toBe('tc-42');
  });

  it('does not stamp parent link when caller has no conversation (empty string)', async () => {
    const { router, baseContext, store } = await setup(dir);
    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'first',
      context: { ...baseContext, conversationId: '' },
    });
    const conv = await store.load(result.conversationId);
    expect(conv?.parentConversationId).toBeUndefined();
    expect(conv?.parentToolCallId).toBeUndefined();
  });

  it('reactivates an archived conversation with the inbound append atomically', async () => {
    const { router, baseContext, store, eventBus } = await setup(dir);
    const archived = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      status: 'archived',
    });
    const transitions: Parameters<Parameters<typeof eventBus.on<'conversation:updated'>>[1]>[0][] =
      [];
    eventBus.on('conversation:updated', (event) => transitions.push(event));

    await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'wake up',
      conversationId: archived.id,
      context: baseContext,
    });

    const wakeTransitions = transitions.filter((event) => event.before.status === 'archived');
    expect(wakeTransitions).toHaveLength(1);
    expect(wakeTransitions[0]).toMatchObject({
      conversationId: archived.id,
      before: { status: 'archived', participants: [] },
      after: { status: 'active', participants: ['op', 'mock-1'] },
    });
    const conversation = await store.load(archived.id);
    expect(conversation?.status).toBe('active');
    expect(
      Object.values(conversation?.messages ?? {}).some((message) => message.content === 'wake up'),
    ).toBe(true);
  });

  it('persists explicit origin intact and mirrors its parent links on creation', async () => {
    const { router, baseContext, store } = await setup(dir);
    const parent = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const origin: ConversationOrigin = {
      kind: 'middleware',
      participantId: 'op',
      middlewareInstanceId: 'instance-1',
      parentConversationId: parent.id,
      parentMessageId: 'message-1',
      parentToolCallId: 'origin-call',
    };

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'start child',
      origin,
      context: {
        ...baseContext,
        conversationId: parent.id,
        toolCallId: 'context-call',
      },
    });

    const conversation = await store.load(result.conversationId);
    expect(conversation?.origin).toEqual(origin);
    expect(conversation?.parentConversationId).toBe(parent.id);
    expect(conversation?.parentToolCallId).toBe('origin-call');
  });

  it('does not fill missing explicit origin links from buffered send context', async () => {
    const { router, baseContext, store } = await setup(dir);
    const originParent = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const contextParent = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const origin: ConversationOrigin = {
      kind: 'middleware',
      participantId: 'op',
      middlewareInstanceId: 'instance-1',
      parentConversationId: originParent.id,
    };

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'partial origin',
      origin,
      context: {
        ...baseContext,
        conversationId: contextParent.id,
        toolCallId: 'context-call',
      },
    });

    const conversation = await store.load(result.conversationId);
    expect(conversation?.origin).toEqual(origin);
    expect(conversation?.parentConversationId).toBe(originParent.id);
    expect(conversation?.parentToolCallId).toBeUndefined();
  });

  it('preserves origin and links when a supplied conversation id falls back to creation', async () => {
    const { router, baseContext, store } = await setup(dir);
    const parent = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const origin: ConversationOrigin = {
      kind: 'middleware',
      participantId: 'op',
      middlewareInstanceId: 'instance-1',
      parentConversationId: parent.id,
      parentMessageId: 'message-1',
      parentToolCallId: 'origin-call',
    };

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'fallback',
      conversationId: 'conv-missing',
      origin,
      context: baseContext,
    });

    expect(result.conversationId).not.toBe('conv-missing');
    const conversation = await store.load(result.conversationId);
    expect(conversation?.origin).toEqual(origin);
    expect(conversation?.parentConversationId).toBe(parent.id);
    expect(conversation?.parentToolCallId).toBe('origin-call');
  });

  it('does not self-parent a buffered fallback when context has the requested missing id', async () => {
    const { router, baseContext, store } = await setup(dir);

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'same id fallback',
      conversationId: 'conv-missing',
      context: {
        ...baseContext,
        conversationId: 'conv-missing',
        toolCallId: 'context-call',
      },
    });

    const conversation = await store.load(result.conversationId);
    expect(conversation?.origin).toEqual({
      kind: 'tool',
      participantId: 'op',
      parentToolCallId: 'context-call',
    });
    expect(conversation?.parentConversationId).toBeUndefined();
    expect(conversation?.parentToolCallId).toBe('context-call');
  });

  it('preserves a distinct context parent when a supplied conversation id falls back', async () => {
    const { router, baseContext, store } = await setup(dir);
    const parent = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'distinct parent fallback',
      conversationId: 'conv-missing',
      context: {
        ...baseContext,
        conversationId: parent.id,
        toolCallId: 'context-call',
      },
    });

    const conversation = await store.load(result.conversationId);
    expect(conversation?.origin).toEqual({
      kind: 'tool',
      participantId: 'op',
      parentConversationId: parent.id,
      parentToolCallId: 'context-call',
    });
    expect(conversation?.parentConversationId).toBe(parent.id);
    expect(conversation?.parentToolCallId).toBe('context-call');
  });

  it('does not overwrite origin when sending into an existing conversation', async () => {
    const { router, baseContext, store } = await setup(dir);
    const originalOrigin: ConversationOrigin = { kind: 'participant', participantId: 'op' };
    const existing = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      origin: originalOrigin,
    });

    await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'continue',
      conversationId: existing.id,
      origin: { kind: 'middleware', middlewareInstanceId: 'ignored' },
      context: baseContext,
    });

    expect((await store.load(existing.id))?.origin).toEqual(originalOrigin);
  });
});

describe('MessageRouter: middleware lifecycle', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-middleware-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('routes buffered inbound and runtime response through injected lifecycle', async () => {
    const phases: string[] = [];
    const { router, baseContext, store, eventBus, runtimeRegistry } = await setupMiddlewareRouter(
      dir,
      {
        type: 'test:router-middleware',
        displayName: 'Router middleware',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
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
      },
    );
    runtimeRegistry.registerFactory('mock', (id) => new MockRuntime(id));
    eventBus.on('message:sent', ({ senderId }) => phases.push(`persist ${senderId}`));

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });

    expect(result).toMatchObject({
      status: 'success',
      response: 'hello back:mock-1:send:op:receive',
    });
    expect(phases).toEqual([
      'op beforeSend',
      'mock-1 beforeReceive',
      'persist op',
      'op afterSend',
      'mock-1 afterReceive pre_runtime',
      'mock-1 beforeSend',
      'op beforeReceive',
      'persist mock-1',
      'mock-1 afterSend',
      'op afterReceive post_response',
    ]);
    expect(
      Object.values((await store.load(result.conversationId))!.messages).map(
        (message) => message.content,
      ),
    ).toEqual(['hello:op:send:mock-1:receive', 'hello back:mock-1:send:op:receive']);
  });

  it('maps middleware approval suspension and does not dispatch runtime', async () => {
    const { router, baseContext, collective, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Approval middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: () => ({ kind: 'tool', requestId: 'approval-1', tool: 'risky', arguments: {} }),
      },
    });
    await collective.update('op', { tools: { risky: 'requires_approval' } });
    const handle = vi.fn(async () => ({ kind: 'response' as const, content: 'must not run' }));
    runtimeRegistry.registerFactory('mock', () => ({ handle }));

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hold',
      context: baseContext,
    });

    expect(result).toMatchObject({
      status: 'pending_approval',
      approvalId: expect.stringMatching(/^appr-/),
      checkpointId: expect.stringMatching(/^mwcp-/),
      pendingParticipantId: 'op',
    });
    expect(result.approvalRequests).toHaveLength(1);
    expect(handle).not.toHaveBeenCalled();
  });

  it('routes pre-runtime middleware responses through lifecycle without runtime dispatch', async () => {
    const { router, baseContext, store, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Respond middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        afterReceive: (context) =>
          context.mode === 'pre_runtime' && context.participant.id === 'mock-1'
            ? {
                kind: 'respond',
                message: {
                  senderId: 'mock-1',
                  recipientId: 'op',
                  role: 'assistant',
                  content: 'short circuit',
                },
              }
            : { kind: 'continue' },
      },
    });
    const handle = vi.fn(async () => ({ kind: 'response' as const, content: 'must not run' }));
    runtimeRegistry.registerFactory('mock', () => ({ handle }));

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });

    expect(result).toMatchObject({ status: 'success', response: 'short circuit' });
    expect(handle).not.toHaveBeenCalled();
    expect(Object.values((await store.load(result.conversationId))!.messages)).toHaveLength(2);
  });

  it('routes replyTo runtime responses through injected lifecycle', async () => {
    const phases: string[] = [];
    const { router, baseContext, store, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Reply lifecycle',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) => {
          phases.push(`${context.participant.id}:beforeSend`);
          return {
            kind: 'continue',
            message: {
              ...context.message,
              content: `${context.message.content}:${context.participant.id}`,
            },
          };
        },
        afterReceive: (context) => {
          phases.push(`${context.participant.id}:afterReceive:${context.mode}`);
          return { kind: 'continue' };
        },
      },
    });
    runtimeRegistry.registerFactory('mock', (id) => new MockRuntime(id));

    const result = await router.send({
      senderId: 'svc',
      recipientId: 'mock-1',
      replyTo: 'op',
      message: 'analyze',
      context: baseContext,
    });
    await router.drain();

    expect(result.status).toBe('dispatched');
    expect(phases).toEqual([
      'mock-1:afterReceive:pre_runtime',
      'mock-1:beforeSend',
      'op:afterReceive:post_response',
    ]);
    expect(
      Object.values((await store.load(result.conversationId))!.messages).find(
        (message) => message.role === 'assistant',
      )?.content,
    ).toBe('hello back:mock-1');
  });
});

describe('MessageRouter: fire-and-forget', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-faf-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns dispatched immediately and routes the response to replyTo', async () => {
    const { router, baseContext, store, eventBus } = await setup(dir);
    let delivered: { recipientId: string } | null = null;
    eventBus.on('message:delivered', (p) => (delivered = { recipientId: p.recipientId }));

    const result = await router.send({
      senderId: 'svc',
      recipientId: 'mock-1',
      message: 'analyze',
      replyTo: 'op',
      context: baseContext,
    });
    expect(result.status).toBe('dispatched');
    expect(result.response).toBeUndefined();

    await router.drain();

    expect(delivered).toEqual({ recipientId: 'op' });
    const conv = await store.load(result.conversationId);
    const toOp = Object.values(conv!.messages).find(
      (m) => m.recipientId === 'op' && m.role === 'assistant',
    );
    expect(toOp?.content).toBe('hello back');
  });

  it('catches runtime errors in fire-and-forget and persists an error message', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/op.json', {
      id: 'op',
      name: 'Op',
      type: 'user',
      tools: {},
      status: 'active',
    });
    await storage.writeJson('collective/participants/throwing.json', {
      id: 'throwing',
      name: 'Throwing',
      type: 'mock',
      tools: {},
      status: 'active',
    });
    const collective = await Collective.load(storage);
    const eventBus = new EventBus();
    const store = new FileConversationStore(storage, eventBus);
    const registry = new RuntimeRegistry();
    registry.registerFactory('mock', () => ({
      async handle() {
        throw new Error('provider boom');
      },
    }));
    const router = new MessageRouter(store, registry, collective, eventBus);

    const baseContext = {
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry: new ToolRegistry(),
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as ToolContext;

    let delivered: { recipientId: string } | null = null;
    eventBus.on('message:delivered', (p) => (delivered = { recipientId: p.recipientId }));

    const result = await router.send({
      senderId: 'op',
      recipientId: 'throwing',
      message: 'hello',
      replyTo: 'op',
      context: baseContext,
    });
    expect(result.status).toBe('dispatched');

    await router.drain();

    expect(delivered).toEqual({ recipientId: 'op' });
    const conv = await store.load(result.conversationId);
    const toOp = Object.values(conv!.messages).find(
      (m) => m.recipientId === 'op' && m.role === 'assistant',
    );
    expect(toOp?.content).toMatch(/provider boom/);
  });

  it('preserves intervening conversation updates before persisting a background response', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/op.json', {
      id: 'op',
      name: 'Op',
      type: 'user',
      tools: {},
      status: 'active',
    });
    await storage.writeJson('collective/participants/slow.json', {
      id: 'slow',
      name: 'Slow',
      type: 'mock',
      tools: {},
      status: 'active',
    });
    const collective = await Collective.load(storage);
    const eventBus = new EventBus();
    const store = new FileConversationStore(storage, eventBus);
    const registry = new RuntimeRegistry();

    let calls = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    registry.registerFactory('mock', () => ({
      async handle() {
        calls += 1;
        if (calls === 1) {
          markFirstStarted();
          await new Promise<void>((release) => {
            releaseFirst = release;
          });
          return { kind: 'response', content: 'first response' };
        }
        return { kind: 'response', content: 'second response' };
      },
    }));

    const router = new MessageRouter(store, registry, collective, eventBus);
    const baseContext = {
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry: new ToolRegistry(),
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as ToolContext;

    const first = await router.send({
      senderId: 'op',
      recipientId: 'slow',
      message: 'first',
      replyTo: 'op',
      context: baseContext,
    });
    await firstStarted;

    const second = router.send({
      senderId: 'op',
      recipientId: 'slow',
      message: 'second',
      conversationId: first.conversationId,
      context: baseContext,
    });

    releaseFirst();
    await Promise.all([second, router.drain()]);

    const conv = await store.load(first.conversationId);
    const contents = Object.values(conv!.messages).map((m) => m.content);
    expect(contents).toEqual(
      expect.arrayContaining(['first', 'second', 'second response', 'first response']),
    );
  });

  it('preserves internal runtime appends and queued sends during background dispatch', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/op.json', {
      id: 'op',
      name: 'Op',
      type: 'user',
      tools: {},
      status: 'active',
    });
    await storage.writeJson('collective/participants/agent.json', {
      id: 'agent',
      name: 'Agent',
      type: 'mock',
      tools: {},
      status: 'active',
    });
    const collective = await Collective.load(storage);
    const eventBus = new EventBus();
    const store = new FileConversationStore(storage, eventBus);
    const registry = new RuntimeRegistry();

    let calls = 0;
    let releaseInternalAppend!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    registry.registerFactory('mock', () => ({
      async handle(_incoming, context) {
        calls += 1;
        if (calls === 1) {
          markFirstStarted();
          await new Promise<void>((release) => {
            releaseInternalAppend = release;
          });
          await context.conversation.append({
            senderId: 'agent',
            recipientId: 'agent',
            role: 'assistant',
            content: 'tool-call turn',
          });
          return { kind: 'response', content: 'first response' };
        }
        return { kind: 'response', content: 'second response' };
      },
    }));

    const router = new MessageRouter(store, registry, collective, eventBus);
    const baseContext = {
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry: new ToolRegistry(),
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as ToolContext;

    const first = await router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'first',
      replyTo: 'op',
      context: baseContext,
    });
    await firstStarted;

    const second = router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'second',
      conversationId: first.conversationId,
      context: baseContext,
    });

    releaseInternalAppend();
    await Promise.all([second, router.drain()]);

    const conv = await store.load(first.conversationId);
    const contents = Object.values(conv!.messages).map((m) => m.content);
    expect(contents).toEqual(
      expect.arrayContaining([
        'first',
        'tool-call turn',
        'first response',
        'second',
        'second response',
      ]),
    );
  });

  it('does not deadlock when background runtime sends to the same conversation', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/op.json', {
      id: 'op',
      name: 'Op',
      type: 'user',
      tools: {},
      status: 'active',
    });
    await storage.writeJson('collective/participants/agent.json', {
      id: 'agent',
      name: 'Agent',
      type: 'mock',
      tools: {},
      status: 'active',
    });
    const collective = await Collective.load(storage);
    const eventBus = new EventBus();
    const store = new FileConversationStore(storage, eventBus);
    const registry = new RuntimeRegistry();

    let calls = 0;
    registry.registerFactory('mock', () => ({
      async handle(_incoming, context) {
        calls += 1;
        if (calls === 1) {
          const result = await context.messageRouter.send({
            senderId: 'agent',
            recipientId: 'agent',
            message: 'nested',
            conversationId: context.conversationId,
            context,
          });
          expect(result.status).toBe('success');
          return { kind: 'response', content: 'outer response' };
        }
        return { kind: 'response', content: 'nested response' };
      },
    }));

    const router = new MessageRouter(store, registry, collective, eventBus);
    const baseContext = {
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry: new ToolRegistry(),
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as ToolContext;

    const result = await router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'outer',
      replyTo: 'op',
      context: baseContext,
    });
    expect(result.status).toBe('dispatched');

    await router.drain();
    const conv = await store.load(result.conversationId);
    const contents = Object.values(conv!.messages).map((m) => m.content);
    expect(contents).toEqual(
      expect.arrayContaining(['outer', 'nested', 'nested response', 'outer response']),
    );
  });
});

describe('MessageRouter: pending_approval result', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-pa-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns pending_approval status and approvalRequests when runtime returns pending_approval', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/op.json', {
      id: 'op',
      name: 'Op',
      type: 'user',
      tools: {},
      status: 'active',
    });
    await storage.writeJson('collective/participants/mock-1.json', {
      id: 'mock-1',
      name: 'M',
      type: 'mock',
      tools: {},
      responses: [],
      status: 'active',
    });
    const collective = await Collective.load(storage);
    const eventBus = new EventBus();
    const store = new FileConversationStore(storage, eventBus);
    const registry = new RuntimeRegistry();

    // A runtime that returns pending_approval
    const pendingRuntime = {
      async handle(): Promise<import('./Runtime.js').RuntimeResult> {
        return {
          kind: 'pending_approval',
          approvalRequests: [
            {
              approvalId: 'appr-test',
              conversationId: 'conv-1',
              requesterId: 'mock-1',
              tool: 'write_file',
              args: {},
              createdAt: new Date().toISOString(),
            },
          ],
        };
      },
    };
    registry.registerFactory('mock', () => pendingRuntime);

    const router = new MessageRouter(store, registry, collective, eventBus);
    const baseContext = {
      participant: collective.getOrThrow('mock-1'),
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry: new ToolRegistry(),
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as import('../tools/Tool.js').ToolContext;

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hi',
      context: baseContext,
    });

    expect(result.status).toBe('pending_approval');
    expect(result.approvalRequests?.[0].approvalId).toBe('appr-test');
    // No response message should be persisted to the conversation
    const conv = await store.load(result.conversationId);
    const messages = Object.values(conv!.messages);
    expect(messages.every((m) => m.role === 'user')).toBe(true);
  });
});

describe('MessageRouter: resume()', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-resume-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('re-triggers the paused runtime and persists the final response', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/op.json', {
      id: 'op',
      name: 'Op',
      type: 'user',
      tools: {},
      status: 'active',
    });
    await storage.writeJson('collective/participants/mock-1.json', {
      id: 'mock-1',
      name: 'M',
      type: 'mock',
      tools: {},
      responses: ['resumed response'],
      status: 'active',
    });
    const collective = await Collective.load(storage);
    const eventBus = new EventBus();
    const store = new FileConversationStore(storage, eventBus);
    const registry = new RuntimeRegistry();
    registry.registerFactory('mock', (id) => new MockRuntime(id));

    const router = new MessageRouter(store, registry, collective, eventBus);
    const baseContext = {
      participant: collective.getOrThrow('mock-1'),
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry: new ToolRegistry(),
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as import('../tools/Tool.js').ToolContext;

    // Send a message to establish the conversation
    const sent = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'original',
      context: baseContext,
    });
    const { conversationId } = sent;

    // resume() should call handle() again and persist the response
    const resumeResult = await router.resume(conversationId, 'mock-1', baseContext);
    expect(resumeResult.status).toBe('success');
    expect(resumeResult.response).toBe('resumed response');

    // The response should appear in the conversation
    const conv = await store.load(conversationId);
    const assistantMsgs = Object.values(conv!.messages).filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(2); // original + resumed
  });
});

describe('MessageRouter: generate()', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-generate-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('dispatches from the latest incoming user message without appending another user message', async () => {
    const { router, baseContext, store } = await setup(dir);
    const sent = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'original',
      context: baseContext,
    });

    const result = await router.generate(sent.conversationId, 'mock-1', baseContext);
    expect(result.status).toBe('dispatched');

    await router.drain();

    const conv = await store.load(sent.conversationId);
    const messages = Object.values(conv!.messages);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('delivers generated responses to the incoming message replyTo target', async () => {
    const { router, baseContext, eventBus } = await setup(dir);
    const delivered: string[] = [];
    eventBus.on('message:delivered', (p) => delivered.push(p.recipientId));

    const sent = await router.send({
      senderId: 'svc',
      recipientId: 'mock-1',
      message: 'original',
      replyTo: 'op',
      context: baseContext,
    });
    await router.drain();

    const result = await router.generate(sent.conversationId, 'mock-1', baseContext);
    expect(result.status).toBe('dispatched');
    await router.drain();

    expect(delivered).toEqual(['op', 'op']);
  });
});

describe('MessageRouter: per-conversation locking', () => {
  let dir: string;
  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    dir = await mkdtemp(require('path').join(require('os').tmpdir(), 'legion-lock-'));
  });
  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('serialises concurrent sends to the same conversation', async () => {
    const { router, baseContext } = await setup(dir);
    const first = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'one',
      context: baseContext,
    });
    const order: number[] = [];
    const p1 = router
      .send({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'a',
        conversationId: first.conversationId,
        context: baseContext,
      })
      .then(() => {
        order.push(1);
      });
    const p2 = router
      .send({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'b',
        conversationId: first.conversationId,
        context: baseContext,
      })
      .then(() => {
        order.push(2);
      });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('does not block concurrent sends to different conversations', async () => {
    const { router, baseContext } = await setup(dir);
    const [r1, r2] = await Promise.all([
      router.send({ senderId: 'op', recipientId: 'mock-1', message: 'a', context: baseContext }),
      router.send({ senderId: 'op', recipientId: 'mock-1', message: 'b', context: baseContext }),
    ]);
    expect(r1.conversationId).not.toBe(r2.conversationId);
    expect(r1.status).toBe('success');
    expect(r2.status).toBe('success');
  });

  it('new conversations (no conversationId) bypass the lock', async () => {
    const { router, baseContext } = await setup(dir);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        router.send({ senderId: 'op', recipientId: 'mock-1', message: 'x', context: baseContext }),
      ),
    );
    expect(new Set(results.map((r) => r.conversationId)).size).toBe(4);
  });
});

describe('MessageRouter.sendStream()', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-stream-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a generator that yields nothing and returns MessageRouterResult for mock runtime', async () => {
    const { router, baseContext } = await setup(dir);
    const gen = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });

    const chunks: LLMChunk[] = [];
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await gen.next();
    }
    const result = next.value;
    expect(result.status).toBe('success');
    expect(result.response).toBe('hello back');
    expect(chunks).toHaveLength(0);
  });

  it('persists response message with correct sender/recipient direction', async () => {
    const { router, baseContext, store } = await setup(dir);
    const gen = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });

    let next = await gen.next();
    while (!next.done) next = await gen.next();

    const conv = await store.load(next.value.conversationId);
    const messages = Object.values(conv!.messages);
    const responseMsg = messages.find((m) => m.role === 'assistant');
    expect(responseMsg).toBeDefined();
    expect(responseMsg!.senderId).toBe('mock-1');
    expect(responseMsg!.recipientId).toBe('op');
  });

  it('reactivates an archived conversation with the streaming inbound append', async () => {
    const { router, baseContext, store, eventBus } = await setup(dir);
    const archived = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      status: 'archived',
    });
    const transitions: Parameters<Parameters<typeof eventBus.on<'conversation:updated'>>[1]>[0][] =
      [];
    eventBus.on('conversation:updated', (event) => transitions.push(event));

    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'stream wake',
      conversationId: archived.id,
      context: baseContext,
    });
    let next = await stream.next();
    while (!next.done) next = await stream.next();

    const wakeTransitions = transitions.filter((event) => event.before.status === 'archived');
    expect(wakeTransitions).toHaveLength(1);
    expect(wakeTransitions[0]?.after).toMatchObject({
      status: 'active',
      participants: ['op', 'mock-1'],
    });
    expect((await store.load(archived.id))?.status).toBe('active');
  });

  it('does not fill missing explicit origin links from streaming send context', async () => {
    const { router, baseContext, store } = await setup(dir);
    const originParent = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const contextParent = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const origin: ConversationOrigin = {
      kind: 'middleware',
      participantId: 'op',
      middlewareInstanceId: 'instance-1',
      parentConversationId: originParent.id,
    };

    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'partial stream origin',
      origin,
      context: {
        ...baseContext,
        conversationId: contextParent.id,
        toolCallId: 'context-call',
      },
    });
    let next = await stream.next();
    while (!next.done) next = await stream.next();

    const conversation = await store.load(next.value.conversationId);
    expect(conversation?.origin).toEqual(origin);
    expect(conversation?.parentConversationId).toBe(originParent.id);
    expect(conversation?.parentToolCallId).toBeUndefined();
  });

  it('preserves origin and links when a streamed conversation id falls back to creation', async () => {
    const { router, baseContext, store } = await setup(dir);
    const parent = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const origin: ConversationOrigin = {
      kind: 'middleware',
      participantId: 'op',
      middlewareInstanceId: 'instance-1',
      parentConversationId: parent.id,
      parentMessageId: 'message-1',
      parentToolCallId: 'origin-call',
    };

    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'stream fallback',
      conversationId: 'conv-missing',
      origin,
      context: baseContext,
    });
    let next = await stream.next();
    while (!next.done) next = await stream.next();

    expect(next.value.conversationId).not.toBe('conv-missing');
    const conversation = await store.load(next.value.conversationId);
    expect(conversation?.origin).toEqual(origin);
    expect(conversation?.parentConversationId).toBe(parent.id);
    expect(conversation?.parentToolCallId).toBe('origin-call');
  });

  it('does not self-parent a streamed fallback when context has the requested missing id', async () => {
    const { router, baseContext, store } = await setup(dir);
    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'same id stream fallback',
      conversationId: 'conv-missing',
      context: {
        ...baseContext,
        conversationId: 'conv-missing',
        toolCallId: 'context-call',
      },
    });
    let next = await stream.next();
    while (!next.done) next = await stream.next();

    const conversation = await store.load(next.value.conversationId);
    expect(conversation?.origin).toEqual({
      kind: 'tool',
      participantId: 'op',
      parentToolCallId: 'context-call',
    });
    expect(conversation?.parentConversationId).toBeUndefined();
    expect(conversation?.parentToolCallId).toBe('context-call');
  });
});

describe('MessageRouter: reasoning persistence', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-reasoning-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists reasoning from send()', async () => {
    const { router, baseContext, store } = await setupReasoningRouter(dir);
    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });

    const conv = await store.load(result.conversationId);
    const response = Object.values(conv!.messages).find((message) => message.role === 'assistant');
    expect(response).toMatchObject({ content: 'answer', reasoning: 'analysis' });
  });

  it('forwards stream chunks and persists reasoning from sendStream()', async () => {
    const { router, baseContext, store } = await setupReasoningRouter(dir);
    const gen = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });
    const chunks: LLMChunk[] = [];
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await gen.next();
    }

    expect(chunks).toEqual([
      { type: 'iteration_start', iteration: 0 },
      { type: 'reasoning_delta', delta: 'analysis' },
      { type: 'text_delta', delta: 'answer' },
    ]);
    const conv = await store.load(next.value.conversationId);
    const response = Object.values(conv!.messages).find((message) => message.role === 'assistant');
    expect(response).toMatchObject({ content: 'answer', reasoning: 'analysis' });
  });

  it('persists reasoning from fire-and-forget send()', async () => {
    const { router, baseContext, store } = await setupReasoningRouter(dir);
    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      replyTo: 'op',
      context: baseContext,
    });
    await router.drain();

    const conv = await store.load(result.conversationId);
    const response = Object.values(conv!.messages).find((message) => message.role === 'assistant');
    expect(response).toMatchObject({ content: 'answer', reasoning: 'analysis' });
  });
});
