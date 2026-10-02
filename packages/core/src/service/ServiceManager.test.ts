import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServiceConfig } from '@legion-collective/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileStorage } from '../storage/FileStorage.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { MessageRouterPort } from '../tools/Tool.js';
import { ServiceManager, type ServiceManagerDeps } from './ServiceManager.js';

const BASE_CONFIG: ServiceConfig = {
  id: 'svc-1',
  name: 'Test Service',
  type: 'service',
  module: '',
  tools: {},
  autoStart: false,
};

async function writeModule(dir: string, src: string): Promise<string> {
  const path = join(dir, `svc-${Date.now()}.mjs`);
  await writeFile(path, src, 'utf8');
  return path;
}

const ECHO_SRC = `
export const service = {
  async start(_ctx) {},
  async stop() {},
  async onMessage(msg, _ctx) { return 'echo: ' + msg.content; },
};
`.trimStart();

const CRASH_SRC = `
export const service = {
  async start() { throw new Error('boot failure'); },
  async stop() {},
};
`.trimStart();

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'legion-svcmgr-'));
  const storage = new FileStorage(dir);
  const store = new FileConversationStore(storage);

  const mockRouter: MessageRouterPort = {
    send: vi.fn().mockResolvedValue({ conversationId: 'c1', status: 'success' }),
    resume: vi.fn(),
    sendStream: async function* () {
      return { conversationId: 'mock', status: 'success' as const };
    },
  };
  const eventBus = { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() } as any;
  const collective = {
    getOrThrow: vi.fn().mockReturnValue(BASE_CONFIG),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    listActive: vi.fn().mockReturnValue([]),
  } as any;
  const toolRegistry = { get: vi.fn(), has: vi.fn(), list: vi.fn(), execute: vi.fn() } as any;

  const deps: ServiceManagerDeps = {
    collective,
    store,
    toolRegistry,
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
    middlewareConfigurationValidator: { validate: vi.fn() },
    messageRouter: mockRouter,
    eventBus,
    storage,
    workspaceConfig: { version: '2' } as any,
    workspaceRoot: dir,
  };

  const manager = new ServiceManager(deps);
  return { dir, deps, manager, mockRouter, eventBus };
}

describe('ServiceManager', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loadService stores the runtime and sets status to stopped', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    expect(manager.getStatus('svc-1')).toBe('stopped');
    expect(manager.getRuntime('svc-1')).toBeDefined();
  });

  it('forwards middleware validator into service tool contexts', async () => {
    const { manager, deps, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(
      d,
      `export const service = { async start(ctx) { await ctx.callTool('test', {}); }, async stop() {} };`,
    );
    const validator = { validate: vi.fn() };
    const execute = vi.fn().mockResolvedValue({ status: 'success' });
    deps.middlewareConfigurationValidator = validator;
    (deps.toolRegistry as { execute: unknown }).execute = execute;

    await manager.loadService({ ...BASE_CONFIG, module: modPath, tools: { test: 'auto' } });
    await manager.startService('svc-1');

    expect(execute).toHaveBeenCalledWith(
      'test',
      {},
      expect.objectContaining({ middlewareValidator: validator }),
    );
  });

  it('loadService throws ConfigError when the module lacks a service export', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, `export const notAService = {};`);
    await expect(manager.loadService({ ...BASE_CONFIG, module: modPath })).rejects.toThrow(
      /service.*export|named.*service/i,
    );
  });

  it('getRuntime throws ParticipantNotFoundError for an unloaded service', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    expect(() => manager.getRuntime('ghost')).toThrow(/ghost/);
  });

  it('startService transitions status to running', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.startService('svc-1');
    expect(manager.getStatus('svc-1')).toBe('running');
  });

  it('startService is idempotent when already running', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.startService('svc-1');
    await manager.startService('svc-1');
    expect(manager.getStatus('svc-1')).toBe('running');
  });

  it('marks service failed and emits error event when start() throws', async () => {
    const { manager, dir: d, eventBus } = await setup();
    dir = d;
    const modPath = await writeModule(d, CRASH_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.startService('svc-1');
    expect(manager.getStatus('svc-1')).toBe('failed');
    const info = manager.getAll().find((s) => s.participantId === 'svc-1');
    expect(info?.error).toMatch(/boot failure/);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ error: expect.objectContaining({ message: 'boot failure' }) }),
    );
  });

  it('sends errorNotify message when start() throws and errorNotify is set', async () => {
    const { manager, dir: d, mockRouter } = await setup();
    dir = d;
    const modPath = await writeModule(d, CRASH_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath, errorNotify: 'op-1' });
    await manager.startService('svc-1');
    expect(mockRouter.send).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: 'svc-1', recipientId: 'op-1' }),
    );
  });

  it('stopService transitions status to stopped', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.startService('svc-1');
    expect(manager.getStatus('svc-1')).toBe('running');
    await manager.stopService('svc-1');
    expect(manager.getStatus('svc-1')).toBe('stopped');
  });

  it('stopService is idempotent when already stopped', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.stopService('svc-1');
    expect(manager.getStatus('svc-1')).toBe('stopped');
  });

  it('autoStart starts services where autoStart is not false', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath, autoStart: true });
    await manager.autoStart();
    expect(manager.getStatus('svc-1')).toBe('running');
  });

  it('autoStart skips services where autoStart is explicitly false', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath, autoStart: false });
    await manager.autoStart();
    expect(manager.getStatus('svc-1')).toBe('stopped');
  });

  it('getAll returns ServiceInfo for every loaded service', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    const all = manager.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ participantId: 'svc-1', status: 'stopped' });
  });
});
