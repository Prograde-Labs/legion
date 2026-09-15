import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { Collective } from '../collective/Collective.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import { EventBus } from '../events/EventBus.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { MockRuntime } from './MockRuntime.js';
import { AgentRuntime } from './AgentRuntime.js';
import { MessageRouter } from './MessageRouter.js';
import type {
  ConversationOrigin,
  LLMChunk,
  MiddlewareDefinition,
  MiddlewareLogger,
  MiddlewareActionResult,
} from '@legion/types';
import type { ToolContext } from '../tools/Tool.js';
import { MiddlewareLifecycle } from '../middleware/MiddlewareLifecycle.js';
import { MiddlewareRegistry } from '../middleware/MiddlewareRegistry.js';
import { MiddlewareRunner } from '../middleware/MiddlewareRunner.js';
import type { Provider, ProviderMessage } from '../providers/Provider.js';
import type { ModelRouter } from '../providers/ModelRouter.js';
import { createCompactConversationTool } from '../tools/automation-tools.js';
import { appendMessage } from '../conversation/conversation-ops.js';

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
  await storage.writeJson('collective/participants/agent.json', {
    id: 'agent',
    name: 'Agent',
    type: 'agent',
    tools: {},
    systemPrompt: 'Base prompt',
    model: { model: 'test-model' },
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
    pendingApprovalRegistry: new PendingApprovalRegistry(storage),
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
  middlewareRegistry.register(
    definition,
    definition.type.startsWith('builtin:') ? 'builtin:test' : 'test',
  );
  const logger: MiddlewareLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const toolRegistry = base.baseContext.toolRegistry as ToolRegistry;
  const runtimeRegistry = new RuntimeRegistry();
  const createRouter = (pendingApprovals: PendingApprovalRegistry) => {
    let messageRouter!: MessageRouter;
    const context = {
      ...base.baseContext,
      pendingApprovalRegistry: pendingApprovals,
    } as ToolContext;
    const runner = new MiddlewareRunner({
      registry: middlewareRegistry,
      authEngine: base.baseContext.authEngine as AuthEngine,
      toolRegistry,
      pendingApprovals,
      eventBus: base.eventBus,
      logger,
      conversationStore: base.store,
      collective: base.collective,
      buildToolContext: (participant, thread, signal) => ({
        ...context,
        participant,
        conversationId: thread.id,
        conversation: thread,
        conversationStore: base.store,
        messageRouter,
        signal,
      }),
    });
    messageRouter = new MessageRouter(
      base.store,
      runtimeRegistry,
      base.collective,
      base.eventBus,
      new MiddlewareLifecycle(runner, base.eventBus),
      runner,
    );
    return { context, router: messageRouter, runner };
  };
  const initial = createRouter(base.baseContext.pendingApprovalRegistry as PendingApprovalRegistry);
  return {
    ...base,
    baseContext: initial.context,
    runtimeRegistry,
    middlewareRegistry,
    runner: initial.runner,
    router: initial.router,
    reload: async () =>
      createRouter(await PendingApprovalRegistry.load(base.baseContext.storage as FileStorage)),
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

  it('stops after inbound complete without invoking recipient runtime', async () => {
    const { router, baseContext, store, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Complete middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        afterReceive: (context) =>
          context.mode === 'pre_runtime' && context.participant.id === 'mock-1'
            ? { kind: 'complete' }
            : { kind: 'continue' },
      },
    });
    const handle = vi.fn(async () => ({ kind: 'response' as const, content: 'must not run' }));
    runtimeRegistry.registerFactory('mock', () => ({ handle }));

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'complete this',
      context: baseContext,
    });

    expect(result).toMatchObject({ status: 'success' });
    expect(result.response).toBeUndefined();
    expect(handle).not.toHaveBeenCalled();
    expect(Object.values((await store.load(result.conversationId))!.messages)).toHaveLength(1);
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

  it('routes pre-runtime responses through full response lifecycle', async () => {
    const phases: string[] = [];
    const { router, baseContext, store, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Respond lifecycle middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) => {
          phases.push(`${context.participant.id}:beforeSend`);
          return {
            kind: 'continue',
            message: {
              ...context.message,
              content: `${context.message.content}:${context.participant.id}:beforeSend`,
            },
          };
        },
        beforeReceive: (context) => {
          phases.push(`${context.participant.id}:beforeReceive`);
          return { kind: 'continue', message: context.message };
        },
        afterSend: (context) => {
          phases.push(`${context.participant.id}:afterSend`);
          return { kind: 'continue' };
        },
        afterReceive: (context) => {
          phases.push(`${context.participant.id}:afterReceive:${context.mode}`);
          if (context.mode !== 'pre_runtime' || context.participant.id !== 'mock-1') {
            return { kind: 'continue' };
          }
          return {
            kind: 'respond',
            message: {
              senderId: 'mock-1',
              recipientId: 'op',
              role: 'assistant',
              content: 'short circuit',
            },
          };
        },
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

    expect(result).toMatchObject({
      status: 'success',
      response: 'short circuit:mock-1:beforeSend',
    });
    expect(handle).not.toHaveBeenCalled();
    expect(phases.slice(-4)).toEqual([
      'mock-1:beforeSend',
      'op:beforeReceive',
      'mock-1:afterSend',
      'op:afterReceive:post_response',
    ]);
    expect(Object.values((await store.load(result.conversationId))!.messages)).toHaveLength(2);
  });

  it('does not expose agent prompt hooks to non-agent runtimes', async () => {
    const { router, baseContext, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Agent prompt middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: { buildSystemPrompt: () => ({ kind: 'continue' }) },
    });
    const handle = vi.fn(async (_incoming, context) => {
      expect(context.buildSystemPrompt).toBeUndefined();
      return { kind: 'void' as const };
    });
    runtimeRegistry.registerFactory('mock', () => ({ handle }));

    await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'not an agent',
      context: baseContext,
    });
    expect(handle).toHaveBeenCalledOnce();
  });

  it('provides agent prompt hooks backed by middleware runner', async () => {
    const { router, baseContext, collective, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Agent prompt middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        buildSystemPrompt: () => ({
          kind: 'continue',
          change: { operation: 'append', content: ':middleware' },
        }),
      },
    });
    await collective.update('agent', {
      middleware: [{ id: 'agent-middleware', type: 'test:router-middleware', config: {} }],
    });
    const handle = vi.fn(async (incoming, context) => {
      expect(context.buildSystemPrompt).toBeDefined();
      await expect(
        context.buildSystemPrompt!({
          basePrompt: 'Base prompt',
          iteration: 0,
          incomingMessageId: incoming.id,
          actions: [],
        }),
      ).resolves.toEqual({ kind: 'continue', prompt: 'Base prompt:middleware', actions: [] });
      return { kind: 'void' as const };
    });
    runtimeRegistry.registerFactory('agent', () => ({ handle }));

    await router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'prompt me',
      context: baseContext,
    });
    expect(handle).toHaveBeenCalledOnce();
  });

  it('resumes approved prompt checkpoint at provider boundary and acknowledges after terminal response', async () => {
    const promptCalls: string[] = [];
    const { router, baseContext, collective, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Prompt approval middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        buildSystemPrompt: (context) =>
          (() => {
            promptCalls.push(context.instance.id);
            return context.instance.id === 'request'
              ? { kind: 'tool', requestId: 'prompt-gate', tool: 'gate', arguments: {} }
              : { kind: 'continue', change: { operation: 'append', content: ':resumed' } };
          })(),
      },
    });
    await collective.update('agent', {
      tools: { gate: 'requires_approval' },
      middleware: [
        { id: 'request', type: 'test:router-middleware', config: {} },
        { id: 'following', type: 'test:router-middleware', config: {} },
      ],
    });
    const resumeFromMiddleware = vi.fn(async (resume) => {
      expect(resume.preparedPrompt).toBe('Base prompt:resumed');
      expect(resume.actions).toMatchObject([{ requestId: 'prompt-gate', status: 'success' }]);
      return { kind: 'response' as const, content: 'provider resumed', actions: resume.actions };
    });
    runtimeRegistry.registerFactory('agent', () => ({
      async handle(incoming, context) {
        const prompt = await context.buildSystemPrompt!({
          basePrompt: 'Base prompt',
          iteration: 0,
          incomingMessageId: incoming.id,
          actions: [],
        });
        if (prompt.kind !== 'pending') throw new Error('Expected prompt approval');
        return {
          kind: 'middleware_pending' as const,
          approvalId: prompt.approvalId,
          checkpointId: prompt.checkpointId,
        };
      },
      resumeFromMiddleware,
    }));
    (baseContext.toolRegistry as ToolRegistry).register({
      name: 'gate',
      description: 'gate',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success' as const, data: { ok: true } };
      },
    });

    const pending = await router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'resume prompt',
      context: baseContext,
    });
    if (!pending.approvalId) throw new Error('Expected pending approval');
    const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    await approvals.resolve(pending.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(router.resumeApproval(pending.approvalId, baseContext)).resolves.toMatchObject({
      status: 'success',
      response: 'provider resumed',
    });
    expect(resumeFromMiddleware).toHaveBeenCalledOnce();
    expect(promptCalls).toEqual(['request', 'following']);
    expect(approvals.getRecord(pending.approvalId)).toMatchObject({ lifecycle: 'acknowledged' });
  });

  it.each([
    ['beforeSend', 'pre_runtime', 'op'],
    ['beforeReceive', 'pre_runtime', 'mock-1'],
    ['afterSend', 'pre_runtime', 'op'],
    ['afterReceive', 'pre_runtime', 'mock-1'],
    ['beforeSend', 'post_response', 'mock-1'],
    ['beforeReceive', 'post_response', 'op'],
    ['afterSend', 'post_response', 'mock-1'],
    ['afterReceive', 'post_response', 'op'],
  ] as const)(
    'continues %s approval exactly once during %s lifecycle',
    async (phase, mode, ownerId) => {
      const calls: string[] = [];
      const ledgers: MiddlewareActionResult[][] = [];
      const role = mode === 'pre_runtime' ? 'user' : 'assistant';
      const matches = (context: { message: { role: string } }) => context.message.role === role;
      const request = (
        hookPhase: typeof phase,
        context: { instance: { id: string }; message: { role: string }; mode?: string },
      ) => {
        if (hookPhase !== phase || context.instance.id !== 'request' || !matches(context)) {
          return undefined;
        }
        calls.push('request');
        return {
          kind: 'tool' as const,
          requestId: `${phase}-${mode}`,
          tool: 'gate',
          arguments: {},
        };
      };
      const following = (
        hookPhase: typeof phase,
        context: {
          instance: { id: string };
          message: { role: string };
          mode?: string;
          actions: MiddlewareActionResult[];
        },
      ) => {
        if (hookPhase !== phase || context.instance.id !== 'following' || !matches(context)) {
          return false;
        }
        calls.push('following');
        ledgers.push(context.actions);
        return true;
      };
      const { router, baseContext, collective, runtimeRegistry, store } =
        await setupMiddlewareRouter(dir, {
          type: 'test:router-middleware',
          displayName: 'Continuation matrix middleware',
          defaultFailureMode: 'closed',
          configSchema: { type: 'object', additionalProperties: true },
          hooks: {
            beforeSend: (context) => {
              const result = request('beforeSend', context);
              if (result) return result;
              following('beforeSend', context);
              return { kind: 'continue', message: context.message };
            },
            beforeReceive: (context) => {
              const result = request('beforeReceive', context);
              if (result) return result;
              following('beforeReceive', context);
              return { kind: 'continue', message: context.message };
            },
            afterSend: (context) => {
              const result = request('afterSend', context);
              if (result) return result;
              following('afterSend', context);
              return { kind: 'continue' };
            },
            afterReceive: (context) => {
              const result = request('afterReceive', context);
              if (result) return result;
              following('afterReceive', context);
              return { kind: 'continue' };
            },
          },
        });
      await collective.update(ownerId, {
        tools: { gate: 'requires_approval' },
        middleware: [
          { id: 'request', type: 'test:router-middleware', config: {} },
          { id: 'following', type: 'test:router-middleware', config: {} },
        ],
      });
      (baseContext.toolRegistry as ToolRegistry).register({
        name: 'gate',
        description: 'gate',
        parameters: { type: 'object' },
        async execute() {
          return { status: 'success' as const };
        },
      });
      const handle = vi.fn(async () => ({ kind: 'response' as const, content: 'response' }));
      runtimeRegistry.registerFactory('mock', () => ({ handle }));

      const pending = await router.send({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'continue me',
        context: baseContext,
      });
      if (!pending.approvalId) throw new Error('Expected pending approval');
      const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
      await approvals.resolve(pending.approvalId, {
        approved: true,
        decidedByParticipantId: 'op',
        decidedAt: '2026-01-01T00:00:00.000Z',
      });

      const resumed = await router.resumeApproval(pending.approvalId, baseContext);
      expect(resumed.status, resumed.error).toBe('success');
      expect(calls).toEqual(['request', 'following']);
      expect(ledgers).toMatchObject([[{ requestId: `${phase}-${mode}`, status: 'success' }]]);
      expect(handle).toHaveBeenCalledOnce();
      expect(approvals.getRecord(pending.approvalId)).toMatchObject({ lifecycle: 'acknowledged' });
      expect(Object.values((await store.load(pending.conversationId))!.messages)).toHaveLength(2);
    },
  );

  it('acknowledges stale router checkpoints with a cached error and no runtime replay', async () => {
    const { router, baseContext, collective, runtimeRegistry, store } = await setupMiddlewareRouter(
      dir,
      {
        type: 'test:router-middleware',
        displayName: 'Stale checkpoint middleware',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
        hooks: {
          beforeSend: () => ({
            kind: 'tool',
            requestId: 'stale-gate',
            tool: 'gate',
            arguments: {},
          }),
        },
      },
    );
    await collective.update('op', { tools: { gate: 'requires_approval' } });
    (baseContext.toolRegistry as ToolRegistry).register({
      name: 'gate',
      description: 'gate',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success' as const };
      },
    });
    const handle = vi.fn(async () => ({ kind: 'response' as const, content: 'must not run' }));
    runtimeRegistry.registerFactory('mock', () => ({ handle }));

    const pending = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'stale',
      context: baseContext,
    });
    if (!pending.approvalId) throw new Error('Expected pending approval');
    const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    await approvals.resolve(pending.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.updateHead(pending.conversationId, 'newer-head');

    const first = await router.resumeApproval(pending.approvalId, baseContext);
    const second = await router.resumeApproval(pending.approvalId, baseContext);

    expect(first).toMatchObject({ status: 'error', error: expect.stringMatching(/stale/i) });
    expect(second).toEqual(first);
    expect(handle).not.toHaveBeenCalled();
    expect(approvals.getRecord(pending.approvalId)).toMatchObject({
      lifecycle: 'acknowledged',
      routerResult: { status: 'error' },
    });
    expect(Object.values((await store.load(pending.conversationId))!.messages)).toHaveLength(0);
  });

  it('acknowledges stale middleware config snapshots without executing their tool', async () => {
    const { router, baseContext, collective, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Stale config middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: () => ({ kind: 'tool', requestId: 'config-gate', tool: 'gate', arguments: {} }),
      },
    });
    await collective.update('op', {
      tools: { gate: 'requires_approval' },
      middleware: [{ id: 'request', type: 'test:router-middleware', config: { revision: 1 } }],
    });
    const execute = vi.fn(async () => ({ status: 'success' as const }));
    (baseContext.toolRegistry as ToolRegistry).register({
      name: 'gate',
      description: 'gate',
      parameters: { type: 'object' },
      execute,
    });
    const handle = vi.fn(async () => ({ kind: 'response' as const, content: 'must not run' }));
    runtimeRegistry.registerFactory('mock', () => ({ handle }));

    const pending = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'stale config',
      context: baseContext,
    });
    if (!pending.approvalId) throw new Error('Expected pending approval');
    const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    await approvals.resolve(pending.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    const internals = collective as unknown as {
      participants: Map<string, { middleware?: unknown[] }>;
    };
    const stored = internals.participants.get('op')!;
    (stored.middleware![0] as { config: unknown }).config = { revision: 2 };

    const first = await router.resumeApproval(pending.approvalId, baseContext);
    const second = await router.resumeApproval(pending.approvalId, baseContext);

    expect(first).toMatchObject({ status: 'error', error: expect.stringMatching(/stale/i) });
    expect(second).toEqual(first);
    expect(execute).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
    expect(approvals.getRecord(pending.approvalId)).toMatchObject({
      lifecycle: 'acknowledged',
      routerResult: { status: 'error' },
    });
  });

  it('persists an empty provider response once before acknowledging its prompt approval', async () => {
    const { router, baseContext, collective, runtimeRegistry, store } = await setupMiddlewareRouter(
      dir,
      {
        type: 'test:router-middleware',
        displayName: 'Empty provider middleware',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
        hooks: {
          buildSystemPrompt: (context) =>
            context.instance.id === 'request'
              ? { kind: 'tool', requestId: 'empty-gate', tool: 'gate', arguments: {} }
              : { kind: 'continue' },
        },
      },
    );
    await collective.update('agent', {
      tools: { gate: 'requires_approval' },
      middleware: [
        { id: 'request', type: 'test:router-middleware', config: {} },
        { id: 'following', type: 'test:router-middleware', config: {} },
      ],
    });
    (baseContext.toolRegistry as ToolRegistry).register({
      name: 'gate',
      description: 'gate',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success' as const };
      },
    });
    const resumeFromMiddleware = vi.fn(async (resume) => ({
      kind: 'response' as const,
      content: '',
      actions: resume.actions,
    }));
    runtimeRegistry.registerFactory('agent', () => ({
      async handle(incoming, context) {
        const prompt = await context.buildSystemPrompt!({
          basePrompt: 'Base prompt',
          iteration: 0,
          incomingMessageId: incoming.id,
          actions: [],
        });
        if (prompt.kind !== 'pending') throw new Error('Expected prompt approval');
        return {
          kind: 'middleware_pending' as const,
          approvalId: prompt.approvalId,
          checkpointId: prompt.checkpointId,
        };
      },
      resumeFromMiddleware,
    }));

    const pending = await router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'empty response',
      context: baseContext,
    });
    if (!pending.approvalId) throw new Error('Expected pending approval');
    const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    await approvals.resolve(pending.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(router.resumeApproval(pending.approvalId, baseContext)).resolves.toMatchObject({
      status: 'success',
      response: '',
    });
    expect(resumeFromMiddleware).toHaveBeenCalledOnce();
    expect(Object.values((await store.load(pending.conversationId))!.messages)).toMatchObject([
      { role: 'user', content: 'empty response' },
      { role: 'assistant', content: '' },
    ]);
    expect(approvals.getRecord(pending.approvalId)).toMatchObject({ lifecycle: 'acknowledged' });
  });

  it('refuses provider-boundary replay after reload recovers an execution claim', async () => {
    const { router, baseContext, collective, runtimeRegistry, runner, store } =
      await setupMiddlewareRouter(dir, {
        type: 'test:router-middleware',
        displayName: 'Provider claim middleware',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
        hooks: {
          buildSystemPrompt: (context) =>
            context.instance.id === 'request'
              ? { kind: 'tool', requestId: 'claim-gate', tool: 'gate', arguments: {} }
              : { kind: 'continue' },
        },
      });
    await collective.update('agent', {
      tools: { gate: 'requires_approval' },
      middleware: [
        { id: 'request', type: 'test:router-middleware', config: {} },
        { id: 'following', type: 'test:router-middleware', config: {} },
      ],
    });
    (baseContext.toolRegistry as ToolRegistry).register({
      name: 'gate',
      description: 'gate',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success' as const };
      },
    });
    const resumeFromMiddleware = vi.fn(async () => ({
      kind: 'response' as const,
      content: 'must not run',
    }));
    const handle = vi.fn(async (incoming, context) => {
      const prompt = await context.buildSystemPrompt!({
        basePrompt: 'Base prompt',
        iteration: 0,
        incomingMessageId: incoming.id,
        actions: [],
      });
      if (prompt.kind !== 'pending') throw new Error('Expected prompt approval');
      return {
        kind: 'middleware_pending' as const,
        approvalId: prompt.approvalId,
        checkpointId: prompt.checkpointId,
      };
    });
    runtimeRegistry.registerFactory('agent', () => ({ handle, resumeFromMiddleware }));

    const pending = await router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'claim provider',
      context: baseContext,
    });
    if (!pending.approvalId) throw new Error('Expected pending approval');
    const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    await approvals.resolve(pending.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    const thread = new ConversationThread((await store.load(pending.conversationId))!, store);
    await expect(runner.resumeApproval(pending.approvalId, thread)).resolves.toMatchObject({
      kind: 'continue',
    });
    await expect(approvals.claimProviderExecution(pending.approvalId)).resolves.toBe('claimed');

    const reloaded = await PendingApprovalRegistry.load(baseContext.storage as FileStorage);
    const reloadedContext = { ...baseContext, pendingApprovalRegistry: reloaded };
    const first = await router.resumeApproval(pending.approvalId, reloadedContext);
    const second = await router.resumeApproval(pending.approvalId, reloadedContext);

    expect(first).toMatchObject({
      status: 'error',
      error: 'Middleware provider outcome unknown and was not retried',
    });
    expect(second).toEqual(first);
    expect(handle).toHaveBeenCalledOnce();
    expect(resumeFromMiddleware).not.toHaveBeenCalled();
    expect(reloaded.getRecord(pending.approvalId)).toMatchObject({
      lifecycle: 'acknowledged',
      providerExecution: 'unknown',
      routerResult: { status: 'error' },
    });
  });

  it('marks a throwing resumed provider as unknown without replay after reload', async () => {
    const { router, baseContext, collective, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Throwing provider middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        buildSystemPrompt: (context) =>
          context.instance.id === 'request'
            ? { kind: 'tool', requestId: 'throw-gate', tool: 'gate', arguments: {} }
            : { kind: 'continue' },
      },
    });
    await collective.update('agent', {
      tools: { gate: 'requires_approval' },
      middleware: [
        { id: 'request', type: 'test:router-middleware', config: {} },
        { id: 'following', type: 'test:router-middleware', config: {} },
      ],
    });
    (baseContext.toolRegistry as ToolRegistry).register({
      name: 'gate',
      description: 'gate',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success' as const };
      },
    });
    const resumeFromMiddleware = vi.fn(async () => {
      throw new Error('provider transport failed');
    });
    runtimeRegistry.registerFactory('agent', () => ({
      async handle(incoming, context) {
        const prompt = await context.buildSystemPrompt!({
          basePrompt: 'Base prompt',
          iteration: 0,
          incomingMessageId: incoming.id,
          actions: [],
        });
        if (prompt.kind !== 'pending') throw new Error('Expected prompt approval');
        return {
          kind: 'middleware_pending' as const,
          approvalId: prompt.approvalId,
          checkpointId: prompt.checkpointId,
        };
      },
      resumeFromMiddleware,
    }));

    const pending = await router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'throw provider',
      context: baseContext,
    });
    if (!pending.approvalId) throw new Error('Expected pending approval');
    const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    await approvals.resolve(pending.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    const first = await router.resumeApproval(pending.approvalId, baseContext);
    const reloaded = await PendingApprovalRegistry.load(baseContext.storage as FileStorage);
    const second = await router.resumeApproval(pending.approvalId, {
      ...baseContext,
      pendingApprovalRegistry: reloaded,
    });

    expect(first).toMatchObject({
      status: 'error',
      error: 'Middleware provider outcome unknown and was not retried',
    });
    expect(second).toEqual(first);
    expect(resumeFromMiddleware).toHaveBeenCalledOnce();
    expect(reloaded.getRecord(pending.approvalId)).toMatchObject({
      lifecycle: 'acknowledged',
      providerExecution: 'unknown',
      routerResult: { status: 'error' },
    });
  });

  it('rechecks durable approval state after another router completes while resume is pending', async () => {
    const { baseContext, collective, eventBus, store } = await setup(dir);
    const conversation = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const registry = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    const checkpoint = {
      checkpointId: 'coordinated-checkpoint',
      operationId: 'coordinated-operation',
      conversationId: conversation.id,
      phase: 'beforeSend' as const,
      participantId: 'agent',
      instanceId: 'gate',
      middlewareType: 'test:gate',
      middlewareRevision: 0,
      middlewareConfig: {},
      nextHookIndex: 1,
      actionCursor: 0,
      draft: { senderId: 'agent', recipientId: 'op', role: 'assistant' as const, content: 'reply' },
      final: true,
      request: { requestId: 'gate-request', tool: 'gate', arguments: {} },
      actions: [],
      observedHead: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { approvalId } = await registry.create({
      conversationId: conversation.id,
      requesterId: 'agent',
      tool: 'gate',
      args: {},
      continuation: { kind: 'middleware', checkpoint },
    });
    await registry.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    await registry.beginResume(approvalId);
    await registry.recordResumeResult(approvalId, { status: 'error', error: 'terminal' });
    const storage = baseContext.storage as FileStorage;
    const staleRegistry = await PendingApprovalRegistry.load(storage);
    const completingRegistry = await PendingApprovalRegistry.load(storage);
    let releasePending!: () => void;
    const pendingStarted = Promise.withResolvers<void>();
    const pendingRunner = {
      resumeApproval: vi.fn(async () => {
        pendingStarted.resolve();
        await new Promise<void>((resolve) => {
          releasePending = resolve;
        });
        return { kind: 'resume_pending' as const, checkpointId: checkpoint.checkpointId };
      }),
    };
    const completingRunner = {
      resumeApproval: vi.fn(async () => ({ kind: 'abort' as const, error: 'terminal' })),
    };
    const runtimeRegistry = new RuntimeRegistry();
    const staleRouter = new MessageRouter(
      store,
      runtimeRegistry,
      collective,
      eventBus,
      undefined,
      pendingRunner as unknown as MiddlewareRunner,
    );
    const completingRouter = new MessageRouter(
      store,
      runtimeRegistry,
      collective,
      eventBus,
      undefined,
      completingRunner as unknown as MiddlewareRunner,
    );
    const staleResult = staleRouter.resumeApproval(approvalId, {
      ...baseContext,
      pendingApprovalRegistry: staleRegistry,
    });
    await pendingStarted.promise;
    const terminal = await completingRouter.resumeApproval(approvalId, {
      ...baseContext,
      pendingApprovalRegistry: completingRegistry,
    });
    releasePending();

    expect(await staleResult).toEqual(terminal);
    expect(terminal).toMatchObject({ status: 'error', error: 'terminal' });
  });

  it('returns a durable successor when another router hands off during resume pending', async () => {
    const { baseContext, collective, eventBus, store } = await setup(dir);
    const conversation = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const registry = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    const checkpoint = {
      checkpointId: 'source-checkpoint',
      operationId: 'source-operation',
      conversationId: conversation.id,
      phase: 'beforeSend' as const,
      participantId: 'agent',
      instanceId: 'gate',
      middlewareType: 'test:gate',
      middlewareRevision: 0,
      middlewareConfig: {},
      nextHookIndex: 1,
      actionCursor: 0,
      draft: { senderId: 'agent', recipientId: 'op', role: 'assistant' as const, content: 'reply' },
      final: true,
      request: { requestId: 'source-request', tool: 'gate', arguments: {} },
      actions: [],
      observedHead: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const source = await registry.create({
      conversationId: conversation.id,
      requesterId: 'agent',
      tool: 'gate',
      args: {},
      continuation: { kind: 'middleware', checkpoint },
    });
    await registry.resolve(source.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    await registry.beginResume(source.approvalId);
    await registry.recordResumeResult(source.approvalId, { status: 'success' });
    const storage = baseContext.storage as FileStorage;
    const staleRegistry = await PendingApprovalRegistry.load(storage);
    const handingOffRegistry = await PendingApprovalRegistry.load(storage);
    const pendingStarted = Promise.withResolvers<void>();
    const releasePending = Promise.withResolvers<void>();
    const staleRunner = {
      resumeApproval: vi.fn(async () => {
        pendingStarted.resolve();
        await releasePending.promise;
        return { kind: 'resume_pending' as const, checkpointId: checkpoint.checkpointId };
      }),
    };
    let successorApprovalId = '';
    const handingOffRunner = {
      resumeApproval: vi.fn(async () => ({
        kind: 'pending_approval' as const,
        approvalId: successorApprovalId,
        checkpointId: 'successor-checkpoint',
        participantId: 'agent',
      })),
    };
    const runtimeRegistry = new RuntimeRegistry();
    const staleRouter = new MessageRouter(
      store,
      runtimeRegistry,
      collective,
      eventBus,
      undefined,
      staleRunner as unknown as MiddlewareRunner,
    );
    const handingOffRouter = new MessageRouter(
      store,
      runtimeRegistry,
      collective,
      eventBus,
      undefined,
      handingOffRunner as unknown as MiddlewareRunner,
    );
    const staleResume = vi.spyOn(staleRouter, 'resumeApproval');
    const staleResult = staleRouter.resumeApproval(source.approvalId, {
      ...baseContext,
      pendingApprovalRegistry: staleRegistry,
    });
    await pendingStarted.promise;
    const successorCheckpoint = {
      ...checkpoint,
      checkpointId: 'successor-checkpoint',
      request: { requestId: 'successor-request', tool: 'gate', arguments: {} },
    };
    ({ approvalId: successorApprovalId } = await handingOffRegistry.create({
      conversationId: conversation.id,
      requesterId: 'agent',
      tool: 'gate',
      args: {},
      continuation: { kind: 'middleware', checkpoint: successorCheckpoint },
    }));
    vi.spyOn(handingOffRegistry, 'acknowledge').mockRejectedValueOnce(
      new Error('simulated acknowledgement interruption'),
    );
    const handoff = await handingOffRouter.resumeApproval(source.approvalId, {
      ...baseContext,
      pendingApprovalRegistry: handingOffRegistry,
    });
    releasePending.resolve();
    const boundedResult = await Promise.race([
      staleResult,
      new Promise<'deadlocked'>((resolve) => setTimeout(() => resolve('deadlocked'), 100)),
    ]);

    expect(boundedResult).not.toBe('deadlocked');
    expect(staleResume).toHaveBeenCalledOnce();
    expect(boundedResult).toMatchObject({
      status: 'pending_approval',
      approvalId: successorApprovalId,
      checkpointId: 'successor-checkpoint',
      pendingParticipantId: 'agent',
    });
    expect(handoff).toMatchObject({
      status: 'pending_approval',
      approvalId: successorApprovalId,
      checkpointId: 'successor-checkpoint',
      pendingParticipantId: 'agent',
    });
  });

  it.each([
    ['afterSend', 'op'],
    ['afterReceive', 'mock-1'],
  ] as const)(
    'does not replay %s pre-runtime provider execution after reload',
    async (phase, ownerId) => {
      const { router, baseContext, collective, eventBus, runtimeRegistry, runner, store } =
        await setupMiddlewareRouter(dir, {
          type: 'test:router-middleware',
          displayName: 'Non-prompt provider claim middleware',
          defaultFailureMode: 'closed',
          configSchema: { type: 'object', additionalProperties: true },
          hooks: {
            afterSend: (context) =>
              phase === 'afterSend' && context.instance.id === 'request'
                ? { kind: 'tool', requestId: 'non-prompt-gate', tool: 'gate', arguments: {} }
                : { kind: 'continue' },
            afterReceive: (context) =>
              phase === 'afterReceive' && context.instance.id === 'request'
                ? { kind: 'tool', requestId: 'non-prompt-gate', tool: 'gate', arguments: {} }
                : { kind: 'continue' },
          },
        });
      await collective.update(ownerId, {
        tools: { gate: 'requires_approval' },
        middleware: [{ id: 'request', type: 'test:router-middleware', config: {} }],
      });
      (baseContext.toolRegistry as ToolRegistry).register({
        name: 'gate',
        description: 'gate',
        parameters: { type: 'object' },
        async execute() {
          return { status: 'success' as const };
        },
      });
      const handle = vi
        .fn()
        .mockImplementationOnce(
          async () => new Promise<{ kind: 'response'; content: string }>(() => undefined),
        )
        .mockResolvedValueOnce({ kind: 'response' as const, content: 'replayed' });
      runtimeRegistry.registerFactory('mock', () => ({ handle }));

      const pending = await router.send({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'claim non-prompt provider',
        context: baseContext,
      });
      if (!pending.approvalId) throw new Error('Expected pending approval');
      const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
      await approvals.resolve(pending.approvalId, {
        approved: true,
        decidedByParticipantId: 'op',
        decidedAt: '2026-01-01T00:00:00.000Z',
      });

      void router.resumeApproval(pending.approvalId, baseContext);
      await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
      const reloaded = await PendingApprovalRegistry.load(baseContext.storage as FileStorage);
      const reloadedRouter = new MessageRouter(
        store,
        runtimeRegistry,
        collective,
        eventBus,
        new MiddlewareLifecycle(runner, eventBus),
        runner,
      );
      const result = await reloadedRouter.resumeApproval(pending.approvalId, {
        ...baseContext,
        pendingApprovalRegistry: reloaded,
      });

      expect(result).toMatchObject({
        status: 'error',
        error: 'Middleware provider outcome unknown and was not retried',
      });
      expect(handle).toHaveBeenCalledOnce();
      expect(reloaded.getRecord(pending.approvalId)).toMatchObject({
        lifecycle: 'acknowledged',
        providerExecution: 'unknown',
      });
    },
  );

  it.each(['pending_approval', 'middleware_pending'] as const)(
    'hands provider %s successors to a resumable child without replaying the parent',
    async (successorKind) => {
      let createChild = false;
      const { router, baseContext, collective, runtimeRegistry, runner, store } =
        await setupMiddlewareRouter(dir, {
          type: 'test:router-middleware',
          displayName: 'Successor handoff middleware',
          defaultFailureMode: 'closed',
          configSchema: { type: 'object', additionalProperties: true },
          hooks: {
            buildSystemPrompt: (context) =>
              context.instance.id === 'request'
                ? { kind: 'tool', requestId: 'parent-gate', tool: 'gate', arguments: {} }
                : { kind: 'continue' },
            afterReceive: (context) =>
              createChild && context.instance.id === 'child'
                ? { kind: 'tool', requestId: 'child-gate', tool: 'gate', arguments: {} }
                : { kind: 'continue' },
          },
        });
      await collective.update('agent', {
        tools: { gate: 'requires_approval' },
        middleware: [
          { id: 'request', type: 'test:router-middleware', config: {} },
          { id: 'following', type: 'test:router-middleware', config: {} },
          { id: 'child', type: 'test:router-middleware', config: {} },
        ],
      });
      (baseContext.toolRegistry as ToolRegistry).register({
        name: 'gate',
        description: 'gate',
        parameters: { type: 'object' },
        async execute() {
          return { status: 'success' as const };
        },
      });
      let childApprovalId = '';
      const resumeFromMiddleware = vi.fn(async () => {
        if (successorKind === 'middleware_pending') {
          return {
            kind: 'middleware_pending' as const,
            approvalId: childApprovalId,
            checkpointId: 'child-checkpoint',
          };
        }
        const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
        return {
          kind: 'pending_approval' as const,
          approvalRequests: [approvals.get(childApprovalId)!],
        };
      });
      runtimeRegistry.registerFactory('agent', () => ({
        async handle(incoming, context) {
          const prompt = await context.buildSystemPrompt!({
            basePrompt: 'Base prompt',
            iteration: 0,
            incomingMessageId: incoming.id,
            actions: [],
          });
          if (prompt.kind !== 'pending') throw new Error('Expected prompt approval');
          return {
            kind: 'middleware_pending' as const,
            approvalId: prompt.approvalId,
            checkpointId: prompt.checkpointId,
          };
        },
        resumeFromMiddleware,
      }));

      const parent = await router.send({
        senderId: 'op',
        recipientId: 'agent',
        message: 'handoff',
        context: baseContext,
      });
      if (!parent.approvalId) throw new Error('Expected parent approval');
      const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
      const thread = new ConversationThread((await store.load(parent.conversationId))!, store);
      const incoming = thread.activeChain.find((message) => message.role === 'user')!;
      createChild = true;
      const child = await runner.runAfterReceive({
        operationId: 'child-setup',
        participant: collective.getOrThrow('agent'),
        thread,
        message: incoming,
        persistedMessageId: incoming.id,
        mode: 'post_response',
        actions: [],
      });
      if (child.kind !== 'pending_approval') throw new Error('Expected child approval');
      childApprovalId = child.approvalId;
      await approvals.resolve(parent.approvalId, {
        approved: true,
        decidedByParticipantId: 'op',
        decidedAt: '2026-01-01T00:00:00.000Z',
      });

      const handoff = await router.resumeApproval(parent.approvalId, baseContext);
      expect(handoff.status).toBe('pending_approval');
      if (successorKind === 'middleware_pending') {
        expect(handoff.approvalId).toBe(childApprovalId);
      } else {
        expect(handoff.approvalRequests?.map((request) => request.approvalId)).toEqual([
          childApprovalId,
        ]);
      }
      expect(resumeFromMiddleware).toHaveBeenCalledOnce();
      expect(approvals.getRecord(parent.approvalId)).toMatchObject({
        lifecycle: 'acknowledged',
        successorApprovalId: childApprovalId,
        providerExecution: 'completed',
      });

      await approvals.resolve(childApprovalId, {
        approved: true,
        decidedByParticipantId: 'op',
        decidedAt: '2026-01-01T00:00:00.000Z',
      });
      await expect(router.resumeApproval(childApprovalId, baseContext)).resolves.toMatchObject({
        status: 'success',
      });
      await expect(router.resumeApproval(parent.approvalId, baseContext)).resolves.toMatchObject({
        status: 'success',
      });
      expect(resumeFromMiddleware).toHaveBeenCalledOnce();
      expect(approvals.getRecord(childApprovalId)).toMatchObject({ lifecycle: 'acknowledged' });
      expect(approvals.listPending(parent.conversationId)).toEqual([]);
    },
  );

  it('hands nested post-response beforeReceive approval to a child without rerunning runtime', async () => {
    const { router, baseContext, collective, runtimeRegistry, store } = await setupMiddlewareRouter(
      dir,
      {
        type: 'test:router-middleware',
        displayName: 'Nested response continuation middleware',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
        hooks: {
          beforeSend: (context) =>
            context.participant.id === 'mock-1' &&
            context.instance.id === 'request' &&
            context.message.role === 'assistant'
              ? { kind: 'tool', requestId: 'parent-response-gate', tool: 'gate', arguments: {} }
              : { kind: 'continue', message: context.message },
          beforeReceive: (context) =>
            context.participant.id === 'op' &&
            context.instance.id === 'child' &&
            context.message.role === 'assistant'
              ? { kind: 'tool', requestId: 'child-response-gate', tool: 'gate', arguments: {} }
              : { kind: 'continue', message: context.message },
        },
      },
    );
    await collective.update('mock-1', {
      tools: { gate: 'requires_approval' },
      middleware: [
        { id: 'request', type: 'test:router-middleware', config: {} },
        { id: 'following', type: 'test:router-middleware', config: {} },
      ],
    });
    await collective.update('op', {
      tools: { gate: 'requires_approval' },
      middleware: [{ id: 'child', type: 'test:router-middleware', config: {} }],
    });
    (baseContext.toolRegistry as ToolRegistry).register({
      name: 'gate',
      description: 'gate',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success' as const };
      },
    });
    const handle = vi.fn(async () => ({ kind: 'response' as const, content: 'nested response' }));
    runtimeRegistry.registerFactory('mock', () => ({ handle }));

    const parent = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'nested',
      context: baseContext,
    });
    if (!parent.approvalId) throw new Error('Expected parent approval');
    const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    await approvals.resolve(parent.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    const handoff = await router.resumeApproval(parent.approvalId, baseContext);
    if (!handoff.approvalId) throw new Error('Expected child approval');
    const child = approvals.getRecord(handoff.approvalId);
    expect(handoff).toMatchObject({ status: 'pending_approval' });
    expect(child?.continuation?.checkpoint.mode).toBe('post_response');
    expect(approvals.getRecord(parent.approvalId)).toMatchObject({
      lifecycle: 'acknowledged',
      successorApprovalId: handoff.approvalId,
    });

    await approvals.resolve(handoff.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(router.resumeApproval(handoff.approvalId, baseContext)).resolves.toMatchObject({
      status: 'success',
    });
    expect(handle).toHaveBeenCalledOnce();
    expect(Object.values((await store.load(parent.conversationId))!.messages)).toMatchObject([
      { role: 'user', content: 'nested' },
      { role: 'assistant', content: 'nested response' },
    ]);
  });

  it('links multiple provider child approvals and resumes each without provider replay', async () => {
    let childTarget = '';
    const { router, baseContext, collective, runtimeRegistry, runner, store } =
      await setupMiddlewareRouter(dir, {
        type: 'test:router-middleware',
        displayName: 'Multiple successor middleware',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
        hooks: {
          buildSystemPrompt: (context) =>
            context.instance.id === 'request'
              ? { kind: 'tool', requestId: 'parent-gate', tool: 'gate', arguments: {} }
              : { kind: 'continue' },
          afterReceive: (context) =>
            context.instance.id === childTarget
              ? { kind: 'tool', requestId: `${childTarget}-gate`, tool: 'gate', arguments: {} }
              : { kind: 'continue' },
        },
      });
    await collective.update('agent', {
      tools: { gate: 'requires_approval' },
      middleware: [
        { id: 'request', type: 'test:router-middleware', config: {} },
        { id: 'following', type: 'test:router-middleware', config: {} },
        { id: 'child-one', type: 'test:router-middleware', config: {} },
        { id: 'child-two', type: 'test:router-middleware', config: {} },
      ],
    });
    (baseContext.toolRegistry as ToolRegistry).register({
      name: 'gate',
      description: 'gate',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success' as const };
      },
    });
    const childIds: string[] = [];
    const resumeFromMiddleware = vi.fn(async () => {
      const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
      return {
        kind: 'pending_approval' as const,
        approvalRequests: childIds.map((approvalId) => approvals.get(approvalId)!),
      };
    });
    runtimeRegistry.registerFactory('agent', () => ({
      async handle(incoming, context) {
        const prompt = await context.buildSystemPrompt!({
          basePrompt: 'Base prompt',
          iteration: 0,
          incomingMessageId: incoming.id,
          actions: [],
        });
        if (prompt.kind !== 'pending') throw new Error('Expected prompt approval');
        return {
          kind: 'middleware_pending' as const,
          approvalId: prompt.approvalId,
          checkpointId: prompt.checkpointId,
        };
      },
      resumeFromMiddleware,
    }));

    const parent = await router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'two children',
      context: baseContext,
    });
    if (!parent.approvalId) throw new Error('Expected parent approval');
    const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
    const thread = new ConversationThread((await store.load(parent.conversationId))!, store);
    const incoming = thread.activeChain.find((message) => message.role === 'user')!;
    for (const instanceId of ['child-one', 'child-two']) {
      childTarget = instanceId;
      const child = await runner.runAfterReceive({
        operationId: `setup-${instanceId}`,
        participant: collective.getOrThrow('agent'),
        thread,
        message: incoming,
        persistedMessageId: incoming.id,
        mode: 'post_response',
        actions: [],
      });
      if (child.kind !== 'pending_approval') throw new Error('Expected child approval');
      childIds.push(child.approvalId);
    }
    await approvals.resolve(parent.approvalId, {
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    const handoff = await router.resumeApproval(parent.approvalId, baseContext);
    expect(handoff).toMatchObject({ status: 'pending_approval' });
    expect(handoff.approvalRequests?.map((request) => request.approvalId)).toEqual(childIds);
    expect(approvals.getRecord(parent.approvalId)).toMatchObject({
      lifecycle: 'acknowledged',
      successorApprovalIds: childIds,
    });
    childTarget = '';
    for (const childId of childIds) {
      await approvals.resolve(childId, {
        approved: true,
        decidedByParticipantId: 'op',
        decidedAt: '2026-01-01T00:00:00.000Z',
      });
      await expect(router.resumeApproval(childId, baseContext)).resolves.toMatchObject({
        status: 'success',
      });
    }
    expect(resumeFromMiddleware).toHaveBeenCalledOnce();
    expect(approvals.listPending(parent.conversationId)).toEqual([]);
  });

  it.each([
    ['approved', true],
    ['summary-ready-restart', true, 'summary_ready'],
    [
      'summary-ready-restart-with-parent-append',
      true,
      'summary_ready',
      false,
      false,
      false,
      'parent-append-after-commit',
    ],
    ['parent-committed-restart', true, 'parent_committed'],
    ['rejected', false],
    ['stale-retired-participant', true, undefined, true],
    ['stale-helper-origin', true, undefined, false, true],
    ['archive-storage-error', true, undefined, false, true, false, 'archive-error'],
    ['stale-missing-helper', true, undefined, false, false, false, 'missing-helper'],
    ['parent-provider-unknown', true, undefined, false, false, true],
    [
      'cached-terminal-missing-helper',
      true,
      undefined,
      false,
      false,
      true,
      'cached-missing-helper',
    ],
    ['successor-link-crash', true, undefined, false, false, false, 'successor-crash'],
    ['router-result-crash', true, undefined, false, false, false, 'router-result-crash'],
    ['stale-parent-head', true, undefined, false, false, false, 'head'],
    ['stale-selected-message', true, undefined, false, false, false, 'message'],
    ['stale-middleware-config', true, undefined, false, false, false, 'config'],
    ['stale-middleware-revision', true, undefined, false, false, false, 'revision'],
    ['stale-middleware-type', true, undefined, false, false, false, 'type'],
    ['whitespace-summary', true, undefined, false, false, false, 'whitespace'],
    ['nested-helper-restart', true, undefined, false, false, false, undefined, true],
    ['before-receive-transform', true, undefined, false, false, false, undefined, true, true],
  ] as const)(
    '%s automation compaction finalizes safely once',
    async (
      _label,
      approved,
      restartStage?: 'summary_ready' | 'parent_committed',
      retireParticipant = false,
      corruptHelperOrigin = false,
      providerThrows = false,
      staleKind?:
        | 'head'
        | 'message'
        | 'config'
        | 'revision'
        | 'type'
        | 'whitespace'
        | 'missing-helper'
        | 'archive-error'
        | 'cached-missing-helper'
        | 'successor-crash'
        | 'router-result-crash'
        | 'parent-append-after-commit',
      nestedHelper = false,
      transformWithoutRecipientApproval = false,
    ) => {
      const hookCalls: string[] = [];
      const parentExecutionOrder: string[] = [];
      let trackedParentConversationId: string | undefined;
      const {
        router,
        baseContext,
        collective,
        eventBus,
        middlewareRegistry,
        reload,
        runtimeRegistry,
        runner,
        store,
      } = await setupMiddlewareRouter(dir, {
        type: 'builtin:auto-compaction',
        displayName: 'Test compaction',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
        hooks: {
          afterReceive: (context) => {
            hookCalls.push(context.participant.id);
            return context.participant.id === 'mock-1' && context.message.role === 'user'
              ? {
                  kind: 'tool',
                  requestId: `compact:${context.conversationId}`,
                  tool: 'compact_conversation',
                  arguments: {
                    conversationId: context.conversationId,
                    messageIds: [context.message.id],
                    middlewareInstanceId: context.instance.id,
                    parentMessageId: context.message.id,
                  },
                }
              : { kind: 'continue' };
          },
        },
      });
      middlewareRegistry.register(
        {
          type: 'test:helper-gate',
          displayName: 'Helper gate',
          defaultFailureMode: 'closed',
          configSchema: { type: 'object', additionalProperties: true },
          hooks: {
            buildSystemPrompt: (context) =>
              !nestedHelper || context.instance.id === 'helper-gate-one'
                ? {
                    kind: 'tool',
                    requestId: `helper-gate:${context.instance.id}`,
                    tool: 'gate',
                    arguments: {},
                  }
                : { kind: 'continue' },
            beforeSend: (context) =>
              nestedHelper && context.instance.id === 'helper-gate-two'
                ? {
                    kind: 'tool',
                    requestId: `helper-gate:${context.instance.id}`,
                    tool: 'gate',
                    arguments: {},
                  }
                : nestedHelper && context.instance.id === 'helper-transform'
                  ? {
                      kind: 'continue',
                      message: { ...context.message, content: 'sender transformed summary' },
                    }
                  : { kind: 'continue' },
            beforeReceive: (context) =>
              nestedHelper && context.instance.id === 'helper-recipient-transform'
                ? {
                    kind: 'continue',
                    message: { ...context.message, content: 'final transformed summary' },
                  }
                : { kind: 'continue' },
          },
        },
        'test',
      );
      middlewareRegistry.register(
        {
          type: 'test:parent-tail',
          displayName: 'Parent tail',
          defaultFailureMode: 'closed',
          configSchema: { type: 'object', additionalProperties: true },
          hooks: {
            beforeReceive: (context) =>
              nestedHelper &&
              !transformWithoutRecipientApproval &&
              trackedParentConversationId !== undefined &&
              context.conversationId !== trackedParentConversationId
                ? {
                    kind: 'tool',
                    requestId: 'helper-recipient-gate',
                    tool: 'gate',
                    arguments: {},
                  }
                : { kind: 'continue' },
            afterReceive: (context) => {
              if (context.conversationId === trackedParentConversationId) {
                parentExecutionOrder.push('hook');
                if (staleKind === 'successor-crash') {
                  return {
                    kind: 'tool',
                    requestId: 'parent-successor-gate',
                    tool: 'gate',
                    arguments: {},
                  };
                }
              }
              return { kind: 'continue' };
            },
          },
        },
        'test',
      );
      await collective.update('op', { middleware: [] });
      await collective.update('mock-1', {
        tools: {
          compact_conversation: 'auto',
          ...(nestedHelper || staleKind === 'successor-crash'
            ? { gate: 'requires_approval' as const }
            : {}),
        },
        middleware: [
          {
            id: 'auto-compaction',
            type: 'builtin:auto-compaction',
            config: { summarizerParticipantId: 'agent' },
          },
          { id: 'parent-tail', type: 'test:parent-tail', config: {} },
          ...(nestedHelper
            ? [
                {
                  id: 'helper-recipient-transform',
                  type: 'test:helper-gate',
                  config: {},
                },
              ]
            : []),
        ],
      });
      await collective.update('agent', {
        tools: { gate: 'requires_approval' },
        middleware: nestedHelper
          ? [
              { id: 'helper-gate-one', type: 'test:helper-gate', config: {} },
              { id: 'helper-gate-two', type: 'test:helper-gate', config: {} },
              { id: 'helper-transform', type: 'test:helper-gate', config: {} },
            ]
          : [{ id: 'helper-gate', type: 'test:helper-gate', config: {} }],
      });
      const parentHandle = vi.fn(async () => {
        if (providerThrows) throw new Error('simulated parent provider interruption');
        return { kind: 'response' as const, content: 'parent reply' };
      });
      const helperResume = vi.fn(async () => ({
        kind: 'response' as const,
        content: staleKind === 'whitespace' ? '   \n' : 'durable summary',
      }));
      runtimeRegistry.registerFactory('mock', () => ({ handle: parentHandle }));
      runtimeRegistry.registerFactory('agent', () => ({
        async handle(incoming, context) {
          const prompt = await context.buildSystemPrompt!({
            basePrompt: 'summarize',
            iteration: 0,
            incomingMessageId: incoming.id,
            actions: [],
          });
          if (prompt.kind !== 'pending') throw new Error('Expected helper approval');
          return {
            kind: 'middleware_pending' as const,
            approvalId: prompt.approvalId,
            checkpointId: prompt.checkpointId,
          };
        },
        resumeFromMiddleware: helperResume,
      }));
      const compactTool = createCompactConversationTool();
      let compactResult: unknown;
      (baseContext.toolRegistry as ToolRegistry).register({
        ...compactTool,
        async execute(args, context) {
          trackedParentConversationId = (args as { conversationId: string }).conversationId;
          compactResult = await compactTool.execute(args, context);
          return compactResult;
        },
      });
      (baseContext.toolRegistry as ToolRegistry).register({
        name: 'gate',
        description: 'gate',
        parameters: { type: 'object' },
        async execute() {
          return { status: 'success' as const };
        },
      });
      const approvalContinuationsAtObservation: Array<string | undefined> = [];
      let observedApprovals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
      baseContext.eventBus.on('approval:requested', ({ approvalId }) => {
        approvalContinuationsAtObservation.push(
          observedApprovals.getRecord(approvalId)?.continuation?.kind,
        );
      });

      const pending = await router.send({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'old context',
        context: baseContext,
      });
      expect(hookCalls).toContain('mock-1');
      expect(compactResult).toMatchObject({ status: 'pending_approval' });
      expect(pending.status).toBe('pending_approval');
      expect(approvalContinuationsAtObservation).toEqual(['automation_compaction']);
      if (!pending.approvalId) throw new Error('Expected helper approval');
      const approvals = baseContext.pendingApprovalRegistry as PendingApprovalRegistry;
      trackedParentConversationId = pending.conversationId;
      parentExecutionOrder.length = 0;
      const claimParentExecution = approvals.claimAutomationParentExecution.bind(approvals);
      vi.spyOn(approvals, 'claimAutomationParentExecution').mockImplementation(
        async (approvalId) => {
          parentExecutionOrder.push('claim');
          return claimParentExecution(approvalId);
        },
      );
      expect(approvals.getRecord(pending.approvalId)?.continuation?.kind).toBe(
        'automation_compaction',
      );
      if (corruptHelperOrigin) {
        const continuation = approvals.getRecord(pending.approvalId)?.continuation;
        if (continuation?.kind !== 'automation_compaction') throw new Error('Expected automation');
        const helper = await store.load(continuation.helperConversationId);
        if (!helper) throw new Error('Expected helper');
        helper.origin = { ...helper.origin!, parentMessageId: 'wrong-parent-message' };
        await store.replaceForTesting(helper);
      }
      if (staleKind === 'missing-helper') {
        const continuation = approvals.getRecord(pending.approvalId)?.continuation;
        if (continuation?.kind !== 'automation_compaction') throw new Error('Expected automation');
        await baseContext.storage.delete(`conversations/${continuation.helperConversationId}.json`);
      }
      if (staleKind === 'head' || staleKind === 'message') {
        const parent = await store.load(pending.conversationId);
        if (!parent) throw new Error('Expected parent');
        if (staleKind === 'head') parent.activeBranchHead = '';
        else parent.messages[parent.activeBranchHead].content = 'changed after checkpoint';
        await store.replaceForTesting(parent);
      }
      if (staleKind === 'config' || staleKind === 'revision' || staleKind === 'type') {
        await collective.update('mock-1', {
          middleware: [
            {
              id: 'auto-compaction',
              type: staleKind === 'type' ? 'test:parent-tail' : 'builtin:auto-compaction',
              config:
                staleKind === 'config'
                  ? { summarizerParticipantId: 'agent', changed: true }
                  : { summarizerParticipantId: 'agent' },
            },
            { id: 'parent-tail', type: 'test:parent-tail', config: {} },
          ],
        });
        if (staleKind === 'config' || staleKind === 'type') {
          const registryData = await baseContext.storage.readJson<{
            records: Record<
              string,
              {
                continuation: {
                  kind: string;
                  middlewareRevision: number;
                  parentCheckpoint: { middlewareRevision: number };
                };
              }
            >;
          }>('pending-approvals/registry.json');
          const currentRevision = collective.get('mock-1')?.middlewareRevision;
          if (!registryData || currentRevision === undefined) throw new Error('Expected registry');
          const durableContinuation = registryData.records[pending.approvalId].continuation;
          durableContinuation.middlewareRevision = currentRevision;
          durableContinuation.parentCheckpoint.middlewareRevision = currentRevision;
          await baseContext.storage.writeJson('pending-approvals/registry.json', registryData);
        }
      }
      await approvals.resolve(pending.approvalId, {
        approved,
        decidedByParticipantId: 'op',
        decidedAt: '2026-01-01T00:00:00.000Z',
      });
      if (retireParticipant) await collective.retire('mock-1');

      if (staleKind === 'archive-error') {
        vi.spyOn(store, 'mutate').mockRejectedValueOnce(new Error('archive storage unavailable'));
        await expect(router.resumeApproval(pending.approvalId, baseContext)).rejects.toThrow(
          'archive storage unavailable',
        );
        const fresh = await reload();
        expect(fresh.context.pendingApprovalRegistry!.getRecord(pending.approvalId)).toMatchObject({
          lifecycle: 'decided',
          routerResult: { status: 'error' },
          continuation: { kind: 'automation_compaction' },
        });
        await expect(
          fresh.router.resumeApproval(pending.approvalId, fresh.context),
        ).resolves.toMatchObject({ status: 'error' });
        expect(
          (await reload()).context.pendingApprovalRegistry!.getRecord(pending.approvalId),
        ).toMatchObject({ lifecycle: 'acknowledged' });
        return;
      }

      if (staleKind === 'cached-missing-helper') {
        vi.spyOn(approvals, 'acknowledge').mockRejectedValueOnce(
          new Error('simulated acknowledgement interruption'),
        );
        const terminal = await router.resumeApproval(pending.approvalId, baseContext);
        const continuation = approvals.getRecord(pending.approvalId)?.continuation;
        if (continuation?.kind !== 'automation_compaction') throw new Error('Expected automation');
        await baseContext.storage.delete(`conversations/${continuation.helperConversationId}.json`);
        const freshOne = await reload();
        const freshTwo = await reload();
        const [duplicateOne, duplicateTwo] = await Promise.all([
          freshOne.router.resumeApproval(pending.approvalId, freshOne.context),
          freshTwo.router.resumeApproval(pending.approvalId, freshTwo.context),
        ]);
        expect(duplicateOne).toEqual(terminal);
        expect(duplicateTwo).toEqual(terminal);
        expect(
          (await reload()).context.pendingApprovalRegistry!.getRecord(pending.approvalId),
        ).toMatchObject({ lifecycle: 'acknowledged' });
        return;
      }

      if (staleKind === 'successor-crash' || staleKind === 'router-result-crash') {
        const continuation = approvals.getRecord(pending.approvalId)?.continuation;
        if (continuation?.kind !== 'automation_compaction') throw new Error('Expected automation');
        const completed = await router.resumeApproval(pending.approvalId, baseContext);
        expect(completed).toMatchObject(
          staleKind === 'successor-crash'
            ? { status: 'pending_approval' }
            : { status: 'success', response: 'parent reply' },
        );
        const storedRegistry = await baseContext.storage.readJson<{
          records: Record<string, Record<string, unknown>>;
        }>('pending-approvals/registry.json');
        const source = storedRegistry!.records[pending.approvalId];
        source.lifecycle = 'decided';
        source.continuation = continuation;
        source.automationCompaction = {
          ...(source.automationCompaction as Record<string, unknown>),
          lifecycle: 'parent_committed',
        };
        await baseContext.storage.writeJson('pending-approvals/registry.json', storedRegistry);

        const fresh = await reload();
        const recovered = await fresh.router.resumeApproval(pending.approvalId, fresh.context);
        expect(recovered).toMatchObject(completed);
        expect(parentExecutionOrder).toEqual(['claim', 'hook']);
        expect(parentHandle).toHaveBeenCalledTimes(staleKind === 'successor-crash' ? 0 : 1);
        expect(
          (await reload()).context.pendingApprovalRegistry!.getRecord(pending.approvalId),
        ).toMatchObject({
          lifecycle: 'acknowledged',
          automationCompaction: { lifecycle: 'completed' },
        });
        return;
      }

      if (nestedHelper) {
        const handoff = await router.resumeApproval(pending.approvalId, baseContext);
        expect(handoff).toMatchObject({ status: 'pending_approval' });
        if (!handoff.approvalId) throw new Error('Expected nested helper approval');
        expect(approvalContinuationsAtObservation).toEqual([
          'automation_compaction',
          'automation_compaction',
        ]);
        expect(approvals.getRecord(pending.approvalId)).toMatchObject({
          lifecycle: 'acknowledged',
          successorApprovalIds: [handoff.approvalId],
        });
        const fresh = await reload();
        observedApprovals = fresh.context.pendingApprovalRegistry!;
        await fresh.context.pendingApprovalRegistry!.resolve(handoff.approvalId, {
          approved: true,
          decidedByParticipantId: 'op',
          decidedAt: '2026-01-01T00:00:00.000Z',
        });
        const nextHandoff = await fresh.router.resumeApproval(handoff.approvalId, fresh.context);
        if (transformWithoutRecipientApproval) {
          expect(nextHandoff.status, nextHandoff.error).toBe('success');
          expect(nextHandoff.response).toBe('parent reply');
          const parent = await store.load(pending.conversationId);
          expect(
            Object.values(parent!.messages).filter(
              (message) =>
                message.type === 'summary' && message.content === 'final transformed summary',
            ),
          ).toHaveLength(1);
          expect(helperResume).toHaveBeenCalledOnce();
          expect(parentHandle).toHaveBeenCalledOnce();
          return;
        }
        expect(nextHandoff).toMatchObject({ status: 'pending_approval' });
        if (!nextHandoff.approvalId) throw new Error('Expected recipient helper approval');
        expect(approvalContinuationsAtObservation).toEqual([
          'automation_compaction',
          'automation_compaction',
          'automation_compaction',
        ]);
        const finalFresh = await reload();
        observedApprovals = finalFresh.context.pendingApprovalRegistry!;
        await finalFresh.context.pendingApprovalRegistry!.resolve(nextHandoff.approvalId, {
          approved: true,
          decidedByParticipantId: 'op',
          decidedAt: '2026-01-01T00:00:00.000Z',
        });
        const [completed, duplicate] = await Promise.all([
          finalFresh.router.resumeApproval(nextHandoff.approvalId, finalFresh.context),
          finalFresh.router.resumeApproval(nextHandoff.approvalId, finalFresh.context),
        ]);
        expect(completed.status, completed.error).toBe('success');
        expect(completed.response).toBe('parent reply');
        expect(duplicate).toEqual(completed);
        expect(helperResume).toHaveBeenCalledOnce();
        expect(parentHandle).toHaveBeenCalledOnce();
        const parent = await store.load(pending.conversationId);
        expect(
          Object.values(parent!.messages).filter(
            (message) =>
              message.type === 'summary' && message.content === 'final transformed summary',
          ),
        ).toHaveLength(1);
        const helper = (await store.list({ status: 'all' })).find(
          (conversation) => conversation.origin?.parentConversationId === pending.conversationId,
        );
        expect(helper?.status).toBe('archived');
        const finalRegistry = await PendingApprovalRegistry.load(
          baseContext.storage as FileStorage,
        );
        expect(finalRegistry.getRecord(nextHandoff.approvalId)).toMatchObject({
          lifecycle: 'acknowledged',
          routerResult: { status: 'success' },
        });
        expect(finalRegistry.getRecord(nextHandoff.approvalId)?.continuation).toBeUndefined();
        return;
      }

      if (restartStage === 'summary_ready') {
        vi.spyOn(approvals, 'recordAutomationParentCommitted').mockRejectedValueOnce(
          new Error('simulated restart after parent commit'),
        );
      } else if (restartStage === 'parent_committed') {
        vi.spyOn(approvals, 'claimAutomationParentExecution').mockResolvedValueOnce('unknown');
      }
      let first: Awaited<ReturnType<typeof router.resumeApproval>>;
      let second: Awaited<ReturnType<typeof router.resumeApproval>>;
      let third: Awaited<ReturnType<typeof router.resumeApproval>> | undefined;
      if (restartStage) {
        first = await router.resumeApproval(pending.approvalId, baseContext);
        if (staleKind === 'parent-append-after-commit') {
          await store.mutate(pending.conversationId, (parent) =>
            appendMessage(parent, {
              senderId: 'op',
              recipientId: 'mock-1',
              role: 'user',
              content: 'new context after compaction commit',
            }),
          );
        }
        const freshOne = await reload();
        const freshTwo = await reload();
        [second, third] = await Promise.all([
          freshOne.router.resumeApproval(pending.approvalId, freshOne.context),
          freshTwo.router.resumeApproval(pending.approvalId, freshTwo.context),
        ]);
      } else {
        [first, second] = await Promise.all([
          router.resumeApproval(pending.approvalId, baseContext),
          router.resumeApproval(pending.approvalId, baseContext),
        ]);
      }

      if (restartStage) {
        expect(first).toMatchObject({ status: 'error' });
        expect(second).toMatchObject({ status: 'success', response: 'parent reply' });
        expect(third).toEqual(second);
      } else {
        expect(second).toEqual(first);
      }
      const parent = await store.load(pending.conversationId);
      const summaries = Object.values(parent!.messages).filter(
        (message) => message.type === 'summary' && message.content === 'durable summary',
      );
      if (providerThrows) {
        expect(second).toEqual(first);
        expect(first).toMatchObject({
          status: 'error',
          error: 'Automation parent provider outcome unknown and was not retried',
        });
        expect(helperResume).toHaveBeenCalledOnce();
        expect(parentHandle).toHaveBeenCalledOnce();
        expect(parentExecutionOrder).toEqual(['claim', 'hook']);
        expect(summaries).toHaveLength(1);
      } else if (
        approved &&
        !retireParticipant &&
        !corruptHelperOrigin &&
        (staleKind === undefined || staleKind === 'parent-append-after-commit')
      ) {
        const completed = restartStage ? second : first;
        expect(completed.status, completed.error).toBe('success');
        expect(completed.response).toBe('parent reply');
        expect(helperResume).toHaveBeenCalledOnce();
        expect(parentHandle).toHaveBeenCalledOnce();
        expect(parentExecutionOrder).toEqual(restartStage ? ['hook'] : ['claim', 'hook']);
        expect(summaries).toHaveLength(1);
        expect(parent?.middlewareState?.['mock-1']?.['auto-compaction']).toEqual({
          summaryMessageId: summaries[0].id,
        });
      } else {
        expect(first.status).toBe('error');
        expect(helperResume).toHaveBeenCalledTimes(
          corruptHelperOrigin || staleKind === 'missing-helper' ? 0 : approved ? 1 : 0,
        );
        expect(parentHandle).not.toHaveBeenCalled();
        expect(summaries).toHaveLength(0);
        expect(parent?.middlewareState).toBeUndefined();
      }
      const helper = (await store.list({ status: 'all' })).find(
        (conversation) => conversation.origin?.parentConversationId === pending.conversationId,
      );
      if (staleKind === 'missing-helper') expect(helper).toBeUndefined();
      else if (corruptHelperOrigin) expect(helper?.status).toBe('active');
      else expect(helper?.status).toBe('archived');
      if (!corruptHelperOrigin) {
        const terminal = restartStage ? second : first;
        const freshOne = await reload();
        const freshTwo = await reload();
        const [duplicateOne, duplicateTwo] = await Promise.all([
          freshOne.router.resumeApproval(pending.approvalId, freshOne.context),
          freshTwo.router.resumeApproval(pending.approvalId, freshTwo.context),
        ]);
        expect(duplicateOne).toEqual(terminal);
        expect(duplicateTwo).toEqual(terminal);
        expect(
          freshOne.context.pendingApprovalRegistry!.getRecord(pending.approvalId),
        ).toMatchObject({
          lifecycle: 'acknowledged',
          routerResult: { status: terminal.status },
        });
        expect(
          freshOne.context.pendingApprovalRegistry!.getRecord(pending.approvalId)?.continuation,
        ).toBeUndefined();
      } else {
        const freshOne = await reload();
        const freshTwo = await reload();
        const [duplicateOne, duplicateTwo] = await Promise.all([
          freshOne.router.resumeApproval(pending.approvalId, freshOne.context),
          freshTwo.router.resumeApproval(pending.approvalId, freshTwo.context),
        ]);
        expect(duplicateOne).toEqual(first);
        expect(duplicateTwo).toEqual(first);
        expect(
          freshOne.context.pendingApprovalRegistry!.getRecord(pending.approvalId),
        ).toMatchObject({
          lifecycle: 'acknowledged',
          routerResult: { status: 'error', error: first.error },
        });
        expect(
          freshOne.context.pendingApprovalRegistry!.getRecord(pending.approvalId)?.continuation,
        ).toBeUndefined();
      }
    },
  );

  it('passes inbound and prompt actions to every response lifecycle hook', async () => {
    const observed: string[][] = [];
    const { router, baseContext, collective, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Ledger middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) => {
          if (context.participant.id === 'op' && context.message.role === 'user') {
            return { kind: 'tool', requestId: 'inbound', tool: 'record', arguments: {} };
          }
          if (context.participant.id === 'agent') {
            observed.push(context.actions.map((action) => action.requestId));
          }
          return { kind: 'continue', message: context.message };
        },
        beforeReceive: (context) => {
          if (context.participant.id === 'op') {
            observed.push(context.actions.map((action) => action.requestId));
          }
          return { kind: 'continue', message: context.message };
        },
        buildSystemPrompt: (context) => ({
          kind: 'tool',
          requestId: `prompt-${context.actions.length}`,
          tool: 'record',
          arguments: {},
        }),
        afterSend: (context) => {
          if (context.participant.id === 'agent') {
            observed.push(context.actions.map((action) => action.requestId));
          }
          return { kind: 'continue' };
        },
        afterReceive: (context) => {
          if (context.mode === 'post_response' && context.participant.id === 'op') {
            observed.push(context.actions.map((action) => action.requestId));
          }
          return { kind: 'continue' };
        },
      },
    });
    await collective.update('op', { tools: { record: 'auto' } });
    await collective.update('agent', {
      tools: { record: 'auto' },
      middleware: [{ id: 'agent-middleware', type: 'test:router-middleware', config: {} }],
    });
    (baseContext.toolRegistry as ToolRegistry).register({
      name: 'record',
      description: 'records middleware action',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success', data: 'recorded' };
      },
    });
    runtimeRegistry.registerFactory('agent', () => ({
      async handle(incoming, context) {
        const first = await context.buildSystemPrompt!({
          basePrompt: 'Base prompt',
          iteration: 0,
          incomingMessageId: incoming.id,
          actions: context.middlewareActions ?? [],
        });
        if (first.kind !== 'continue') throw new Error('first prompt did not continue');
        const second = await context.buildSystemPrompt!({
          basePrompt: 'Base prompt',
          iteration: 1,
          incomingMessageId: incoming.id,
          actions: first.actions,
        });
        if (second.kind !== 'continue') throw new Error('second prompt did not continue');
        return { kind: 'response' as const, content: 'done', actions: second.actions };
      },
    }));

    await router.send({
      senderId: 'op',
      recipientId: 'agent',
      message: 'ledger',
      context: baseContext,
    });

    expect(observed).toEqual([
      ['inbound', 'prompt-1', 'prompt-2'],
      ['inbound', 'prompt-1', 'prompt-2'],
      ['inbound', 'prompt-1', 'prompt-2'],
      ['inbound', 'prompt-1', 'prompt-2'],
    ]);
  });

  it('runs agent prompt middleware before streaming provider calls', async () => {
    const { router, baseContext, collective, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Streaming prompt middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        buildSystemPrompt: () => ({
          kind: 'continue',
          change: { operation: 'append', content: ':stream' },
        }),
      },
    });
    await collective.update('agent', {
      middleware: [{ id: 'agent-middleware', type: 'test:router-middleware', config: {} }],
    });
    const requests: ProviderMessage[][] = [];
    const provider: Provider = {
      async *stream(messages) {
        requests.push(messages);
        yield { type: 'text_delta', delta: 'streamed' };
        yield { type: 'done', stopReason: 'stop' };
      },
    };
    const modelRouter = {
      async resolveWithId() {
        return { provider, providerId: 'test' };
      },
    } as ModelRouter;
    runtimeRegistry.registerFactory('agent', (id) => new AgentRuntime(id, modelRouter));

    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'agent',
      message: 'stream prompt',
      context: baseContext,
    });
    let next = await stream.next();
    while (!next.done) next = await stream.next();

    expect(next.value).toMatchObject({ status: 'success', response: 'streamed' });
    expect(requests).toHaveLength(1);
    expect(requests[0][0]).toMatchObject({ role: 'system', content: 'Base prompt:stream' });
  });

  it.each([
    ['abort', () => ({ kind: 'abort', error: 'stop' }), 'error'],
    [
      'pending approval',
      () => ({ kind: 'tool', requestId: 'gate', tool: 'gate', arguments: {} }),
      'pending_approval',
    ],
  ])(
    'prevents streaming provider calls after prompt %s',
    async (_name, buildSystemPrompt, status) => {
      const { router, baseContext, collective, runtimeRegistry } = await setupMiddlewareRouter(
        dir,
        {
          type: 'test:router-middleware',
          displayName: 'Streaming prompt terminal',
          defaultFailureMode: 'closed',
          configSchema: { type: 'object', additionalProperties: true },
          hooks: { buildSystemPrompt },
        },
      );
      await collective.update('agent', {
        tools: { gate: 'requires_approval' },
        middleware: [{ id: 'agent-middleware', type: 'test:router-middleware', config: {} }],
      });
      let providerCalls = 0;
      const provider: Provider = {
        async *stream() {
          providerCalls += 1;
          yield { type: 'text_delta', delta: 'must not stream' };
          yield { type: 'done', stopReason: 'stop' };
        },
      };
      const modelRouter = {
        async resolveWithId() {
          return { provider, providerId: 'test' };
        },
      } as ModelRouter;
      runtimeRegistry.registerFactory('agent', (id) => new AgentRuntime(id, modelRouter));

      const stream = router.sendStream({
        senderId: 'op',
        recipientId: 'agent',
        message: 'stream terminal',
        context: baseContext,
      });
      const chunks: LLMChunk[] = [];
      let next = await stream.next();
      while (!next.done) {
        chunks.push(next.value);
        next = await stream.next();
      }

      expect(next.value.status).toBe(status);
      expect(chunks).toEqual([]);
      expect(providerCalls).toBe(0);
    },
  );

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

  it.each(['sync', 'fire-and-forget', 'stream'] as const)(
    'runs identical final middleware lifecycle for %s send',
    async (mode) => {
      const calls: string[] = [];
      const { router, baseContext, store, runtimeRegistry } = await setupMiddlewareRouter(dir, {
        type: 'test:router-middleware',
        displayName: 'Parity middleware',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
        hooks: {
          beforeSend: (context) => {
            calls.push(`${context.participant.id}:beforeSend`);
            return {
              kind: 'continue',
              message: {
                ...context.message,
                content:
                  context.message.role === 'user'
                    ? `IN:${context.message.content}`
                    : `OUT:${context.message.content}`,
              },
            };
          },
          beforeReceive: (context) => {
            calls.push(`${context.participant.id}:beforeReceive`);
            return { kind: 'continue', message: context.message };
          },
          afterSend: (context) => {
            calls.push(`${context.participant.id}:afterSend`);
            return { kind: 'continue' };
          },
          afterReceive: (context) => {
            calls.push(`${context.participant.id}:afterReceive:${context.mode}`);
            return { kind: 'continue' };
          },
        },
      });
      runtimeRegistry.registerFactory('mock', () => ({
        async handle() {
          return { kind: 'response' as const, content: 'response' };
        },
        async *handleStream() {
          return { kind: 'response' as const, content: 'response' };
        },
      }));

      let conversationId: string;
      if (mode === 'stream') {
        const stream = router.sendStream({
          senderId: 'op',
          recipientId: 'mock-1',
          message: 'hello',
          context: baseContext,
        });
        let next = await stream.next();
        while (!next.done) next = await stream.next();
        conversationId = next.value.conversationId;
      } else {
        const result = await router.send({
          senderId: 'op',
          recipientId: 'mock-1',
          message: 'hello',
          ...(mode === 'fire-and-forget' ? { replyTo: 'op' } : {}),
          context: baseContext,
        });
        conversationId = result.conversationId;
        if (mode === 'fire-and-forget') await router.drain();
      }

      expect(calls).toEqual([
        'op:beforeSend',
        'mock-1:beforeReceive',
        'op:afterSend',
        'mock-1:afterReceive:pre_runtime',
        'mock-1:beforeSend',
        'op:beforeReceive',
        'mock-1:afterSend',
        'op:afterReceive:post_response',
      ]);
      expect(
        Object.values((await store.load(conversationId))!.messages).map(
          (message) => message.content,
        ),
      ).toEqual(['IN:hello', 'OUT:response']);
    },
  );

  it('generates without rerunning inbound middleware phases', async () => {
    const calls: string[] = [];
    const { router, baseContext, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Generate middleware',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) => {
          calls.push(`${context.participant.id}:beforeSend:${context.message.role}`);
          return { kind: 'continue', message: context.message };
        },
      },
    });
    runtimeRegistry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'response' as const, content: 'response' };
      },
    }));

    const sent = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });
    calls.length = 0;

    await router.generate(sent.conversationId, 'mock-1', baseContext);
    await router.drain();

    expect(calls).not.toContain('op:beforeSend:user');
    expect(calls).toContain('mock-1:beforeSend:assistant');
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

  it('supports explicit disposal via Symbol.asyncDispose (aborts and closes the generator)', async () => {
    const { router, baseContext } = await setup(dir);
    const gen = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'dispose me',
      context: baseContext,
    });

    expect(typeof gen[Symbol.asyncDispose]).toBe('function');
    await gen[Symbol.asyncDispose]();

    const after = await gen.next();
    expect(after.done).toBe(true);
  });

  it('rejects unknown senders before creating a streaming conversation', async () => {
    const { router, baseContext, eventBus } = await setup(dir);
    let created = 0;
    eventBus.on('conversation:created', () => (created += 1));

    const stream = router.sendStream({
      senderId: 'ghost',
      recipientId: 'mock-1',
      message: 'nope',
      context: baseContext,
    });
    const result = await stream.next();

    expect(result).toMatchObject({
      done: true,
      value: { conversationId: '', status: 'error', error: expect.stringMatching(/ghost/) },
    });
    expect(created).toBe(0);
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

  it('persists the partial assistant message when the stream is aborted mid-response', async () => {
    const { baseContext, store, eventBus, collective } = await setup(dir);
    const registry = new RuntimeRegistry();
    registry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'void' as const };
      },
      async *handleStream(_incoming: unknown, context: { signal: AbortSignal }) {
        yield { type: 'iteration_start', iteration: 0 } as const;
        yield { type: 'reasoning_delta', delta: 'thinking ' } as const;
        yield { type: 'text_delta', delta: 'partial ' } as const;
        yield { type: 'text_delta', delta: 'answer' } as const;
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', resolve));
        return { kind: 'response' as const, content: 'must not win' };
      },
    }));
    const plainRouter = new MessageRouter(store, registry, collective, eventBus);
    const controller = new AbortController();
    const delivered: string[] = [];
    eventBus.on('message:delivered', (event) => delivered.push(event.messageId));

    const stream = plainRouter.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'abort me',
      context: { ...baseContext, signal: controller.signal },
    });

    for (let i = 0; i < 4; i++) {
      const chunk = await stream.next();
      expect(chunk.done).toBe(false);
    }
    const terminal = stream.next();
    controller.abort();
    let terminalResult = await terminal;
    while (!terminalResult.done) terminalResult = await stream.next();

    expect(terminalResult).toMatchObject({
      done: true,
      value: { status: 'success', response: 'partial answer' },
    });

    const conv = await store.load(terminalResult.value.conversationId);
    const messages = Object.values(conv!.messages);
    const partial = messages.find((m) => m.role === 'assistant');
    expect(partial).toBeDefined();
    expect(partial!.content).toBe('partial answer');
    expect(partial!.reasoning).toBe('thinking ');
    expect(delivered).toContain(partial!.id);
  });

  it('keeps the error terminal when aborted before any content streamed', async () => {
    const { baseContext, store, eventBus, collective } = await setup(dir);
    const registry = new RuntimeRegistry();
    registry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'void' as const };
      },
      async *handleStream(_incoming: unknown, context: { signal: AbortSignal }) {
        yield { type: 'iteration_start', iteration: 0 } as const;
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', resolve));
        return { kind: 'response' as const, content: 'must not persist' };
      },
    }));
    const plainRouter = new MessageRouter(store, registry, collective, eventBus);
    const controller = new AbortController();

    const stream = plainRouter.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'abort early',
      context: { ...baseContext, signal: controller.signal },
    });

    await stream.next();
    const terminal = stream.next();
    controller.abort();
    const terminalResult = await terminal;

    expect(terminalResult).toMatchObject({ done: true, value: { status: 'error' } });
    const conv = await store.load(terminalResult.value.conversationId);
    expect(Object.values(conv!.messages)).toHaveLength(1);
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

describe('MessageRouter: middleware response streaming', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-middleware-stream-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects an already-aborted stream before creating or appending a conversation', async () => {
    const { router, baseContext, eventBus } = await setup(dir);
    const controller = new AbortController();
    controller.abort();
    let created = 0;
    let sent = 0;
    eventBus.on('conversation:created', () => (created += 1));
    eventBus.on('message:sent', () => (sent += 1));

    await expect(
      router
        .sendStream({
          senderId: 'op',
          recipientId: 'mock-1',
          message: 'cancelled',
          context: { ...baseContext, signal: controller.signal },
        })
        .next(),
    ).resolves.toMatchObject({ done: true, value: { status: 'error' } });
    expect(created).toBe(0);
    expect(sent).toBe(0);
  });

  it('transforms provisional deltas, runs one final draft pass, and persists final draft', async () => {
    const hooks: { final: boolean; iteration?: number; chunk?: LLMChunk }[] = [];
    const { router, baseContext, store, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Streaming response transform',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) => {
          if (context.message.role !== 'assistant') return { kind: 'continue' };
          hooks.push({ final: context.final, iteration: context.iteration, chunk: context.chunk });
          return {
            kind: 'continue',
            message: {
              ...context.message,
              content: context.message.content.toUpperCase(),
              reasoning: context.message.reasoning?.toUpperCase(),
            },
          };
        },
      },
    });
    runtimeRegistry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'void' as const };
      },
      async *handleStream() {
        yield { type: 'iteration_start', iteration: 4 } as const;
        yield { type: 'reasoning_delta', delta: 'why' } as const;
        yield { type: 'tool_call_start', index: 0, id: 'tool-1', name: 'unchanged' } as const;
        yield { type: 'text_delta', delta: 'answer' } as const;
        return { kind: 'response' as const, content: 'answer', reasoning: 'why' };
      },
    }));

    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'stream',
      context: baseContext,
    });
    const chunks: LLMChunk[] = [];
    let next = await stream.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await stream.next();
    }

    expect(chunks).toEqual([
      { type: 'iteration_start', iteration: 4 },
      { type: 'reasoning_delta', delta: 'WHY' },
      { type: 'tool_call_start', index: 0, id: 'tool-1', name: 'unchanged' },
      { type: 'text_delta', delta: 'ANSWER' },
    ]);
    expect(hooks).toEqual([
      { final: false, iteration: 4, chunk: { type: 'reasoning_delta', delta: 'why' } },
      { final: false, iteration: 4, chunk: { type: 'text_delta', delta: 'answer' } },
      { final: true, iteration: undefined, chunk: undefined },
    ]);
    expect(next.value).toMatchObject({ status: 'success', response: 'ANSWER' });
    const response = Object.values((await store.load(next.value.conversationId))!.messages).find(
      (message) => message.role === 'assistant',
    );
    expect(response).toMatchObject({ content: 'ANSWER', reasoning: 'WHY' });
  });

  it('retracts and aborts a rejected provisional response without persisting it', async () => {
    let runtimeFinally = false;
    const { router, baseContext, store, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Streaming response rejection',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) =>
          context.message.role === 'assistant'
            ? { kind: 'reject', error: 'blocked stream' }
            : { kind: 'continue' },
      },
    });
    runtimeRegistry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'void' as const };
      },
      async *handleStream() {
        try {
          yield { type: 'iteration_start', iteration: 0 } as const;
          yield { type: 'text_delta', delta: 'secret' } as const;
          yield { type: 'text_delta', delta: 'must not continue' } as const;
          return { kind: 'response' as const, content: 'secret' };
        } finally {
          runtimeFinally = true;
        }
      },
    }));

    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'stream',
      context: baseContext,
    });
    const chunks: LLMChunk[] = [];
    let next = await stream.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await stream.next();
    }

    expect(chunks).toEqual([
      { type: 'iteration_start', iteration: 0 },
      { type: 'message_snapshot', content: '' },
    ]);
    expect(next.value).toMatchObject({ status: 'error', error: 'blocked stream' });
    expect(runtimeFinally).toBe(true);
    expect(Object.values((await store.load(next.value.conversationId))!.messages)).toHaveLength(1);
  });

  it('holds conversation lock through stream cancellation, then releases queued send', async () => {
    const { router, baseContext, store } = await setup(dir);
    const conversation = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const registry = new RuntimeRegistry();
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    let calls = 0;
    registry.registerFactory('mock', () => ({
      async handle() {
        calls += 1;
        return { kind: 'response' as const, content: 'queued' };
      },
      async *handleStream() {
        calls += 1;
        streamStarted();
        try {
          yield { type: 'iteration_start', iteration: 0 } as const;
          await new Promise<void>(() => undefined);
          return { kind: 'void' as const };
        } finally {
          // Generator cancellation must release MessageRouter's conversation lock.
        }
      },
    }));
    const lockedRouter = new MessageRouter(
      store,
      registry,
      baseContext.collective as typeof baseContext.collective,
      baseContext.eventBus as EventBus,
    );
    const first = lockedRouter.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'first',
      conversationId: conversation.id,
      context: baseContext,
    });
    await first.next();
    await started;
    const queued = lockedRouter.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'second',
      conversationId: conversation.id,
      context: baseContext,
    });
    await Promise.resolve();
    expect(calls).toBe(1);

    await first.return({ conversationId: conversation.id, status: 'success' });
    await expect(queued).resolves.toMatchObject({ status: 'success', response: 'queued' });
    expect(calls).toBe(2);
  });

  it('keeps provisional failure-open actions when final runtime actions arrive', async () => {
    const finalActions: string[][] = [];
    const { router, baseContext, runtimeRegistry } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Streaming action ledger',
      defaultFailureMode: 'open',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) => {
          if (context.message.role !== 'assistant') return { kind: 'continue' };
          if (!context.final) {
            return { kind: 'tool', requestId: 'provisional', tool: 'missing', arguments: {} };
          }
          finalActions.push(context.actions.map((action) => action.requestId));
          return { kind: 'continue' };
        },
      },
    });
    runtimeRegistry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'void' as const };
      },
      async *handleStream() {
        yield { type: 'iteration_start', iteration: 0 } as const;
        yield { type: 'text_delta', delta: 'draft' } as const;
        return {
          kind: 'response' as const,
          content: 'draft',
          actions: [
            {
              requestId: 'runtime',
              participantId: 'mock-1',
              instanceId: 'runtime',
              tool: 'runtime_tool',
              status: 'success' as const,
              result: { status: 'success' as const, data: 'done' },
            },
          ],
        };
      },
    }));

    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'stream',
      context: baseContext,
    });
    let next = await stream.next();
    while (!next.done) next = await stream.next();

    expect(next.value.status).toBe('success');
    expect(finalActions).toEqual([['provisional', 'runtime']]);
  });

  it('returns from a blocked agent provider on abort and releases its conversation lock', async () => {
    const { router, baseContext, collective, runtimeRegistry, store } = await setupMiddlewareRouter(
      dir,
      {
        type: 'test:router-middleware',
        displayName: 'Blocked provider',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
        hooks: {},
      },
    );
    await collective.update('agent', {
      middleware: [{ id: 'agent-middleware', type: 'test:router-middleware', config: {} }],
    });
    let providerSignal: AbortSignal | undefined;
    const provider: Provider = {
      async *stream(_messages, _tools, _model, options) {
        providerSignal = options?.signal;
        await new Promise<void>(() => undefined);
      },
    };
    const modelRouter = {
      async resolveWithId() {
        return { provider, providerId: 'test' };
      },
    } as ModelRouter;
    runtimeRegistry.registerFactory('agent', (id) => new AgentRuntime(id, modelRouter));
    runtimeRegistry.registerFactory('mock', (id) => new MockRuntime(id));
    const controller = new AbortController();
    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'agent',
      message: 'block',
      context: { ...baseContext, signal: controller.signal },
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'iteration_start', iteration: 0 },
    });
    const terminal = stream.next();
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort();
    let terminalResult: Awaited<typeof terminal> | undefined;
    void terminal.then((result) => {
      terminalResult = result;
    });
    await vi.waitFor(() => expect(terminalResult).toBeDefined());
    expect(terminalResult).toMatchObject({
      done: true,
      value: { status: 'error', error: expect.stringMatching(/cancelled|aborted/i) },
    });
    const conversationId = terminalResult!.value.conversationId;
    expect(Object.values((await store.load(conversationId))!.messages)).toHaveLength(1);

    await expect(
      router.send({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'queued',
        conversationId,
        context: baseContext,
      }),
    ).resolves.toMatchObject({ status: 'success' });
  });

  it('persists emitted partial output when a lifecycle stream aborts', async () => {
    let finalCalls = 0;
    const { router, baseContext, runtimeRegistry, store, eventBus } = await setupMiddlewareRouter(
      dir,
      {
        type: 'test:router-middleware',
        displayName: 'Abort persistence',
        defaultFailureMode: 'closed',
        configSchema: { type: 'object', additionalProperties: true },
        hooks: {
          beforeSend: (context) => {
            if (context.message.role !== 'assistant' || !context.final) return { kind: 'continue' };
            finalCalls += 1;
            return {
              kind: 'continue',
              message: { ...context.message, content: `${context.message.content} finalized` },
            };
          },
        },
      },
    );
    runtimeRegistry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'void' as const };
      },
      async *handleStream(_incoming, context) {
        yield { type: 'iteration_start', iteration: 0 } as const;
        yield { type: 'text_delta', delta: 'partial' } as const;
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', resolve));
        return { kind: 'response' as const, content: 'must not persist' };
      },
    }));
    const controller = new AbortController();
    const delivered: string[] = [];
    eventBus.on('message:delivered', (event) => delivered.push(event.messageId));
    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'abort',
      context: { ...baseContext, signal: controller.signal },
    });

    await stream.next();
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'text_delta', delta: 'partial' },
    });
    const terminal = stream.next();
    controller.abort();
    let terminalResult = await terminal;
    while (!terminalResult.done) terminalResult = await stream.next();
    expect(terminalResult).toMatchObject({
      done: true,
      value: { status: 'success', response: 'partial finalized' },
    });
    const messages = Object.values(
      (await store.load(terminalResult.value.conversationId))!.messages,
    );
    expect(messages).toHaveLength(2);
    const partial = messages.find((message) => message.role === 'assistant');
    expect(partial).toMatchObject({
      content: 'partial finalized',
    });
    expect(finalCalls).toBe(1);
    expect(delivered).toEqual([partial!.id]);
  });

  it('keeps final middleware rejection authoritative when a stream aborts', async () => {
    const { router, baseContext, runtimeRegistry, store } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Abort rejection',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) =>
          context.message.role === 'assistant' && context.final
            ? { kind: 'reject', error: 'partial rejected' }
            : { kind: 'continue' },
      },
    });
    runtimeRegistry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'void' as const };
      },
      async *handleStream(_incoming, context) {
        yield { type: 'iteration_start', iteration: 0 } as const;
        yield { type: 'text_delta', delta: 'partial' } as const;
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', resolve));
        return { kind: 'response' as const, content: 'must not persist' };
      },
    }));
    const controller = new AbortController();
    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'abort',
      context: { ...baseContext, signal: controller.signal },
    });
    await stream.next();
    await stream.next();

    const terminal = stream.next();
    controller.abort();

    let result = await terminal;
    while (!result.done) result = await stream.next();
    expect(result).toMatchObject({
      done: true,
      value: { status: 'error', error: 'partial rejected' },
    });
    expect(Object.values((await store.load(result.value.conversationId))!.messages)).toHaveLength(
      1,
    );
  });

  it('finalizes the last emitted draft when cancellation interrupts a blocked push', async () => {
    const { router, baseContext, runtimeRegistry, store } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Blocked provisional hook',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) => {
          if (
            context.message.role === 'assistant' &&
            !context.final &&
            context.message.content === 'approved blocked'
          ) {
            return new Promise(() => undefined);
          }
          return context.message.role === 'assistant' && context.final
            ? {
                kind: 'continue',
                message: { ...context.message, content: `${context.message.content} finalized` },
              }
            : { kind: 'continue' };
        },
      },
    });
    runtimeRegistry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'void' as const };
      },
      async *handleStream() {
        yield { type: 'iteration_start', iteration: 0 } as const;
        yield { type: 'text_delta', delta: 'approved' } as const;
        yield { type: 'text_delta', delta: ' blocked' } as const;
        return { kind: 'response' as const, content: 'approved blocked' };
      },
    }));
    const controller = new AbortController();
    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'abort push',
      context: { ...baseContext, signal: controller.signal },
    });
    await stream.next();
    await stream.next();
    const terminal = stream.next();
    controller.abort();

    let result = await terminal;
    while (!result.done) result = await stream.next();
    expect(result).toMatchObject({
      done: true,
      value: { status: 'success', response: 'approved finalized' },
    });
    const response = Object.values((await store.load(result.value.conversationId))!.messages).find(
      (message) => message.role === 'assistant',
    );
    expect(response?.content).toBe('approved finalized');
  });

  it('restarts final middleware with the emitted draft when cancellation interrupts finish', async () => {
    let finalCalls = 0;
    const finalActions: string[][] = [];
    const { router, baseContext, runtimeRegistry, store } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Blocked final hook',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {
        beforeSend: (context) => {
          if (context.message.role !== 'assistant' || !context.final) return { kind: 'continue' };
          finalCalls += 1;
          finalActions.push(context.actions.map((action) => action.requestId));
          if (finalCalls === 1) return new Promise(() => undefined);
          return {
            kind: 'continue',
            message: { ...context.message, content: `${context.message.content} finalized` },
          };
        },
      },
    });
    runtimeRegistry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'void' as const };
      },
      async *handleStream() {
        yield { type: 'iteration_start', iteration: 0 } as const;
        yield { type: 'text_delta', delta: 'complete' } as const;
        return {
          kind: 'response' as const,
          content: 'complete',
          actions: [
            {
              requestId: 'runtime',
              participantId: 'mock-1',
              instanceId: 'runtime',
              tool: 'runtime_tool',
              status: 'success' as const,
              result: { status: 'success' as const, data: 'done' },
            },
          ],
        };
      },
    }));
    const controller = new AbortController();
    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'abort finish',
      context: { ...baseContext, signal: controller.signal },
    });
    await stream.next();
    await stream.next();
    const terminal = stream.next();
    await vi.waitFor(() => expect(finalCalls).toBe(1));
    controller.abort();

    let result = await terminal;
    while (!result.done) result = await stream.next();
    expect(result).toMatchObject({
      done: true,
      value: { status: 'success', response: 'complete finalized' },
    });
    const response = Object.values((await store.load(result.value.conversationId))!.messages).find(
      (message) => message.role === 'assistant',
    );
    expect(response?.content).toBe('complete finalized');
    expect(finalActions).toEqual([['runtime'], ['runtime']]);
  });

  it('blocks late custom-runtime appends after cancellation before releasing its lock', async () => {
    const { router, baseContext, runtimeRegistry, store } = await setupMiddlewareRouter(dir, {
      type: 'test:router-middleware',
      displayName: 'Late append guard',
      defaultFailureMode: 'closed',
      configSchema: { type: 'object', additionalProperties: true },
      hooks: {},
    });
    let appendBlocked = false;
    runtimeRegistry.registerFactory('mock', () => ({
      async handle() {
        return { kind: 'response' as const, content: 'queued' };
      },
      async *handleStream(_incoming, context) {
        yield { type: 'iteration_start', iteration: 0 } as const;
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', resolve));
        try {
          await context.conversation.append({
            senderId: 'mock-1',
            recipientId: 'op',
            role: 'assistant',
            content: 'late append',
          });
        } catch {
          appendBlocked = true;
        }
        return { kind: 'response' as const, content: 'late response' };
      },
    }));
    const controller = new AbortController();
    const stream = router.sendStream({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'cancel',
      context: { ...baseContext, signal: controller.signal },
    });

    await stream.next();
    const terminal = stream.next();
    controller.abort();
    const result = await terminal;
    expect(result).toMatchObject({ done: true, value: { status: 'error' } });
    await vi.waitFor(() => expect(appendBlocked).toBe(true));
    expect(Object.values((await store.load(result.value.conversationId))!.messages)).toHaveLength(
      1,
    );
    await expect(
      router.send({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'queued',
        conversationId: result.value.conversationId,
        context: baseContext,
      }),
    ).resolves.toMatchObject({ status: 'success' });
  });
});
