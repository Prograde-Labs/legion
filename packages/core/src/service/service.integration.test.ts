import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MessageData, ServiceConfig } from '@legion/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileStorage } from '../storage/FileStorage.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { MessageRouterPort } from '../tools/Tool.js';
import { ServiceManager } from './ServiceManager.js';

describe('Service SDK integration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-svc-int-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('full lifecycle: load → start → handle message → stop', async () => {
    // ── Write a real service module to disk ────────────────────────────────────
    const modPath = join(dir, 'echo-service.mjs');
    await writeFile(
      modPath,
      `
export const service = {
  started: false,
  stopped: false,
  async start(_ctx) { this.started = true; },
  async stop() { this.stopped = true; },
  async onMessage(msg, _ctx) {
    return 'Echo from service: ' + msg.content;
  },
};
`.trimStart(),
    );

    // ── Assemble real dependencies ─────────────────────────────────────────────
    const storage = new FileStorage(dir);
    const store = new FileConversationStore(storage);
    const authEngine = new AuthEngine();
    const pendingApprovalRegistry = new PendingApprovalRegistry();
    const eventBus = { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() } as any;

    const mockRouter: MessageRouterPort = {
      send: vi.fn().mockResolvedValue({ conversationId: 'c1', status: 'success' }),
      resume: vi.fn(),
    };

    const collective = {
      getOrThrow: vi.fn().mockReturnValue({ id: 'svc-echo', type: 'service', tools: {} }),
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      listActive: vi.fn().mockReturnValue([]),
    } as any;

    const toolRegistry = {
      get: vi.fn().mockReturnValue(undefined),
      has: vi.fn().mockReturnValue(false),
      list: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockResolvedValue({ status: 'error', error: 'not found' }),
    } as any;

    const manager = new ServiceManager({
      collective,
      store,
      toolRegistry,
      authEngine,
      pendingApprovalRegistry,
      messageRouter: mockRouter,
      eventBus,
      storage,
      workspaceConfig: { version: '2' } as any,
      workspaceRoot: dir,
    });

    const config: ServiceConfig = {
      id: 'svc-echo',
      name: 'Echo Service',
      type: 'service',
      module: modPath,
      tools: {},
      autoStart: false,
    };

    // ── Load and start ─────────────────────────────────────────────────────────
    await manager.loadService(config);
    expect(manager.getStatus('svc-echo')).toBe('stopped');

    await manager.startService('svc-echo');
    expect(manager.getStatus('svc-echo')).toBe('running');

    // ── Dispatch a message via the ServiceRuntime ──────────────────────────────
    const runtime = manager.getRuntime('svc-echo');

    const conv = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    const incomingMsg: MessageData = {
      id: 'msg-1',
      parentId: null,
      conversationId: conv.id,
      senderId: 'op-1',
      recipientId: 'svc-echo',
      role: 'user',
      content: 'integration test ping',
      status: 'active',
      timestamp: new Date().toISOString(),
    };

    const result = await runtime.handle(incomingMsg, {} as any);
    expect(result).toEqual({
      kind: 'response',
      content: 'Echo from service: integration test ping',
    });

    // ── Stop ───────────────────────────────────────────────────────────────────
    await manager.stopService('svc-echo');
    expect(manager.getStatus('svc-echo')).toBe('stopped');

    // ── getAll reflects final state ────────────────────────────────────────────
    const all = manager.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ participantId: 'svc-echo', status: 'stopped' });
  });

  it('service without onMessage declines inbound messages gracefully', async () => {
    const modPath = join(dir, 'silent-service.mjs');
    await writeFile(modPath, `export const service = { async start() {}, async stop() {} };\n`);

    const storage = new FileStorage(dir);
    const store = new FileConversationStore(storage);

    const manager = new ServiceManager({
      collective: {
        getOrThrow: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        listActive: vi.fn().mockReturnValue([]),
      } as any,
      store,
      toolRegistry: { get: vi.fn(), has: vi.fn(), list: vi.fn(), execute: vi.fn() } as any,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
      messageRouter: { send: vi.fn(), resume: vi.fn() } as any,
      eventBus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() } as any,
      storage,
      workspaceConfig: { version: '2' } as any,
      workspaceRoot: dir,
    });

    await manager.loadService({
      id: 'svc-silent',
      name: 'Silent',
      type: 'service',
      module: modPath,
      tools: {},
    });
    await manager.startService('svc-silent');

    const runtime = manager.getRuntime('svc-silent');
    const result = await runtime.handle(
      {
        id: 'msg-1',
        parentId: null,
        conversationId: 'c1',
        senderId: 'op-1',
        recipientId: 'svc-silent',
        role: 'user',
        content: 'hi',
        status: 'active',
        timestamp: new Date().toISOString(),
      },
      {} as any,
    );
    expect(result.kind).toBe('response');
    expect((result as any).content).toMatch(/does not accept/i);
  });
});
