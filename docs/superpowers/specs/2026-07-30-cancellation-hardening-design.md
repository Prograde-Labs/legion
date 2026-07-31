# Cancellation Hardening Design

## Goal

Make chat cancellation terminate predictably across network failure, middleware processing, and
approval creation while retaining policy-compliant partial output.

## Scope

This change addresses seven confirmed gaps on `feat/chat-stop-button`:

1. WebSocket disconnect leaves stream promises unresolved and blocks reconnect.
2. Cancellation during response middleware drops partial output.
3. Direct partial persistence bypasses final middleware lifecycle.
4. Stop exposes Send before cancellation settles, allowing cross-run state races.
5. Cancellation HTTP and tool failures are ignored.
6. Terminal WebSocket frames can arrive before client handler registration.
7. Cancellation can leave approvals from an unpersisted agent turn.

Participant-bound stream cancellation and navigation-time stream ownership remain separate follow-up
issues.

## Client Stream Lifecycle

`useWebSocket` will own transport-level stream routing. It will retain a bounded set of frames that
arrive before a stream handler is registered and drain them when `onStreamChunk` registers. Socket
close will notify every registered stream handler with a local transport terminal before clearing
the routing table. Buffered unmatched frames will be cleared on disconnect and bounded by count to
prevent unbounded memory growth.

`useToolStream` will use generation-scoped state so terminal events from an older call cannot mutate
a newer call. It will expose `cancelling` separately from `active`. Cancellation will keep the
original terminal handler registered, inspect both HTTP status and buffered `ToolResult`, and settle
on transport disconnect. Logical cancellation failure will preserve the original stream handler and
surface an error; it will not claim cancellation succeeded. Starting another stream will wait until
the prior stream reaches a terminal state.

`useConversation` and `ConversationThread` will treat `active || cancelling` as composer-busy state.
Stop will not expose Send until cancellation settles. Existing conversations reload after terminal
cancellation and after WebSocket reconnection so server-persisted output becomes authoritative. New
conversation navigation continues to use the terminal result's conversation ID.

## Server Partial Finalization

`MessageRouter` will retain the latest draft emitted by `ResponseStreamTransformer`, not reconstruct
policy state from raw runtime deltas. User cancellation will stop runtime/provider work immediately,
then finalize that emitted draft through the normal response lifecycle using a fresh finalization
signal. This executes final draft hooks, persistence, after-send/after-receive hooks, approval logic,
and delivery events exactly once.

Cancellation detected while waiting for the next runtime chunk, inside transformer `push()`, or
during transformer `finish()` will use the same finalization path. Middleware policy rejection or
approval remains authoritative. Empty emitted drafts produce the existing cancellation error and no
assistant message.

Finalization will not reuse the aborted runtime signal because that would automatically cancel the
policy pipeline. It remains serialized under the conversation lock. Non-cancellation middleware
errors retain existing behavior and must not be mistaken for user cancellation.

## Approval Consistency

`AgentRuntime` will track approval IDs created for the current tool-call turn until that turn is
persisted. If cancellation occurs before persistence, it will remove those pending records before
returning `middleware_abort`. Once the tool-call message is persisted, approvals are authoritative
and are not rolled back.

Cleanup applies only to records created by that runtime iteration. Existing approvals and approvals
from other operations are untouched. Cleanup failure returns an explicit runtime error rather than
silently leaving inconsistent state.

## Error Handling

- WebSocket disconnect terminates local waits immediately; server socket-close cancellation remains
  authoritative for backend work.
- Cancellation authorization, approval, HTTP, and tool errors are exposed to UI.
- A stream-not-found result is treated as a completion race only if terminal state arrives; otherwise
  it remains an error.
- Stale terminal chunks are ignored by generation ID.
- Middleware rejection or pending approval from partial finalization is returned normally.

## Tests

Frontend regressions will cover:

- socket close settles active stream and permits reconnect restart;
- unmatched terminal frame drains on handler registration;
- Stop keeps composer busy until terminal;
- immediate Send cannot start during cancellation;
- HTTP and logical cancellation failures surface errors without dropping handler;
- stale terminal events do not mutate a newer stream;
- reconnect reloads existing conversation.

Core regressions will cover:

- cancellation while a response middleware hook is blocked;
- cancellation during response finalization;
- final hooks can transform, reject, or suspend partial output;
- empty cancellation persists nothing;
- approvals created during an unpersisted turn are removed on cancellation;
- persisted pending-approval turns are not rolled back.

Runtime integration coverage will exercise a real WebSocket stream cancelled through buffered
`cancel_stream`, asserting generator abort, terminal delivery, partial persistence, and registry
cleanup where observable.

## Follow-Ups

Two GitLab issues will track excluded design work:

- bind stream cancellation to requesting participant or connection ownership;
- define app-level ownership for streams when conversation components unmount.
