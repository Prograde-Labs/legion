# Process Management Design

**Date:** 2026-07-04  
**Status:** Approved for implementation  
**Scope:** `packages/core`, `packages/types`, `packages/runtime` (wiring only)

---

## Overview

Legion needs the ability to execute shell commands and manage long-lived OS processes as first-class operations. Participants (agents, services, users via connectors) call process management tools like any other authorized tool call. A new internal `ProcessManager` component (sibling to `ServiceManager`) owns the process lifecycle, output capture, and per-process event emission. Eight new tools expose the surface. The SPA subscribes to live process output via an extended WebSocket protocol.

Two runtime modes are supported per-process: **pipe mode** (`child_process.spawn` with stdin/stdout/stderr pipes) for build scripts, servers, and non-interactive programs; and **PTY mode** (`node-pty`) for interactive shells and programs that behave differently under a terminal. The caller picks per-process at start time.

---

## Decisions

| Decision                | Choice                                                                                               | Rationale                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Architecture            | Tool family + internal `ProcessManager`                                                              | Matches `file_*`, `create_agent` pattern; management actions are ordinary authorized tool calls                           |
| Execution modes         | Both pipe + PTY; caller chooses per-process                                                          | Some programs require a TTY (interactive shells, TUI apps, programs that branch on `isatty`)                              |
| Output capture          | In-memory ring buffer (1 MiB) + persistent `output.log` + per-process event emitter                  | Ring = fast hot reads; file = historical seeks; emitter = live subscribers (services, SPA)                                |
| Process identity        | Auto-generated `proc-<uuid>` via existing `createId('proc')` + optional display name                 | Consistent with existing ID convention; no collision risk                                                                 |
| Auth                    | Per-tool `ToolPolicy` only, no command-pattern inspection                                            | Matches Legion philosophy; operator responsibility; default `requires_approval` fallback means no accidental shell access |
| Dirty shutdown          | Startup sweep: stale `running` entries → `abandoned`                                                 | Deterministic, honest about uncertainty, cheap, self-healing; no PID liveness probe                                       |
| Live-only vs historical | Live table + persisted `meta.json` per process                                                       | Cheap historical record; survives restart for audit/debug                                                                 |
| Prune/retention         | Not in v1                                                                                            | Future work; `delete_process` covers manual cleanup                                                                       |
| Shutdown behavior       | Kill all running processes on Legion shutdown                                                        | Processes are ephemeral, tied to Legion lifecycle; clean exit                                                             |
| Events                  | Per-process `EventEmitter` on `ProcessEntry`                                                         | Avoids global-bus pollution; finer-grained than global `LegionEventMap`; subscribers attach to specific process           |
| SPA event delivery      | WS `subscribe_process` / `unsubscribe_process` messages; server relays per-process emitter to socket | SPA subscribes to the process it's viewing, not a fire-hose; no global-bus relay needed                                   |
| WS output encoding      | base64                                                                                               | Safe for binary/partial-UTF-8 chunks, ANSI escape codes; SPA decodes via `TextDecoder`; optimize later if needed          |
| `cwd` / `env`           | Caller-supplied; default `workspaceRoot` + inherited `process.env`                                   | Flexible, caller-responsible                                                                                              |
| `delete_process`        | Manual one-at-a-time cleanup of dead process records                                                 | Pruning/retention (automated bulk) is future work                                                                         |

---

## Package Layout

### New files

```
packages/types/src/
  process.ts                  # ProcessStatus, ProcessMeta, ProcessHandle, ProcessEvents

packages/core/src/process/
  ProcessManager.ts           # owns live Map<id,ProcessEntry>, spawn, shutdown, sweep
  ProcessEntry.ts             # single process handle: metadata + EventEmitter + ring buffer + log stream
  RingBuffer.ts               # bounded chunk buffer, ~1 MiB cap
  process-tools.ts            # 8 Tool objects registered in LegionProcess.start
  process-storage.ts          # helpers: read/write meta.json, open output.log append stream
  process-events.ts           # per-process event type map (started|output|exited|error)
  ProcessManager.test.ts
  process-tools.test.ts
  RingBuffer.test.ts
  process-storage.test.ts
```

### Modified files

```
packages/types/src/index.ts           # re-export process.ts
packages/core/src/index.ts            # export ProcessManager, process types
packages/runtime/src/LegionProcess.ts # construct ProcessManager, register tools, hook shutdown, pass to WebConnector deps
packages/runtime/src/server/WebConnector.ts  # subscribe_process / unsubscribe_process WS messages
```

### Import direction (unchanged)

```
packages/types  <--  packages/core  <--  packages/runtime
```

`ProcessManager` lives in `core`. `WebConnector` (runtime) receives it via deps injection. Types live in `packages/types`. `core` never imports `runtime`.

---

## Types (`packages/types/src/process.ts`)

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
  exitedAt: string | null; // ISO-8601; null if still running or abandoned without exit event
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
```

---

## Component: `ProcessEntry` (`packages/core/src/process/ProcessEntry.ts`)

Internal to `ProcessManager`. Never exposed to callers directly.

```typescript
interface ProcessEntry {
  meta: ProcessMeta;
  child: ChildProcess | IPty | null; // null after exit
  emitter: EventEmitter; // per-process event channel
  ringBuffer: RingBuffer;
  logStream: Writable | null; // output.log append stream; null after close
  logByteCount: number; // running total for read offset / totalBytes
}
```

**ProcessEntry is internal.** Callers get `ProcessHandle` (a frozen snapshot of public fields). Subscribers call `processManager.subscribe(id, event, cb)` which attaches to `entry.emitter` internally.

---

## Component: `RingBuffer` (`packages/core/src/process/RingBuffer.ts`)

Bounded ring of `Buffer` chunks. Target size 1 MiB (`DEFAULT_RING_BYTES = 1024 * 1024`).

```typescript
class RingBuffer {
  constructor(maxBytes: number = DEFAULT_RING_BYTES) {}
  push(chunk: Buffer): void; // append chunk; drop oldest chunks until byteSize <= maxBytes
  tail(bytes: number): Buffer; // return last `bytes` bytes as single concatenated Buffer
  get byteSize(): number;
}
```

Chunk-based (not byte-precise splitting): chunks are appended whole; when cumulative size exceeds `maxBytes`, oldest chunks are dropped whole. No chunk splitting. This is correct because output consumers decode the resulting Buffer as text anyway and don't care about exact boundaries.

---

## Component: `ProcessManager` (`packages/core/src/process/ProcessManager.ts`)

### Constructor

```typescript
interface ProcessManagerDeps {
  storage: Storage; // will scope to 'processes'
  workspaceRoot: string;
  // injectable for testing:
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  ptySpawn?: (cmd: string, args: string[], opts: PtyOptions) => IPty;
}

class ProcessManager {
  constructor(deps: ProcessManagerDeps) {}
}
```

`spawn` and `ptySpawn` default to `child_process.spawn` and `nodePty.spawn` in production. Tests inject fakes — no real OS processes in unit tests.

### Methods

#### `reconcileOnStartup(): Promise<void>`

Called early in `LegionProcess.start`, before tools are registered.

1. List all `processes/*/meta.json` from scoped storage.
2. Parse each. If `status === 'running'`: mutate to `{ status: 'abandoned', exitedAt: <now>, exitCode: null, abandonedReason: 'parent_unclean_shutdown' }`, persist.
3. Clean entries (already exited/killed/abandoned) are left on disk — available to `list_processes` as historical records but not loaded into the live map.

#### `start(config: SpawnConfig, startedByParticipantId: string): Promise<ProcessHandle>`

```typescript
interface SpawnConfig {
  command: string;
  args?: string[];
  cwd?: string; // default workspaceRoot
  env?: Record<string, string>; // merged onto process.env
  tty?: boolean; // default false
  shell?: boolean; // default false; wraps command in /bin/sh -c
  name?: string;
  cols?: number; // tty only, default 80
  rows?: number; // tty only, default 24
}
```

Steps:

1. Generate `id = createId('proc')`.
2. Create storage dir `.legion/processes/<id>/`.
3. Build `ProcessEntry`: construct `EventEmitter`, `RingBuffer`, set `meta.status = 'starting'`.
4. Persist initial `meta.json`.
5. Spawn: if `tty:false` → `spawn(command, args, {stdio:['pipe','pipe','pipe'], cwd, env, shell})`; if `tty:true` → `ptySpawn(command, args, {cwd, env, cols, rows})`.
6. Open `output.log` append stream.
7. Attach data handlers (see Output Capture below).
8. Update `meta.status = 'running'`, persist meta.
9. Emit `started` on per-process emitter.
10. Add entry to live map.
11. Return `ProcessHandle` snapshot.

On spawn error (ENOENT, EACCES — emitted as `child.on('error')` before any `exit`): set `status:'abandoned'`, persist meta, emit `error` on per-process emitter, close log stream, do NOT add to live map (or remove if already added). Return error result.

#### `execute(config: SpawnConfig & { timeoutMs?: number }, startedByParticipantId: string): Promise<ExecuteResult>`

Sync wrapper — internally calls `start()`, buffers all output, awaits exit.

1. Call `start()`. Attach private output accumulator (separate from ring — captures stdout/stderr separately for the return value; ring also gets the chunks).
2. Race: `entry.emitter.once('exited', ...)` vs `setTimeout(timeoutMs)`.
3. On exit: return `{processId, exitCode, stdout, stderr, durationMs, timedOut: false}`.
4. On timeout: call `stop(id, {signal:'SIGTERM', graceMs: 5000})`, return `{..., timedOut: true, exitCode: null}`.
5. Entry remains in live map as historical record with final status.

`timeoutMs: 0` = no timeout. Default `60000`.

#### `stop(id: string, opts?: { signal?: 'SIGTERM'|'SIGKILL', graceMs?: number }): Promise<void>`

Defaults: `signal: 'SIGTERM'`, `graceMs: 5000`.

Caller-initiated stop of a single named process. `stop()` owns the full lifecycle: it sends the signal, waits for the OS `exit` event to fire, lets the `child.on('exit')` handler write the final `meta.json` and emit `exited`, then returns. The promise does not resolve until that handler has completed. This is safe because `stop()` controls the wait — it is stopping exactly one process and can afford to block until it is truly done.

1. Look up entry. Error if not found or not running.
2. If `SIGTERM`: send SIGTERM, await `child.on('exit')` up to `graceMs`. If still alive after grace: send SIGKILL, await exit.
3. If `SIGKILL`: send SIGKILL immediately, await exit.
4. The `child.on('exit')` handler (not `stop()` itself) sets `status:'killed'`, persists `meta.json`, emits `exited` on the per-process emitter, closes the log stream. This is the single canonical write path — `stop()` never mutates status directly, avoiding double-write races.
5. Return after the exit handler completes.

#### `writeInput(id: string, data: string, eof?: boolean): Promise<void>`

- Pipe mode: write `Buffer.from(data)` to `child.stdin`. If `eof`: call `child.stdin.end()`.
- PTY mode: call `pty.write(data)`. `eof` in PTY mode: write `\x04` (ctrl-D) — standard EOF in terminal.
- Error if process not running or stdin already closed.

#### `get(id: string): ProcessHandle | undefined`

Returns live-map handle or undefined. Callers needing historical (exited) handles use `getFromDisk(id)` (internal) or rely on `list()`.

#### `list(filter?: { status?: ProcessStatus | 'all', limit?: number, offset?: number }): Promise<ProcessHandle[]>`

1. Load all `processes/*/meta.json` from disk (historical + live).
2. Overlay live-map entries (authoritative for running status).
3. Filter by status.
4. Sort by `startedAt` desc.
5. Slice `[offset, offset+limit]`.
6. Return array of `ProcessHandle`.

#### `readOutput(id: string, opts?: { bytes?: number, from?: number }): Promise<{ data: Buffer, totalBytes: number, from: number }>`

- `from` omitted: return last `bytes` (default 8192, max 1 MiB) from ring buffer.
- `from` present: read from `output.log` at byte offset `from`, up to `bytes` bytes.
- `totalBytes`: total bytes written to `output.log` so far (= `entry.logByteCount`).

#### `subscribe(id: string, event: 'output'|'exited'|'error', cb: (payload) => void): () => void`

Attaches `cb` to `entry.emitter` for the given event. Returns an unsubscribe function. Throws if process not found (running processes only — dead entries have no live emitter). Callers are responsible for calling the returned unsub.

#### `delete(id: string): Promise<void>`

1. Look up entry (live map or disk). Error if `status === 'running'` — must stop first.
2. Remove from live map (if present).
3. Delete `meta.json`, `output.log`, and the `.legion/processes/<id>/` directory itself.

#### `shutdown(): Promise<void>`

Called from Legion's SIGINT/SIGTERM handler. Unlike `stop()`, which stops one process and can await its clean exit, `shutdown()` must stop all running processes simultaneously while Legion itself is terminating. Node's event loop may not fully drain — exit handlers may not complete before the process dies. Therefore `shutdown()` is best-effort: it attempts to write final metadata, but makes no guarantee. Any entries that don't get written are handled by `reconcileOnStartup()` on the next start.

1. Collect all live `status:'running'` entries.
2. Send SIGTERM to all simultaneously.
3. Wait up to 3000ms for the group (via `Promise.allSettled` on per-process exit promises).
4. For any still-alive entries: send SIGKILL.
5. For each entry that exited during shutdown: write `meta.json` with final status directly (not via the exit handler, which may not fire in time) — `status:'killed'` if signalled, `status:'exited'` if it exited cleanly. Close log streams.
6. Clear live map.

If Legion crashes (SIGKILL, OOM, panic) before `shutdown()` completes or is called at all, entries remain on disk with `status:'running'`. `reconcileOnStartup()` sweeps these to `abandoned` on the next start. The two mechanisms — `shutdown()` best-effort writes + `reconcileOnStartup()` sweep — together ensure no entry is permanently stuck as `running`.

---

## Output Capture

### Data flow (per chunk)

```
child.stdout on('data', chunk):
  entry.ringBuffer.push(chunk)
  entry.logStream.write(chunk)         // best-effort; error → emit 'error', never throw
  entry.logByteCount += chunk.length
  entry.emitter.emit('output', { id, stream: 'stdout', data: chunk, timestamp: nowIso() })

child.stderr on('data', chunk):
  // same, stream: 'stderr'

pty on('data', chunk):
  // same, stream: 'combined' (PTY merges stdout+stderr)
```

### Log file

- Raw bytes, stdout+stderr interleaved in arrival order.
- No framing, no stream markers, no rotation.
- `tail -f .legion/processes/<id>/output.log` works from a shell — intentional.
- Structured framing (timestamps, stream tags) deferred to future work.

### On log write failure

If `logStream.write` emits an error (disk full, FS error): emit `{type:'error', id, error: message}` on the per-process emitter. Continue delivering to ring buffer and per-process emitter. Log write failures never crash the process or block stdout piping.

### Exit handler

```typescript
child.on('exit', (code, signal) => {
  entry.meta.status = signal !== null ? 'killed' : 'exited';
  entry.meta.exitCode = code ?? null;
  entry.meta.exitedAt = nowIso();
  await persistMeta(entry);
  entry.emitter.emit('exited', { id, exitCode: code, signal, durationMs });
  entry.logStream?.end();
  entry.child = null; // keep entry in map; drop child handle
});
```

---

## Tool Family (`packages/core/src/process/process-tools.ts`)

Eight `Tool` objects. All retrieve `processManager` from `ToolContext` via the smuggling channel (same as `serviceManager`). All follow the `{name, description, parameters: JSONSchema, execute}` interface. All are `async`, return `ToolResult`.

### Shared spawn input schema

Used by both `execute_command` and `start_process` (the only difference is `timeoutMs`):

```jsonc
{
  "command": string,            // required
  "args": string[] = [],
  "cwd": string,                // default workspaceRoot from ToolContext
  "env": { [k]: string } = {},
  "tty": boolean = false,
  "shell": boolean = false,     // wrap in /bin/sh -c; useful for pipes/&&/redirects
  "name": string,               // optional display name
  "cols": number = 80,          // tty only
  "rows": number = 24           // tty only
}
```

### `execute_command`

Adds `timeoutMs: number = 60000` (0 = no timeout) to spawn input schema.

Returns:

```jsonc
{
  "processId": string,
  "exitCode": number | null,
  "stdout": string,
  "stderr": string,
  "durationMs": number,
  "timedOut": boolean
}
```

### `start_process`

Spawn input schema only (no `timeoutMs`). Fire-and-forget — returns immediately after spawn.

Returns `ProcessHandle`.

### `list_processes`

Input:

```jsonc
{
  "status": "running"|"exited"|"killed"|"abandoned"|"all" = "all",
  "limit": number = 100,
  "offset": number = 0
}
```

Returns `ProcessHandle[]`, sorted by `startedAt` desc. Includes both live and historical entries from disk.

### `get_process`

Input: `{ "id": string }`

Returns `ProcessHandle` or error result if not found.

### `read_process_output`

Input:

```jsonc
{
  "id": string,
  "bytes": number = 8192,      // max 1048576 (1 MiB) per call
  "from": number,              // byte offset in output.log; omit = ring buffer tail
  "decode": "utf8"|"base64" = "utf8"
}
```

Returns:

```jsonc
{
  "data": string,
  "totalBytes": number,        // total bytes in output.log; for SPA to know if more history exists
  "from": number               // actual start offset of returned data
}
```

### `write_process_input`

Input:

```jsonc
{
  "id": string,
  "data": string,
  "eof": boolean = false
}
```

Returns `{ "ok": true }` or error result.

### `stop_process`

Input:

```jsonc
{
  "id": string,
  "signal": "SIGTERM"|"SIGKILL" = "SIGTERM",
  "graceMs": number = 5000
}
```

Returns final `ProcessHandle`. Error if process already exited.

### `delete_process`

Input: `{ "id": string }`

Returns `{ "ok": true, "id": string }`. Error if `status === 'running'` (must call `stop_process` first).

### Auth / tool policy

Process tools are NOT seeded in `default-participants.ts`. The `AuthEngine` builtin fallback is `requires_approval`. Any participant that should run shell commands must have `execute_command`, `start_process`, etc. explicitly set to `auto` (or `requires_approval`) via `set_tool_policy`. Agents do not get shell access by accident.

---

## SPA WebSocket Subscription

### New client → server messages

```jsonc
{ "type": "subscribe_process",   "processId": "proc-..." }
{ "type": "unsubscribe_process", "processId": "proc-..." }
```

Only honored on authenticated sockets (`participantId` set). Pre-auth messages are dropped.

### New server → client messages

```jsonc
{ "type": "subscribe_ack",   "processId": "proc-...", "status": "subscribed"|"not_found"|"dead" }
{ "type": "unsubscribe_ack", "processId": "proc-..." }
{ "type": "process:output",  "processId": "proc-...", "stream": "stdout"|"stderr"|"combined", "data": "<base64>" }
{ "type": "process:exited",  "processId": "proc-...", "exitCode": 0, "signal": null }
{ "type": "process:error",   "processId": "proc-...", "error": "..." }
```

`process:output` data is base64-encoded. Handles binary output, partial UTF-8 sequences at chunk boundaries, and ANSI escape codes safely. SPA decodes: `Buffer.from(data, 'base64')` or `atob(data)` → `TextDecoder`.

### Per-socket subscription state

`WebConnector` maintains a `WeakMap<WebSocket, Map<processId, Array<() => void>>>` (three unsubscribe handles per subscription: output, exited, error). On subscribe:

1. `processManager.get(processId)` — not found → `subscribe_ack {status:'not_found'}`.
2. `status !== 'running'` → `subscribe_ack {status:'dead'}` (use `read_process_output` for historical data).
3. Running → attach three listeners via `processManager.subscribe(id, event, cb)`, store unsub handles, send `subscribe_ack {status:'subscribed'}`.

Relay callback guards `socket.readyState === WebSocket.OPEN` before every send.

On `unsubscribe_process`: call all three unsub handles, remove from per-socket map, send `unsubscribe_ack`.

On socket close: iterate all subscribed processIds, call all unsub handles — no leaks.

On `process:exited` relay: after sending `process:exited`, call all three unsub handles and remove from per-socket map (dead process won't emit again). SPA switches to historical mode.

### `processManager` in `WebConnector` deps

`WebConnector` receives `processManager: ProcessManager` in its deps object (constructed in `LegionProcess.start` before connectors start). No new global, no separate init step.

### SPA flow

1. User opens process list view → SPA calls `list_processes` tool via `POST /api/execute`.
2. User navigates to a running process → SPA sends `subscribe_process`.
3. `process:output` chunks stream in → SPA renders terminal-style scrollback.
4. User navigates away → SPA sends `unsubscribe_process` (or socket close auto-detaches).
5. User calls `stop_process` via SPA → receives `process:exited` on WS, subscription auto-detaches.
6. User calls `delete_process` → process disappears from list.

---

## Wiring in `LegionProcess.start`

1. Construct `ProcessManager` after `StorageManager`, before `ServiceManager`:
   ```typescript
   const processManager = new ProcessManager({ storage, workspaceRoot });
   ```
2. `await processManager.reconcileOnStartup()` — early, before tools registered.
3. Register process tools alongside other core tools (step 6 in existing startup sequence).
4. Smuggle `processManager` into `ToolContext` via the `[key: string]: unknown` index signature (same as `serviceManager`, `authEngine`, etc.).
5. Pass `processManager` to `WebConnector` deps.
6. Hook `processManager.shutdown()` into existing SIGINT/SIGTERM handler (alongside `serviceManager.stopAll()`).

---

## Dependencies

- **`node-pty`** — native module; add to `packages/core/package.json`. Enables PTY mode. May require build tools on some platforms. Import guarded:

  ```typescript
  // native dep — may require build tools (node-gyp)
  import * as nodePty from 'node-pty';
  ```

  If `node-pty` fails to install (e.g. missing build tools in CI), PTY mode is unavailable at build time. Consider a dynamic `import()` with a try/catch that disables PTY mode gracefully rather than failing the whole process — defer this resilience to implementation.

- No other new external deps. `child_process`, `EventEmitter`, `Writable` are Node built-ins.

---

## Storage Layout

```
.legion/
  processes/
    proc-<uuid>/
      meta.json      # ProcessMeta; written on start, updated on exit/reconcile
      output.log     # raw stdout+stderr bytes in arrival order; append-only
    proc-<uuid>/
      ...
```

`meta.json` shape matches `ProcessMeta` type exactly. `output.log` is raw bytes, no framing. Both files are gitignored (`.legion/` is already gitignored).

---

## Testing Strategy

### Unit tests (`packages/core/src/process/*.test.ts`)

**Fake spawner injection.** `ProcessManager` constructor accepts optional `spawn` and `ptySpawn` for test injection. Fakes return a mock `ChildProcess`/`IPty` that emits events on demand. No real OS processes in unit tests — fast and deterministic.

**`RingBuffer.test.ts`**

- Push chunks until over 1 MiB; verify oldest dropped, byte count bounded.
- `tail(bytes)` returns correct slice.
- Edge: empty buffer, single oversized chunk.

**`process-storage.test.ts`**

- `meta.json` write/read round-trip (all fields, null fields).
- Corrupted JSON parse: must throw, not silently swallow.
- Missing directory: must error clearly.
- `output.log` append: multiple writes, read-back matches.

**`ProcessManager.test.ts`**

- `start()` happy path: persists `running` meta, emits `started`, returns handle.
- `start()` ENOENT: fake emits `error` before `exit`; manager sets `abandoned`, emits `error`, persists meta.
- `execute()` success: returns captured stdout/stderr/durationMs, entry stays in map as `exited`.
- `execute()` timeout: SIGTERM at `timeoutMs`, SIGKILL after grace, returns `timedOut:true`.
- `execute()` with `timeoutMs:0`: no timeout; resolves when fake emits exit.
- `stop()` SIGTERM → grace → SIGKILL escalation; final status `killed`.
- `writeInput()` pipe mode writes to `child.stdin`; tty mode calls `pty.write`; errors on dead process.
- `readOutput()` ring tail, `from` offset reads from file, `bytes` clamped to 1 MiB.
- `subscribe()` returns unsub; events fire; unsub stops delivery.
- `shutdown()` SIGTERMs all running, writes killed meta, clears live map, closes log streams.
- `reconcileOnStartup()` stale `running` → `abandoned`, persisted; clean entries untouched.
- `delete()` dead process: removed from map + disk. Running process: returns error.

**`process-tools.test.ts`**

- Each tool: mock `ProcessManager` injected into `ToolContext`. Validates JSONSchema enforcement (missing required, wrong type), error propagation, `delete_process` refusing on running entry.

### Integration tests (`*.integration.test.ts`, gated by `LEGION_INTEGRATION=1`)

- `echo hello` via `execute_command`: captured stdout, `exitCode:0`, `output.log` contents match.
- `sleep 1` started async, killed mid-flight via `stop_process`: `status:'killed'`.
- `node -e "process.stdin.resume()"`: `write_process_input` path.
- Real PTY via `node-pty`: `bash -c 'tty'` confirms TTY allocated; write `echo foo\n`, receive output.
- `reconcileOnStartup()` against real `.legion/processes/` with hand-crafted stale `running` meta.

### WebSocket integration tests (gated by `LEGION_INTEGRATION=1`)

Modeled on `WebConnector.ws.integration.test.ts`.

- Auth → `subscribe_process` running process → `subscribe_ack {status:'subscribed'}` → write stdin → receive `process:output` → `stop_process` → receive `process:exited` → auto-detach.
- Subscribe nonexistent → `subscribe_ack {status:'not_found'}`.
- Subscribe dead process → `subscribe_ack {status:'dead'}`.
- Unsubscribe mid-stream → no further events.
- Socket close → subscriber count drops (spy on `subscribe`/unsub).

### E2E (`packages/e2e`)

Full UI round-trip (lower priority for v1; implement once SPA process management view exists):

- List processes → start via tool call from SPA execute pane → appear in list → click → live output → stop → exit → delete → gone.

---

## Future Work

- **Pruning / retention**: automated bulk cleanup by age or count (e.g. keep last 100 exited, or last 7 days). `delete_process` covers manual one-at-a-time cleanup in v1.
- **`read_process_output` with `follow: true`**: long-poll or SSE tail. Deferred — live tail goes through WS subscribe path in v1.
- **Structured log framing**: timestamps + stream tags in `output.log` for richer historical seeks.
- **Per-process sandbox**: constrained `cwd`, filtered `env`, resource limits (`ulimit`, cgroups). Operator responsibility in v1.
- **`node-pty` resilience**: dynamic import with graceful degradation if native build unavailable.
- **PTY resize**: `pty.resize(cols, rows)` API exposed as a new tool or WS message. Needed for proper TUI rendering.
- **Process groups**: `detached: true` + `pid group kill` for spawning trees of processes cleanly.
