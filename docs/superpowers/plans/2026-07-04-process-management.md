# Process Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ProcessManager` core component and 8 process tools so Legion participants can execute shell commands synchronously and manage long-lived OS processes asynchronously, with live output streaming to the SPA via WebSocket.

**Architecture:** A new `ProcessManager` class in `packages/core/src/process/` (sibling to `service/`) owns a live `Map<id, ProcessEntry>` and persists metadata + raw output to `.legion/processes/<id>/`. Eight tools expose the surface through the existing `ToolRegistry`. The SPA subscribes to per-process output via new `subscribe_process`/`unsubscribe_process` WebSocket messages handled in `WebConnector`.

**Tech Stack:** Node.js `child_process` (pipe mode), `node-pty` (PTY mode), `EventEmitter` (per-process events), Vitest (unit + integration tests), TypeScript strict + NodeNext ESM.

**Spec:** `docs/superpowers/specs/2026-07-04-process-management-design.md`

---

## File Map

### New files

| File                                                | Responsibility                                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/process.ts`                     | `ProcessStatus`, `ProcessMeta`, `ProcessHandle`, `ExecuteResult`, `ProcessOutputChunk`                                                                                |
| `packages/core/src/process/RingBuffer.ts`           | Bounded chunk ring buffer, ~1 MiB cap                                                                                                                                 |
| `packages/core/src/process/RingBuffer.test.ts`      | Unit tests for `RingBuffer`                                                                                                                                           |
| `packages/core/src/process/process-storage.ts`      | `readMeta`, `writeMeta`, `openLogStream`, `listProcessIds` helpers                                                                                                    |
| `packages/core/src/process/process-storage.test.ts` | Unit tests for storage helpers                                                                                                                                        |
| `packages/core/src/process/ProcessEntry.ts`         | Internal per-process handle: metadata + `EventEmitter` + `RingBuffer` + log stream                                                                                    |
| `packages/core/src/process/ProcessManager.ts`       | Owns live map, `start`, `execute`, `stop`, `shutdown`, `reconcileOnStartup`, `delete`, `subscribe`, `readOutput`, `list`, `get`, `writeInput`                         |
| `packages/core/src/process/ProcessManager.test.ts`  | Unit tests with fake spawner injection                                                                                                                                |
| `packages/core/src/process/process-tools.ts`        | 8 `Tool` objects: `execute_command`, `start_process`, `list_processes`, `get_process`, `read_process_output`, `write_process_input`, `stop_process`, `delete_process` |
| `packages/core/src/process/process-tools.test.ts`   | Unit tests for each tool (mock `ProcessManager`)                                                                                                                      |

### Modified files

| File                                          | Change                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/index.ts`                 | Add `export * from './process.js';`                                                                                                               |
| `packages/core/src/index.ts`                  | Add `export * from './process/ProcessManager.js';`                                                                                                |
| `packages/core/package.json`                  | Add `node-pty` dependency                                                                                                                         |
| `packages/runtime/src/LegionProcess.ts`       | Construct `ProcessManager`, call `reconcileOnStartup`, register process tools, pass to `WebConnector` deps, call `shutdown()` in `stop()`         |
| `packages/runtime/src/server/WebConnector.ts` | Extend `WebConnectorDeps` with `processManager`, handle `subscribe_process`/`unsubscribe_process` WS messages, relay per-process events to socket |

---

## Task 1: Add `node-pty` dependency

**Files:**

- Modify: `packages/core/package.json`

- [ ] **Step 1: Add `node-pty` to core dependencies**

Edit `packages/core/package.json`. The full file currently reads:

```json
{
  "name": "@legion-collective/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": {
    "@legion-collective/types": "*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@node-rs/argon2": "^2.0.0"
  }
}
```

Add `node-pty`:

```json
{
  "name": "@legion-collective/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": {
    "@legion-collective/types": "*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@node-rs/argon2": "^2.0.0",
    "node-pty": "^1.0.0"
  }
}
```

- [ ] **Step 2: Install**

```bash
npm install
```

Expected: installs cleanly. `node-pty` is a native module — if build tools are missing it will error here. Fix before proceeding (install `python3`, `make`, `g++` as needed on the system).

- [ ] **Step 3: Verify types are available**

```bash
npx tsc --version
node -e "import('node-pty').then(m => console.log('ok', Object.keys(m)))"
```

Expected: prints `ok` with exports including `spawn`. If ESM import fails, check `node-pty` version supports ESM or use `createRequire` workaround.

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json package-lock.json
git commit -m "chore: add node-pty dependency to core"
```

---

## Task 2: Process types (`packages/types`)

**Files:**

- Create: `packages/types/src/process.ts`
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Create `packages/types/src/process.ts`**

```typescript
export type ProcessStatus = 'starting' | 'running' | 'exited' | 'killed' | 'abandoned';

export interface ProcessMeta {
  id: string;
  name?: string;
  command: string;
  args: string[];
  cwd: string;
  tty: boolean;
  shell: boolean;
  startedAt: string; // ISO-8601
  startedByParticipantId: string;
  pid: number;
  status: ProcessStatus;
  exitCode: number | null;
  exitedAt: string | null; // ISO-8601; null if running or abandoned without clean exit
  abandonedReason?: 'parent_unclean_shutdown';
}

export interface ProcessHandle {
  id: string;
  name?: string;
  command: string;
  args: string[];
  cwd: string;
  tty: boolean;
  shell: boolean;
  startedAt: string;
  startedByParticipantId: string;
  pid: number;
  status: ProcessStatus;
  exitCode: number | null;
  exitedAt: string | null;
}

export interface ExecuteResult {
  processId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcessOutputChunk {
  id: string;
  stream: 'stdout' | 'stderr' | 'combined'; // 'combined' in PTY mode
  data: Buffer;
  timestamp: string;
}

export interface SpawnConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  tty?: boolean;
  shell?: boolean;
  name?: string;
  cols?: number; // tty only, default 80
  rows?: number; // tty only, default 24
}
```

- [ ] **Step 2: Export from `packages/types/src/index.ts`**

Current content of `packages/types/src/index.ts`:

```typescript
export * from './tool.js';
export * from './conversation.js';
export * from './config.js';
export * from './participant.js';
export * from './events.js';
```

Add process exports:

```typescript
export * from './tool.js';
export * from './conversation.js';
export * from './config.js';
export * from './participant.js';
export * from './events.js';
export * from './process.js';
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors. `packages/types` has no runtime code, coverage stays 0% (expected per AGENTS.md).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/process.ts packages/types/src/index.ts
git commit -m "feat(types): add process management types"
```

---

## Task 3: `RingBuffer`

**Files:**

- Create: `packages/core/src/process/RingBuffer.ts`
- Create: `packages/core/src/process/RingBuffer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/process/RingBuffer.test.ts`:

```typescript
import { RingBuffer } from './RingBuffer.js';

describe('RingBuffer', () => {
  it('starts empty', () => {
    const rb = new RingBuffer(1024);
    expect(rb.byteSize).toBe(0);
    expect(rb.tail(100)).toEqual(Buffer.alloc(0));
  });

  it('stores and returns chunks', () => {
    const rb = new RingBuffer(1024);
    rb.push(Buffer.from('hello '));
    rb.push(Buffer.from('world'));
    expect(rb.tail(100)).toEqual(Buffer.from('hello world'));
  });

  it('tail returns at most requested bytes', () => {
    const rb = new RingBuffer(1024);
    rb.push(Buffer.from('abcdefghij'));
    const result = rb.tail(5);
    expect(result).toEqual(Buffer.from('fghij'));
  });

  it('drops oldest chunks when full', () => {
    // cap = 10 bytes
    const rb = new RingBuffer(10);
    rb.push(Buffer.from('12345')); // 5 bytes, fits
    rb.push(Buffer.from('67890')); // 5 bytes, total 10, fits
    rb.push(Buffer.from('ABCDE')); // 5 bytes, total 15 > 10 → drop oldest
    // After drop: '67890' dropped next if still over, then 'ABCDE' only chunk
    // Actually: drop oldest until byteSize <= maxBytes
    // After adding ABCDE (15 bytes): drop '12345' → 10 bytes (≤ 10, stop)
    expect(rb.byteSize).toBeLessThanOrEqual(10);
    const result = rb.tail(100);
    // '12345' dropped, remaining is '67890ABCDE'
    expect(result).toEqual(Buffer.from('67890ABCDE'));
  });

  it('handles single oversized chunk', () => {
    const rb = new RingBuffer(5);
    rb.push(Buffer.from('123456789')); // 9 bytes > 5 cap
    // Chunk is kept even though it alone exceeds maxBytes (cannot drop itself)
    expect(rb.byteSize).toBe(9);
    expect(rb.tail(100)).toEqual(Buffer.from('123456789'));
  });

  it('tail with bytes larger than content returns all content', () => {
    const rb = new RingBuffer(1024);
    rb.push(Buffer.from('hi'));
    expect(rb.tail(9999)).toEqual(Buffer.from('hi'));
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
npx vitest run packages/core/src/process/RingBuffer.test.ts
```

Expected: FAIL — `RingBuffer` not found.

- [ ] **Step 3: Implement `RingBuffer`**

Create `packages/core/src/process/RingBuffer.ts`:

```typescript
export const DEFAULT_RING_BYTES = 1024 * 1024; // 1 MiB

export class RingBuffer {
  private chunks: Buffer[] = [];
  private _byteSize = 0;

  constructor(private readonly maxBytes: number = DEFAULT_RING_BYTES) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this._byteSize += chunk.length;
    // Drop oldest chunks until within cap, but never drop the only chunk
    while (this._byteSize > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this._byteSize -= dropped.length;
    }
  }

  tail(bytes: number): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    const full = Buffer.concat(this.chunks);
    if (full.length <= bytes) return full;
    return full.subarray(full.length - bytes);
  }

  get byteSize(): number {
    return this._byteSize;
  }
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
npx vitest run packages/core/src/process/RingBuffer.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/process/RingBuffer.ts packages/core/src/process/RingBuffer.test.ts
git commit -m "feat(core): add RingBuffer for process output capture"
```

---

## Task 4: Process storage helpers

**Files:**

- Create: `packages/core/src/process/process-storage.ts`
- Create: `packages/core/src/process/process-storage.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/process/process-storage.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { join, tmpdir } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { readMeta, writeMeta, listProcessIds } from './process-storage.js';
import type { ProcessMeta } from '@legion-collective/types';

const BASE_META: ProcessMeta = {
  id: 'proc-test-1',
  command: 'echo',
  args: ['hello'],
  cwd: '/tmp',
  tty: false,
  shell: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  startedByParticipantId: 'user-1',
  pid: 12345,
  status: 'running',
  exitCode: null,
  exitedAt: null,
};

describe('process-storage', () => {
  let dir: string;
  let storage: FileStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-proc-'));
    storage = new FileStorage(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writeMeta and readMeta round-trip', async () => {
    await writeMeta(storage, BASE_META);
    const result = await readMeta(storage, 'proc-test-1');
    expect(result).toEqual(BASE_META);
  });

  it('readMeta returns null for missing entry', async () => {
    const result = await readMeta(storage, 'proc-does-not-exist');
    expect(result).toBeNull();
  });

  it('readMeta returns null for corrupted JSON', async () => {
    // Write bad JSON directly
    await storage.write('proc-bad/meta.json', '{not valid json}');
    const result = await readMeta(storage, 'proc-bad');
    expect(result).toBeNull();
  });

  it('writeMeta persists all nullable fields correctly', async () => {
    const meta: ProcessMeta = {
      ...BASE_META,
      exitCode: 0,
      exitedAt: '2026-01-01T00:01:00.000Z',
      status: 'exited',
    };
    await writeMeta(storage, meta);
    const result = await readMeta(storage, 'proc-test-1');
    expect(result?.exitCode).toBe(0);
    expect(result?.exitedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(result?.status).toBe('exited');
  });

  it('listProcessIds returns ids of stored processes', async () => {
    await writeMeta(storage, BASE_META);
    await writeMeta(storage, { ...BASE_META, id: 'proc-test-2' });
    const ids = await listProcessIds(storage);
    expect(ids.sort()).toEqual(['proc-test-1', 'proc-test-2']);
  });

  it('listProcessIds returns empty array when none stored', async () => {
    const ids = await listProcessIds(storage);
    expect(ids).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
npx vitest run packages/core/src/process/process-storage.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `process-storage.ts`**

Create `packages/core/src/process/process-storage.ts`:

```typescript
import type { Storage } from '../storage/Storage.js';
import type { ProcessMeta } from '@legion-collective/types';

function metaKey(id: string): string {
  return `${id}/meta.json`;
}

export async function writeMeta(storage: Storage, meta: ProcessMeta): Promise<void> {
  await storage.writeJson(metaKey(meta.id), meta);
}

export async function readMeta(storage: Storage, id: string): Promise<ProcessMeta | null> {
  try {
    return await storage.readJson<ProcessMeta>(metaKey(id));
  } catch {
    return null;
  }
}

export async function listProcessIds(storage: Storage): Promise<string[]> {
  const keys = await storage.list('');
  // Keys look like 'proc-<uuid>/meta.json' — extract the id prefix
  return keys.filter((k) => k.endsWith('/meta.json')).map((k) => k.replace(/\/meta\.json$/, ''));
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
npx vitest run packages/core/src/process/process-storage.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/process/process-storage.ts packages/core/src/process/process-storage.test.ts
git commit -m "feat(core): add process storage helpers"
```

---

## Task 5: `ProcessEntry` type

**Files:**

- Create: `packages/core/src/process/ProcessEntry.ts`

No tests needed — this is a plain internal data type, not logic. It gets exercised by `ProcessManager` tests.

- [ ] **Step 1: Create `ProcessEntry.ts`**

```typescript
import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import type { IPty } from 'node-pty';
import type { ProcessMeta } from '@legion-collective/types';
import type { RingBuffer } from './RingBuffer.js';

/**
 * Internal per-process handle. Never exposed outside ProcessManager.
 * Callers receive ProcessHandle (a frozen snapshot of public fields).
 */
export interface ProcessEntry {
  meta: ProcessMeta;
  /** null after exit */
  child: ChildProcess | IPty | null;
  /** Per-process event channel. Subscribers attach via ProcessManager.subscribe(). */
  emitter: EventEmitter;
  ringBuffer: RingBuffer;
  /** Append stream to .legion/processes/<id>/output.log. null after close. */
  logStream: Writable | null;
  /** Running total bytes written to output.log. Used for totalBytes in readOutput(). */
  logByteCount: number;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/process/ProcessEntry.ts
git commit -m "feat(core): add ProcessEntry internal type"
```

---

## Task 6: `ProcessManager` — core logic

**Files:**

- Create: `packages/core/src/process/ProcessManager.ts`
- Create: `packages/core/src/process/ProcessManager.test.ts`

This is the largest task. We build and test `ProcessManager` with a fake spawner. Split into sub-steps by method group.

### 6a: Constructor, types, `reconcileOnStartup`

- [ ] **Step 1: Write failing tests for `reconcileOnStartup`**

Create `packages/core/src/process/ProcessManager.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { join, tmpdir } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { FileStorage } from '../storage/FileStorage.js';
import { writeMeta } from './process-storage.js';
import { ProcessManager } from './ProcessManager.js';
import type { ProcessMeta, SpawnConfig } from '@legion-collective/types';

// ── Fake spawner ────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
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
  const storage = new FileStorage(dir);
  const child = fakeChild ?? new FakeChild();
  const manager = new ProcessManager({
    storage,
    workspaceRoot: dir,
    spawn: makeFakeSpawn(child) as any,
    ptySpawn: vi.fn() as any,
  });
  return { manager, storage, dir, child };
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

    const { readMeta } = await import('./process-storage.js');
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

    const { readMeta } = await import('./process-storage.js');
    const result = await readMeta(scoped, 'proc-clean-1');
    expect(result?.status).toBe('exited');
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
npx vitest run packages/core/src/process/ProcessManager.test.ts
```

Expected: FAIL — `ProcessManager` not found.

- [ ] **Step 3: Implement constructor + `reconcileOnStartup`**

Create `packages/core/src/process/ProcessManager.ts`:

```typescript
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
} from '@legion-collective/types';

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
}
```

- [ ] **Step 4: Run — verify reconcile tests PASS**

```bash
npx vitest run packages/core/src/process/ProcessManager.test.ts
```

Expected: 2 tests pass. (More tests will be added in sub-steps below.)

### 6b: `start` and `get`

- [ ] **Step 5: Add `start` and `get` tests to `ProcessManager.test.ts`**

Append to `ProcessManager.test.ts`:

```typescript
// ── start ────────────────────────────────────────────────────────────────────

describe('ProcessManager.start', () => {
  it('spawns process, persists running meta, emits started, returns handle', async () => {
    const { manager, child, dir } = await makeManager();

    const events: string[] = [];
    // Subscribe before start to capture 'started'
    // We need the id first — start returns it. Listen on 'started' via a global spy.
    // Instead, subscribe via manager after start but before async events fire.

    const handleP = manager.start({ command: 'sleep', args: ['10'], cwd: dir }, 'user-1');
    const handle = await handleP;

    expect(handle.command).toBe('sleep');
    expect(handle.status).toBe('running');
    expect(handle.pid).toBe(9999);
    expect(handle.id).toMatch(/^proc-/);

    // Entry should be in live map
    const got = manager.get(handle.id);
    expect(got).toBeDefined();
    expect(got?.status).toBe('running');

    // Clean up
    await rm(dir, { recursive: true, force: true });
  });

  it('returns error result on spawn failure (ENOENT)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legion-pm-'));
    const badChild = new FakeChild();
    // Simulate spawn error: emit 'error' before any 'exit'
    const spawnFn = vi.fn().mockImplementation(() => {
      setImmediate(() => {
        const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
        badChild.emit('error', err);
      });
      return badChild;
    });
    const storage = new FileStorage(dir);
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
```

- [ ] **Step 6: Run — verify FAIL (start not implemented)**

```bash
npx vitest run packages/core/src/process/ProcessManager.test.ts
```

Expected: new tests fail.

- [ ] **Step 7: Implement `start` and `get` in `ProcessManager.ts`**

Add these methods to `ProcessManager` class:

```typescript
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
      pid: 0, // updated after spawn
      status: 'starting',
      exitCode: null,
      exitedAt: null,
    };

    // Persist initial meta (status: starting)
    await writeMeta(this.storage, meta);

    const emitter = new EventEmitter();
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
        child = this.ptySpawnFn(config.command, args, { cwd, env: env as Record<string, string>, cols, rows });
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

    // Attach error handler (pipe mode ENOENT etc.)
    if (!tty) {
      (child as ChildProcess).on('error', async (err) => {
        entry.meta.status = 'abandoned';
        entry.meta.exitedAt = nowIso();
        await writeMeta(this.storage, entry.meta).catch(() => undefined);
        logStream.end();
        entry.logStream = null;
        entry.child = null;
        this.live.delete(id);
        emitter.emit('error', { id, error: String(err) });
        throw err; // re-throw so start() rejects
      });
    }

    // Update meta to running, add to live map
    meta.status = 'running';
    await writeMeta(this.storage, meta);
    emitter.emit('started', { id, pid: meta.pid, startedAt: meta.startedAt });
    this.live.set(id, entry);

    return this.toHandle(meta);
  }

  private attachOutputHandlers(entry: ProcessEntry, tty: boolean): void {
    const { meta, ringBuffer, emitter } = entry;
    const id = meta.id;

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
```

- [ ] **Step 8: Run — verify start/get tests PASS**

```bash
npx vitest run packages/core/src/process/ProcessManager.test.ts
```

Expected: all tests so far pass.

### 6c: `stop`, `writeInput`, `subscribe`

- [ ] **Step 9: Add tests**

Append to `ProcessManager.test.ts`:

```typescript
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

    // Emit fake stdout data
    child.stdout.emit('data', Buffer.from('hello'));
    expect(received).toHaveLength(1);

    unsub();
    child.stdout.emit('data', Buffer.from('world'));
    expect(received).toHaveLength(1); // no new events after unsub

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 10: Run — verify FAIL**

```bash
npx vitest run packages/core/src/process/ProcessManager.test.ts
```

Expected: new tests fail.

- [ ] **Step 11: Implement `stop`, `writeInput`, `subscribe`**

Add to `ProcessManager` class:

```typescript
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
    const grace = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), graceMs));
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
```

- [ ] **Step 12: Run — verify all tests PASS**

```bash
npx vitest run packages/core/src/process/ProcessManager.test.ts
```

Expected: all tests pass.

### 6d: `execute`, `list`, `readOutput`, `delete`, `shutdown`

- [ ] **Step 13: Add remaining tests**

Append to `ProcessManager.test.ts`:

```typescript
// ── execute ───────────────────────────────────────────────────────────────────

describe('ProcessManager.execute', () => {
  it('captures stdout and returns on exit', async () => {
    const { manager, child, dir } = await makeManager();

    const resultP = manager.execute({ command: 'echo', args: ['hi'] }, 'user-1');

    // Simulate output + exit
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('hi\n'));
      child.emit('exit', 0, null);
    });

    const result = await resultP;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hi');
    expect(result.timedOut).toBe(false);
    expect(result.processId).toMatch(/^proc-/);
    await rm(dir, { recursive: true, force: true });
  });

  it('returns timedOut:true when timeout exceeded', async () => {
    const { manager, child, dir } = await makeManager();

    // Override kill to emit exit after a tick (simulating SIGKILL)
    child.kill = vi.fn().mockImplementation(() => {
      setImmediate(() => child.emit('exit', null, 'SIGKILL'));
      return true;
    });

    const resultP = manager.execute(
      { command: 'sleep', args: ['999'] },
      'user-1',
      { timeoutMs: 1 }, // 1ms — will time out immediately
    );

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

    // Let it exit
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
```

- [ ] **Step 14: Run — verify new tests FAIL**

```bash
npx vitest run packages/core/src/process/ProcessManager.test.ts
```

Expected: new tests fail.

- [ ] **Step 15: Implement `execute`, `list`, `readOutput`, `delete`, `shutdown`**

Add to `ProcessManager` class:

```typescript
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
    const offOut = manager_subscribe(entry, 'output', (evt: any) => {
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
      const result = await Promise.race([exitPromise.then((r) => ({ ...r, _tag: 'exited' as const })), timeoutP]);
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
        const stream = createReadStream(logPath, { start: opts.from, end: opts.from! + maxBytes - 1 });
        stream.on('data', (c: Buffer) => chunks.push(c));
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
    return { data, totalBytes: entry.logByteCount, from: Math.max(0, entry.logByteCount - data.length) };
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
        (entry.child as ChildProcess).kill?.('SIGTERM') ??
          (entry.child as IPty).kill?.('SIGTERM');
      } catch {
        // best-effort
      }
    }

    // Wait for group up to graceMs
    const exitPromises = running.map(
      (entry) =>
        new Promise<void>((resolve) => {
          entry.emitter.once('exited', () => resolve());
          // Also resolve on timeout to avoid hanging
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
        // Write meta directly (cannot rely on exit handler completing)
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
```

Also add this private helper at the top of the class (needed by `execute`):

```typescript
  // Private helper used by execute() to attach a one-off output listener
  private subscribeOutput(
    entry: ProcessEntry,
    cb: (evt: unknown) => void,
  ): () => void {
    entry.emitter.on('output', cb);
    return () => entry.emitter.off('output', cb);
  }
```

And fix `execute` to use `this.subscribeOutput(entry, ...)` instead of the standalone `manager_subscribe` placeholder.

- [ ] **Step 16: Run — verify all tests PASS**

```bash
npx vitest run packages/core/src/process/ProcessManager.test.ts
```

Expected: all tests pass.

- [ ] **Step 17: Full test suite**

```bash
npm test
```

Expected: no regressions.

- [ ] **Step 18: Commit**

```bash
git add packages/core/src/process/ProcessManager.ts packages/core/src/process/ProcessManager.test.ts
git commit -m "feat(core): add ProcessManager with start/stop/execute/shutdown/list/readOutput/delete"
```

---

## Task 7: Process tools

**Files:**

- Create: `packages/core/src/process/process-tools.ts`
- Create: `packages/core/src/process/process-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/process/process-tools.test.ts`:

```typescript
import { processTools } from './process-tools.js';
import type { ToolContext } from '../tools/Tool.js';
import type { ProcessHandle, ExecuteResult } from '@legion-collective/types';

const HANDLE: ProcessHandle = {
  id: 'proc-test',
  command: 'echo',
  args: [],
  cwd: '/tmp',
  tty: false,
  shell: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  startedByParticipantId: 'user-1',
  pid: 1234,
  status: 'running',
  exitCode: null,
  exitedAt: null,
};

function makeCtx(overrides: Partial<ReturnType<typeof makeMockPm>> = {}): ToolContext {
  const pm = makeMockPm(overrides);
  return {
    participant: { id: 'user-1', type: 'user' } as any,
    conversationId: 'conv-1',
    conversation: {} as any,
    collective: {} as any,
    communicationDepth: 0,
    toolRegistry: {} as any,
    config: {} as any,
    eventBus: {} as any,
    storage: {} as any,
    workspaceRoot: '/tmp',
    processManager: pm,
  } as unknown as ToolContext;
}

function makeMockPm(overrides: Record<string, any> = {}) {
  return {
    start: vi.fn().mockResolvedValue(HANDLE),
    execute: vi.fn().mockResolvedValue({
      processId: 'proc-test',
      exitCode: 0,
      stdout: 'hello',
      stderr: '',
      durationMs: 100,
      timedOut: false,
    } satisfies ExecuteResult),
    list: vi.fn().mockResolvedValue([HANDLE]),
    get: vi.fn().mockReturnValue(HANDLE),
    readOutput: vi.fn().mockResolvedValue({ data: Buffer.from('hi'), totalBytes: 2, from: 0 }),
    writeInput: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function getTool(name: string) {
  const t = processTools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

describe('process tools', () => {
  it('exports 8 tools', () => {
    expect(processTools).toHaveLength(8);
    const names = processTools.map((t) => t.name);
    expect(names).toContain('execute_command');
    expect(names).toContain('start_process');
    expect(names).toContain('list_processes');
    expect(names).toContain('get_process');
    expect(names).toContain('read_process_output');
    expect(names).toContain('write_process_input');
    expect(names).toContain('stop_process');
    expect(names).toContain('delete_process');
  });

  describe('execute_command', () => {
    it('calls pm.execute and returns result', async () => {
      const ctx = makeCtx();
      const tool = getTool('execute_command');
      const result = await tool.execute({ command: 'echo', args: ['hi'] }, ctx);
      expect((result as any).status).toBe('success');
      expect((result as any).data.stdout).toBe('hello');
    });

    it('returns error result on failure', async () => {
      const ctx = makeCtx({ execute: vi.fn().mockRejectedValue(new Error('ENOENT')) });
      const result = await getTool('execute_command').execute({ command: 'nope' }, ctx);
      expect((result as any).status).toBe('error');
    });
  });

  describe('start_process', () => {
    it('calls pm.start and returns handle', async () => {
      const ctx = makeCtx();
      const result = await getTool('start_process').execute(
        { command: 'sleep', args: ['10'] },
        ctx,
      );
      expect((result as any).status).toBe('success');
      expect((result as any).data.id).toBe('proc-test');
    });
  });

  describe('list_processes', () => {
    it('returns array of handles', async () => {
      const ctx = makeCtx();
      const result = await getTool('list_processes').execute({ status: 'all' }, ctx);
      expect((result as any).status).toBe('success');
      expect(Array.isArray((result as any).data)).toBe(true);
    });
  });

  describe('get_process', () => {
    it('returns handle for known id', async () => {
      const ctx = makeCtx();
      const result = await getTool('get_process').execute({ id: 'proc-test' }, ctx);
      expect((result as any).status).toBe('success');
    });

    it('returns error for unknown id', async () => {
      const ctx = makeCtx({ get: vi.fn().mockReturnValue(undefined) });
      const result = await getTool('get_process').execute({ id: 'proc-unknown' }, ctx);
      expect((result as any).status).toBe('error');
    });
  });

  describe('delete_process', () => {
    it('refuses running process', async () => {
      const ctx = makeCtx({
        delete: vi.fn().mockRejectedValue(new Error('Cannot delete running process')),
      });
      const result = await getTool('delete_process').execute({ id: 'proc-test' }, ctx);
      expect((result as any).status).toBe('error');
    });
  });

  describe('read_process_output', () => {
    it('returns utf8 decoded data by default', async () => {
      const ctx = makeCtx();
      const result = await getTool('read_process_output').execute({ id: 'proc-test' }, ctx);
      expect((result as any).status).toBe('success');
      expect((result as any).data.data).toBe('hi');
    });

    it('returns base64 when decode:base64', async () => {
      const ctx = makeCtx();
      const result = await getTool('read_process_output').execute(
        { id: 'proc-test', decode: 'base64' },
        ctx,
      );
      expect((result as any).data.data).toBe(Buffer.from('hi').toString('base64'));
    });
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
npx vitest run packages/core/src/process/process-tools.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `process-tools.ts`**

Create `packages/core/src/process/process-tools.ts`:

```typescript
import type { Tool, ToolContext, ToolResult } from '../tools/Tool.js';
import type { ProcessManager } from './ProcessManager.js';

function pm(ctx: ToolContext): ProcessManager {
  return ctx.processManager as ProcessManager;
}

function ok(data: unknown): ToolResult {
  return { status: 'success', data };
}

function err(error: unknown): ToolResult {
  return { status: 'error', error: String(error) };
}

const spawnInputSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Executable path or name' },
    args: { type: 'array', items: { type: 'string' }, default: [] },
    cwd: { type: 'string', description: 'Working directory; defaults to workspaceRoot' },
    env: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
    tty: { type: 'boolean', default: false, description: 'Allocate a PTY (pseudo-terminal)' },
    shell: { type: 'boolean', default: false, description: 'Wrap command in /bin/sh -c' },
    name: { type: 'string', description: 'Optional display name' },
    cols: { type: 'number', default: 80, description: 'PTY columns (tty mode only)' },
    rows: { type: 'number', default: 24, description: 'PTY rows (tty mode only)' },
  },
  required: ['command'],
} as const;

export const executeCommandTool: Tool = {
  name: 'execute_command',
  description:
    'Run a shell command synchronously and return its stdout, stderr, and exit code. Blocks until the command exits or timeoutMs is reached.',
  parameters: {
    ...spawnInputSchema,
    properties: {
      ...spawnInputSchema.properties,
      timeoutMs: {
        type: 'number',
        default: 60000,
        description: 'Milliseconds before SIGTERM is sent; 0 = no timeout',
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      const result = await pm(ctx).execute(
        {
          command: a.command,
          args: a.args,
          cwd: a.cwd,
          env: a.env,
          tty: a.tty,
          shell: a.shell,
          name: a.name,
          cols: a.cols,
          rows: a.rows,
        },
        ctx.participant.id,
        { timeoutMs: a.timeoutMs },
      );
      return ok(result);
    } catch (e) {
      return err(e);
    }
  },
};

export const startProcessTool: Tool = {
  name: 'start_process',
  description:
    'Start a long-running process asynchronously. Returns immediately with a process handle. Use read_process_output, write_process_input, and stop_process to interact with it.',
  parameters: spawnInputSchema,
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const handle = await pm(ctx).start(args as any, ctx.participant.id);
      return ok(handle);
    } catch (e) {
      return err(e);
    }
  },
};

export const listProcessesTool: Tool = {
  name: 'list_processes',
  description: 'List processes (running and historical). Sorted by startedAt descending.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['running', 'exited', 'killed', 'abandoned', 'all'],
        default: 'all',
      },
      limit: { type: 'number', default: 100 },
      offset: { type: 'number', default: 0 },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      const handles = await pm(ctx).list({ status: a.status, limit: a.limit, offset: a.offset });
      return ok(handles);
    } catch (e) {
      return err(e);
    }
  },
};

export const getProcessTool: Tool = {
  name: 'get_process',
  description: 'Get the current state of a single process by id.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as any;
    const handle = pm(ctx).get(a.id);
    if (!handle) return err(`Process ${a.id} not found`);
    return ok(handle);
  },
};

export const readProcessOutputTool: Tool = {
  name: 'read_process_output',
  description:
    'Read captured output from a process. Omit `from` to get the ring buffer tail (fast). Provide `from` (byte offset) to read historical output from the log file.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      bytes: { type: 'number', default: 8192, description: 'Max bytes to return (cap: 1 MiB)' },
      from: { type: 'number', description: 'Byte offset in output.log; omit for ring buffer tail' },
      decode: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
    },
    required: ['id'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      const result = await pm(ctx).readOutput(a.id, { bytes: a.bytes, from: a.from });
      const decode = a.decode ?? 'utf8';
      return ok({
        data: decode === 'base64' ? result.data.toString('base64') : result.data.toString('utf8'),
        totalBytes: result.totalBytes,
        from: result.from,
      });
    } catch (e) {
      return err(e);
    }
  },
};

export const writeProcessInputTool: Tool = {
  name: 'write_process_input',
  description: 'Write data to a running process stdin (pipe mode) or PTY (tty mode).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      data: { type: 'string' },
      eof: { type: 'boolean', default: false, description: 'Send EOF / close stdin after write' },
    },
    required: ['id', 'data'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      await pm(ctx).writeInput(a.id, a.data, a.eof);
      return ok({ ok: true });
    } catch (e) {
      return err(e);
    }
  },
};

export const stopProcessTool: Tool = {
  name: 'stop_process',
  description:
    'Stop a running process. Sends SIGTERM by default, waits graceMs, then escalates to SIGKILL.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      signal: { type: 'string', enum: ['SIGTERM', 'SIGKILL'], default: 'SIGTERM' },
      graceMs: { type: 'number', default: 5000 },
    },
    required: ['id'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      await pm(ctx).stop(a.id, { signal: a.signal, graceMs: a.graceMs });
      const handle = pm(ctx).get(a.id);
      return ok(handle);
    } catch (e) {
      return err(e);
    }
  },
};

export const deleteProcessTool: Tool = {
  name: 'delete_process',
  description:
    'Delete the record of a dead process (meta.json, output.log, and directory). Refuses if the process is still running — call stop_process first.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      await pm(ctx).delete(a.id);
      return ok({ ok: true, id: a.id });
    } catch (e) {
      return err(e);
    }
  },
};

export const processTools: Tool[] = [
  executeCommandTool,
  startProcessTool,
  listProcessesTool,
  getProcessTool,
  readProcessOutputTool,
  writeProcessInputTool,
  stopProcessTool,
  deleteProcessTool,
];
```

- [ ] **Step 4: Run — verify PASS**

```bash
npx vitest run packages/core/src/process/process-tools.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Full test suite**

```bash
npm test
```

Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/process/process-tools.ts packages/core/src/process/process-tools.test.ts
git commit -m "feat(core): add 8 process management tools"
```

---

## Task 8: Export from `packages/core` barrel

**Files:**

- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add export**

Current `packages/core/src/index.ts` has one export per module. Add:

```typescript
export * from './process/ProcessManager.js';
export * from './process/process-tools.js';
```

(Add after the last existing `export *` line.)

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export ProcessManager and process tools"
```

---

## Task 9: Wire `ProcessManager` into `LegionProcess`

**Files:**

- Modify: `packages/runtime/src/LegionProcess.ts`

- [ ] **Step 1: Import `ProcessManager` and `processTools` at top of `LegionProcess.ts`**

Add to imports (after existing `@legion-collective/core` imports):

```typescript
import { ProcessManager, processTools } from '@legion-collective/core';
```

- [ ] **Step 2: Construct `ProcessManager` and call `reconcileOnStartup`**

In `LegionProcess.start()`, after storage is initialised (around line 102, before `FileConversationStore`):

```typescript
const processManager = new ProcessManager({ storage, workspaceRoot });
await processManager.reconcileOnStartup();
```

- [ ] **Step 3: Register process tools**

After the existing `for (const tool of fileTools)` loop (around line 153), add:

```typescript
for (const tool of processTools) {
  toolRegistry.register(tool);
}
```

- [ ] **Step 4: Smuggle `processManager` into `ToolContext`**

In the `callTool` path where `toolCtx` is built (around line 517-533), add `processManager` alongside the other smuggled values:

```typescript
const toolCtx: ToolContext = {
  participant,
  conversationId,
  conversation: thread,
  collective,
  communicationDepth: 0,
  toolRegistry,
  config,
  eventBus,
  storage,
  workspaceRoot,
  authEngine,
  pendingApprovalRegistry,
  messageRouter: router,
  serviceManager,
  conversationStore: store,
  processManager, // add this line
};
```

Also update the second `toolCtx` literal in the `submit` path (around line 429-445) the same way.

- [ ] **Step 5: Store `processManager` as a class field and call `shutdown()` in `stop()`**

Add a private field:

```typescript
private processManager: ProcessManager | undefined;
```

Set it during `start()`:

```typescript
this.processManager = processManager;
```

In `LegionProcess.stop()` (around line 256), add at the top:

```typescript
if (this.processManager) {
  await this.processManager.shutdown().catch(() => undefined);
}
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 7: Smoke test — start Legion and verify process tools appear**

```bash
npm run dev &
sleep 3
# In another terminal or curl:
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"participantId":"operator","password":"<your-bootstrap-password>"}' | jq .token
# Then use the token:
curl -s -X POST http://localhost:3000/api/execute \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"tool":"list_tools","args":{}}' | jq '.result.data[] | select(.name | startswith("execute_command","start_process","list_processes"))'
```

Expected: process tools appear in the tool list.

- [ ] **Step 8: Kill dev server, commit**

```bash
kill %1
git add packages/runtime/src/LegionProcess.ts
git commit -m "feat(runtime): wire ProcessManager into LegionProcess"
```

---

## Task 10: WebSocket process subscriptions

**Files:**

- Modify: `packages/runtime/src/server/WebConnector.ts`

- [ ] **Step 1: Extend `WebConnectorDeps` with `processManager`**

In `WebConnector.ts`, find the `WebConnectorDeps` interface (lines 21-32):

```typescript
export interface WebConnectorDeps {
  collective: Collective;
  credentials: CredentialStore;
  eventBus: EventBus;
  serverConfig?: ServerConfig;
  webDistPath?: string;
  webSrcPath?: string;
  dev?: boolean;
}
```

Add `processManager`:

```typescript
import type { ProcessManager } from '@legion-collective/core';

export interface WebConnectorDeps {
  collective: Collective;
  credentials: CredentialStore;
  eventBus: EventBus;
  processManager: ProcessManager;
  serverConfig?: ServerConfig;
  webDistPath?: string;
  webSrcPath?: string;
  dev?: boolean;
}
```

- [ ] **Step 2: Add per-socket subscription state and handle `subscribe_process` / `unsubscribe_process`**

In `handleWebSocket`, after the existing `let anyOff: (() => void) | null = null;` line, add:

```typescript
const processSubs = new Map<string, Array<() => void>>();

function detachProcessSub(processId: string): void {
  const unsubs = processSubs.get(processId);
  if (unsubs) {
    for (const u of unsubs) u();
    processSubs.delete(processId);
  }
}
```

Inside the `socket.on('message', ...)` handler, after the `ping` branch and before the closing brace, add handling for process subscription messages. The existing structure is:

```typescript
if (msg.type === 'ping') { ... return; }
if (msg.type === 'auth' && !participantId) { ... }
```

Add after:

```typescript
if (msg.type === 'subscribe_process' && participantId) {
  const processId = (msg as any).processId as string;
  if (!processId) return;

  const handle = this.deps.processManager.get(processId);
  if (!handle) {
    socket.send(JSON.stringify({ type: 'subscribe_ack', processId, status: 'not_found' }));
    return;
  }
  if (handle.status !== 'running') {
    socket.send(JSON.stringify({ type: 'subscribe_ack', processId, status: 'dead' }));
    return;
  }

  // Detach previous subscription for same processId (idempotent re-subscribe)
  detachProcessSub(processId);

  const send = (type: string, payload: Record<string, unknown>): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type, processId, ...payload }));
    }
  };

  const offOutput = this.deps.processManager.subscribe(processId, 'output', (evt: any) => {
    send('process:output', {
      stream: evt.stream,
      data: (evt.data as Buffer).toString('base64'),
    });
  });

  const offExited = this.deps.processManager.subscribe(processId, 'exited', (evt: any) => {
    send('process:exited', { exitCode: evt.exitCode, signal: evt.signal ?? null });
    detachProcessSub(processId);
  });

  const offError = this.deps.processManager.subscribe(processId, 'error', (evt: any) => {
    send('process:error', { error: evt.error });
  });

  processSubs.set(processId, [offOutput, offExited, offError]);
  socket.send(JSON.stringify({ type: 'subscribe_ack', processId, status: 'subscribed' }));
  return;
}

if (msg.type === 'unsubscribe_process' && participantId) {
  const processId = (msg as any).processId as string;
  if (processId) detachProcessSub(processId);
  socket.send(JSON.stringify({ type: 'unsubscribe_ack', processId }));
  return;
}
```

- [ ] **Step 3: Clean up all process subscriptions on socket close**

In `socket.on('close', ...)`:

```typescript
socket.on('close', () => {
  clearTimeout(authTimer);
  if (participantId) {
    ctx.registry.clearActive(participantId, this.name);
    this.connections.get(participantId)?.delete(socket);
    if (this.connections.get(participantId)?.size === 0) {
      this.connections.delete(participantId);
    }
  }
  anyOff?.();
  // Detach all process subscriptions for this socket
  for (const processId of processSubs.keys()) {
    detachProcessSub(processId);
  }
});
```

- [ ] **Step 4: Pass `processManager` when constructing `WebConnector` in `LegionProcess.ts`**

In `LegionProcess.ts`, find where `WebConnector` is constructed (around line 208-216):

```typescript
const webConnector = new WebConnector({
  collective,
  credentials,
  eventBus,
  serverConfig: webConnectorConfig,
  webDistPath,
  webSrcPath,
  dev,
});
```

Add `processManager`:

```typescript
const webConnector = new WebConnector({
  collective,
  credentials,
  eventBus,
  processManager,
  serverConfig: webConnectorConfig,
  webDistPath,
  webSrcPath,
  dev,
});
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/server/WebConnector.ts packages/runtime/src/LegionProcess.ts
git commit -m "feat(runtime): add WebSocket process subscription (subscribe_process/unsubscribe_process)"
```

---

## Task 11: Format check + final verification

- [ ] **Step 1: Format**

```bash
npm run format
```

- [ ] **Step 2: Format check**

```bash
npm run format:check
```

Expected: no issues.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Full test suite**

```bash
npm test
```

Expected: all tests pass, no regressions.

- [ ] **Step 5: Build**

```bash
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 6: Smoke test**

```bash
npm start &
sleep 3
# Get a token (use your LEGION_BOOTSTRAP_PASSWORD)
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"participantId":"operator","password":"legion-dev"}' | jq -r .token)

# Run a command synchronously
curl -s -X POST http://localhost:3000/api/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tool":"execute_command","args":{"command":"echo","args":["hello from legion"]}}' | jq .

# Start an async process
curl -s -X POST http://localhost:3000/api/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tool":"start_process","args":{"command":"sleep","args":["30"],"name":"test-sleep"}}' | jq .

# List processes
curl -s -X POST http://localhost:3000/api/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tool":"list_processes","args":{}}' | jq .
```

Expected:

- `execute_command` returns `{status:'success', data:{exitCode:0, stdout:'hello from legion\n', ...}}`
- `start_process` returns `{status:'success', data:{id:'proc-...', status:'running', ...}}`
- `list_processes` returns both entries

- [ ] **Step 7: Final commit**

```bash
kill %1
git add -A
git commit -m "feat: process management — execute_command, start_process, 6 more tools, WS subscriptions"
```

---

## Self-Review

### Spec coverage check

| Spec requirement                                                                                            | Task                                                                        |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ProcessStatus`, `ProcessMeta`, `ProcessHandle`, `ExecuteResult`, `ProcessOutputChunk`, `SpawnConfig` types | Task 2                                                                      |
| `RingBuffer` — chunk-based, 1 MiB cap, `push`, `tail`, `byteSize`                                           | Task 3                                                                      |
| `process-storage` — `readMeta`, `writeMeta`, `listProcessIds`                                               | Task 4                                                                      |
| `ProcessEntry` internal type                                                                                | Task 5                                                                      |
| `ProcessManager` constructor with injectable spawner                                                        | Task 6a                                                                     |
| `reconcileOnStartup` sweeps stale `running` → `abandoned`                                                   | Task 6a                                                                     |
| `start` — pipe + PTY, spawn error handling, meta persist, emitter                                           | Task 6b                                                                     |
| `get`                                                                                                       | Task 6b                                                                     |
| `stop` — SIGTERM → grace → SIGKILL, awaits exit handler                                                     | Task 6c                                                                     |
| `writeInput` — pipe stdin, PTY write, EOF                                                                   | Task 6c                                                                     |
| `subscribe` — per-process emitter, returns unsub                                                            | Task 6c                                                                     |
| `execute` — sync wrapper, captures stdout/stderr, timeout                                                   | Task 6d                                                                     |
| `list` — disk + live overlay, filter, sort, paginate                                                        | Task 6d                                                                     |
| `readOutput` — ring tail + log file seek                                                                    | Task 6d                                                                     |
| `delete` — refuses running, removes files + dir                                                             | Task 6d                                                                     |
| `shutdown` — SIGTERM all, grace, SIGKILL, best-effort meta writes, clear map                                | Task 6d                                                                     |
| 8 process tools                                                                                             | Task 7                                                                      |
| Core barrel export                                                                                          | Task 8                                                                      |
| `LegionProcess` wiring — construct, reconcile, register tools, smuggle ctx, shutdown hook                   | Task 9                                                                      |
| WS `subscribe_process` / `unsubscribe_process`                                                              | Task 10                                                                     |
| `subscribe_ack` statuses: `subscribed`, `not_found`, `dead`                                                 | Task 10                                                                     |
| Auto-detach on process exit or socket close                                                                 | Task 10                                                                     |
| base64 encoding of `process:output` data                                                                    | Task 10                                                                     |
| `node-pty` dependency                                                                                       | Task 1                                                                      |
| Auth: process tools not seeded in bootstrap policy                                                          | Covered by existing AuthEngine default `requires_approval` — no task needed |
| Prune/retention: explicitly not in v1                                                                       | Correctly absent                                                            |

### Placeholder scan

No TBDs, TODOs, "similar to task N", or missing code blocks found.

### Type consistency check

- `SpawnConfig` defined in Task 2 (`packages/types/src/process.ts`), used in Task 6 `ProcessManager.start` and Task 7 tools — consistent.
- `ProcessHandle` returned by `start()`, `get()`, `list()` throughout — consistent field names.
- `ExecuteResult` defined in Task 2, returned by `execute()` in Task 6, returned by `execute_command` tool in Task 7 — consistent.
- `ProcessEntry.logByteCount` defined in Task 5, incremented in `attachOutputHandlers` (Task 6b), read in `readOutput` (Task 6d) — consistent.
- `writeMeta(storage, meta)` signature used the same way in Tasks 4, 6a, 6b, 6d — consistent.
- `listProcessIds(storage)` called in `reconcileOnStartup` (Task 6a) and `list()` (Task 6d) — consistent.
- `processTools` exported from `process-tools.ts` (Task 7), imported and registered in `LegionProcess.ts` (Task 9) — consistent.
- `ProcessManager` exported from `packages/core/src/index.ts` (Task 8), imported in `LegionProcess.ts` (Task 9) and `WebConnector.ts` (Task 10) — consistent.
- `processSubs` and `detachProcessSub` defined and used only within `handleWebSocket` scope (Task 10) — consistent.
