# Synchronous Human Reply Design

> Status: approved in chat 2026-11-23. Spec written for review.

## 1. Problem

`communicate` without `replyTo` is synchronous: the framework contract says the
sender blocks until the recipient responds (`docs/legion-v2-greenfield-spec.md`
§3). That holds for agents, whose runtime produces a response. It does not hold
for human participants (`type: 'user'`): `UserDeliveryRuntime` returns
`{ kind: 'void', delivery }` as soon as the connector accepts the message, so
`communicate` returns `status: 'success'` with a `conversationId` and no
`response`.

A participant that asks a human a question therefore cannot receive the answer
as the tool result. The human's reply arrives later as a separate inbound turn
and is dispatched to the bot owner.

## 2. Goal

Make a synchronous `communicate` to a human participant block until that human's
next message in the same conversation arrives, and return that message's text as
the tool result. The reply is persisted but consumed by the waiting call — it is
not also dispatched to the recipient's bot, so the bot does not reply twice.

## 3. Semantics

- Applies when: `replyTo` is absent, the recipient participant is
  `type: 'user'`, the runtime result is `kind: 'void'`, and delivery is
  `delivered` or `accepted`.
- The call returns `{ status: 'success', conversationId, response: <human text> }`.
- The human's message is appended to the conversation and `message:sent` is
  emitted exactly as for any inbound message; runtime dispatch and response
  persistence are skipped.
- A reply that arrives with no registered waiter routes normally (dispatched to
  the recipient bot).
- Delivery failure (`failed` / `not-reachable`) returns the existing delivery
  error and leaves no waiter.
- Fire-and-forget (`replyTo` set) is unchanged: returns `dispatched`
  immediately, no waiter.
- Non-user recipients (agent, service, mock) are unchanged.
- Both call paths get the behavior: the `communicate` tool (`sendStream`) and
  `ServiceContext.communicate` (`send`).

## 4. Core mechanism

All in `packages/core/src/runtime/MessageRouter.ts`.

### 4.1 Waiter registry

A private map keyed by `(conversationId, participantId)` holding a set of
resolvers. Registering returns an unregister function. Multiple waiters on the
same key are allowed; the first matching reply resolves all of them.

### 4.2 Registration and waiting

`MessageRouter` has two dispatch implementations that must share this behavior:
`sendInner` (used by `send`) and `sendStreamInner` (used by `sendStream`). A
shared helper handles registration, waiting, and consumption.

In both, when the conditions in §3 hold, register a waiter **before**
dispatching the recipient runtime (so a fast reply cannot race the
registration). Then:

1. `runtime.handle(...)` delivers the message.
2. If the result is `void` with `delivered`/`accepted`: release the conversation
   lock, then await the waiter.
3. If the result is anything else, or delivery failed, or `handle` throws:
   unregister and continue with the existing `completeResponse` path.

Releasing the lock before waiting is required: the human's reply is routed
through `send`/`sendStream`, which needs the same conversation lock to append.
Waiting while holding it deadlocks.

To make early release possible, both dispatch implementations gain a
`releaseLock` callback. `sendStreamWithController` already owns its release
closure. `send` is refactored from `withLock(...)` to
`acquireLock`/`release` so it can release early and still release in `finally`;
when no `conversationId` is supplied, `send` has no lock to release (existing
behavior) and the waiter still works.

On a successful reply, call `completeResponse` first (to preserve middleware
actions for the void result), then return the same result with `response` set to
the human's text.

### 4.3 Inbound consumption

In both `sendInner` and `sendStreamInner`, after the inbound message is
appended and lifecycle `receive` has run, before the runtime is built: look up
a waiter for
`(thread.id, opts.senderId)`. If one exists:

- append/persist is already done, and `message:sent` has been emitted;
- resolve the waiter(s) with the appended content;
- return `{ conversationId: thread.id, status: 'success' }` without building or
  dispatching the recipient runtime.

This is the only change to the inbound path; messages with no waiter are
untouched.

### 4.4 Timeout and cancellation

Effective reply timeout, highest precedence first:

1. explicit `timeoutMs` argument (existing `communicate` parameter);
2. the sender participant's `replyTimeoutMs`;
3. the collective's `communication.replyTimeoutMs`;
4. 30 minutes.

`null` at level 2 or 3 means wait indefinitely. A value must be a positive
integer; invalid values fall back to the next level with a warning.

On timeout: unregister the waiter, return
`{ conversationId, status: 'timeout', partial: true }`, and on the stream path
yield a `call_timeout` chunk so connectors can show the deadline. The late
reply then routes normally.

On caller abort (`opts.context.signal`): unregister and return
`{ conversationId, status: 'error', error: 'Runtime cancelled' }`.

## 5. Configuration

- `WorkspaceConfig.communication?: { replyTimeoutMs?: number | null }` in
  `.legion/config.json`. Unset means 30 minutes; `null` means indefinite.
- `BaseParticipant.replyTimeoutMs?: number | null` on the participant making
  the call (agent or service). Overrides the collective default; `null` means
  indefinite.
- `MessageRouter` gains an optional constructor argument carrying the
  collective communication config; `LegionProcess` passes the merged workspace
  config. Existing four-argument constructions keep working.

## 6. Service context

`ServiceContextImpl.communicate` maps router results to
`CommunicateResult`. A `timeout` result becomes
`{ status: 'error', error: 'deadline exceeded', conversationId }` instead of
being reported as success. Other mappings are unchanged.

## 7. Connector behavior

No connector changes. A consumed reply produces no assistant text on the
stream path, so the connector closes its stream with no content (Teams may show
an empty bubble for the human's own message). The assistant's outer turn, which
was blocked in `communicate`, continues with the reply as its tool result and
produces the visible response.

On Teams, this relies on thread learning (default on): the outbound send makes
the initiated conversation the chat's current thread, so the human's reply
lands in the conversation the waiter is watching. With `learnOutboundThread:
false`, the reply lands in the previous thread and the waiter times out; the
late reply then routes normally.

## 8. Edge cases

- Reply arrives between delivery and waiting: impossible to miss, because the
  waiter is registered before delivery.
- Two synchronous calls waiting on the same human in the same conversation:
  the first reply resolves both. Documented, not prevented.
- Human sends several messages: the first resolves the waiter; the rest route
  normally.
- Human replies in a different conversation: the waiter stays until timeout.
- A middleware short-circuit (`receive` returns `respond`) on the inbound reply
  takes precedence over consumption; the reply is handled by the middleware.

## 9. Non-goals

- No outbox, retries, delivery receipts, or multi-reply correlation.
- No new connector API; `deliver` still returns a `DeliveryOutcome`.
- No UI changes (no "waiting for reply" indicator).
- No per-connector reply timeout.

## 10. Tests

MessageRouter unit tests with a fake `user` runtime and a `mock` bot owner:

- reply consumed and returned as `response`; bot runtime not dispatched; the
  conversation contains both messages;
- reply with no waiter dispatches normally;
- timeout returns `status: 'timeout'` and a late reply routes normally;
- caller abort returns `Runtime cancelled` and removes the waiter;
- delivery failure returns the delivery error and removes the waiter;
- `replyTo` returns `dispatched` without waiting;
- agent recipients unchanged;
- precedence: participant override beats collective; collective beats default;
  `null` waits indefinitely.

Service context test: `timeout` maps to `error` with `deadline exceeded`.

## 11. Compatibility

- `MessageRouter`'s new config argument is optional; all existing call sites and
  tests compile unchanged.
- `BaseParticipant.replyTimeoutMs` is optional and ignored by participants that
  never call `communicate`.
- Connectors' inbound `submit` targets the bot owner (an agent) in normal
  operation, so inbound routing is unchanged. A connector that submits to a
  `user` participant now blocks for that human's reply, consistent with the
  synchronous contract.
