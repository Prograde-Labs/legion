import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceConfig, ToolResult } from '@legion-collective/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { EventBus } from '../events/EventBus.js';
import { MessageRouter } from '../runtime/MessageRouter.js';
import { RuntimeRegistry } from '../runtime/RuntimeRegistry.js';
import { FileStorage } from '../storage/FileStorage.js';
import type {
  MessageRouterPort,
  MessageRouterResult,
  ToolContext,
  ToolRegistryLike,
} from '../tools/Tool.js';
import type { LegionService } from './LegionService.js';
import { ServiceContextImpl, type ServiceContextDeps } from './ServiceContextImpl.js';
import { ServiceRuntime } from './ServiceRuntime.js';

/**
 * File-local equivalent of ES2024 `Promise.withResolvers()` (Node >= 22 only;
 * the project supports Node >= 20).
 */
function withResolvers<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BASE_CONFIG: ServiceConfig = {
  id: 'svc-test',
  name: 'Test Service',
  type: 'service',
  module: './test-svc.js',
  tools: { file_read: 'auto' },
};

function makeMockToolRegistry(toolResult: ToolResult): ToolRegistryLike {
  const tool = {
    name: 'file_read',
    description: 'reads a file',
    parameters: {},
    execute: async () => toolResult,
  };
  return {
    get: (name: string) => (name === 'file_read' ? tool : undefined),
    has: (name: string) => name === 'file_read',
    list: () => [tool],
    listAll: () => ['file_read'],
    execute: async (name: string, _args: unknown, _ctx: unknown) =>
      name === 'file_read'
        ? toolResult
        : ({ status: 'error', error: `Tool '${name}' not found` } as ToolResult),
    async *stream(name: string) {
      yield { type: 'stream:error', error: `Tool '${name}' not found` } as any;
    },
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'legion-svc-ctx-'));
  const storage = new FileStorage(dir);
  const store = new FileConversationStore(storage);
  const conv = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
  const abortController = new AbortController();

  const routerResult: MessageRouterResult = {
    conversationId: conv.id,
    status: 'success',
    response: 'router response',
  };
  const mockRouter: MessageRouterPort = {
    send: vi.fn().mockResolvedValue(routerResult),
    resume: vi.fn(),
    sendStream: async function* () {
      return { conversationId: 'mock', status: 'success' as const };
    },
  };

  const deps: ServiceContextDeps = {
    participant: BASE_CONFIG,
    conversationId: conv.id,
    store,
    collective: {
      getOrThrow: vi.fn().mockReturnValue(BASE_CONFIG),
      get: vi.fn(),
      list: vi.fn(),
    } as any,
    toolRegistry: makeMockToolRegistry({ status: 'success', data: 'file content' }),
    workspaceConfig: { version: '2' } as any,
    eventBus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() } as any,
    scopedStorage: storage.scope('services/svc-test'),
    rawStorage: storage,
    workspaceRoot: dir,
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: {
      create: vi.fn(),
      get: vi.fn(),
      resolve: vi.fn(),
      getAll: vi.fn(),
    } as any,
    middlewareConfigurationValidator: { validate: vi.fn() },
    messageRouter: mockRouter,
    stopped: abortController.signal,
    serviceManager: undefined,
  };

  return { dir, deps, conv, mockRouter, abortController };
}

/**
 * Real-router harness: no mocked `MessageRouter`, so the service path exercises
 * the router's conversation locking and reply-waiter machinery end to end.
 */
async function setupRealRouter() {
  const dir = await mkdtemp(join(tmpdir(), 'legion-svc-ctx-router-'));
  const storage = new FileStorage(dir);
  await storage.writeJson('collective/participants/svc-test.json', {
    ...BASE_CONFIG,
    status: 'active',
  });
  await storage.writeJson('collective/participants/op.json', {
    id: 'op',
    name: 'Op',
    type: 'user',
    tools: {},
    status: 'active',
  });
  await storage.writeJson('collective/participants/bot.json', {
    id: 'bot',
    name: 'Bot',
    type: 'mock',
    tools: {},
    responses: [],
    status: 'active',
  });

  const collective = await Collective.load(storage);
  const eventBus = new EventBus();
  const store = new FileConversationStore(storage, eventBus);
  const abortController = new AbortController();
  const pendingApprovalRegistry = {
    create: vi.fn(),
    get: vi.fn(),
    resolve: vi.fn(),
    getAll: vi.fn(),
  } as any;
  const authEngine = new AuthEngine();
  const toolRegistry = makeMockToolRegistry({ status: 'success', data: 'file content' });

  const humanDelivered = withResolvers<string>();
  const registry = new RuntimeRegistry();
  registry.registerFactory('user', () => ({
    async handle(_incoming, context) {
      humanDelivered.resolve(context.conversationId);
      return { kind: 'void' as const, delivery: { status: 'delivered' as const } };
    },
  }));
  registry.registerFactory('mock', (id) => ({
    async handle() {
      return { kind: 'response' as const, content: `echo from ${id}` };
    },
  }));

  const router = new MessageRouter(store, registry, collective, eventBus, undefined, undefined, {
    replyTimeoutMs: 1000,
  });

  const makeContext = (conversationId: string): ServiceContextImpl =>
    new ServiceContextImpl({
      participant: BASE_CONFIG,
      conversationId,
      store,
      collective,
      toolRegistry,
      workspaceConfig: { version: '2' } as any,
      eventBus,
      scopedStorage: storage.scope('services/svc-test'),
      rawStorage: storage,
      workspaceRoot: dir,
      authEngine,
      pendingApprovalRegistry,
      middlewareConfigurationValidator: { validate: vi.fn() },
      messageRouter: router,
      stopped: abortController.signal,
      serviceManager: undefined,
    });

  const service: LegionService = {
    async start() {},
    async stop() {},
    async onMessage(_message, ctx) {
      const result = await ctx.communicate('op', 'question?');
      return result.response;
    },
  };
  registry.registerFactory('service', () => new ServiceRuntime(service, {}, makeContext));

  const toolContext = {
    collective,
    config: { version: '2' },
    eventBus,
    storage,
    workspaceRoot: dir,
    communicationDepth: 0,
    toolRegistry,
    authEngine,
    pendingApprovalRegistry,
  } as unknown as ToolContext;

  return { dir, router, store, toolContext, humanDelivered };
}

describe('ServiceContextImpl', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('exposes participantId from the participant config', async () => {
    const { dir: d, deps } = await setup();
    dir = d;
    const ctx = new ServiceContextImpl(deps);
    expect(ctx.participantId).toBe('svc-test');
  });

  it('exposes the stopped AbortSignal', async () => {
    const { dir: d, deps } = await setup();
    dir = d;
    const ctx = new ServiceContextImpl(deps);
    expect(ctx.stopped).toBe(deps.stopped);
  });

  it('exposes scoped storage (not raw storage)', async () => {
    const { dir: d, deps } = await setup();
    dir = d;
    const ctx = new ServiceContextImpl(deps);
    expect(ctx.storage).toBe(deps.scopedStorage);
    expect(ctx.storage).not.toBe(deps.rawStorage);
  });

  it('exposes the eventBus', async () => {
    const { dir: d, deps } = await setup();
    dir = d;
    const ctx = new ServiceContextImpl(deps);
    expect(ctx.eventBus).toBe(deps.eventBus);
  });

  describe('callTool', () => {
    it('forwards middleware validator into tool context', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const execute = vi.fn().mockResolvedValue({ status: 'success' });
      const validator = { validate: vi.fn() };
      const ctx = new ServiceContextImpl({
        ...deps,
        toolRegistry: { ...deps.toolRegistry, execute },
        middlewareConfigurationValidator: validator,
      });

      await ctx.callTool('file_read', {});

      expect(execute).toHaveBeenCalledWith(
        'file_read',
        {},
        expect.objectContaining({ middlewareValidator: validator }),
      );
    });

    it('executes an authorized tool and returns the result', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      const result = await ctx.callTool('file_read', { path: 'test.txt' });
      expect(result).toEqual({ status: 'success', data: 'file content' });
    });

    it('returns error result when tool is not in participant tools map (hidden)', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl({
        ...deps,
        participant: { ...BASE_CONFIG, tools: {} }, // file_read absent = hidden
      });
      const result = await ctx.callTool('file_read', {});
      expect(result.status).toBe('error');
      expect((result as any).error).toMatch(/not available/i);
    });

    it('fails closed for requires_approval (no authority chain in service context)', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl({
        ...deps,
        participant: { ...BASE_CONFIG, tools: { file_read: 'requires_approval' } },
      });
      const result = await ctx.callTool('file_read', {});
      expect(result.status).toBe('error');
      expect((result as any).error).toMatch(/requires_approval/i);
    });

    it('fails closed when arguments violate the tool scope', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl({
        ...deps,
        participant: {
          ...BASE_CONFIG,
          tools: { file_read: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } } },
        },
      });
      const result = await ctx.callTool('file_read', { path: '../escape.txt' });
      expect(result.status).toBe('error');
      expect((result as { error: string }).error).toMatch(
        /argument scope violation: file_read\.path/,
      );
    });
  });

  describe('communicate', () => {
    it('calls messageRouter.send with correct sender, recipient, and message', async () => {
      const { dir: d, deps, mockRouter } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      await ctx.communicate('agent-b', 'hello there');
      expect(mockRouter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: 'svc-test',
          recipientId: 'agent-b',
          message: 'hello there',
        }),
      );
    });

    it('does not reuse the context conversationId when none is supplied', async () => {
      const { dir: d, deps, conv, mockRouter } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      await ctx.communicate('agent-b', 'hello there');
      const call = vi.mocked(mockRouter.send).mock.calls[0][0];
      expect(call.conversationId).toBeUndefined();
      expect(call.conversationId).not.toBe(conv.id);
    });

    it('returns a CommunicateResult mapped from MessageRouterResult', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      const result = await ctx.communicate('agent-b', 'ping');
      expect(result.status).toBe('success');
      expect(result.response).toBe('router response');
    });

    it('passes replyTo when provided in opts', async () => {
      const { dir: d, deps, mockRouter } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      await ctx.communicate('agent-b', 'async task', { replyTo: 'op-1' });
      expect(mockRouter.send).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'op-1' }));
    });

    it('uses supplied conversationId when provided', async () => {
      const { dir: d, deps, mockRouter } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      await ctx.communicate('agent-b', 'msg', { conversationId: 'conv-override' });
      expect(mockRouter.send).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-override' }),
      );
    });

    it('maps a router timeout to deadline exceeded', async () => {
      const { dir: d, deps, mockRouter } = await setup();
      dir = d;
      vi.mocked(mockRouter.send).mockResolvedValueOnce({
        conversationId: 'conv-timeout',
        status: 'timeout',
        partial: true,
      });
      const ctx = new ServiceContextImpl(deps);

      const result = await ctx.communicate('op-1', 'question');

      expect(result).toMatchObject({
        conversationId: 'conv-timeout',
        status: 'error',
        error: 'deadline exceeded',
      });
    });
  });

  describe('sleep', () => {
    it('resolves after the given number of milliseconds', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      const start = Date.now();
      await ctx.sleep(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });

    it('resolves early (without throwing) when the stopped signal fires', async () => {
      const { dir: d, deps, abortController } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      // Abort after 20ms while sleep is waiting for 5000ms.
      setTimeout(() => abortController.abort(), 20);
      const start = Date.now();
      await ctx.sleep(5000);
      expect(Date.now() - start).toBeLessThan(300);
    });
  });

  describe('communicate through a real router', () => {
    let dir: string;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('does not deadlock when a synchronously dispatched service asks a human', async () => {
      const { dir: d, router, store, toolContext, humanDelivered } = await setupRealRouter();
      dir = d;
      const conversation = await store.create({
        schemaVersion: '2.0',
        activeBranchHead: '',
        messages: {},
      });

      // The outer dispatch holds `conversation.id`'s lock while the service runs.
      const outer = router.send({
        senderId: 'bot',
        recipientId: 'svc-test',
        message: 'please ask the operator',
        conversationId: conversation.id,
        context: toolContext,
      });

      // The service's `communicate` created a child conversation; the human
      // runtime reports its id once the question is delivered.
      const humanConversationId = await humanDelivered.promise;
      expect(humanConversationId).not.toBe(conversation.id);

      const reply = await router.send({
        senderId: 'op',
        recipientId: 'svc-test',
        message: 'the human answer',
        conversationId: humanConversationId,
        context: toolContext,
      });
      expect(reply).toMatchObject({ status: 'success' });

      await expect(outer).resolves.toMatchObject({
        status: 'success',
        response: 'the human answer',
      });
    }, 5000);
  });
});
