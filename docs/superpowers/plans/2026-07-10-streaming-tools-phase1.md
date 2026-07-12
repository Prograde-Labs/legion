# Streaming Tools — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add core streaming infrastructure — `StreamingTool` interface, `ToolRegistry` streaming, 3-mode transport (WS/SSE/buffered), subscription tools replacing the EventBus→WebSocket bridge, `cancel_stream` tool.

**Architecture:** `StreamingTool` yields `StreamChunk` values; `ToolRegistry` wraps them with lifecycle injection (`stream:done`/`stream:error`). `WebConnector` issues a `connectionId` per socket; the execute route routes chunks to that socket. Subscription tools bridge `EventBus` push events into pull-based async generators via `AsyncQueue`.

**Tech Stack:** Node.js 20+, TypeScript strict + NodeNext, Vitest, Vue 3, Fastify, WebSocket (ws library)

---

## File Map

### New files

| File                                                  | Purpose                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/types/src/streaming.ts`                     | `LLMChunk`, `LifecycleChunk`, `EventChunk`, `ProcessChunk`, `StreamChunk` |
| `packages/core/src/streaming/AsyncQueue.ts`           | Abort-signal-aware async queue for subscription tools                     |
| `packages/core/src/streaming/StreamRegistry.ts`       | Transport-internal stream lifecycle tracking                              |
| `packages/core/src/tools/cancel-stream-tool.ts`       | `cancel_stream` regular Tool                                              |
| `packages/core/src/tools/watch-conversations-tool.ts` | `watch_conversations` StreamingTool                                       |
| `packages/core/src/tools/watch-participants-tool.ts`  | `watch_participants` StreamingTool                                        |
| `packages/core/src/tools/watch-activity-tool.ts`      | `watch_activity` StreamingTool                                            |
| `packages/core/src/tools/watch-conversation-tool.ts`  | `watch_conversation` StreamingTool                                        |
| `packages/core/src/tools/watch-process-tool.ts`       | `watch_process` StreamingTool                                             |
| `packages/web/src/composables/useToolStream.ts`       | Core frontend streaming composable                                        |

### Modified files

| File                                              | Change                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/index.ts`                     | Export `streaming.ts`                                                                                                                                    |
| `packages/core/src/tools/Tool.ts`                 | Add `StreamingTool`, `AnyTool`, `isStreamingTool`; update `ToolContext` (signal, cancelStream); update `ToolRegistryLike` (stream, AnyTool return types) |
| `packages/core/src/tools/ToolRegistry.ts`         | Update `register()` + map to `AnyTool`, add `stream()`, update `execute()` to drain streaming tools                                                      |
| `packages/core/src/connectors/Connector.ts`       | Add `streamTool()` to `ConnectorContext`                                                                                                                 |
| `packages/core/src/index.ts`                      | Export new tools and streaming utilities                                                                                                                 |
| `packages/runtime/src/LegionProcess.ts`           | Implement `streamTool()` in `buildConnectorContext`, register subscription tools, add to operator tool policies                                          |
| `packages/runtime/src/server/WebConnector.ts`     | Add `StreamRegistry`, `connectionId` per socket, send `connectionId` in `connected` frame, remove `onAny` bridge, remove `subscribe_process` handler     |
| `packages/runtime/src/server/routes/execute.ts`   | 3 transport modes: WS streaming (`X-Stream-Connection`), SSE, buffered (`?stream=false`)                                                                 |
| `packages/web/src/composables/useWebSocket.ts`    | Add `connectionId`, `onStreamChunk()`, `getConnectionId()`; remove `event` frame dispatch                                                                |
| `packages/web/src/views/ParticipantsView.vue`     | Replace `useEventStream` with `useToolStream` + `watch_participants`                                                                                     |
| `packages/web/src/views/ConversationsView.vue`    | Replace `useEventStream` with `useToolStream` + `watch_conversations`/`watch_activity`                                                                   |
| `packages/web/src/composables/useConversation.ts` | Replace `useEventStream` with `useToolStream` + `watch_conversation`/`watch_activity`                                                                    |

### Deleted files

| File                                                  | Reason                                      |
| ----------------------------------------------------- | ------------------------------------------- |
| `packages/runtime/src/server/event-filter.ts`         | Replaced by subscription tool authorization |
| `packages/runtime/src/server/event-filter.test.ts`    | Test for deleted file                       |
| `packages/web/src/composables/useEventStream.ts`      | Replaced by `useToolStream`                 |
| `packages/web/src/composables/useEventStream.test.ts` | Test for deleted composable                 |

---

## Task 1: `StreamChunk` types in `packages/types`

**Files:**

- Create: `packages/types/src/streaming.ts`
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Write the file**

```ts
// packages/types/src/streaming.ts
import type { ToolResult } from './tool.js';
import type { LegionEventMap, LegionEventName } from './events.js';

// LLM output — from communicate and any LLM-backed streaming tools
export type LLMChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string };

// Lifecycle — emitted by ToolRegistry, never by tool authors
export type LifecycleChunk =
  | { type: 'stream:done'; result: ToolResult }
  | { type: 'stream:error'; error: string };

// Event — from subscription tools; reuses LegionEventMap shapes
export type EventChunk = {
  [K in LegionEventName]: { type: K; data: LegionEventMap[K] };
}[LegionEventName];

// Process — from watch_process; source is ProcessManager, not EventBus
export type ProcessChunk =
  | { type: 'process:output'; processId: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'process:exited'; processId: string; exitCode: number | null }
  | { type: 'process:error'; processId: string; error: string };

export type StreamChunk = LLMChunk | EventChunk | LifecycleChunk | ProcessChunk;
```

- [ ] **Step 2: Export from `packages/types/src/index.ts`**

Add after the existing exports:

```ts
export * from './streaming.js';
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/streaming.ts packages/types/src/index.ts
git commit -m "feat(types): add StreamChunk union types for streaming"
```

---

## Task 2: `StreamingTool` + `ToolContext` additions in `packages/core/src/tools/Tool.ts`

**Files:**

- Modify: `packages/core/src/tools/Tool.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/tools/ToolRegistry.test.ts` (new `describe` block at the end of the file):

```ts
import { isStreamingTool } from './Tool.js';
import type { AnyTool, StreamingTool } from './Tool.js';
import type { StreamChunk } from '@legion/types';

describe('isStreamingTool', () => {
  it('returns false for a regular Tool', () => {
    const tool: AnyTool = {
      name: 'echo',
      description: 'desc',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success' };
      },
    };
    expect(isStreamingTool(tool)).toBe(false);
  });

  it('returns true for a StreamingTool', () => {
    const tool: StreamingTool = {
      name: 'watch',
      description: 'desc',
      parameters: { type: 'object' },
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'stream:done', result: { status: 'success' } };
      },
    };
    expect(isStreamingTool(tool)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/ToolRegistry.test.ts`
Expected: FAIL — `isStreamingTool` not exported from `./Tool.js`

- [ ] **Step 3: Add `StreamingTool`, `AnyTool`, `isStreamingTool` to `Tool.ts`**

Add import at the top of `packages/core/src/tools/Tool.ts`:

```ts
import type {
  JSONSchema,
  ToolResult,
  ParticipantConfig,
  WorkspaceConfig,
  StreamChunk,
} from '@legion/types';
```

Add to `ToolContext` interface (after `conversationStore?`):

```ts
  /** AbortSignal set by transport when a streaming call is cancelled. */
  signal?: AbortSignal;
  /** Narrow cancellation capability — only for the cancel_stream tool. */
  cancelStream?: (streamId: string) => boolean;
```

Replace the `ToolRegistryLike` interface:

```ts
export interface ToolRegistryLike {
  get(name: string): AnyTool | undefined;
  has(name: string): boolean;
  list(): AnyTool[];
  listAll(): string[];
  execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult>;
  stream(name: string, args: unknown, context: ToolContext): AsyncGenerator<StreamChunk>;
}
```

Replace the `Tool` interface (keep existing) and add after it:

```ts
/** A tool that yields chunks instead of returning a single result. */
export interface StreamingTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk>;
}

/** Either a regular tool or a streaming tool. */
export type AnyTool = Tool | StreamingTool;

/** Type guard — use before accessing `.stream()` or `.execute()`. */
export function isStreamingTool(t: AnyTool): t is StreamingTool {
  return 'stream' in t && typeof (t as StreamingTool).stream === 'function';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/ToolRegistry.test.ts`
Expected: PASS

- [ ] **Step 5: Full typecheck**

Run: `npm run typecheck`
Expected: no errors (if any appear, they're in places that use `ToolRegistryLike.list()` expecting `Tool[]` — cast as needed)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/Tool.ts packages/core/src/tools/ToolRegistry.test.ts
git commit -m "feat(core): add StreamingTool interface + ToolContext signal/cancelStream"
```

---

## Task 3: `AsyncQueue` — abort-signal-aware async queue

**Files:**

- Create: `packages/core/src/streaming/AsyncQueue.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/streaming/AsyncQueue.test.ts`:

```ts
import { AsyncQueue } from './AsyncQueue.js';

describe('AsyncQueue', () => {
  it('returns pushed values in order', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBe(2);
  });

  it('awaits a value that arrives after next() is called', async () => {
    const q = new AsyncQueue<string>();
    const prom = q.next();
    q.push('hello');
    expect(await prom).toBe('hello');
  });

  it('returns null when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const q = new AsyncQueue<number>();
    const result = await q.next(controller.signal);
    expect(result).toBeNull();
  });

  it('returns null when signal aborts while waiting', async () => {
    const controller = new AbortController();
    const q = new AsyncQueue<number>();
    const prom = q.next(controller.signal);
    controller.abort();
    expect(await prom).toBeNull();
  });

  it('delivers value pushed before abort fires', async () => {
    const controller = new AbortController();
    const q = new AsyncQueue<number>();
    q.push(42);
    const result = await q.next(controller.signal);
    // Value was in buffer — should return it even though signal exists
    expect(result).toBe(42);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/streaming/AsyncQueue.test.ts`
Expected: FAIL — `AsyncQueue` not found

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/streaming/AsyncQueue.ts`:

```ts
/**
 * A simple async queue that bridges EventBus push-events into pull-based
 * AsyncGenerator consumption. Signal-aware: `next(signal)` returns null
 * if the signal is already aborted or aborts while waiting.
 */
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiting: ((value: T | null) => void) | null = null;

  push(value: T): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(value);
    } else {
      this.buffer.push(value);
    }
  }

  async next(signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) return null;
    if (this.buffer.length > 0) return this.buffer.shift()!;

    return new Promise<T | null>((resolve) => {
      this.waiting = resolve;

      if (signal) {
        const onAbort = () => {
          // Only resolve if we're still the waiting callback.
          if (this.waiting === resolve) {
            this.waiting = null;
            resolve(null);
          }
        };
        // { once: true } auto-removes the listener after it fires.
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/streaming/AsyncQueue.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/streaming/AsyncQueue.ts packages/core/src/streaming/AsyncQueue.test.ts
git commit -m "feat(core): add AsyncQueue for subscription tool event bridging"
```

---

## Task 4: `StreamRegistry` — transport-internal lifecycle tracking

**Files:**

- Create: `packages/core/src/streaming/StreamRegistry.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/streaming/StreamRegistry.test.ts`:

```ts
import { StreamRegistry } from './StreamRegistry.js';

describe('StreamRegistry', () => {
  it('register returns an AbortSignal that is not aborted', () => {
    const reg = new StreamRegistry();
    const signal = reg.register('s1', 'conn-1');
    expect(signal.aborted).toBe(false);
  });

  it('cancel aborts the signal and returns true', () => {
    const reg = new StreamRegistry();
    const signal = reg.register('s1', 'conn-1');
    expect(reg.cancel('s1')).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it('cancel returns false for unknown streamId', () => {
    const reg = new StreamRegistry();
    expect(reg.cancel('nope')).toBe(false);
  });

  it('cancelAll aborts all streams for a connectionId', () => {
    const reg = new StreamRegistry();
    const sig1 = reg.register('s1', 'conn-A');
    const sig2 = reg.register('s2', 'conn-A');
    const sig3 = reg.register('s3', 'conn-B');
    reg.cancelAll('conn-A');
    expect(sig1.aborted).toBe(true);
    expect(sig2.aborted).toBe(true);
    expect(sig3.aborted).toBe(false);
  });

  it('cancel after cancelAll returns false', () => {
    const reg = new StreamRegistry();
    reg.register('s1', 'conn-1');
    reg.cancelAll('conn-1');
    expect(reg.cancel('s1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/streaming/StreamRegistry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/streaming/StreamRegistry.ts`:

```ts
/**
 * Transport-internal stream lifecycle tracker. Holds one AbortController per
 * active stream. Never exposed to ToolRegistry callers or tool authors.
 */
export class StreamRegistry {
  private streams = new Map<string, { connectionId: string; abort: AbortController }>();

  /**
   * Register a new stream. Returns an AbortSignal the tool generator can
   * poll or pass to AsyncQueue.next() to detect cancellation.
   */
  register(streamId: string, connectionId: string): AbortSignal {
    const controller = new AbortController();
    this.streams.set(streamId, { connectionId, abort: controller });
    return controller.signal;
  }

  /**
   * Cancel a specific stream. Returns false if not found (already done or unknown).
   */
  cancel(streamId: string): boolean {
    const entry = this.streams.get(streamId);
    if (!entry) return false;
    entry.abort.abort();
    this.streams.delete(streamId);
    return true;
  }

  /**
   * Cancel all streams for a connection — called on WS socket close.
   */
  cancelAll(connectionId: string): void {
    for (const [streamId, entry] of this.streams) {
      if (entry.connectionId === connectionId) {
        entry.abort.abort();
        this.streams.delete(streamId);
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/streaming/StreamRegistry.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/streaming/StreamRegistry.ts packages/core/src/streaming/StreamRegistry.test.ts
git commit -m "feat(core): add StreamRegistry for transport-internal stream lifecycle"
```

---

## Task 5: `ToolRegistry` — streaming support

**Files:**

- Modify: `packages/core/src/tools/ToolRegistry.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/tools/ToolRegistry.test.ts` (new describe block):

```ts
import type { StreamingTool } from './Tool.js';
import type { StreamChunk } from '@legion/types';

// Helper: collect all chunks from a generator
async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

describe('ToolRegistry streaming', () => {
  it('register accepts a StreamingTool', () => {
    const reg = new ToolRegistry();
    const tool: StreamingTool = {
      name: 'streamer',
      description: 'yields chunks',
      parameters: { type: 'object' },
      async *stream() {
        yield { type: 'text_delta', delta: 'hi' } satisfies StreamChunk;
      },
    };
    expect(() => reg.register(tool)).not.toThrow();
    expect(reg.has('streamer')).toBe(true);
  });

  it('stream() on a regular Tool yields stream:done with the result', async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    const chunks = await collect(reg.stream('echo', { text: 'hi' }, fakeContext()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: 'stream:done', result: { status: 'success', data: 'hi' } });
  });

  it('stream() on a StreamingTool yields tool chunks then stream:done', async () => {
    const reg = new ToolRegistry();
    const tool: StreamingTool = {
      name: 'delta',
      description: 'yields text deltas',
      parameters: { type: 'object' },
      async *stream() {
        yield { type: 'text_delta', delta: 'a' } satisfies StreamChunk;
        yield { type: 'text_delta', delta: 'b' } satisfies StreamChunk;
      },
    };
    reg.register(tool);
    const chunks = await collect(reg.stream('delta', {}, fakeContext()));
    expect(chunks).toEqual([
      { type: 'text_delta', delta: 'a' },
      { type: 'text_delta', delta: 'b' },
      { type: 'stream:done', result: { status: 'success' } },
    ]);
  });

  it('stream() yields stream:error when tool throws', async () => {
    const reg = new ToolRegistry();
    const tool: StreamingTool = {
      name: 'exploder',
      description: 'throws',
      parameters: { type: 'object' },
      async *stream() {
        throw new Error('boom');
        yield { type: 'text_delta', delta: '' } satisfies StreamChunk; // appease TS
      },
    };
    reg.register(tool);
    const chunks = await collect(reg.stream('exploder', {}, fakeContext()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: 'stream:error', error: 'boom' });
  });

  it('stream() yields stream:error for unknown tool', async () => {
    const reg = new ToolRegistry();
    const chunks = await collect(reg.stream('nope', {}, fakeContext()));
    expect(chunks[0].type).toBe('stream:error');
  });

  it('execute() on a StreamingTool drains and returns result', async () => {
    const reg = new ToolRegistry();
    const tool: StreamingTool = {
      name: 'quick',
      description: 'streaming but finite',
      parameters: { type: 'object' },
      async *stream() {
        yield { type: 'text_delta', delta: 'x' } satisfies StreamChunk;
      },
    };
    reg.register(tool);
    const result = await reg.execute('quick', {}, fakeContext());
    expect(result).toEqual({ status: 'success' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tools/ToolRegistry.test.ts`
Expected: FAIL — `reg.stream` is not a function, `reg.register(streamingTool)` throws ConflictError or type error

- [ ] **Step 3: Write the implementation**

Replace `packages/core/src/tools/ToolRegistry.ts` with:

```ts
import { randomUUID } from 'node:crypto';
import type { ToolResult, StreamChunk } from '@legion/types';
import { ConflictError, ToolNotFoundError } from '../errors/LegionError.js';
import type { AnyTool, Tool, ToolContext, ToolRegistryLike } from './Tool.js';
import { isStreamingTool } from './Tool.js';
import type { ToolResultStatus } from '@legion/types';

async function* managedStream(
  tool: AnyTool,
  args: unknown,
  context: ToolContext,
): AsyncGenerator<StreamChunk> {
  try {
    if (isStreamingTool(tool)) {
      yield* tool.stream(args, context);
    } else {
      const result = (await (tool as Tool).execute(args, context)) as ToolResult;
      yield { type: 'stream:done', result };
      return;
    }
    yield { type: 'stream:done', result: { status: 'success' } };
  } catch (err) {
    yield { type: 'stream:error', error: err instanceof Error ? err.message : String(err) };
  }
}

export class ToolRegistry implements ToolRegistryLike {
  private tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      throw new ConflictError(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  listAll(): string[] {
    return [...this.tools.keys()];
  }

  async *stream(name: string, args: unknown, context: ToolContext): AsyncGenerator<StreamChunk> {
    const tool = this.tools.get(name);
    if (!tool) {
      yield { type: 'stream:error', error: new ToolNotFoundError(name).message };
      return;
    }

    const callId = randomUUID();
    context.eventBus.emit('tool:call', {
      conversationId: context.conversationId ?? '',
      participantId: context.participant.id,
      tool: name,
      callId,
    });

    let finalStatus: ToolResultStatus = 'error';
    try {
      for await (const chunk of managedStream(tool, args, context)) {
        yield chunk;
        if (chunk.type === 'stream:done') finalStatus = chunk.result.status;
        else if (chunk.type === 'stream:error') finalStatus = 'error';
      }
    } finally {
      context.eventBus.emit('tool:result', {
        conversationId: context.conversationId ?? '',
        participantId: context.participant.id,
        tool: name,
        callId,
        status: finalStatus,
      });
    }
  }

  async execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { status: 'error', error: new ToolNotFoundError(name).message };
    }

    const callId = randomUUID();
    context.eventBus.emit('tool:call', {
      conversationId: context.conversationId ?? '',
      participantId: context.participant.id,
      tool: name,
      callId,
    });

    if (isStreamingTool(tool)) {
      try {
        for await (const chunk of managedStream(tool, args, context)) {
          if (chunk.type === 'stream:done') {
            context.eventBus.emit('tool:result', {
              conversationId: context.conversationId ?? '',
              participantId: context.participant.id,
              tool: name,
              callId,
              status: chunk.result.status,
            });
            return chunk.result;
          }
          if (chunk.type === 'stream:error') {
            context.eventBus.emit('tool:result', {
              conversationId: context.conversationId ?? '',
              participantId: context.participant.id,
              tool: name,
              callId,
              status: 'error',
            });
            return { status: 'error', error: chunk.error };
          }
          // discard intermediate chunks (LLMChunk, EventChunk, ProcessChunk)
        }
        // should not reach here — managedStream always yields a terminal chunk
        return { status: 'error', error: 'Stream ended without terminal chunk' };
      } catch (err) {
        const errorResult = {
          status: 'error' as const,
          error: err instanceof Error ? err.message : String(err),
        };
        context.eventBus.emit('tool:result', {
          conversationId: context.conversationId ?? '',
          participantId: context.participant.id,
          tool: name,
          callId,
          status: 'error',
        });
        return errorResult;
      }
    }

    // Regular tool (original path)
    try {
      const result = (await (tool as Tool).execute(args, context)) as ToolResult;
      context.eventBus.emit('tool:result', {
        conversationId: context.conversationId ?? '',
        participantId: context.participant.id,
        tool: name,
        callId,
        status: result.status,
      });
      return result;
    } catch (err) {
      const errorResult = {
        status: 'error' as const,
        error: err instanceof Error ? err.message : String(err),
      };
      context.eventBus.emit('tool:result', {
        conversationId: context.conversationId ?? '',
        participantId: context.participant.id,
        tool: name,
        callId,
        status: 'error',
      });
      return errorResult;
    }
  }
}
```

- [ ] **Step 4: Run to verify tests pass**

Run: `npx vitest run packages/core/src/tools/ToolRegistry.test.ts`
Expected: PASS (all tests including old ones)

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/ToolRegistry.ts packages/core/src/tools/ToolRegistry.test.ts
git commit -m "feat(core): add ToolRegistry.stream() and StreamingTool support"
```

---

## Task 6: `cancel_stream` tool

**Files:**

- Create: `packages/core/src/tools/cancel-stream-tool.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/cancel-stream-tool.test.ts`:

```ts
import { cancelStreamTool } from './cancel-stream-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';

function fakeContext(cancelStream?: (sid: string) => boolean): ToolContext {
  return {
    participant: { id: 'p', name: 'P', type: 'mock', tools: {}, responses: [] },
    conversationId: '',
    eventBus: new EventBus(),
    cancelStream,
  } as unknown as ToolContext;
}

describe('cancel_stream tool', () => {
  it('calls cancelStream and returns success when found', async () => {
    const cancel = vi.fn().mockReturnValue(true);
    const result = await cancelStreamTool.execute({ streamId: 'abc' }, fakeContext(cancel));
    expect(cancel).toHaveBeenCalledWith('abc');
    expect(result).toEqual({ status: 'success' });
  });

  it('returns error when stream not found', async () => {
    const cancel = vi.fn().mockReturnValue(false);
    const result = await cancelStreamTool.execute({ streamId: 'abc' }, fakeContext(cancel));
    expect(result.status).toBe('error');
  });

  it('returns error when cancelStream is not in context', async () => {
    const result = await cancelStreamTool.execute({ streamId: 'abc' }, fakeContext());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/streaming not supported/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tools/cancel-stream-tool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/tools/cancel-stream-tool.ts`:

```ts
import type { ToolResult } from '@legion/types';
import type { Tool, ToolContext } from './Tool.js';

export const cancelStreamTool: Tool = {
  name: 'cancel_stream',
  description: 'Cancel an active streaming tool call by its stream ID.',
  parameters: {
    type: 'object',
    properties: {
      streamId: {
        type: 'string',
        description: 'The streamId returned when the streaming call was started.',
      },
    },
    required: ['streamId'],
  },
  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const { streamId } = args as { streamId: string };
    if (!context.cancelStream) {
      return { status: 'error', error: 'Streaming not supported in this context' };
    }
    const cancelled = context.cancelStream(streamId);
    return cancelled
      ? { status: 'success' }
      : { status: 'error', error: 'Stream not found or already complete' };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/tools/cancel-stream-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/cancel-stream-tool.ts packages/core/src/tools/cancel-stream-tool.test.ts
git commit -m "feat(core): add cancel_stream tool"
```

---

## Task 7: `watch_conversations` tool

**Files:**

- Create: `packages/core/src/tools/watch-conversations-tool.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/watch-conversations-tool.test.ts`:

```ts
import { watchConversationsTool } from './watch-conversations-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';
import type { StreamChunk } from '@legion/types';

function fakeCtx(eventBus: EventBus, signal?: AbortSignal): ToolContext {
  return {
    participant: { id: 'p', name: 'P', type: 'user', tools: {}, status: 'active' },
    conversationId: '',
    eventBus,
    signal,
  } as unknown as ToolContext;
}

describe('watch_conversations tool', () => {
  it('yields conversation:created chunks when event fires', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchConversationsTool.stream({}, fakeCtx(bus, controller.signal));

    // Fire event then abort
    bus.emit('conversation:created', { conversationId: 'conv-1' });
    controller.abort();

    const chunks: StreamChunk[] = [];
    for await (const chunk of gen) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      type: 'conversation:created',
      data: { conversationId: 'conv-1' },
    });
  });

  it('terminates cleanly when signal is aborted immediately', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    controller.abort();
    const chunks: StreamChunk[] = [];
    for await (const chunk of watchConversationsTool.stream({}, fakeCtx(bus, controller.signal))) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tools/watch-conversations-tool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/tools/watch-conversations-tool.ts`:

```ts
import type { StreamChunk } from '@legion/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';

export const watchConversationsTool: StreamingTool = {
  name: 'watch_conversations',
  description: 'Stream real-time conversation:created events.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async *stream(_args: unknown, context: ToolContext): AsyncGenerator<StreamChunk> {
    const queue = new AsyncQueue<StreamChunk>();
    const unsub = context.eventBus.on('conversation:created', (data) => {
      queue.push({ type: 'conversation:created', data });
    });
    try {
      while (true) {
        const chunk = await queue.next(context.signal);
        if (chunk === null) break; // signal aborted
        yield chunk;
      }
    } finally {
      unsub();
    }
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/tools/watch-conversations-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/watch-conversations-tool.ts packages/core/src/tools/watch-conversations-tool.test.ts
git commit -m "feat(core): add watch_conversations streaming tool"
```

---

## Task 8: `watch_participants` tool

**Files:**

- Create: `packages/core/src/tools/watch-participants-tool.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/watch-participants-tool.test.ts`:

```ts
import { watchParticipantsTool } from './watch-participants-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';
import type { StreamChunk } from '@legion/types';

function fakeCtx(eventBus: EventBus, signal?: AbortSignal): ToolContext {
  return {
    participant: { id: 'p', name: 'P', type: 'user', tools: {}, status: 'active' },
    conversationId: '',
    eventBus,
    signal,
  } as unknown as ToolContext;
}

describe('watch_participants tool', () => {
  it('yields participant:active and participant:retired chunks', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchParticipantsTool.stream({}, fakeCtx(bus, controller.signal));

    bus.emit('participant:active', { participantId: 'u1' });
    bus.emit('participant:retired', { participantId: 'u2' });
    controller.abort();

    const chunks: StreamChunk[] = [];
    for await (const chunk of gen) chunks.push(chunk);

    expect(chunks).toContainEqual({ type: 'participant:active', data: { participantId: 'u1' } });
    expect(chunks).toContainEqual({ type: 'participant:retired', data: { participantId: 'u2' } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tools/watch-participants-tool.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/tools/watch-participants-tool.ts`:

```ts
import type { StreamChunk } from '@legion/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';

export const watchParticipantsTool: StreamingTool = {
  name: 'watch_participants',
  description: 'Stream real-time participant:active and participant:retired events.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async *stream(_args: unknown, context: ToolContext): AsyncGenerator<StreamChunk> {
    const queue = new AsyncQueue<StreamChunk>();
    const unsubs = [
      context.eventBus.on('participant:active', (data) => {
        queue.push({ type: 'participant:active', data });
      }),
      context.eventBus.on('participant:retired', (data) => {
        queue.push({ type: 'participant:retired', data });
      }),
    ];
    try {
      while (true) {
        const chunk = await queue.next(context.signal);
        if (chunk === null) break;
        yield chunk;
      }
    } finally {
      for (const unsub of unsubs) unsub();
    }
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/tools/watch-participants-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/watch-participants-tool.ts packages/core/src/tools/watch-participants-tool.test.ts
git commit -m "feat(core): add watch_participants streaming tool"
```

---

## Task 9: `watch_activity` tool

**Files:**

- Create: `packages/core/src/tools/watch-activity-tool.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/watch-activity-tool.test.ts`:

```ts
import { watchActivityTool } from './watch-activity-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';
import type { StreamChunk } from '@legion/types';

function fakeCtx(eventBus: EventBus, signal?: AbortSignal): ToolContext {
  return {
    participant: { id: 'p', name: 'P', type: 'user', tools: {}, status: 'active' },
    conversationId: '',
    eventBus,
    signal,
  } as unknown as ToolContext;
}

describe('watch_activity tool', () => {
  it('yields tool:call and tool:result chunks', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchActivityTool.stream({}, fakeCtx(bus, controller.signal));

    bus.emit('tool:call', { conversationId: 'c1', participantId: 'a1', tool: 'echo', callId: '1' });
    bus.emit('tool:result', {
      conversationId: 'c1',
      participantId: 'a1',
      tool: 'echo',
      callId: '1',
      status: 'success',
    });
    controller.abort();

    const chunks: StreamChunk[] = [];
    for await (const chunk of gen) chunks.push(chunk);

    expect(chunks.some((c) => c.type === 'tool:call')).toBe(true);
    expect(chunks.some((c) => c.type === 'tool:result')).toBe(true);
  });

  it('filters by conversationId when provided', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchActivityTool.stream({ conversationId: 'c1' }, fakeCtx(bus, controller.signal));

    bus.emit('tool:call', { conversationId: 'c2', participantId: 'a1', tool: 'echo', callId: '1' });
    bus.emit('tool:call', { conversationId: 'c1', participantId: 'a1', tool: 'echo', callId: '2' });
    controller.abort();

    const chunks: StreamChunk[] = [];
    for await (const chunk of gen) chunks.push(chunk);

    // Only c1 call passes filter
    expect(chunks).toHaveLength(1);
    const c = chunks[0] as { type: string; data: { conversationId: string } };
    expect(c.data.conversationId).toBe('c1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tools/watch-activity-tool.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/tools/watch-activity-tool.ts`:

```ts
import type { LegionEventMap, LegionEventName, StreamChunk } from '@legion/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';

type ActivityEventName =
  | 'tool:call'
  | 'tool:result'
  | 'iteration'
  | 'approval:requested'
  | 'approval:resolved'
  | 'error';

const ACTIVITY_EVENTS: ActivityEventName[] = [
  'tool:call',
  'tool:result',
  'iteration',
  'approval:requested',
  'approval:resolved',
  'error',
];

export const watchActivityTool: StreamingTool = {
  name: 'watch_activity',
  description:
    'Stream real-time tool:call, tool:result, iteration, approval:requested, approval:resolved, and error events. Optionally filter by conversationId.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Only yield events from this conversation. Omit to receive all.',
      },
    },
    required: [],
  },
  async *stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk> {
    const { conversationId: filterConvId } = (args ?? {}) as { conversationId?: string };
    const queue = new AsyncQueue<StreamChunk>();

    const unsubs = ACTIVITY_EVENTS.map((event) =>
      context.eventBus.on(event as LegionEventName, (data) => {
        if (filterConvId) {
          const payload = data as { conversationId?: string };
          if (payload.conversationId !== filterConvId) return;
        }
        queue.push({ type: event, data } as unknown as StreamChunk);
      }),
    );

    try {
      while (true) {
        const chunk = await queue.next(context.signal);
        if (chunk === null) break;
        yield chunk;
      }
    } finally {
      for (const unsub of unsubs) unsub();
    }
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/tools/watch-activity-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/watch-activity-tool.ts packages/core/src/tools/watch-activity-tool.test.ts
git commit -m "feat(core): add watch_activity streaming tool"
```

---

## Task 10: `watch_conversation` tool

**Files:**

- Create: `packages/core/src/tools/watch-conversation-tool.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/watch-conversation-tool.test.ts`:

```ts
import { watchConversationTool } from './watch-conversation-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';
import type { StreamChunk } from '@legion/types';

function fakeCtx(eventBus: EventBus, signal?: AbortSignal): ToolContext {
  return {
    participant: { id: 'p', name: 'P', type: 'user', tools: {}, status: 'active' },
    conversationId: '',
    eventBus,
    signal,
  } as unknown as ToolContext;
}

describe('watch_conversation tool', () => {
  it('yields message:sent and message:delivered for the given conversationId', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchConversationTool.stream(
      { conversationId: 'conv-1' },
      fakeCtx(bus, controller.signal),
    );

    bus.emit('message:sent', {
      conversationId: 'conv-1',
      senderId: 'u1',
      recipientId: 'a1',
      messageId: 'm1',
    });
    bus.emit('message:sent', {
      conversationId: 'conv-2',
      senderId: 'u2',
      recipientId: 'a2',
      messageId: 'm2',
    }); // filtered
    bus.emit('message:delivered', { conversationId: 'conv-1', recipientId: 'u1', messageId: 'm1' });
    controller.abort();

    const chunks: StreamChunk[] = [];
    for await (const chunk of gen) chunks.push(chunk);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('message:sent');
    expect(chunks[1].type).toBe('message:delivered');
  });

  it('throws when conversationId arg is missing', async () => {
    const bus = new EventBus();
    const gen = watchConversationTool.stream({}, fakeCtx(bus));
    await expect(async () => {
      for await (const _chunk of gen) {
        /* empty */
      }
    }).rejects.toThrow(/conversationId/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tools/watch-conversation-tool.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/tools/watch-conversation-tool.ts`:

```ts
import type { StreamChunk } from '@legion/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';

export const watchConversationTool: StreamingTool = {
  name: 'watch_conversation',
  description: 'Stream message:sent and message:delivered events for a specific conversation.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation to watch.',
      },
    },
    required: ['conversationId'],
  },
  async *stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk> {
    const { conversationId } = args as { conversationId?: string };
    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    const queue = new AsyncQueue<StreamChunk>();
    const unsubs = [
      context.eventBus.on('message:sent', (data) => {
        if (data.conversationId === conversationId) {
          queue.push({ type: 'message:sent', data });
        }
      }),
      context.eventBus.on('message:delivered', (data) => {
        if (data.conversationId === conversationId) {
          queue.push({ type: 'message:delivered', data });
        }
      }),
    ];

    try {
      while (true) {
        const chunk = await queue.next(context.signal);
        if (chunk === null) break;
        yield chunk;
      }
    } finally {
      for (const unsub of unsubs) unsub();
    }
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/tools/watch-conversation-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/watch-conversation-tool.ts packages/core/src/tools/watch-conversation-tool.test.ts
git commit -m "feat(core): add watch_conversation streaming tool"
```

---

## Task 11: `watch_process` tool

**Files:**

- Create: `packages/core/src/tools/watch-process-tool.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/watch-process-tool.test.ts`:

```ts
import { watchProcessTool } from './watch-process-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';
import type { ProcessChunk, StreamChunk } from '@legion/types';

function makeMockProcessManager(processId: string, ownerId: string) {
  const listeners: Record<string, Array<(evt: unknown) => void>> = {
    output: [],
    exited: [],
    error: [],
  };
  return {
    get: (id: string) =>
      id === processId ? { id, status: 'running', startedByParticipantId: ownerId } : undefined,
    subscribe: (id: string, event: string, cb: (evt: unknown) => void) => {
      listeners[event]?.push(cb);
      return () => {
        const arr = listeners[event];
        if (arr) {
          const idx = arr.indexOf(cb);
          if (idx >= 0) arr.splice(idx, 1);
        }
      };
    },
    emit: (event: string, data: unknown) => {
      listeners[event]?.forEach((cb) => cb(data));
    },
  };
}

function fakeCtx(
  pm: ReturnType<typeof makeMockProcessManager>,
  participantId: string,
  signal?: AbortSignal,
): ToolContext {
  return {
    participant: { id: participantId, name: 'P', type: 'user', tools: {}, status: 'active' },
    conversationId: '',
    eventBus: new EventBus(),
    processManager: pm,
    signal,
  } as unknown as ToolContext;
}

describe('watch_process tool', () => {
  it('yields process:output chunks from processManager', async () => {
    const pm = makeMockProcessManager('proc-1', 'owner-1');
    const controller = new AbortController();
    const gen = watchProcessTool.stream(
      { processId: 'proc-1' },
      fakeCtx(pm, 'owner-1', controller.signal),
    );

    pm.emit('output', { stream: 'stdout', data: Buffer.from('hello') });
    controller.abort();

    const chunks: StreamChunk[] = [];
    for await (const chunk of gen) chunks.push(chunk);

    expect(chunks[0]).toMatchObject({
      type: 'process:output',
      processId: 'proc-1',
      stream: 'stdout',
    });
  });

  it('terminates after process:exited', async () => {
    const pm = makeMockProcessManager('proc-1', 'owner-1');
    const gen = watchProcessTool.stream({ processId: 'proc-1' }, fakeCtx(pm, 'owner-1'));

    pm.emit('exited', { exitCode: 0, signal: null });

    const chunks: StreamChunk[] = [];
    for await (const chunk of gen) chunks.push(chunk);

    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'process:exited', exitCode: 0 });
  });

  it('throws when process not found', async () => {
    const pm = makeMockProcessManager('proc-1', 'owner-1');
    const gen = watchProcessTool.stream({ processId: 'nope' }, fakeCtx(pm, 'owner-1'));
    await expect(async () => {
      for await (const _c of gen) {
        /* noop */
      }
    }).rejects.toThrow(/not found/i);
  });

  it('throws when participant is not the owner and not operator', async () => {
    const pm = makeMockProcessManager('proc-1', 'owner-1');
    const gen = watchProcessTool.stream({ processId: 'proc-1' }, fakeCtx(pm, 'other-user'));
    await expect(async () => {
      for await (const _c of gen) {
        /* noop */
      }
    }).rejects.toThrow(/not authorized/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tools/watch-process-tool.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/tools/watch-process-tool.ts`:

```ts
import type { ProcessChunk, StreamChunk } from '@legion/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';
import type { ProcessManager } from '../process/ProcessManager.js';

export const watchProcessTool: StreamingTool = {
  name: 'watch_process',
  description:
    'Stream stdout/stderr output and exit events for a running process. The caller must own the process or be an operator.',
  parameters: {
    type: 'object',
    properties: {
      processId: { type: 'string', description: 'ID of the process to watch.' },
    },
    required: ['processId'],
  },
  async *stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk> {
    const { processId } = args as { processId: string };
    const pm = context.processManager as ProcessManager;

    const handle = pm.get(processId);
    if (!handle) {
      throw new Error(`Process not found: ${processId}`);
    }

    const isOperator = (context.participant as { operator?: boolean }).operator === true;
    if (handle.startedByParticipantId !== context.participant.id && !isOperator) {
      throw new Error(`Not authorized to watch process ${processId}`);
    }

    const queue = new AsyncQueue<ProcessChunk>();

    const offOutput = pm.subscribe(processId, 'output', (evt: unknown) => {
      const e = evt as { stream: 'stdout' | 'stderr'; data: Buffer };
      queue.push({
        type: 'process:output',
        processId,
        stream: e.stream,
        data: e.data.toString('base64'),
      });
    });

    const offExited = pm.subscribe(processId, 'exited', (evt: unknown) => {
      const e = evt as { exitCode: number | null };
      queue.push({ type: 'process:exited', processId, exitCode: e.exitCode ?? null });
    });

    const offError = pm.subscribe(processId, 'error', (evt: unknown) => {
      const e = evt as { error: unknown };
      queue.push({ type: 'process:error', processId, error: String(e.error) });
    });

    try {
      while (true) {
        const chunk = await queue.next(context.signal);
        if (chunk === null) break; // signal aborted
        yield chunk;
        if (chunk.type === 'process:exited' || chunk.type === 'process:error') break;
      }
    } finally {
      offOutput();
      offExited();
      offError();
    }
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/tools/watch-process-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/watch-process-tool.ts packages/core/src/tools/watch-process-tool.test.ts
git commit -m "feat(core): add watch_process streaming tool"
```

---

## Task 12: Core exports + mock `ToolRegistryLike` update

**Files:**

- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/service/ServiceContextImpl.test.ts`

- [ ] **Step 1: Update `packages/core/src/index.ts`**

Add the following exports after the existing tool exports:

```ts
export * from './streaming/AsyncQueue.js';
export * from './streaming/StreamRegistry.js';
export * from './tools/cancel-stream-tool.js';
export * from './tools/watch-conversations-tool.js';
export * from './tools/watch-participants-tool.js';
export * from './tools/watch-activity-tool.js';
export * from './tools/watch-conversation-tool.js';
export * from './tools/watch-process-tool.js';
export { isStreamingTool } from './tools/Tool.js';
export type { StreamingTool, AnyTool } from './tools/Tool.js';
```

- [ ] **Step 2: Update the mock in `ServiceContextImpl.test.ts`**

The mock at line 19 implements `ToolRegistryLike` but is missing `listAll` and will now also be missing `stream`. Update the mock:

```ts
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
```

- [ ] **Step 3: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/service/ServiceContextImpl.test.ts
git commit -m "feat(core): export streaming tools and utilities"
```

---

## Task 13: `ConnectorContext.streamTool()` interface

**Files:**

- Modify: `packages/core/src/connectors/Connector.ts`

- [ ] **Step 1: Update the interface**

Replace the `ConnectorContext` interface in `packages/core/src/connectors/Connector.ts`:

```ts
import type { ToolResult, StreamChunk } from '@legion/types';
import type { MessageRouterResult } from '../tools/Tool.js';
import type { ConnectorRegistry } from './ConnectorRegistry.js';

export interface ConnectorSubmitOptions {
  senderId: string;
  recipientId: string;
  content: string;
  conversationId?: string;
  replyTo?: string;
}

export interface ConnectorContext {
  /** Route an inbound message from an external entity into the collective. */
  submit(msg: ConnectorSubmitOptions): Promise<MessageRouterResult>;

  /**
   * Execute a named tool as the given participant (buffered — returns when complete).
   * Authorization is checked before execution.
   */
  callTool(
    participantId: string,
    toolName: string,
    args: unknown,
    opts?: { conversationId?: string },
  ): Promise<{ result: ToolResult; conversationId: string }>;

  /**
   * Execute a named streaming tool as the given participant.
   * Authorization is checked before the generator is returned.
   * The generator must be iterated to drive execution.
   */
  streamTool(
    participantId: string,
    toolName: string,
    args: unknown,
    opts?: {
      conversationId?: string;
      signal?: AbortSignal;
      cancelStream?: (streamId: string) => boolean;
    },
  ): Promise<{ gen: AsyncGenerator<StreamChunk>; conversationId: string }>;

  /** The active-participant registry. */
  registry: ConnectorRegistry;
}

export interface Connector {
  readonly name: string;
  start(ctx: ConnectorContext): Promise<void>;
  deliver(message: {
    id: string;
    conversationId: string;
    senderId: string;
    recipientId: string;
    replyTo?: string;
    content: string;
    timestamp: string;
  }): Promise<void>;
  stop(): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: errors in `LegionProcess.ts` and `WebConnector.test.ts` (mock doesn't have `streamTool`) — these are fixed in Task 16 and the test update below.

- [ ] **Step 3: Update `WebConnector.test.ts` mock to add `streamTool`**

In `makeConnectorContext()` at `packages/runtime/src/server/WebConnector.test.ts`, add `streamTool`:

```ts
function makeConnectorContext(
  toolResult: ToolResult = { status: 'success', data: 'ok' },
): ConnectorContext {
  return {
    submit: vi.fn().mockResolvedValue({ status: 'success', conversationId: 'conv-1' }),
    callTool: vi.fn().mockResolvedValue({ result: toolResult, conversationId: 'conv-test' }),
    streamTool: vi.fn().mockResolvedValue({
      gen: (async function* () {
        yield { type: 'stream:done', result: toolResult };
      })(),
      conversationId: 'conv-test',
    }),
    registry: {
      setActive: vi.fn(),
      clearActive: vi.fn(),
      register: vi.fn(),
      deregister: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      getActiveConnectors: vi.fn().mockReturnValue([]),
    } as any,
  };
}
```

- [ ] **Step 4: Typecheck again**

Run: `npm run typecheck`
Expected: only error remains in `LegionProcess.ts` (fixed in Task 16)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/connectors/Connector.ts packages/runtime/src/server/WebConnector.test.ts
git commit -m "feat(core): add streamTool() to ConnectorContext interface"
```

---

## Task 14: `WebConnector` — connectionId + StreamRegistry + remove EventBus bridge

**Files:**

- Modify: `packages/runtime/src/server/WebConnector.ts`

This is the largest single-file change. Read `WebConnector.ts` carefully before editing.

- [ ] **Step 1: Add imports and new fields**

At the top of `WebConnector.ts`, add imports:

```ts
import { randomUUID } from 'node:crypto';
import { StreamRegistry } from '@legion/core';
```

In the `WebConnector` class body, add private fields after `private connections`:

```ts
/** connectionId (UUID per socket) → WebSocket */
private connectionSockets = new Map<string, WebSocket>();
/** connectionId → participantId (for security validation) */
private connectionParticipants = new Map<string, string>();
/** Transport-internal stream registry */
private readonly streamRegistry = new StreamRegistry();
```

- [ ] **Step 2: Update `stop()` to clean up new maps**

In `stop()`, add before clearing connections:

```ts
this.connectionSockets.clear();
this.connectionParticipants.clear();
```

- [ ] **Step 3: Add `sendToStream()` method**

Add to the class:

```ts
/**
 * Send a stream chunk frame to a specific connection.
 * Returns false if the socket is gone or the connectionId doesn't belong
 * to the claimed participant.
 */
sendToStream(connectionId: string, participantId: string, data: object): boolean {
  if (this.connectionParticipants.get(connectionId) !== participantId) return false;
  const socket = this.connectionSockets.get(connectionId);
  if (!socket || (socket as any).readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Pass `streamRegistry` and `sendToStream` to execute route**

In `start()`, update the `registerExecuteRoute` call:

```ts
await registerExecuteRoute(app, {
  collective: this.deps.collective,
  ctx,
  jwtSecret: this.jwtSecret,
  streamRegistry: this.streamRegistry,
  sendToStream: this.sendToStream.bind(this),
});
```

- [ ] **Step 5: Update `handleWebSocket` — add connectionId, remove bridge, remove subscribe_process**

Replace the `handleWebSocket` method body entirely. The new method:

1. Issues `connectionId = randomUUID()` on auth success
2. Sends `connectionId` in the `connected` frame
3. Tracks `connectionSockets` and `connectionParticipants`
4. Routes `stream:chunk` frames to socket from background tasks (handled by `sendToStream`)
5. Removes the `onAny` EventBus bridge
6. Removes the `subscribe_process` / `unsubscribe_process` handlers
7. Calls `streamRegistry.cancelAll(connectionId)` on close

```ts
private handleWebSocket(socket: WebSocket, ctx: ConnectorContext): void {
  let participantId: string | null = null;
  let connectionId: string | null = null;

  const authTimer = setTimeout(() => {
    if (!participantId) socket.close(4401, 'Authentication timeout');
  }, WS_AUTH_TIMEOUT_MS);

  socket.on('message', (raw) => {
    let msg: { type?: string; token?: string };
    try {
      msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'auth' && !participantId) {
      const token = msg.token;
      if (!token) {
        socket.close(4401, 'No token provided');
        return;
      }
      verifyToken(token, this.jwtSecret)
        .then(({ participantId: pid }) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          clearTimeout(authTimer);
          participantId = pid;
          connectionId = randomUUID();

          // Track connection
          ctx.registry.setActive(pid, this.name);
          const set = this.connections.get(pid) ?? new Set<WebSocket>();
          set.add(socket);
          this.connections.set(pid, set);
          this.connectionSockets.set(connectionId, socket);
          this.connectionParticipants.set(connectionId, pid);

          socket.send(JSON.stringify({ type: 'connected', participantId: pid, connectionId }));
        })
        .catch(() => {
          socket.close(4401, 'Invalid token');
        });
    }
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    if (participantId) {
      ctx.registry.clearActive(participantId, this.name);
      this.connections.get(participantId)?.delete(socket);
      if (this.connections.get(participantId)?.size === 0) {
        this.connections.delete(participantId);
      }
    }
    if (connectionId) {
      this.connectionSockets.delete(connectionId);
      this.connectionParticipants.delete(connectionId);
      this.streamRegistry.cancelAll(connectionId);
    }
  });

  socket.on('error', () => {
    // Errors handled by the 'close' event.
  });
}
```

- [ ] **Step 6: Remove the `isRelevantToParticipant` import**

Delete the import line at the top of `WebConnector.ts`:

```ts
import { isRelevantToParticipant } from './event-filter.js';
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: errors only in `execute.ts` (missing new deps) — fixed in Task 15

- [ ] **Step 8: Run WebConnector tests**

Run: `npx vitest run packages/runtime/src/server/WebConnector.test.ts`
Expected: most tests pass; tests that verified event frame delivery may fail — those are deleted in Task 16

- [ ] **Step 9: Commit**

```bash
git add packages/runtime/src/server/WebConnector.ts
git commit -m "feat(runtime): add connectionId per socket, StreamRegistry, remove EventBus bridge"
```

---

## Task 15: Execute route — 3 transport modes

**Files:**

- Modify: `packages/runtime/src/server/routes/execute.ts`

- [ ] **Step 1: Write the updated execute route**

Replace `packages/runtime/src/server/routes/execute.ts` entirely:

```ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { verifyToken, extractBearerToken } from '../auth.js';
import type { JwtSecret } from '../auth.js';
import type { ConnectorContext, Collective, StreamChunk } from '@legion/core';
import { StreamRegistry } from '@legion/core';

export interface ExecuteRouteDeps {
  collective: Collective;
  ctx: ConnectorContext;
  jwtSecret: JwtSecret;
  streamRegistry: StreamRegistry;
  sendToStream: (connectionId: string, participantId: string, data: object) => boolean;
}

export async function registerExecuteRoute(
  app: FastifyInstance,
  deps: ExecuteRouteDeps,
): Promise<void> {
  const { collective, ctx, jwtSecret, streamRegistry, sendToStream } = deps;

  app.post<{
    Body: { tool?: string; args?: unknown; conversationId?: string };
    Querystring: { stream?: string };
  }>('/api/execute', async (req, reply) => {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return reply.status(401).send({ error: 'Unauthenticated' });

    let participantId: string;
    try {
      ({ participantId } = await verifyToken(token, jwtSecret));
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    if (!collective.get(participantId)) {
      return reply.status(401).send({ error: 'Participant not found' });
    }

    const { tool: toolName, args = {}, conversationId } = req.body ?? {};
    if (!toolName) return reply.status(400).send({ error: 'tool is required' });

    // ── Buffered mode (?stream=false) ────────────────────────────────────────
    if (req.query.stream === 'false') {
      const { result, conversationId: convId } = await ctx.callTool(participantId, toolName, args, {
        conversationId: conversationId ?? '',
      });
      return reply.send({ result, conversationId: convId });
    }

    // ── WS streaming mode (X-Stream-Connection header) ────────────────────────
    const connectionId = req.headers['x-stream-connection'] as string | undefined;
    if (connectionId) {
      const streamId = randomUUID();
      const signal = streamRegistry.register(streamId, connectionId);
      const cancelStream = (sid: string) => streamRegistry.cancel(sid);

      let gen: AsyncGenerator<StreamChunk>;
      let convId: string;
      try {
        ({ gen, conversationId: convId } = await ctx.streamTool(participantId, toolName, args, {
          conversationId: conversationId ?? '',
          signal,
          cancelStream,
        }));
      } catch (err) {
        streamRegistry.cancel(streamId);
        return reply.status(500).send({ error: String(err) });
      }

      // Return streamId immediately; background task routes chunks to WS socket.
      await reply.send({ streamId, conversationId: convId });

      // Background iteration — fire-and-forget, errors silently cleaned up.
      void (async () => {
        let seq = 0;
        try {
          for await (const chunk of gen) {
            const sent = sendToStream(connectionId, participantId, {
              type: 'stream:chunk',
              streamId,
              seq: seq++,
              data: chunk,
            });
            if (!sent) {
              // Socket gone — abort the generator.
              streamRegistry.cancel(streamId);
              break;
            }
            if (chunk.type === 'stream:done' || chunk.type === 'stream:error') break;
          }
        } catch (err) {
          sendToStream(connectionId, participantId, {
            type: 'stream:chunk',
            streamId,
            seq: seq++,
            data: { type: 'stream:error', error: String(err) },
          });
        } finally {
          streamRegistry.cancel(streamId); // no-op if already done
        }
      })();

      return;
    }

    // ── SSE mode (no special header, not stream=false) ────────────────────────
    let gen: AsyncGenerator<StreamChunk>;
    let convId: string;
    try {
      ({ gen, conversationId: convId } = await ctx.streamTool(participantId, toolName, args, {
        conversationId: conversationId ?? '',
      }));
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.writeHead(200);

    // First event carries conversationId
    let seq = 0;
    const write = (data: object) => {
      reply.raw.write(`data: ${JSON.stringify({ seq: seq++, data })}\n\n`);
    };

    write({ type: 'stream:start', conversationId: convId });

    try {
      for await (const chunk of gen) {
        write(chunk);
        if (chunk.type === 'stream:done' || chunk.type === 'stream:error') break;
      }
    } catch (err) {
      write({ type: 'stream:error', error: String(err) });
    }

    reply.raw.end();
    reply.hijack();
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: errors should now resolve (streamTool + streamRegistry available in deps)

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/server/routes/execute.ts
git commit -m "feat(runtime): add WS streaming and SSE modes to execute route"
```

---

## Task 16: LegionProcess — implement `streamTool()`, register tools, delete event-filter

**Files:**

- Modify: `packages/runtime/src/LegionProcess.ts`
- Delete: `packages/runtime/src/server/event-filter.ts`
- Delete: `packages/runtime/src/server/event-filter.test.ts`

- [ ] **Step 1: Delete event-filter files**

```bash
rm packages/runtime/src/server/event-filter.ts
rm packages/runtime/src/server/event-filter.test.ts
```

- [ ] **Step 2: Add subscription tool imports to `LegionProcess.ts`**

In the import block at the top, add alongside `communicateTool`:

```ts
cancelStreamTool,
watchConversationsTool,
watchParticipantsTool,
watchActivityTool,
watchConversationTool,
watchProcessTool,
```

- [ ] **Step 3: Register new tools in step 6 of `LegionProcess.ts`**

After registering `processTools`, add:

```ts
// Streaming / subscription tools
toolRegistry.register(cancelStreamTool);
toolRegistry.register(watchConversationsTool);
toolRegistry.register(watchParticipantsTool);
toolRegistry.register(watchActivityTool);
toolRegistry.register(watchConversationTool);
toolRegistry.register(watchProcessTool);
```

- [ ] **Step 4: Add subscription tool names to operator policies**

The `RUNTIME_TOOL_NAMES` const governs which tools the bootstrap operator gets auto-added. Add subscription tools there (or create a new const):

Add after `RUNTIME_TOOL_NAMES`:

```ts
const SUBSCRIPTION_TOOL_NAMES = [
  'cancel_stream',
  'watch_conversations',
  'watch_participants',
  'watch_activity',
  'watch_conversation',
  'watch_process',
] as const;
```

In `ensureBootstrapRuntimeToolPolicies()`, add after the loop for `RUNTIME_TOOL_NAMES`:

```ts
for (const name of SUBSCRIPTION_TOOL_NAMES) {
  if (!(name in tools)) {
    tools[name] = 'auto';
    changed = true;
  }
}
```

- [ ] **Step 5: Implement `streamTool()` in `buildConnectorContext()`**

In `buildConnectorContext()`, add `streamTool` to the returned object (after `callTool`):

```ts
async streamTool(participantId, toolName, args, opts) {
  const participant = collective.get(participantId);
  if (!participant) {
    const gen = (async function* () {
      yield { type: 'stream:error', error: `Participant not found: ${participantId}` } as const;
    })();
    return { gen, conversationId: '' };
  }

  const authResult = authEngine.authorize(participantId, toolName, args, participant.tools);
  if (!authResult.authorized) {
    const gen = (async function* () {
      yield {
        type: 'stream:error',
        error: authResult.reason ?? 'Not authorized',
      } as const;
    })();
    return { gen, conversationId: '' };
  }

  // Conversation thread setup (mirrors callTool logic)
  let thread: ConversationThread;
  let conversationId: string;
  const reqConvId = opts?.conversationId;
  if (reqConvId && reqConvId !== '') {
    const existing = await store.load(reqConvId);
    if (!existing) {
      const gen = (async function* () {
        yield {
          type: 'stream:error',
          error: `Conversation not found: ${reqConvId}`,
        } as const;
      })();
      return { gen, conversationId: reqConvId };
    }
    conversationId = reqConvId;
    thread = new ConversationThread(existing, store);
  } else if (reqConvId === '') {
    const now = new Date().toISOString();
    const data: ConversationData = {
      id: '',
      schemaVersion: '2.0',
      createdAt: now,
      updatedAt: now,
      activeBranchHead: '',
      messages: {},
    };
    conversationId = '';
    thread = new ConversationThread(data, store);
  } else {
    const data = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    conversationId = data.id;
    thread = new ConversationThread(data, store);
  }

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
    processManager,
    signal: opts?.signal,
    cancelStream: opts?.cancelStream,
  };

  const gen = toolRegistry.stream(toolName, args, toolCtx);
  return { gen, conversationId };
},
```

Note: `ConversationData` is already imported (`type ConversationData` from `@legion/types`). `ConversationThread` is already imported.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts
git rm packages/runtime/src/server/event-filter.ts packages/runtime/src/server/event-filter.test.ts
git commit -m "feat(runtime): implement streamTool, register subscription tools, delete event-filter"
```

---

## Task 17: Frontend `useWebSocket` — connectionId + stream:chunk routing

**Files:**

- Modify: `packages/web/src/composables/useWebSocket.ts`

- [ ] **Step 1: Write the updated composable**

Replace `packages/web/src/composables/useWebSocket.ts`:

```ts
import { useAuth } from './useAuth.js';
import { router } from '../router/index.js';
import type { StreamChunk } from '@legion/types';

type MessageHandler = (data: unknown) => void;
type StreamChunkHandler = (chunk: StreamChunk) => void;

// Module-level singleton state — one WebSocket for the entire app
const handlers = new Set<MessageHandler>();
const streamHandlers = new Map<string, StreamChunkHandler>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;
let stoppedByAuth = false;
let connectionId: string | null = null;

function connect(): void {
  const { getToken } = useAuth();
  const token = getToken();
  if (!token) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    backoff = 1000;
    ws!.send(JSON.stringify({ type: 'auth', token }));
  });

  ws.addEventListener('message', (evt) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(evt.data as string);
    } catch {
      return;
    }

    const msg = parsed as Record<string, unknown>;

    // Handle stream:chunk frames (O(1) routing to registered handler)
    if (msg['type'] === 'stream:chunk') {
      const sid = msg['streamId'] as string;
      const chunk = msg['data'] as StreamChunk;
      streamHandlers.get(sid)?.(chunk);
      return;
    }

    // Handle connected frame — store connectionId
    if (msg['type'] === 'connected') {
      connectionId = (msg['connectionId'] as string) ?? null;
    }

    // Dispatch to all general message handlers
    for (const handler of [...handlers]) {
      try {
        handler(parsed);
      } catch {
        /* isolate */
      }
    }
  });

  ws.addEventListener('close', (evt) => {
    connectionId = null;
    streamHandlers.clear();
    if (evt.code === 4401) {
      stoppedByAuth = true;
      const { logout } = useAuth();
      logout();
      router.push('/login');
      return;
    }
    scheduleReconnect();
  });

  ws.addEventListener('error', () => ws?.close());
}

function scheduleReconnect(): void {
  if (stoppedByAuth) return;
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (stoppedByAuth) return;
    backoff = Math.min(backoff * 2, 30_000);
    connect();
  }, backoff);
}

export function useWebSocket() {
  return {
    connect() {
      stoppedByAuth = false;
      if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    },
    disconnect() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stoppedByAuth = false;
      ws?.close();
      ws = null;
    },
    onMessage(handler: MessageHandler): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    send(data: unknown): void {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    },
    /** Register a handler for chunks of a specific stream. Returns unsubscribe fn. */
    onStreamChunk(streamId: string, handler: StreamChunkHandler): () => void {
      streamHandlers.set(streamId, handler);
      return () => streamHandlers.delete(streamId);
    },
    /** Returns the connectionId issued by the server on auth, or null if not connected. */
    getConnectionId(): string | null {
      return connectionId;
    },
  };
}
```

- [ ] **Step 2: Run web tests**

Run: `npm run test --workspace=packages/web`
Expected: PASS (existing tests that use `useWebSocket` mock it; they should still pass)

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/composables/useWebSocket.ts
git commit -m "feat(web): add connectionId + onStreamChunk to useWebSocket"
```

---

## Task 18: `useToolStream` composable

**Files:**

- Create: `packages/web/src/composables/useToolStream.ts`

- [ ] **Step 1: Write the composable**

Create `packages/web/src/composables/useToolStream.ts`:

````ts
import { ref, onUnmounted, type Ref } from 'vue';
import { useWebSocket } from './useWebSocket.js';
import { useAuth } from './useAuth.js';
import type { StreamChunk } from '@legion/types';

export interface UseToolStreamOptions<TChunk extends StreamChunk> {
  onChunk?: (chunk: TChunk) => void;
}

export interface UseToolStreamReturn<TChunk extends StreamChunk> {
  start(): Promise<void>;
  cancel(): Promise<void>;
  chunks: Ref<TChunk[]>;
  done: Ref<boolean>;
  error: Ref<string | null>;
  conversationId: Ref<string | null>;
}

/**
 * Vue composable for streaming a tool call over WebSocket.
 *
 * Usage:
 * ```ts
 * const stream = useToolStream('watch_conversations', {});
 * watch(ws.getConnectionId, async (id) => {
 *   if (id) await stream.start();
 * });
 * ```
 */
export function useToolStream<TChunk extends StreamChunk = StreamChunk>(
  toolName: string,
  getArgs: () => unknown = () => ({}),
  options: UseToolStreamOptions<TChunk> = {},
): UseToolStreamReturn<TChunk> {
  const ws = useWebSocket();
  const { getToken } = useAuth();

  const chunks = ref<TChunk[]>([]) as Ref<TChunk[]>;
  const done = ref(false);
  const error = ref<string | null>(null);
  const conversationId = ref<string | null>(null);

  let activeStreamId: string | null = null;
  let unregister: (() => void) | null = null;

  async function start(): Promise<void> {
    // Cancel any in-flight stream before starting a new one
    if (activeStreamId) await cancel();

    const cid = ws.getConnectionId();
    if (!cid) {
      error.value = 'Not connected — connectionId unavailable';
      return;
    }

    const token = getToken();
    if (!token) {
      error.value = 'Not authenticated';
      return;
    }

    done.value = false;
    error.value = null;
    chunks.value = [];

    let res: Response;
    try {
      res = await fetch('/api/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Stream-Connection': cid,
        },
        body: JSON.stringify({ tool: toolName, args: getArgs() }),
      });
    } catch (err) {
      error.value = `Network error: ${String(err)}`;
      return;
    }

    if (!res.ok) {
      error.value = `Execute failed: ${res.status}`;
      return;
    }

    const body = (await res.json()) as { streamId: string; conversationId: string };
    activeStreamId = body.streamId;
    conversationId.value = body.conversationId ?? null;

    unregister = ws.onStreamChunk(activeStreamId, (chunk: StreamChunk) => {
      if (chunk.type === 'stream:done') {
        done.value = true;
        cleanup();
        return;
      }
      if (chunk.type === 'stream:error') {
        error.value = (chunk as { type: string; error: string }).error;
        cleanup();
        return;
      }
      const typed = chunk as TChunk;
      chunks.value.push(typed);
      options.onChunk?.(typed);
    });
  }

  function cleanup(): void {
    unregister?.();
    unregister = null;
    activeStreamId = null;
  }

  async function cancel(): Promise<void> {
    const sid = activeStreamId;
    cleanup();
    if (!sid) return;

    const token = getToken();
    if (!token) return;

    // Use buffered mode (?stream=false) so this doesn't itself create a stream.
    try {
      await fetch('/api/execute?stream=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tool: 'cancel_stream', args: { streamId: sid } }),
      });
    } catch {
      // best-effort
    }
  }

  onUnmounted(() => {
    void cancel();
  });

  return { start, cancel, chunks, done, error, conversationId };
}
````

- [ ] **Step 2: Run web tests**

Run: `npm run test --workspace=packages/web`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/composables/useToolStream.ts
git commit -m "feat(web): add useToolStream composable for WS-backed streaming tool calls"
```

---

## Task 19: Replace `useEventStream` in `ParticipantsView.vue`

**Files:**

- Modify: `packages/web/src/views/ParticipantsView.vue`

The view currently calls:

```ts
on('participant:active', () => load());
on('participant:retired', () => load());
```

Replace with `useToolStream` + `watch_participants`.

- [ ] **Step 1: Update the `<script setup>` block**

Replace the import and usage:

```ts
// Remove:
import { useEventStream } from '../composables/useEventStream.js';
// Add:
import { useToolStream } from '../composables/useToolStream.js';
import { useWebSocket } from '../composables/useWebSocket.js';
import { watch, computed } from 'vue';
```

Replace the `useEventStream` block:

```ts
// Remove:
const { on } = useEventStream();
on('participant:active', () => load());
on('participant:retired', () => load());

// Add:
const ws = useWebSocket();
const participantStream = useToolStream('watch_participants', () => ({}), {
  onChunk: () => void load(),
});
watch(
  () => ws.getConnectionId(),
  async (id) => {
    if (id) await participantStream.start();
  },
);
```

- [ ] **Step 2: Run web tests**

Run: `npm run test --workspace=packages/web`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/views/ParticipantsView.vue
git commit -m "feat(web): replace useEventStream with useToolStream in ParticipantsView"
```

---

## Task 20: Replace `useEventStream` in `ConversationsView.vue`

**Files:**

- Modify: `packages/web/src/views/ConversationsView.vue`

The view currently calls:

```ts
on('conversation:created', () => void loadConversations());
on('approval:requested', (payload) => { pendingApprovalIds.value = new Set([...pendingApprovalIds.value, payload.conversationId]); });
on('approval:resolved', (payload) => { ... });
```

Replace with `watch_conversations` and `watch_activity`.

- [ ] **Step 1: Update `<script setup>` imports**

```ts
// Remove:
import { useEventStream } from '../composables/useEventStream.js';
// Add:
import { useToolStream } from '../composables/useToolStream.js';
import { useWebSocket } from '../composables/useWebSocket.js';
```

- [ ] **Step 2: Replace the event subscriptions**

```ts
// Remove:
const { on } = useEventStream();
on('conversation:created', () => void loadConversations());
on('approval:requested', (payload) => {
  pendingApprovalIds.value = new Set([
    ...pendingApprovalIds.value,
    (payload as any).conversationId,
  ]);
});
on('approval:resolved', (payload) => {
  const next = new Set(pendingApprovalIds.value);
  next.delete((payload as any).conversationId);
  pendingApprovalIds.value = next;
});

// Add:
const ws = useWebSocket();

const convStream = useToolStream('watch_conversations', () => ({}), {
  onChunk: () => void loadConversations(),
});

const activityStream = useToolStream('watch_activity', () => ({}), {
  onChunk: (chunk) => {
    if (chunk.type === 'approval:requested') {
      const p = (chunk as any).data as { conversationId: string };
      pendingApprovalIds.value = new Set([...pendingApprovalIds.value, p.conversationId]);
    } else if (chunk.type === 'approval:resolved') {
      const p = (chunk as any).data as { conversationId: string };
      const next = new Set(pendingApprovalIds.value);
      next.delete(p.conversationId);
      pendingApprovalIds.value = next;
    }
  },
});

watch(
  () => ws.getConnectionId(),
  async (id) => {
    if (!id) return;
    await Promise.all([convStream.start(), activityStream.start()]);
  },
);
```

- [ ] **Step 3: Run web tests**

Run: `npm run test --workspace=packages/web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/views/ConversationsView.vue
git commit -m "feat(web): replace useEventStream with useToolStream in ConversationsView"
```

---

## Task 21: Replace `useEventStream` in `useConversation.ts` + delete `useEventStream.ts`

**Files:**

- Modify: `packages/web/src/composables/useConversation.ts`
- Modify: `packages/web/src/composables/useConversation.test.ts`
- Delete: `packages/web/src/composables/useEventStream.ts`
- Delete: `packages/web/src/composables/useEventStream.test.ts`

`useConversation` subscribes to six event types, all filtered by `conversationId`:

- `message:sent` → reload
- `message:delivered` → clear thinking, reload
- `iteration` → set `iterationFired`
- `approval:requested` → clear thinking, reload
- `approval:resolved` → set `iterationFired`, reload
- `tool:result` → reload

Replace with:

- `watch_conversation` (message:sent, message:delivered)
- `watch_activity` with `conversationId` filter (iteration, approval:requested, approval:resolved, tool:result)

- [ ] **Step 1: Update `useConversation.ts` imports**

```ts
// Remove:
import { useEventStream } from './useEventStream.js';
// Add:
import { useToolStream } from './useToolStream.js';
import { useWebSocket } from './useWebSocket.js';
import { watch as vueWatch } from 'vue';
```

- [ ] **Step 2: Replace the event subscriptions block in `useConversation`**

Find the block that starts with:

```ts
if (conversationId) {
  on(
    'message:sent',
    ...
```

Replace entirely with:

```ts
if (conversationId) {
  const ws = useWebSocket();

  const msgStream = useToolStream('watch_conversation', () => ({ conversationId }), {
    onChunk: (chunk) => {
      if (chunk.type === 'message:sent') {
        void load();
      } else if (chunk.type === 'message:delivered') {
        isThinkingLocal.value = false;
        iterationFired.value = false;
        void load();
      }
    },
  });

  const activityStream = useToolStream('watch_activity', () => ({ conversationId }), {
    onChunk: (chunk) => {
      if (chunk.type === 'iteration') {
        iterationFired.value = true;
      } else if (chunk.type === 'approval:requested') {
        isThinkingLocal.value = false;
        iterationFired.value = false;
        void load();
      } else if (chunk.type === 'approval:resolved') {
        iterationFired.value = true;
        void load();
      } else if (chunk.type === 'tool:result') {
        void load();
      }
    },
  });

  vueWatch(
    () => ws.getConnectionId(),
    async (id) => {
      if (!id) return;
      await Promise.all([msgStream.start(), activityStream.start()]);
    },
    { immediate: true },
  );

  onMounted(() => {
    void load();
  });
}
```

- [ ] **Step 3: Update `useConversation.test.ts`**

The test mocks `useEventStream`. Update it to mock `useToolStream` instead:

```ts
// Remove:
vi.mock('./useEventStream.js', () => ({
  useEventStream: vi.fn(() => ({ on: vi.fn(() => vi.fn()) })),
}));

// Add:
vi.mock('./useToolStream.js', () => ({
  useToolStream: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    chunks: { value: [] },
    done: { value: false },
    error: { value: null },
    conversationId: { value: null },
  })),
}));
vi.mock('./useWebSocket.js', () => ({
  useWebSocket: vi.fn(() => ({
    getConnectionId: vi.fn(() => 'conn-1'),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    send: vi.fn(),
    onStreamChunk: vi.fn(() => vi.fn()),
  })),
}));
```

Also update any assertions in the test that referenced `useEventStream`:

- Find `expect(useEventStream().on).not.toHaveBeenCalled()` and update to verify `useToolStream` was or wasn't called as appropriate.

- [ ] **Step 4: Delete the old files**

```bash
rm packages/web/src/composables/useEventStream.ts
rm packages/web/src/composables/useEventStream.test.ts
```

- [ ] **Step 5: Run web tests**

Run: `npm run test --workspace=packages/web`
Expected: PASS

- [ ] **Step 6: Full format + typecheck + test**

Run: `npm run format:check && npm run typecheck && npm test && npm run test --workspace=packages/web`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/composables/useConversation.ts packages/web/src/composables/useConversation.test.ts
git rm packages/web/src/composables/useEventStream.ts packages/web/src/composables/useEventStream.test.ts
git commit -m "feat(web): replace useEventStream with useToolStream in useConversation; delete useEventStream"
```

---

## Task 22: Final verification

- [ ] **Step 1: Format check**

Run: `npm run format:check`
Expected: PASS (run `npm run format` to fix, then re-check)

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 3: Core + runtime unit tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Web package tests**

Run: `npm run test --workspace=packages/web`
Expected: PASS

- [ ] **Step 5: Tag Phase 1 complete**

```bash
git tag streaming-phase1-complete
```
