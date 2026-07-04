import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { FileStorage } from '../storage/FileStorage.js';
import { writeMeta } from './process-storage.js';
import { readMeta } from './process-storage.js';
import { ProcessManager } from './ProcessManager.js';
import type { ProcessMeta } from '@legion/types';

// ── Fake spawner ────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdin = {
    write: vi.fn((_data: Buffer, cb?: (err?: Error | null) => void) => {
      cb?.();
    }),
    end: vi.fn(),
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 9999;
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    // Auto-emit exit so stop() resolves in tests
    setImmediate(() => this.emit('exit', signal === 'SIGKILL' ? null : 0, signal ?? null));
    return true;
  }
}

function makeFakeSpawn(child: FakeChild) {
  return vi.fn().mockReturnValue(child);
}

async function makeManager(fakeChild?: FakeChild) {
  const dir = await mkdtemp(join(tmpdir(), 'legion-pm-'));
  // Match production layout: FileStorage root = <workspace>/.legion
  const storage = new FileStorage(join(dir, '.legion'));
  const child = fakeChild ?? new FakeChild();
  const manager = new ProcessManager({
    storage,
    workspaceRoot: dir,
    spawn: makeFakeSpawn(child) as any,
    ptySpawn: vi.fn() as any,
  });
  return { manager, storage, dir, child };
}

// ── Fake PTY ────────────────────────────────────────────────────────────────

class FakePty extends EventEmitter {
  readonly pid = 8888;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = '';
  handleFlowControl = false;
  killed = false;
  private exitEmitted = false;

  onData(cb: (data: string) => void): { dispose(): void } {
    this.on('data', cb);
    return { dispose: () => this.off('data', cb) };
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.on('exit', cb);
    return { dispose: () => this.off('exit', cb) };
  }

  resize(_columns: number, _rows: number): void {}

  clear(): void {}

  write(_data: string | Buffer): void {}

  kill(signal?: string): void {
    if (this.exitEmitted) return;
    this.killed = true;
    this.exitEmitted = true;
    setImmediate(() =>
      this.emit('exit', {
        exitCode: signal === 'SIGKILL' ? undefined : 0,
        signal: signal === 'SIGKILL' ? 9 : undefined,
      }),
    );
  }

  pause(): void {}

  resume(): void {}
}

async function makePtyManager(fakePty?: FakePty) {
  const dir = await mkdtemp(join(tmpdir(), 'legion-pm-pty-'));
  const storage = new FileStorage(join(dir, '.legion'));
  const ptyChild = fakePty ?? new FakePty();
  const ptySpawn = vi.fn().mockReturnValue(ptyChild);
  const manager = new ProcessManager({
    storage,
    workspaceRoot: dir,
    spawn: vi.fn() as any,
    ptySpawn: ptySpawn as any,
  });
  return { manager, storage, dir, ptyChild };
}

// ── reconcileOnStartup ───────────────────────────────────────────────────────

describe('ProcessManager.reconcileOnStartup', () => {
  it('marks stale running entries as abandoned', async () => {
    const { manager, storage, dir } = await makeManager();
    const stale: ProcessMeta = {
      id: 'proc-stale-1',
      command: 'sleep',
      args: ['999'],
      cwd: dir,
      tty: false,
      shell: false,
      startedAt: '2026-01-01T00:00:00.000Z',
      startedByParticipantId: 'user-1',
      pid: 11111,
      status: 'running',
      exitCode: null,
      exitedAt: null,
    };
    const scoped = storage.scope('processes');
    await writeMeta(scoped, stale);

    await manager.reconcileOnStartup();

    const updated = await readMeta(scoped, 'proc-stale-1');
    expect(updated?.status).toBe('abandoned');
    expect(updated?.exitCode).toBeNull();
    expect(updated?.exitedAt).not.toBeNull();
    expect(updated?.abandonedReason).toBe('parent_unclean_shutdown');
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves clean entries untouched', async () => {
    const { manager, storage, dir } = await makeManager();
    const clean: ProcessMeta = {
      id: 'proc-clean-1',
      command: 'echo',
      args: [],
      cwd: dir,
      tty: false,
      shell: false,
      startedAt: '2026-01-01T00:00:00.000Z',
      startedByParticipantId: 'user-1',
      pid: 22222,
      status: 'exited',
      exitCode: 0,
      exitedAt: '2026-01-01T00:01:00.000Z',
    };
    const scoped = storage.scope('processes');
    await writeMeta(scoped, clean);

    await manager.reconcileOnStartup();

    const result = await readMeta(scoped, 'proc-clean-1');
    expect(result?.status).toBe('exited');
    await rm(dir, { recursive: true, force: true });
  });
});

// ── start ────────────────────────────────────────────────────────────────────

describe('ProcessManager.start', () => {
  it('spawns process, persists running meta, returns handle', async () => {
    const { manager, child, dir } = await makeManager();

    const handle = await manager.start({ command: 'sleep', args: ['10'], cwd: dir }, 'user-1');

    expect(handle.command).toBe('sleep');
    expect(handle.status).toBe('running');
    expect(handle.pid).toBe(9999);
    expect(handle.id).toMatch(/^proc-/);

    const got = manager.get(handle.id);
    expect(got).toBeDefined();
    expect(got?.status).toBe('running');

    await rm(dir, { recursive: true, force: true });
  });

  it('returns error result on spawn failure (ENOENT)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legion-pm-'));
    const badChild = new FakeChild();
    const spawnFn = vi.fn().mockImplementation(() => {
      setImmediate(() => {
        const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
        badChild.emit('error', err);
      });
      return badChild;
    });
    // Match production layout
    const storage = new FileStorage(join(dir, '.legion'));
    const manager = new ProcessManager({
      storage,
      workspaceRoot: dir,
      spawn: spawnFn as any,
      ptySpawn: vi.fn() as any,
    });

    await expect(manager.start({ command: 'does-not-exist' }, 'user-1')).rejects.toThrow('ENOENT');

    await rm(dir, { recursive: true, force: true });
  });
});

// ── stop ─────────────────────────────────────────────────────────────────────

describe('ProcessManager.stop', () => {
  it('sends SIGTERM and resolves after exit', async () => {
    const { manager, child, dir } = await makeManager();
    const handle = await manager.start({ command: 'sleep', args: ['999'] }, 'user-1');

    await manager.stop(handle.id);

    const updated = manager.get(handle.id);
    expect(['killed', 'exited']).toContain(updated?.status);
    expect(child.killed).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('errors on non-running process', async () => {
    const { manager, dir } = await makeManager();
    await expect(manager.stop('proc-does-not-exist')).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── writeInput ────────────────────────────────────────────────────────────────

describe('ProcessManager.writeInput', () => {
  it('writes data to child stdin in pipe mode', async () => {
    const { manager, child, dir } = await makeManager();
    const handle = await manager.start({ command: 'cat' }, 'user-1');

    await manager.writeInput(handle.id, 'hello\n');
    expect(child.stdin.write).toHaveBeenCalledWith(Buffer.from('hello\n'), expect.any(Function));
    await rm(dir, { recursive: true, force: true });
  });

  it('closes stdin on eof:true', async () => {
    const { manager, child, dir } = await makeManager();
    const handle = await manager.start({ command: 'cat' }, 'user-1');

    await manager.writeInput(handle.id, '', true);
    expect(child.stdin.end).toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── subscribe ─────────────────────────────────────────────────────────────────

describe('ProcessManager.subscribe', () => {
  it('receives output events and can unsubscribe', async () => {
    const { manager, child, dir } = await makeManager();
    const handle = await manager.start({ command: 'echo', args: ['hi'] }, 'user-1');

    const received: Buffer[] = [];
    const unsub = manager.subscribe(handle.id, 'output', (evt) => {
      received.push((evt as any).data);
    });

    child.stdout.emit('data', Buffer.from('hello'));
    expect(received).toHaveLength(1);

    unsub();
    child.stdout.emit('data', Buffer.from('world'));
    expect(received).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });
});

// ── execute ───────────────────────────────────────────────────────────────────

describe('ProcessManager.execute', () => {
  it('captures stdout and returns on exit', async () => {
    const { manager, child, dir } = await makeManager();

    const resultP = manager.execute({ command: 'echo', args: ['hi'] }, 'user-1');

    // Wait for start to fully complete (two awaits) before emitting, so the
    // output/exit listeners are attached when we emit.
    await new Promise<void>((r) => setTimeout(r, 20));
    child.stdout.emit('data', Buffer.from('hi\n'));
    child.emit('exit', 0, null);

    const result = await resultP;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hi');
    expect(result.timedOut).toBe(false);
    expect(result.processId).toMatch(/^proc-/);
    await rm(dir, { recursive: true, force: true });
  });

  it('returns timedOut:true when timeout exceeded', async () => {
    const { manager, child, dir } = await makeManager();

    child.kill = vi.fn().mockImplementation(() => {
      setImmediate(() => child.emit('exit', null, 'SIGKILL'));
      return true;
    });

    const resultP = manager.execute({ command: 'sleep', args: ['999'] }, 'user-1', {
      timeoutMs: 1,
    });

    const result = await resultP;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe('ProcessManager.list', () => {
  it('returns running processes from live map', async () => {
    const { manager, dir } = await makeManager();
    await manager.start({ command: 'sleep' }, 'user-1');

    const results = await manager.list({ status: 'running' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('running');
    await rm(dir, { recursive: true, force: true });
  });
});

// ── readOutput ────────────────────────────────────────────────────────────────

describe('ProcessManager.readOutput', () => {
  it('returns ring buffer tail when from not specified', async () => {
    const { manager, child, dir } = await makeManager();
    const handle = await manager.start({ command: 'echo' }, 'user-1');

    child.stdout.emit('data', Buffer.from('hello world'));

    const result = await manager.readOutput(handle.id);
    expect(result.data.toString()).toContain('hello world');
    await rm(dir, { recursive: true, force: true });
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe('ProcessManager.delete', () => {
  it('removes dead process from live map and storage', async () => {
    const { manager, child, dir } = await makeManager();
    const handle = await manager.start({ command: 'echo' }, 'user-1');

    await new Promise<void>((resolve) => {
      manager.subscribe(handle.id, 'exited', () => resolve());
      child.emit('exit', 0, null);
    });

    await manager.delete(handle.id);
    expect(manager.get(handle.id)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to delete running process', async () => {
    const { manager, dir } = await makeManager();
    const handle = await manager.start({ command: 'sleep' }, 'user-1');
    await expect(manager.delete(handle.id)).rejects.toThrow('running');
    await rm(dir, { recursive: true, force: true });
  });
});

// ── shutdown ──────────────────────────────────────────────────────────────────

describe('ProcessManager.shutdown', () => {
  it('kills all running processes and clears the live map', async () => {
    const { manager, child, dir } = await makeManager();
    await manager.start({ command: 'sleep' }, 'user-1');

    await manager.shutdown();

    expect(child.killed).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

// ── PTY mode ──────────────────────────────────────────────────────────────────

describe('ProcessManager PTY mode', () => {
  it('start with tty:true uses ptySpawn and emits combined output', async () => {
    const { manager, ptyChild, dir } = await makePtyManager();
    const handle = await manager.start(
      { command: 'bash', args: [], cwd: dir, tty: true },
      'user-1',
    );
    expect(handle.tty).toBe(true);
    expect(handle.pid).toBe(8888);

    const received: Buffer[] = [];
    manager.subscribe(handle.id, 'output', (evt: any) => received.push(evt.data));

    (ptyChild as any).emit('data', 'hello pty');
    expect(received).toHaveLength(1);
    expect(received[0].toString()).toBe('hello pty');

    await rm(dir, { recursive: true, force: true });
  });

  it('stop kills PTY once (not double)', async () => {
    const { manager, ptyChild, dir } = await makePtyManager();
    const handle = await manager.start(
      { command: 'bash', args: [], cwd: dir, tty: true },
      'user-1',
    );

    let killCount = 0;
    const origKill = ptyChild.kill.bind(ptyChild);
    ptyChild.kill = (signal?: string) => {
      killCount++;
      origKill(signal);
    };

    await manager.stop(handle.id);
    expect(killCount).toBe(1); // not 2 (the bug would call kill twice)
    await rm(dir, { recursive: true, force: true });
  });
});
