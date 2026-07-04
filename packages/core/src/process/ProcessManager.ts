import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { IPty, IBasePtyForkOptions } from 'node-pty';
import type { Storage } from '../storage/Storage.js';
import { createId, nowIso } from '../util/ids.js';
import { readMeta, writeMeta, listProcessIds } from './process-storage.js';
import { RingBuffer } from './RingBuffer.js';
import type { ProcessEntry } from './ProcessEntry.js';
import type {
  ProcessMeta,
  ProcessHandle,
  ProcessStatus,
  SpawnConfig,
  ExecuteResult,
} from '@legion/types';

// native dep — may require build tools (node-gyp)
let nodePty: typeof import('node-pty') | null = null;
try {
  nodePty = await import('node-pty');
} catch {
  // PTY mode unavailable; tty:true will throw at runtime
}

export interface ProcessManagerDeps {
  storage: Storage;
  workspaceRoot: string;
  /** Injectable for testing — defaults to node:child_process.spawn */
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** Injectable for testing — defaults to node-pty.spawn */
  ptySpawn?: (cmd: string, args: string[], opts: IBasePtyForkOptions) => IPty;
}

export class ProcessManager {
  private readonly storage: Storage; // scoped to 'processes'
  private readonly workspaceRoot: string;
  private readonly spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  private readonly ptySpawnFn: (cmd: string, args: string[], opts: IBasePtyForkOptions) => IPty;
  private readonly live = new Map<string, ProcessEntry>();

  constructor(deps: ProcessManagerDeps) {
    this.storage = deps.storage.scope('processes');
    this.workspaceRoot = deps.workspaceRoot;
    this.spawnFn = deps.spawn ?? nodeSpawn;
    this.ptySpawnFn =
      deps.ptySpawn ??
      ((cmd, args, opts) => {
        if (!nodePty) throw new Error('PTY mode unavailable: node-pty failed to load');
        return nodePty.spawn(cmd, args, opts);
      });
  }

  async reconcileOnStartup(): Promise<void> {
    const ids = await listProcessIds(this.storage);
    await Promise.all(
      ids.map(async (id) => {
        const meta = await readMeta(this.storage, id);
        if (!meta || meta.status !== 'running') return;
        await writeMeta(this.storage, {
          ...meta,
          status: 'abandoned',
          exitedAt: nowIso(),
          exitCode: null,
          abandonedReason: 'parent_unclean_shutdown',
        });
      }),
    );
  }

  private toHandle(meta: ProcessMeta): ProcessHandle {
    return {
      id: meta.id,
      name: meta.name,
      command: meta.command,
      args: meta.args,
      cwd: meta.cwd,
      tty: meta.tty,
      shell: meta.shell,
      startedAt: meta.startedAt,
      startedByParticipantId: meta.startedByParticipantId,
      pid: meta.pid,
      status: meta.status,
      exitCode: meta.exitCode,
      exitedAt: meta.exitedAt,
    };
  }

  get(id: string): ProcessHandle | undefined {
    const entry = this.live.get(id);
    return entry ? this.toHandle(entry.meta) : undefined;
  }

  async start(config: SpawnConfig, startedByParticipantId: string): Promise<ProcessHandle> {
    const id = createId('proc');
    const cwd = config.cwd ?? this.workspaceRoot;
    const args = config.args ?? [];
    const env = config.env ? { ...process.env, ...config.env } : { ...process.env };
    const tty = config.tty ?? false;
    const shell = config.shell ?? false;
    const cols = config.cols ?? 80;
    const rows = config.rows ?? 24;

    // Create storage dir
    await mkdir(join(this.workspaceRoot, '.legion', 'processes', id), { recursive: true });

    const meta: ProcessMeta = {
      id,
      name: config.name,
      command: config.command,
      args,
      cwd,
      tty,
      shell,
      startedAt: nowIso(),
      startedByParticipantId,
      pid: 0,
      status: 'starting',
      exitCode: null,
      exitedAt: null,
    };

    // Persist initial meta (status: starting)
    await writeMeta(this.storage, meta);

    const emitter = new EventEmitter();
    // Prevent Node's EventEmitter from throwing when 'error' is emitted with
    // no external subscriber (we use 'error' as a notification channel here).
    emitter.on('error', () => undefined);
    const ringBuffer = new RingBuffer();

    // Open log stream
    const logPath = join(this.workspaceRoot, '.legion', 'processes', id, 'output.log');
    const logStream = createWriteStream(logPath, { flags: 'a' });

    const entry: ProcessEntry = {
      meta,
      child: null,
      emitter,
      ringBuffer,
      logStream,
      logByteCount: 0,
    };

    // Spawn
    let child: ChildProcess | IPty;
    try {
      if (tty) {
        child = this.ptySpawnFn(config.command, args, {
          cwd,
          env: env as Record<string, string>,
          cols,
          rows,
        });
      } else {
        child = this.spawnFn(config.command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd,
          env,
          shell,
        });
      }
    } catch (err) {
      await writeMeta(this.storage, { ...meta, status: 'abandoned', exitedAt: nowIso() });
      logStream.end();
      throw err;
    }

    entry.child = child;
    meta.pid = (child as ChildProcess).pid ?? (child as IPty).pid ?? 0;

    // Attach output handlers
    this.attachOutputHandlers(entry, tty);

    // Attach exit handler
    this.attachExitHandler(entry);

    // Deferred rejection — used to fail start() if the spawn emits 'error'
    // (e.g. ENOENT) before start() resolves.
    let rejectStart: ((err: Error) => void) | null = null;
    const startError = new Promise<never>((_, reject) => {
      rejectStart = reject;
    });
    startError.catch(() => undefined); // avoid unhandled rejection warning

    // Attach error handler (pipe mode ENOENT etc.)
    if (!tty) {
      (child as ChildProcess).on('error', (err) => {
        // Reject start() synchronously so the caller sees the spawn failure.
        rejectStart?.(err as Error);
        // Best-effort async cleanup (does not block start rejection).
        entry.meta.status = 'abandoned';
        entry.meta.exitedAt = nowIso();
        writeMeta(this.storage, entry.meta).catch(() => undefined);
        logStream.end();
        entry.logStream = null;
        entry.child = null;
        this.live.delete(id);
        emitter.emit('error', { id, error: String(err) });
      });
    }

    // Update meta to running, add to live map
    meta.status = 'running';
    await Promise.race([writeMeta(this.storage, meta), startError]);
    emitter.emit('started', { id, pid: meta.pid, startedAt: meta.startedAt });
    this.live.set(id, entry);

    return this.toHandle(meta);
  }

  private attachOutputHandlers(entry: ProcessEntry, tty: boolean): void {
    const { ringBuffer, emitter } = entry;
    const id = entry.meta.id;

    const onChunk = (stream: 'stdout' | 'stderr' | 'combined', chunk: Buffer): void => {
      ringBuffer.push(chunk);
      if (entry.logStream) {
        entry.logStream.write(chunk, (err) => {
          if (err) emitter.emit('error', { id, error: String(err) });
        });
        entry.logByteCount += chunk.length;
      }
      emitter.emit('output', { id, stream, data: chunk, timestamp: nowIso() });
    };

    if (tty) {
      const pty = entry.child as IPty;
      pty.onData((data: string) => onChunk('combined', Buffer.from(data)));
    } else {
      const cp = entry.child as ChildProcess;
      cp.stdout?.on('data', (chunk: Buffer) => onChunk('stdout', chunk));
      cp.stderr?.on('data', (chunk: Buffer) => onChunk('stderr', chunk));
    }
  }

  private attachExitHandler(entry: ProcessEntry): void {
    const { meta, emitter } = entry;
    const id = meta.id;
    const startedAt = new Date(meta.startedAt).getTime();

    const onExit = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      const durationMs = Date.now() - startedAt;
      meta.status = signal !== null ? 'killed' : 'exited';
      meta.exitCode = code ?? null;
      meta.exitedAt = nowIso();
      await writeMeta(this.storage, meta).catch(() => undefined);
      entry.logStream?.end();
      entry.logStream = null;
      entry.child = null;
      emitter.emit('exited', { id, exitCode: code, signal, durationMs });
    };

    if (meta.tty) {
      (entry.child as IPty).onExit(({ exitCode, signal }) =>
        onExit(exitCode ?? null, (signal as NodeJS.Signals | undefined) ?? null),
      );
    } else {
      (entry.child as ChildProcess).on('exit', (code, signal) => onExit(code, signal));
    }
  }

  async stop(
    id: string,
    opts?: { signal?: 'SIGTERM' | 'SIGKILL'; graceMs?: number },
  ): Promise<void> {
    const entry = this.live.get(id);
    if (!entry || entry.meta.status !== 'running') {
      throw new Error(`Process ${id} is not running`);
    }
    const signal = opts?.signal ?? 'SIGTERM';
    const graceMs = opts?.graceMs ?? 5000;
    const child = entry.child!;

    // Wait for exit event (canonical write path)
    const exitPromise = new Promise<void>((resolve) => {
      entry.emitter.once('exited', () => resolve());
    });

    if (signal === 'SIGKILL') {
      (child as ChildProcess).kill?.('SIGKILL') ?? (child as IPty).kill?.('SIGKILL');
      await exitPromise;
      return;
    }

    // SIGTERM → grace → SIGKILL
    (child as ChildProcess).kill?.('SIGTERM') ?? (child as IPty).kill?.('SIGTERM');
    const grace = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), graceMs),
    );
    const result = await Promise.race([exitPromise.then(() => 'exited' as const), grace]);
    if (result === 'timeout') {
      (child as ChildProcess).kill?.('SIGKILL') ?? (child as IPty).kill?.('SIGKILL');
      await exitPromise;
    }
  }

  async writeInput(id: string, data: string, eof = false): Promise<void> {
    const entry = this.live.get(id);
    if (!entry || entry.meta.status !== 'running' || !entry.child) {
      throw new Error(`Process ${id} is not running`);
    }
    if (entry.meta.tty) {
      (entry.child as IPty).write(eof ? '\x04' : data);
    } else {
      const cp = entry.child as ChildProcess;
      if (!cp.stdin) throw new Error(`Process ${id} has no stdin`);
      if (eof) {
        cp.stdin.end();
      } else {
        await new Promise<void>((resolve, reject) => {
          cp.stdin!.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
        });
      }
    }
  }

  subscribe(
    id: string,
    event: 'output' | 'exited' | 'error',
    cb: (payload: unknown) => void,
  ): () => void {
    const entry = this.live.get(id);
    if (!entry) throw new Error(`Process ${id} not found`);
    entry.emitter.on(event, cb);
    return () => entry.emitter.off(event, cb);
  }

  // Private helper used by execute() to attach a one-off output listener
  private subscribeOutput(entry: ProcessEntry, cb: (evt: unknown) => void): () => void {
    entry.emitter.on('output', cb);
    return () => entry.emitter.off('output', cb);
  }

  async execute(
    config: SpawnConfig,
    startedByParticipantId: string,
    opts?: { timeoutMs?: number },
  ): Promise<ExecuteResult> {
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const startMs = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const handle = await this.start(config, startedByParticipantId);
    const entry = this.live.get(handle.id)!;

    // Accumulate output separately for the return value
    const offOut = this.subscribeOutput(entry, (evt: any) => {
      if (evt.stream === 'stdout' || evt.stream === 'combined') stdoutChunks.push(evt.data);
      if (evt.stream === 'stderr') stderrChunks.push(evt.data);
    });

    const exitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
      entry.emitter.once('exited', (evt: any) => resolve({ exitCode: evt.exitCode }));
    });

    let timedOut = false;
    let exitCode: number | null = null;

    if (timeoutMs === 0) {
      ({ exitCode } = await exitPromise);
    } else {
      const timeoutP = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), timeoutMs),
      );
      const result = await Promise.race([
        exitPromise.then((r) => ({ ...r, _tag: 'exited' as const })),
        timeoutP,
      ]);
      if (result === 'timeout') {
        timedOut = true;
        await this.stop(handle.id, { signal: 'SIGTERM', graceMs: 5000 });
      } else {
        exitCode = result.exitCode;
      }
    }

    offOut();

    return {
      processId: handle.id,
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      durationMs: Date.now() - startMs,
      timedOut,
    };
  }

  async list(filter?: {
    status?: ProcessStatus | 'all';
    limit?: number;
    offset?: number;
  }): Promise<ProcessHandle[]> {
    const ids = await listProcessIds(this.storage);
    const metas: ProcessMeta[] = [];

    await Promise.all(
      ids.map(async (id) => {
        // Live map is authoritative for running entries
        const liveEntry = this.live.get(id);
        if (liveEntry) {
          metas.push(liveEntry.meta);
        } else {
          const m = await readMeta(this.storage, id);
          if (m) metas.push(m);
        }
      }),
    );

    const status = filter?.status ?? 'all';
    const filtered = status === 'all' ? metas : metas.filter((m) => m.status === status);
    filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 100;
    return filtered.slice(offset, offset + limit).map((m) => this.toHandle(m));
  }

  async readOutput(
    id: string,
    opts?: { bytes?: number; from?: number },
  ): Promise<{ data: Buffer; totalBytes: number; from: number }> {
    const maxBytes = Math.min(opts?.bytes ?? 8192, 1024 * 1024);
    const entry = this.live.get(id);

    if (opts?.from !== undefined) {
      // Seek from log file
      const { createReadStream } = await import('node:fs');
      const logPath = join(this.workspaceRoot, '.legion', 'processes', id, 'output.log');
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(logPath, {
          start: opts.from!,
          end: opts.from! + maxBytes - 1,
        });
        stream.on('data', (c: Buffer | string) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
        );
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      const data = Buffer.concat(chunks);
      const totalBytes = entry?.logByteCount ?? data.length + (opts.from ?? 0);
      return { data, totalBytes, from: opts.from ?? 0 };
    }

    // Ring buffer tail
    if (!entry) throw new Error(`Process ${id} not found`);
    const data = entry.ringBuffer.tail(maxBytes);
    return {
      data,
      totalBytes: entry.logByteCount,
      from: Math.max(0, entry.logByteCount - data.length),
    };
  }

  async delete(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (entry && entry.meta.status === 'running') {
      throw new Error(`Cannot delete running process ${id}; call stop() first`);
    }
    // Check disk if not in live map
    if (!entry) {
      const meta = await readMeta(this.storage, id);
      if (meta?.status === 'running') {
        throw new Error(`Cannot delete running process ${id}; call stop() first`);
      }
    }
    this.live.delete(id);
    const dir = join(this.workspaceRoot, '.legion', 'processes', id);
    await rm(dir, { recursive: true, force: true });
  }

  async shutdown(graceMs = 3000): Promise<void> {
    const running = [...this.live.values()].filter((e) => e.meta.status === 'running');
    if (running.length === 0) return;

    // SIGTERM all
    for (const entry of running) {
      try {
        (entry.child as ChildProcess).kill?.('SIGTERM') ?? (entry.child as IPty).kill?.('SIGTERM');
      } catch {
        // best-effort
      }
    }

    // Wait for group up to graceMs
    const exitPromises = running.map(
      (entry) =>
        new Promise<void>((resolve) => {
          entry.emitter.once('exited', () => resolve());
        }),
    );

    await Promise.race([
      Promise.allSettled(exitPromises),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);

    // SIGKILL stragglers; write meta directly for any still running
    for (const entry of running) {
      if (entry.meta.status === 'running') {
        try {
          (entry.child as ChildProcess).kill?.('SIGKILL') ??
            (entry.child as IPty).kill?.('SIGKILL');
        } catch {
          // best-effort
        }
        entry.meta.status = 'killed';
        entry.meta.exitedAt = nowIso();
        entry.meta.exitCode = null;
        await writeMeta(this.storage, entry.meta).catch(() => undefined);
        entry.logStream?.end();
        entry.logStream = null;
      }
    }

    this.live.clear();
  }
}
