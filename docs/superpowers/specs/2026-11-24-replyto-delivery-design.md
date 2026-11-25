# ReplyTo Response Delivery Design

**Date:** 2026-11-24
**Status:** Approved in chat; spec written for review
**Packages:** `@legion-collective/types`, `@legion-collective/core`
**Base:** `fix/replyto-approval-routing` (composes with `dispatchApprovalRequests`)

## 1. Problem

`communicate` with `replyTo` is fire-and-forget: the recipient's runtime runs
asynchronously, and the caller immediately receives `status: 'dispatched'`.
When the recipient finishes, `MessageRouter` persists the response addressed to
the `replyTo` participant and emits `message:delivered`, but it never invokes
the `replyTo` participant's runtime.

The consequence is that `connector.deliver()` is never called for a `replyTo`
response:

- A human on Telegram or Teams never receives the reply.
- A web client only sees it if it is currently watching that exact conversation
  (`watch_conversation` reloads on `message:delivered`). A fresh conversation
  created by a service-started turn is not watched, and the sidebar does not
  refresh on the event.
- An agent/service/mock `replyTo` target never receives a turn; the response
  only sits in the conversation.

This contradicts the framework design in `docs/legion-v2-greenfield-spec.md`
§3 (fire-and-forget) and §6.7 ("normal delivery, fire-and-forget response, or
bubbled approval" all go through the delivery runtime). Approval requests
already follow the correct pattern on `fix/replyto-approval-routing`
(`dispatchApprovalRequests` builds the target runtime and calls `handle`);
ordinary `replyTo` responses do not.

## 2. Goals

- Deliver a response routed to `replyTo` by invoking the target participant's
  runtime, so a human target receives `connector.deliver()`.
- Default to delivering only to human (`type: 'user'`) participants, preserving
  today's behavior for agent/service/mock targets.
- Allow a collective-level opt-in that delivers to all participant types,
  recursively, with a hard depth limit.
- Keep the original caller's result as `dispatched`; delivery failures are
  logged/emitted, not returned to the caller.
- Leave synchronous sends, approval routing, and existing event semantics
  unchanged.

## 3. Non-goals

- Replacing the event bus.
- A retry queue, outbox, or delivery receipts.
- Per-participant delivery configuration.
- Changing the meaning of `message:delivered` (double emission is accepted).
- Running the full inbound middleware lifecycle for delivery turns.
- Changing the existing communication depth-limit constant.

## 4. Configuration

Add to `CommunicationConfig` in `packages/types/src/config.ts`:

```ts
export interface CommunicationConfig {
  replyTimeoutMs?: number | null;

  /**
   * How responses routed to `replyTo` are delivered.
   * - `'users'` (default): invoke the runtime of `type: 'user'` targets only.
   * - `'all'`: invoke the runtime of every target type and recurse on each
   *   returned response until a void result or the depth limit. Two agents
   *   replying to each other can consume up to the depth limit (10) turns
   *   with no human in the loop.
   */
  replyToDelivery?: 'users' | 'all';
}
```

- Absent → `'users'`.
- `'all'` → `'all'`.
- Any other value → `'users'` plus a one-time `console.warn` from
  `MessageRouter`.
- Collective-level only; no per-participant override in this fix.
- `LegionProcess` already passes `mergedConfig.communication` to
  `MessageRouter`, so no wiring change is required beyond the type.

## 5. Architecture

```
caller (service/agent)
  └─ router.send / sendStream({ to: recipient, replyTo: target })
       └─ append inbound, dispatch recipient runtime, return 'dispatched'
            └─ [background] recipient finishes
                 └─ completeResponseDetailed persists response to target
                      └─ deliverReplyTo(target, responseMessage)
                           ├─ target.type === 'user'
                           │    └─ UserDeliveryRuntime.handle
                           │         └─ connector.deliver()
                           └─ replyToDelivery === 'all'
                                └─ target runtime.handle
                                     └─ completeResponseDetailed
                                          └─ recurse (depth + 1)
```

Only the async `replyTo` path changes. `send`, `sendStream`, and `generate`
dispatch through `dispatchAsync`, so all are covered. `resume` and
`resumeApproval` call `runtime.handle` directly, so they invoke
`deliverReplyTo` themselves after `completeResponseDetailed` (see
`2026-11-25-replyto-approval-context-design.md` for the resumed-delivery
dedup). Synchronous sends are untouched.

## 6. Detailed behavior

### 6.1 Persisting the response message

`completeResponse` currently returns only `MessageRouterResult`, which loses
the `MessageData` needed for delivery. Add a private detailed variant:

```ts
private async completeResponseDetailed(
  operation: ResponseOperation,
  result: RuntimeResult,
): Promise<{ result: MessageRouterResult; message?: MessageData }>
```

- `completeResponse` becomes a thin wrapper returning `.result`, so synchronous
  paths, `resume`, `resumeApproval`, and `dispatchApprovalRequests` are
  unchanged.
- `persistResponse` returns `{ result, message }`:
  - Non-lifecycle path: the appended `responseMsg` from `thread.append`.
  - Lifecycle path: add `storedMessageId` to the success return of
    `MiddlewareLifecycle.respond` (the field already exists on
    `MessageRouterResult`), then resolve the message from
    `thread.data.messages[storedMessageId]`.
- `void`, `pending_approval`, and `middleware_abort` return no message. A
  `middleware_abort` partial is not delivered; it remains in the conversation.

### 6.2 `deliverReplyTo`

Add a private helper:

```ts
private async deliverReplyTo(
  thread: ConversationThread,
  responseMessage: MessageData,
  opts: SendOptions,
  depth: number,
): Promise<void>
```

Invoked from `dispatchAsync` after `completeResponseDetailed` when all hold:

1. `opts.replyTo` is set.
2. `completeResponseDetailed` returned a persisted `message`.
3. `message.recipientId !== message.senderId` (self-delivery guard).
4. The `replyTo` participant exists.
5. `replyToDelivery` allows the target:
   - `'users'`: `target.type === 'user'`.
   - `'all'`: any type.
6. `depth <= DEFAULT_DEPTH_LIMIT` (10).

The first delivery runs at `(opts.context.communicationDepth ?? 0) + 1`.

Steps:

1. `runtime = this.registry.build(target.type, target.id)`.
2. Build a `RuntimeContext` with `conversation = thread`,
   `communicationDepth = depth`, and the original `opts.context`.
3. `result = await runtime.handle(responseMessage, context)`.
4. `completed = await this.completeResponseDetailed({ thread, recipientId:
target.id, responseRecipientId: responseMessage.senderId }, result)`.
5. If `completed.result.status === 'pending_approval'`, route any
   `approvalRequests` back up to `responseMessage.senderId` via
   `dispatchApprovalRequests` and stop (with or without requests).
6. If `replyToDelivery === 'all'` and `completed.message` exists, recurse with
   `depth + 1`.

`registry.build` is the established pattern (`sendStreamInner`, `sendInner`,
`resume`, `generate`, `resumeApproval`, `dispatchApprovalRequests`). The
runtime in `dispatchAsync` is bound to the original recipient, so it cannot be
reused for the target.

### 6.3 `'users'` mode

Only `type: 'user'` targets are delivered. `UserDeliveryRuntime` calls every
deliverable connector, aggregates `DeliveryOutcome`s, and returns `void`. A
void result stops recursion, so `'users'` mode performs exactly one delivery
attempt per `replyTo` response.

### 6.4 `'all'` mode

Every target type is delivered. A response produced by the target is persisted
by `completeResponseDetailed` and then delivered to its recipient, and so on.

Recursion stops on:

- a `void` result (the normal human case),
- `pending_approval` (after approval routing),
- an error,
- `depth > DEFAULT_DEPTH_LIMIT`.

**Risk:** two agents (or an agent and a service) replying to each other via
`replyTo` can ping-pong for up to 10 turns with no human in the loop. Each turn
can call tools and consume tokens. `'users'` is the default; `'all'` is opt-in
and should be used when the chain is expected to terminate quickly.

### 6.5 Approvals

If an `'all'` target returns `pending_approval`, the approval requests bubble
back to the participant whose message triggered the target:

```ts
await this.dispatchApprovalRequests(
  thread,
  {
    ...opts,
    senderId: target.id,
    recipientId: target.id,
    replyTo: responseMessage.senderId,
    context: { ...opts.context, communicationDepth: depth },
  },
  completed.result.approvalRequests,
);
```

A `user` target never hits this path (`UserDeliveryRuntime` returns `void`).
Recursion stops after routing the approvals.

### 6.6 Failures

`deliverReplyTo` must never throw into `dispatchAsync`; the caller already
received `dispatched`.

- Missing `replyTo` participant: `console.warn` and skip.
- `registry.build` or `runtime.handle` throws: catch, log, and emit the
  existing `error` event (`{ conversationId, error }`).
- Delivery returns `void` with `not-reachable` or `failed`:
  `completeResponseDetailed` maps it to `status: 'error'`; log and emit
  `error`. Do not recurse.
- Delivery failure does not change the caller's `dispatched` result.
- Self-delivery (`responseMessage.recipientId === responseMessage.senderId`,
  equivalently `replyTo === opts.recipientId`): skip with a debug log.

### 6.7 Middleware

Delivery turns are built with `buildRuntimeContext(..., middlewareState =
undefined)`, mirroring `dispatchApprovalRequests`. Agent middleware
(`buildSystemPrompt`, inbound/outbound middleware) does not run for a delivery
turn. The participant's base runtime and system prompt are used. This is a
documented limitation; running the full inbound lifecycle for a response would
append a second message and is out of scope.

### 6.8 Resume and approval notices

`resume` and `resumeApproval` deliver the resumed reply to `replyTo` as well.
The routed approval notice is persisted with `internal: true`, so it remains a
durable record for the target but is excluded from the requester's agent model
context unless it is the participant's current incoming message. `resume` and
`generate` still select the latest incoming turn regardless of the flag.

`deliverReplyTo` returns whether it delivered, and the resume result records
`responseRecipientId` and `replyToDelivered`. `approval_response` omits the
reply from its `resumed` payload whenever the router already delivered it, so a
connector does not post it twice. A resumed reply with no text is not delivered
and is not returned in `resumed`. The routed notice carries the paused turn's
text (when present) ahead of the approval summary, so the approver sees the
explanation written with the gated call. See
`2026-11-25-replyto-approval-context-design.md` for details.

## 7. Event semantics

`message:delivered` will be emitted twice for a `replyTo` delivery: once by
`persistResponse` when the response is appended, and once by
`UserDeliveryRuntime` after connector delivery. The first event means "response
persisted and addressed to the target"; the second means "connector delivery
attempted". Duplicates are idempotent for the web UI's `watch_conversation`
reload and are accepted because the event bus is slated for deprecation.

## 8. Compatibility

- Default `'users'` preserves today's behavior for agent/service/mock targets
  and fixes human delivery.
- `'all'` is opt-in and does not affect collectives that do not set it.
- Web delivery is unchanged (`WebConnector.deliver` already handles open
  sockets and returns `accepted` when none exists).
- Telegram/Teams now receive a push for a `replyTo` response addressed to a
  human participant.
- Approvals are unchanged; this fix composes with `dispatchApprovalRequests`.

## 9. Testing

Core (`packages/core/src/runtime/MessageRouter.test.ts`):

1. Default `'users'`: a `replyTo` user invokes `UserDeliveryRuntime` /
   `connector.deliver`; the caller still receives `dispatched`; an agent
   `replyTo` target is not runtime-invoked.
2. `'all'`: a `replyTo` agent is runtime-invoked; its response is persisted;
   recursion continues until `void` or the depth limit; assert the turn count.
3. `'all'` with a user target: delivered once and stops.
4. Self-delivery (`replyTo === recipient`) is skipped.
5. Missing `replyTo` participant: warn, no throw, caller still `dispatched`.
6. Delivery failure (`not-reachable` / `failed`): error is logged/emitted,
   caller still `dispatched`, no recursion.
7. `'all'` target returns `pending_approval`: approvals route back to the
   triggering sender and recursion stops.
8. `completeResponseDetailed` returns the stored message for lifecycle and
   non-lifecycle success paths.
9. Invalid `replyToDelivery` falls back to `users` with a warning.
10. All async entry points (`send`, `sendStream`, `generate`, `resume`,
    `resumeApproval`) exercise the same helper.

Connector integration (optional): a `replyTo` response to a web participant
reaches `connector.deliver` with the expected `conversationId`, `recipientId`,
and content.

## 10. Files

- `packages/types/src/config.ts` — add `replyToDelivery`.
- `packages/core/src/runtime/MessageRouter.ts` — config resolution,
  `completeResponseDetailed`, `deliverReplyTo`, `dispatchAsync` changes.
- `packages/core/src/middleware/MiddlewareLifecycle.ts` — return
  `storedMessageId` on a successful `respond`.
- `packages/core/src/runtime/MessageRouter.test.ts` — tests.
- `docs/legion-v2-greenfield-spec.md` — document the config option and default.
- `docs/superpowers/specs/2026-11-24-replyto-delivery-design.md` — this spec.

## 11. Rollout

- Base on `fix/replyto-approval-routing`; merge that branch first or rebase this
  fix onto it.
- Default configuration requires no migration.
- Collectives that want agent/service/mock `replyTo` delivery opt in with
  `communication.replyToDelivery: 'all'`.
