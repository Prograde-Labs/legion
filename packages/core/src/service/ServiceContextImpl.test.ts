import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceConfig, ToolResult } from '@legion/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileStorage } from '../storage/FileStorage.js';
import type { MessageRouterPort, MessageRouterResult, ToolRegistryLike } from '../tools/Tool.js';
import { ServiceContextImpl, type ServiceContextDeps } from './ServiceContextImpl.js';

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

  it('exposes the service participant config', async () => {
    const { dir: d, deps } = await setup();
    dir = d;
    const participant = { ...deps.participant, config: { reportTo: 'caretaker' } };
    const ctx = new ServiceContextImpl({ ...deps, participant });
    expect(ctx.config).toEqual({ reportTo: 'caretaker' });
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

    it('passes conversationStore into the tool context (conversation tools work from services)', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const execute = vi.fn().mockResolvedValue({ status: 'success' });
      const ctx = new ServiceContextImpl({
        ...deps,
        participant: { ...deps.participant, tools: { list_conversations: 'auto' } },
        toolRegistry: { ...deps.toolRegistry, execute },
      });

      await ctx.callTool('list_conversations', {});

      expect(execute).toHaveBeenCalledWith(
        'list_conversations',
        {},
        expect.objectContaining({ conversationStore: deps.store }),
      );
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
});
