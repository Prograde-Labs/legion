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
import type { ToolContext } from '../tools/Tool.js';

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
  const collective = await Collective.load(storage);
  const store = new FileConversationStore(storage);
  const eventBus = new EventBus();
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

describe('MessageRouter: synchronous send', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('routes a message to a mock and returns its response', async () => {
    const { router, baseContext, store } = await setup(dir);
    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });
    expect(result.status).toBe('success');
    expect(result.response).toBe('hello back');
    expect(result.conversationId).toMatch(/^conv-/);

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

  it('emits message:sent for inbound and response', async () => {
    const { router, baseContext, eventBus } = await setup(dir);
    let sent = 0;
    eventBus.on('message:sent', () => (sent += 1));
    await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });
    expect(sent).toBe(2);
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
    await storage.writeJson('collective/participants/mock-1.json', {
      id: 'mock-1',
      name: 'M',
      type: 'mock',
      tools: {},
      responses: [],
      status: 'active',
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(storage);
    const eventBus = new EventBus();
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
    await storage.writeJson('collective/participants/mock-1.json', {
      id: 'mock-1',
      name: 'M',
      type: 'mock',
      tools: {},
      responses: ['resumed response'],
      status: 'active',
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(storage);
    const eventBus = new EventBus();
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
