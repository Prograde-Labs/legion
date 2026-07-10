# Streaming Tools Design

**Date:** 2026-07-10
**Status:** Approved

## Overview

Add streaming support to the Legion tool system via `AsyncGenerator`-based `StreamingTool` interface. Streaming tools replace the `EventBus → WebSocket` bridge as the mechanism for real-time frontend communication, bringing all collective activity under the `AuthEngine` and the single tool interface. LLM output from `communicate` also streams end-to-end.

Two implementation phases share one spec:
- **Phase 1:** Core streaming infrastructure — `StreamingTool` interface, `ToolRegistry` streaming, transport layer (WS routing + SSE fallback), subscription tools, EventBus bridge removal.
- **Phase 2:** Provider streaming and `communicate` — `Provider.stream()`, `AgentRuntime` generator loop, `MessageRouter.sendStream()`, `communicate` as `StreamingTool`.

---

## Motivation

The current `EventBus` is the only real-time delivery mechanism to the frontend. It has three significant problems:

1. **Outside the tool system.** It bypasses `AuthEngine` entirely, requiring a separate per-event authorization layer (`event-filter.ts`) to filter what each participant sees.
2. **Outside the Legion philosophy.** "All collective activity goes through tools" is violated by a global fan-out bus that any connected WebSocket client auto-receives.
3. **Outside auth.** One production consumer (`WebConnector.onAny()`) bridges all events to all authenticated clients. The filtering is a best-effort filter, not the same guarantee as `ToolPolicy`.

Streaming tools solve all three: every real-time feed is an authorized tool call. `AuthEngine` gates access. Subscription tools are composable, filterable, and testable exactly like other tools.

---

## Current Architecture (relevant paths)

```
EventBus.emit()                     [EventBus.ts:45]
  → WebConnector.onAny()            [WebConnector.ts:234]
    → isRelevantToParticipant()     [event-filter.ts:12]
      → socket.send({ type:'event', event, data })
        → useWebSocket.onMessage()  [useWebSocket.ts:26]
          → useEventStream fan-out  [useEventStream.ts:18]
```

**EventBus has exactly one production consumer** — `WebConnector.onAny()`. All other `on()` calls are in test files. The EventBus is purely a broadcast channel to the frontend, not an internal coordination mechanism.

---

## Core Abstractions

### `StreamingTool` interface

```ts
// packages/types/src/tool.ts

export interface StreamingTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk>;
}

export type AnyTool = Tool | StreamingTool;

export function isStreamingTool(t: AnyTool): t is StreamingTool {
  return 'stream' in t && typeof t.stream === 'function';
}
```

`StreamingTool` has no `execute` method. The registry derives it by draining the generator. Tool authors implement exactly one method.

### `StreamChunk` — universal chunk format

```ts
// packages/types/src/streaming.ts (new file)

// LLM output — from communicate and any LLM-backed tools
export type LLMChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string }

// Lifecycle — emitted by registry, never by tool authors
export type LifecycleChunk =
  | { type: 'stream:done'; result: ToolResult }
  | { type: 'stream:error'; error: string }

// Event — from subscription tools, reuses existing LegionEventMap types
export type EventChunk = {
  [K in LegionEventName]: { type: K; data: LegionEventMap[K] }
}[LegionEventName]

export type StreamChunk = LLMChunk | EventChunk | LifecycleChunk
```

**Rules:**
- Tool authors yield `LLMChunk | EventChunk` only.
- `stream:done` and `stream:error` are injected by `ToolRegistry` — never by tool authors.
- `seq` is added by the transport layer, not by tools or the registry.
- `EventChunk` reuses existing `LegionEventMap` shapes — no new event types needed for subscription tools.

### `ProviderStreamChunk` — wire format inside Provider layer

```ts
// packages/types/src/provider.ts (additions)

export type ProviderStreamChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string }
  | { type: 'done'; stopReason: ProviderStopReason; usage?: ProviderUsage }
```

The `done` chunk is consumed internally by `AgentRuntime` and never leaks upstream as a `StreamChunk`.

---

## ToolRegistry Changes

### Updated `register()` and new `stream()` method

```ts
class ToolRegistry {
  register(tool: AnyTool): void               // updated — accepts Tool | StreamingTool
  execute(name, args, context): Promise<ToolResult>  // unchanged
  stream(name, args, context): AsyncGenerator<StreamChunk>  // new
}
```

### `execute()` on a `StreamingTool` — drain to final result

Callers that don't want chunks (e.g. agents calling `communicate`) get a `ToolResult` identical in shape to a regular tool:

```ts
if (isStreamingTool(tool)) {
  for await (const chunk of managedStream(tool, args, context)) {
    if (chunk.type === 'stream:done') return chunk.result;
    if (chunk.type === 'stream:error') return { status: 'error', error: chunk.error };
    // all intermediate chunks discarded — caller only wants the answer
  }
}
```

`execute()` is "give me the answer." `stream()` is "show me everything as it happens." Same underlying work, different observation granularity.

### `stream()` on a regular `Tool` — single-chunk passthrough

Callers can call `stream()` on any tool without knowing its type:

```ts
async function* stream(name, args, context) {
  const result = await tool.execute(args, context);
  yield { type: 'stream:done', result } satisfies LifecycleChunk;
}
```

### Lifecycle injection — registry owns `done` and `error`

```ts
async function* managedStream(tool, args, context) {
  try {
    yield* tool.stream(args, context);
    yield { type: 'stream:done', result: { status: 'success' } };
  } catch (err) {
    yield { type: 'stream:error', error: err.message };
  }
}
```

Tool authors never write terminal chunks. If the generator throws, `stream:error` is emitted. If it returns normally, `stream:done` is emitted. Always clean.

### Auth — unchanged policy model

Auth is checked before the generator starts:

```ts
async function* stream(name, args, context) {
  const auth = authEngine.authorize(participantId, name, args, policies);
  if (!auth.authorized) {
    yield { type: 'stream:error', error: `Tool ${name}: ${auth.reason}` };
    return;
  }
  yield* managedStream(tool, args, context);
}
```

### Observability — `tool:call` / `tool:result`

`ToolRegistry` continues emitting `tool:call` and `tool:result` to `EventBus` (internal). These are consumed by `watch_activity` subscription tool. The registry itself needs no changes here.

---

## Transport Layer

### ConnectionId — issued on WS auth

`WebConnector` generates a `connectionId` per socket on successful auth:

```json
{ "type": "connected", "participantId": "user-1", "connectionId": "<uuid-v4>" }
```

Server maintains: `Map<connectionId, WebSocket>` alongside the existing `Map<participantId, Set<WebSocket>>`.

**Security:** `connectionId` is validated against the authenticated participant on every streaming tool request — you cannot redirect a stream to another participant's connection.

### `POST /api/execute` — three transport modes

```
X-Stream-Connection: <connectionId>   →  WS streaming
(no header)                           →  SSE inline
?stream=false                         →  buffered JSON
```

`stream=false` always wins if present. Non-streaming tools ignore all headers — the endpoint checks `isStreamingTool()` before deciding.

**WS mode** — detaches immediately:
1. Validate `connectionId` belongs to authenticated participant.
2. Generate `streamId = crypto.randomUUID()`.
3. Register stream in `StreamRegistry`.
4. Background: iterate `toolRegistry.stream()` → route chunks to WS socket.
5. Return HTTP 200 `{ streamId }` immediately.

**SSE mode** — stays attached:
1. Set `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
2. Iterate `toolRegistry.stream()`.
3. Write each chunk: `data: {"seq":<n>,"data":<chunk>}\n\n`.
4. On `stream:done`/`stream:error`: write final chunk, end response.

**Buffered mode:**
1. Call `toolRegistry.execute()` — internally drains the stream.
2. Return HTTP 200 `ToolResult` as JSON (same shape as today).

### `StreamRegistry` — transport-internal lifecycle tracking

```ts
// packages/core/src/streaming/StreamRegistry.ts
class StreamRegistry {
  register(streamId: string, connectionId: string): AbortSignal
  cancel(streamId: string): void
  cancelAll(connectionId: string): void  // called on WS close
}
```

`StreamRegistry` is never exposed to callers of `ToolRegistry`. It is invisible to tool authors. It is an internal implementation detail of the transport layer (HTTP execute route + `WebConnector`).

`ToolContext` gains two additions:
- `signal?: AbortSignal` — lets streaming tools know when they've been cancelled.
- `cancelStream?(streamId: string): boolean` — narrow capability for `cancel_stream` tool.

### WS frame protocol — additions

```ts
// server → client (new)
{ type: 'stream:chunk'; streamId: string; seq: number; data: StreamChunk }

// client → server: cancellation goes through cancel_stream tool, not WS protocol
```

`stream:done` and `stream:error` are not separate frame types — they are regular `stream:chunk` frames where `data.type` is `'stream:done'` or `'stream:error'`. Transport is a pure pipe.

`seq` is monotonically increasing per `streamId`, assigned by the transport layer. Cheap out-of-order detection.

### `cancel_stream` tool

Cancellation stays in the tool system — no special WS protocol message:

```ts
const cancelStreamTool: Tool = {
  name: 'cancel_stream',
  parameters: { streamId: { type: 'string', required: true } },
  execute(args, context) {
    const cancelled = context.cancelStream?.(args.streamId as string);
    return cancelled
      ? { status: 'success' }
      : { status: 'error', error: 'Stream not found or already complete' };
  },
};
```

---

## Phase 2: Provider Streaming & `communicate`

### `Provider` interface — `stream()` replaces `complete()`

```ts
interface Provider {
  stream(messages, tools, model): AsyncGenerator<ProviderStreamChunk>
  // complete() removed from interface — may remain as private impl detail
  listModels?(): Promise<ProviderModel[]>
  pricingSource?(): PricingSource
}
```

`stream()` is the only method. Providers without native streaming support implement it by calling their blocking HTTP endpoint and yielding the full response as a sequence of chunks:

```ts
// Non-streaming provider implementation
async function* stream(messages, tools, model) {
  const response = await this.fetchComplete(messages, tools, model);
  if (response.content) yield { type: 'text_delta', delta: response.content };
  for (const tc of response.toolCalls) {
    yield { type: 'tool_call_start', index: tc.index, id: tc.id, name: tc.name };
    yield { type: 'tool_call_args_delta', index: tc.index, delta: JSON.stringify(tc.arguments) };
  }
  yield { type: 'done', stopReason: response.stopReason, usage: response.usage };
}
```

From `AgentRuntime`'s perspective this is indistinguishable from a real streaming provider — one path, no branching.

`OpenAICompatibleProvider.stream()` adds `stream: true, stream_options: { include_usage: true }` to the request, reads the response body as a `ReadableStream`, splits on newlines, parses SSE frames, and yields typed `ProviderStreamChunk` values.

### `AgentRuntime` — unified generator loop

The internal agentic loop always calls `provider.stream()`. The `done` chunk is consumed internally; delta chunks are yielded upstream while simultaneously accumulated for tool execution:

```ts
// Inside AgentRuntime internal loop — one path, no branching
for await (const chunk of provider.stream(messages, providerTools, model)) {
  if (chunk.type === 'done') {
    response = buildProviderResponse(contentParts, toolAccum, chunk);
  } else {
    yield chunk;                              // upstream to caller
    accumulate(chunk, contentParts, toolAccum); // internal for tool execution
  }
}
```

All turns yield chunks — including tool-call turns. The client sees the agent's full reasoning stream: text deltas, tool names forming, argument JSON building. Tool execution happens after each turn completes (full args assembled from accumulator). `JSON.parse` is only called on complete accumulated arg strings, never on partial deltas.

`AgentRuntime` gains an internal generator method. The existing `handle()` method is preserved for backward-compat callers (agents receiving synchronous responses) — it drains the generator and returns `RuntimeResult`:

```ts
async handle(message, context): Promise<RuntimeResult> {
  const gen = this.runLoop(message, context);
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}
```

`handleStream()` passes chunks through for callers that want them.

**`pending_approval` mid-stream:** generator returns `{ kind: 'pending_approval' }` — chunks already delivered are already in the client. `stream:done` carries the `pending_approval` `ToolResult`. Clean.

### `Runtime` interface addition

```ts
interface Runtime {
  handle(message, context): Promise<RuntimeResult>               // unchanged
  handleStream?(message, context): AsyncGenerator<LLMChunk, RuntimeResult>  // new, optional
}
```

Only `AgentRuntime` implements `handleStream`. `UserDeliveryRuntime` and `MockRuntime` are unchanged.

### `MessageRouterPort` — `sendStream()` addition

```ts
interface MessageRouterPort {
  send(options): Promise<MessageRouterResult>                          // unchanged
  sendStream(options): AsyncGenerator<LLMChunk, MessageRouterResult>  // new, required
}
```

`sendStream` is required on the interface. `MockMessageRouter` in tests implements it by yielding nothing and returning a mock result. This avoids optional-chaining in `communicate.stream()` and eliminates TypeScript null checks at the call site.

`MessageRouter.sendStream()` mirrors `sendInner()` but delegates to `handleStream()` when available:

```ts
async function* sendStream(options) {
  // ... same setup: validate, get/create thread, append inbound message
  const runtime = registry.build(recipient.type, recipient.id);

  if (runtime.handleStream) {
    return yield* runtime.handleStream(inbound, ctx);  // pass-through
  } else {
    const result = await runtime.handle(inbound, ctx);
    return handleRuntimeResult(result, ...);
  }
}
```

`yield*` passes all `LLMChunk` values straight through and captures `RuntimeResult` as the return value.

### `communicate` — becomes `StreamingTool`

```ts
const communicateTool: StreamingTool = {
  name: 'communicate',
  description: '...',
  parameters: { ... },  // unchanged

  async *stream(args, context) {
    yield* context.messageRouter.sendStream({
      senderId: context.participant.id,
      recipientId: args.to,
      message: args.message,
      conversationId: args.conversationId,
      replyTo: args.replyTo,
      context: { ...context, communicationDepth: (context.communicationDepth ?? 0) + 1 },
    });
    // registry injects stream:done automatically on generator return
  },
};
```

`replyTo` (fire-and-forget): `sendStream()` dispatches async and returns immediately with no chunks — generator terminates, registry emits `stream:done` with dispatched status. No special-casing needed.

### Full streaming call chain

```
POST /api/execute { tool: 'communicate', ... } (X-Stream-Connection: cid)
  → ToolRegistry.stream('communicate', args, context)
    → communicateTool.stream()
      → messageRouter.sendStream()
        → agentRuntime.handleStream()
          → provider.stream()          ← OpenAI SSE
            yields: text_delta, tool_call_start, tool_call_args_delta
          ↑ chunks flow back unchanged
        ↑ MessageRouterResult as return value
      ↑ LLMChunk stream passes through
    ← registry injects stream:done with ToolResult
  ← chunks routed to WS as stream:chunk frames
```

Each layer is thin — passes chunks through and handles only its own concern.

---

## Subscription Tools

### AsyncQueue — internal utility for subscription tools

Subscription tools bridge the push-based `EventBus` into a pull-based `AsyncGenerator`. An `AsyncQueue<T>` utility handles this:

```ts
// packages/core/src/streaming/AsyncQueue.ts
class AsyncQueue<T> {
  push(value: T): void
  async next(signal?: AbortSignal): Promise<T | null>  // null on abort
}
```

`signal`-awareness is critical: `await queue.next()` must unblock when the stream is cancelled; otherwise subscription tools hang indefinitely. The `AbortSignal` listener is cleaned up when an event arrives or when abort fires.

Template for all subscription tools:

```ts
async function* stream(args, context) {
  const queue = new AsyncQueue<EventChunk>();
  const unsubs = [
    context.eventBus.on('some:event', (data) => queue.push({ type: 'some:event', data })),
  ];
  try {
    while (true) {
      const chunk = await queue.next(context.signal);
      if (chunk === null) break;  // aborted
      yield chunk;
    }
  } finally {
    unsubs.forEach(fn => fn());  // always clean up
  }
}
```

### Subscription tools

**`watch_conversations`**
- Events: `conversation:created`
- Args: none
- Replaces: `conversation:created` EventBus events bridged to frontend

**`watch_participants`**
- Events: `participant:active`, `participant:retired`
- Args: none
- Replaces: `participant:active`, `participant:retired` EventBus events

**`watch_activity`**
- Events: `tool:call`, `tool:result`, `iteration`, `approval:requested`, `approval:resolved`, `error`
- Args: `{ conversationId?: string }` — optional filter
- Replaces: activity feed events bridged to frontend

**`watch_conversation`**
- Events: `message:sent`, `message:delivered`
- Args: `{ conversationId: string }`
- Replaces: per-conversation message event delivery
- **Limitation:** does not deliver in-progress LLM chunks to a second observer (e.g. after page refresh mid-stream). Attaching to an in-progress stream requires a per-conversation multicast channel — deferred as future work.

**`watch_process`**
- Source: `processManager` subscriptions (not EventBus)
- Args: `{ processId: string }`
- Yields: `{ type: 'process:output', stream: 'stdout'|'stderr', data: string }`, `{ type: 'process:exited', exitCode: number }`
- Replaces: `WebConnector` `subscribe_process` handler (lines 241–313)

### EventBus — retained as internal plumbing

The `EventBus` class is not removed. It remains the internal coordination mechanism subscription tools listen to. `ToolContext.eventBus` is retained for subscription tools.

All components that currently emit to `EventBus` (`ToolRegistry`, `MessageRouter`, `AgentRuntime`, `approval-response-tool`) continue to do so unchanged. The `message:sent` and `message:delivered` events in particular must continue to emit so that `watch_conversation` can deliver them to subscribers.

`process:ready` (currently broadcast to all WS clients on startup) is no longer pushed to the frontend. Clients that need startup status call a `get_status` tool or check the existing REST-equivalent on WS connect.

**What is removed:** `WebConnector.onAny()` bridge (line 234) — the single production consumer. External delivery of EventBus events to WebSocket clients is fully eliminated. All real-time frontend data now flows through authorized streaming tool calls.

The EventBus is noted as a future cleanup candidate: component-level subscription interfaces (e.g. `toolRegistry.onToolCall()`) could replace it and eliminate the shared global bus entirely, without changing any external-facing behaviour.

---

## Frontend Changes

### `useWebSocket` additions

`connectionId` stored on auth:
```ts
// connected frame gains connectionId field
{ type: 'connected', participantId: string, connectionId: string }
```

Per-stream routing (O(1), not broadcast):
```ts
const streamHandlers = new Map<string, (chunk: StreamChunk) => void>();

// on stream:chunk frame:
if (msg.type === 'stream:chunk') {
  streamHandlers.get(msg.streamId)?.(msg.data);
  return;
}

// new methods:
onStreamChunk(streamId: string, handler: (chunk: StreamChunk) => void): () => void
getConnectionId(): string | null
```

The `event` frame type and its handler are removed.

### `useToolStream<TChunk>` — new core composable

```ts
function useToolStream<TChunk = StreamChunk>(
  toolName: string,
  args: unknown,
  options?: { onChunk?: (chunk: TChunk) => void }
): {
  start(): Promise<void>
  cancel(): Promise<void>    // calls cancel_stream tool
  chunks: Ref<TChunk[]>
  done: Ref<boolean>
  error: Ref<string | null>
}
```

Internally:
1. Gets `connectionId` from `useWebSocket()`.
2. POSTs `/api/execute` with `X-Stream-Connection: <connectionId>` header.
3. Receives `{ streamId }` in HTTP response.
4. Calls `ws.onStreamChunk(streamId, handler)` to receive chunks.
5. On `stream:done`: sets `done = true`, unregisters handler.
6. On `stream:error`: sets `error`, unregisters handler.
7. Auto-cancels via `cancel_stream` tool on `onUnmounted`.

### Page load pattern

Old: WebConnector auto-subscribed all clients to EventBus on WS connect.

New: frontend explicitly starts the streams it needs once `connectionId` is available:

```ts
// App.vue or useAppStreams composable
const ws = useWebSocket();

watch(() => ws.getConnectionId(), async (id) => {
  if (!id) return;
  await conversationStream.start();   // watch_conversations
  await participantStream.start();    // watch_participants
  await activityStream.start();       // watch_activity
});
```

Page refresh restarts exactly the streams the page needs. No server-side state about what each client is watching.

### Files deleted / changed

| File | Change |
|---|---|
| `packages/web/src/composables/useEventStream.ts` | Deleted |
| `packages/web/src/composables/useWebSocket.ts` | Remove `event` frame handler; add `connectionId`, `onStreamChunk` |
| `packages/runtime/src/server/event-filter.ts` | Deleted |
| `packages/runtime/src/server/WebConnector.ts:234` | Delete `onAny()` bridge |
| `packages/runtime/src/server/WebConnector.ts:241-313` | Delete `subscribe_process` handler |

---

## ToolContext Changes Summary

| Field | Change |
|---|---|
| `eventBus` | Retained — subscription tools subscribe via `context.eventBus.on()` |
| `signal?: AbortSignal` | New — streaming tools check for cancellation |
| `cancelStream?(streamId: string): boolean` | New — used by `cancel_stream` tool |

---

## New Files

| File | Purpose |
|---|---|
| `packages/types/src/streaming.ts` | `StreamChunk`, `LLMChunk`, `EventChunk`, `LifecycleChunk` |
| `packages/core/src/streaming/AsyncQueue.ts` | Abort-aware async queue for subscription tools |
| `packages/core/src/streaming/StreamRegistry.ts` | Transport-internal stream lifecycle tracking |
| `packages/core/src/tools/watch-conversations-tool.ts` | Subscription tool |
| `packages/core/src/tools/watch-participants-tool.ts` | Subscription tool |
| `packages/core/src/tools/watch-activity-tool.ts` | Subscription tool |
| `packages/core/src/tools/watch-conversation-tool.ts` | Subscription tool |
| `packages/core/src/tools/watch-process-tool.ts` | Subscription tool |
| `packages/core/src/tools/cancel-stream-tool.ts` | Cancellation tool |
| `packages/web/src/composables/useToolStream.ts` | Replaces `useEventStream` |

---

## Known Limitations / Future Work

- **In-progress conversation attachment:** `watch_conversation` does not deliver live LLM chunks to a second observer (e.g. page refresh mid-generate). Requires per-conversation multicast channel. Deferred.
- **EventBus full elimination:** Component-level subscription interfaces could replace the shared `EventBus` entirely (e.g. `toolRegistry.onToolCall()`). No external behaviour change. Deferred.
- **Infinite stream `execute()` safety:** Calling `toolRegistry.execute()` on an infinite subscription tool (e.g. `watch_conversations`) will block forever. Callers must only call `execute()` on tools that terminate, or use `stream()` with cancellation. Document as a constraint on subscription tool authoring.
