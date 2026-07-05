# Process Management UI Design

**Date:** 2026-07-05
**Status:** Approved for implementation
**Scope:** `packages/web` only — backend (`ProcessManager`, 8 tools, WS subscriptions) already shipped.

---

## Overview

A `/processes` section in the Legion SPA lets operators start, monitor, and control OS processes managed by `ProcessManager`. The UI follows the existing Conversations split-view pattern: a persistent list sidebar on the left and a context-sensitive right pane (start form or process detail). All processes — whether started by the UI or by agents via tools — appear in the list.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Layout | Split view: list sidebar left, detail right | Mirrors ConversationsView; keeps list visible while watching output |
| Routing | `/processes` + `/processes/:id` | Same route, same component — `activeId` derived from `route.params.id` |
| Empty / default state | Inline `ProcessStartForm` in right pane | Mirrors `/conversations/new`; no wasted click to get a form |
| Process mode | Always `start_process` (async) | Both async and `execute_command` produce `ProcessEntry`; UI treats them uniformly |
| Detail layout | Terminal-first: header bar → scrollback → sticky stdin footer | Output space maximised; metadata in header, not sidebar |
| Terminal style | Classic: cyan prompt, slate stdout, green success, red stderr, cursor blink | Familiar, colour-coded by stream |
| ANSI rendering | `ansi_up` library | Zero deps, single TS file, stateful streaming API handles chunk boundaries, 256-colour + truecolor, MIT, actively maintained (v6.0.6 May 2025) |
| Output data model | `chunks: Ref<string[]>` in `useProcess` | Preserves `AnsiUp` stateful streaming; composable stays UI-free |
| `AnsiOutput.vue` | Owns `AnsiUp` instance, scroll-lock, `<pre>` DOM | UI concern isolated to component; matches `MarkdownContent.vue` pattern |
| `ProcessDetail` lifecycle | `:key="processId"` — destroy/recreate on id change | Matches `ConversationThread` pattern; `useProcess` stays simple |
| List refresh | Poll every 5 s + manual `refresh()` on form submit | No process lifecycle EventBus events in v1; simple and reliable |
| ANSI scroll-lock | Auto-scroll to bottom unless user scrolled up (50 px threshold) | Standard terminal UX |

---

## Package Layout

### New files

```
packages/web/src/
  views/
    ProcessesView.vue                  # root view — list + detail split
  components/processes/
    ProcessList.vue                    # left sidebar: list of all processes
    ProcessDetail.vue                  # right pane: terminal + controls
    ProcessStartForm.vue               # right pane when no :id selected
    ProcessStatusDot.vue               # colour-coded dot per ProcessStatus
    AnsiOutput.vue                     # ANSI-to-HTML renderer with scroll-lock
  composables/
    useProcesses.ts                    # list fetching + polling
    useProcess.ts                      # single process: handle, chunks, actions
```

### Modified files

```
packages/web/src/router/index.ts                        # add /processes + /processes/:id
packages/web/src/components/layout/AppSidebar.vue       # add Processes nav entry
packages/web/package.json                               # add ansi_up dependency
```

---

## Routes

Both routes render `ProcessesView.vue`. The component reads `route.params.id` to determine which pane to show.

```
/processes          → ProcessesView (right pane: ProcessStartForm)
/processes/:id      → ProcessesView (right pane: ProcessDetail, keyed on :id)
```

Router entries follow the existing auth-guard pattern (`meta: { requiresAuth: true }`).

Sidebar nav entry added between Events and Config:

```typescript
{ label: 'Processes', icon: '⚙', to: '/processes' }
```

---

## Components

### `ProcessesView.vue`

Thin orchestrator. Mirrors `ConversationsView` structure.

- Reads `activeId` from `route.params.id`
- Renders `<ProcessList>` (fixed-width left column) and either `<ProcessStartForm>` or `<ProcessDetail :key="activeId" :process-id="activeId">` in the right flex-1 column
- On `ProcessStartForm` submit success: navigates to `/processes/:id` and calls `useProcesses().refresh()`
- Subscribes to `useProcesses()` for the list data passed to `ProcessList`

### `ProcessList.vue`

Left sidebar. Receives `processes: ProcessHandle[]` and `activeId: string | null` as props.

Each row displays:
- `ProcessStatusDot` with current status
- Command + optional name (truncated)
- Elapsed time if running, exit time if done
- Click → `router.push('/processes/' + id)`
- Active row highlighted (cyan accent, matching Conversations pattern)

Rows sorted by `startedAt` descending (most recent first). All statuses shown; exited/killed/abandoned rows appear dimmed (`opacity-50`).

### `ProcessStatusDot.vue`

Extends `StatusDot.vue` pattern with process-specific colours:

| Status | Colour |
|---|---|
| `running` | cyan-400 (animated pulse) |
| `starting` | amber-400 |
| `exited` | slate-500 |
| `killed` | red-400 |
| `abandoned` | navy-500 |

### `ProcessStartForm.vue`

Rendered in the right pane when no process is selected (`/processes`).

Fields:

| Field | Input | Notes |
|---|---|---|
| Command | text, required | e.g. `npm` |
| Args | text, optional | space-separated; split on submit; e.g. `run dev` |
| Name | text, optional | display name for the process list |
| Working dir | text, optional | defaults to workspaceRoot on backend |
| TTY | checkbox | allocate pseudo-terminal |
| Shell | checkbox | wrap in `/bin/sh -c` |

On submit:
1. Calls `execute('start_process', { command, args, name, cwd, tty, shell })`
2. On success: `router.push('/processes/' + result.id)` + `useProcesses().refresh()`
3. On error: shows inline error message, form stays open

Submit button label: `▶ Start process`. Disabled while submitting.

### `ProcessDetail.vue`

Receives `processId: string` prop. Keyed externally so it is destroyed and recreated when `processId` changes.

Uses `useProcess(processId)` for all state and actions.

**Layout (terminal-first):**

```
┌─────────────────────────────────────────────────────┐
│ ● npm run dev   pid 12345   2m 14s      [Stop] [Del] │  ← header bar
├─────────────────────────────────────────────────────┤
│                                                     │
│  $ npm run dev                                      │  ← AnsiOutput (flex-1, overflow-y-auto)
│    VITE v5.4.0  ready in 312ms                      │
│    ➜  Local: http://localhost:3000/                  │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [stdin input………………………………………]  [Send]              │  ← sticky footer (hidden when not running)
└─────────────────────────────────────────────────────┘
```

**Header bar** (always visible):
- `ProcessStatusDot` + status label
- Command string (+ name if set)
- PID
- Elapsed timer: live `setInterval(1s)` while `status === 'running'`; shows final duration when stopped
- `Stop` button: calls `stop()`, disabled when status ≠ `running`, styled red
- `Delete` button: calls `del()`, disabled when status === `running`

**`<AnsiOutput>`**: receives `chunks` from `useProcess`. Takes up all remaining vertical space.

**Stdin footer** (only rendered when `status === 'running'`):
- Text input, placeholder `"stdin…"`
- `Send` button: calls `send(input)`, clears input on success
- Enter key also submits

### `AnsiOutput.vue`

Prop: `chunks: string[]`

Owns:
- `AnsiUp` instance (one per component lifetime — stateful, handles split escape sequences)
- Internal `renderedHtml: string` (append-only, never reset during component lifetime)
- `processed: number` counter — index into `chunks` up to which rendering is complete
- `<pre>` DOM ref for scroll management

Rendering loop (runs in `watchEffect` or `watch(() => chunks.length, ...)`):
1. Slice `chunks.slice(processed)` to get new chunks
2. For each: `renderedHtml += ansiUp.ansi_to_html(chunk)`
3. `processed = chunks.length`
4. Update `<pre>` innerHTML and conditionally scroll

Scroll-lock:
- After each render: if `preEl.scrollHeight - preEl.scrollTop - preEl.clientHeight < 50` → scroll to bottom
- `scroll` listener: if user scrolls up past threshold, auto-scroll stops
- Scroll-to-bottom button appears when not at bottom (small overlay button, bottom-right corner of the output pane)

Styling:
- `<pre>` with `font-family: monospace`, `font-size: 11.5px`, `line-height: 1.65`, `background: #0a111e` (slightly darker than navy-950), padding `14px 16px`
- `ansi_up` configured with `use_classes: false` (inline styles) so ANSI colours render without a separate CSS class sheet

---

## Composables

### `useProcesses.ts`

```typescript
export function useProcesses() {
  const processes: Ref<ProcessHandle[]>
  const loading: Ref<boolean>
  const error: Ref<string | null>

  async function refresh(): Promise<void>  // calls list_processes({ status: 'all' })

  // Auto-poll every 5s; stopped on last consumer unmount via onUnmounted
  // refresh() called immediately on first use

  return { processes, loading, error, refresh }
}
```

Polling runs while any component consuming `useProcesses` is mounted. Uses a module-level ref-count to avoid multiple simultaneous polls when both `ProcessesView` and `ProcessList` consume it.

### `useProcess.ts`

```typescript
export function useProcess(processId: string) {
  const handle: Ref<ProcessHandle | null>
  const chunks: Ref<string[]>      // raw decoded strings, append-only
  const error: Ref<string | null>

  async function send(data: string): Promise<void>   // write_process_input
  async function stop(): Promise<void>               // stop_process
  async function del(): Promise<void>                // delete_process

  return { handle, chunks, error, send, stop, del }
}
```

**Mount sequence:**
1. `execute('get_process', { id })` → populate `handle`
2. If `handle.status === 'running'`: `execute('read_process_output', { id, bytes: 65536, decode: 'base64' })` → decode → push as first element of `chunks`
3. If `handle.status === 'running'`: send `{ type: 'subscribe_process', processId: id }` via `useWebSocket().send()`
4. Register WS message handler via `useWebSocket().onMessage()`

**WS message handling:**
- `{ type: 'process:output', processId: id }` → `atob(data)` → push to `chunks`
- `{ type: 'process:exited', processId: id }` → update `handle.status`, `handle.exitCode`; server auto-detaches subscription
- `{ type: 'process:error', processId: id }` → set `error`
- Messages for other `processId` values are ignored

**Unmount:** send `{ type: 'unsubscribe_process', processId: id }` if still subscribed; call the WS handler unsub function.

---

## Terminal Style Reference

The `<pre>` container background is `#0a111e`. Text colours via `ansi_up` inline styles for ANSI codes. For non-ANSI text (plain stdout):

| Content | Class / colour |
|---|---|
| Default stdout | `text-slate-300` (`#cbd5e1`) |
| stderr (stream label only — ANSI codes colour the content itself) | `text-red-400` |
| Cursor (blinking block) | `border-r-2 border-cyan-400`, CSS `animation: blink 1s step-end infinite` |

The cursor is shown only when `status === 'running'` and the `chunks` array has been populated. It is appended as a static `<span>` after the `<pre>` content, not inside `renderedHtml`.

---

## Dependency

`ansi_up` added to `packages/web/package.json`:

```json
"dependencies": {
  "ansi_up": "^6.0.6"
}
```

Zero transitive dependencies. Single TypeScript source file (`ansi_up.ts`) — self-contained and forkable if maintenance lapses. ESM-compatible.

---

## Testing

Tests live in `packages/web/src/` alongside their subjects. Run with `npm run test --workspace=packages/web` (happy-dom).

### `useProcesses.test.ts`

- Fetches process list on first call
- Returns cached list on subsequent calls before refresh
- `refresh()` re-fetches and updates `processes` ref
- Polling interval created on mount, cleared on unmount

### `useProcess.test.ts`

- Mount with running process: fetches handle, fetches output tail, sends `subscribe_process`
- Mount with exited process: fetches handle, fetches tail from disk (historical), does not send `subscribe_process`
- `process:output` WS message → chunk appended to `chunks`
- `process:exited` WS message → `handle.status` and `handle.exitCode` updated
- Unmount → `unsubscribe_process` sent, WS handler removed
- `send()` calls `write_process_input` with correct args
- `stop()` calls `stop_process`, updates handle on success
- `del()` calls `delete_process`

### `AnsiOutput.test.ts`

- Renders plain text chunks as-is inside `<pre>`
- Renders ANSI colour codes as `<span>` tags with inline styles
- Processes only newly appended chunks (not full re-render on each append)
- Shows scroll-to-bottom button when not at bottom (mocked scroll state)

### `ProcessStartForm.test.ts`

- Submit with empty command: validation error shown, `start_process` not called
- Submit with valid command: calls `start_process`, emits `started` event with process id
- Submit error: inline error shown, form stays open

---

## Out of Scope (v1)

- PTY resize: `pty.resize(cols, rows)` — future WS message
- Process input history (up-arrow)
- Log download button
- Structured log view (timestamps + stream tags)
- Process lifecycle EventBus events (would allow event-driven list refresh instead of polling)
- E2E Playwright tests (noted in backend spec as post-UI work)
- `execute_command` (sync) mode in the UI form
