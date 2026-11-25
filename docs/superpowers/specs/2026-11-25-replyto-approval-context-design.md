# ReplyTo Approval Context and Delivery Dedup Design

**Date:** 2026-11-25
**Status:** Fixes issues #20 and #22
**Packages:** `@legion-collective/types`, `@legion-collective/core`
**Base:** `main` after PR #19 (`fix/replyto-delivery`)

## 1. Problem

When a `communicate` turn uses `replyTo` and the recipient pauses for a tool
approval, two things go wrong after the approval is granted:

1. The agent answers the approval notice instead of the original task.
2. The resumed reply is posted to the connector-bound human twice.

The reproduction is a service calling
`communicate('agent-a', 'Reply with one line "done", then call <gated tool>',
{ replyTo: 'user-u' })`, where `user-u` is a connector-bound user with
approval authority over `agent-a`.

## 2. Root causes

### 2.1 The approval notice enters the agent's model context

`MessageRouter.dispatchApprovalRequests` appends the routed approval notice
to the requester's conversation as a `role: 'user'` message:

```
agent-a -> user-u: "Approval required for tool '<tool>' ... Use approval_response ..."
```

That persistence is intentional: it is the durable record of the approval
request and it is the incoming message the target runtime handles. But the
message stays on the active branch. When the requester resumes, `AgentRuntime`
builds provider messages from the whole active chain, so the notice becomes the
latest user turn and the model answers it ("approval_response is not available
in this session") instead of continuing the original task.

### 2.2 The resumed reply is delivered twice

`MessageRouter.resume` and `resumeApproval` persist the resumed reply
addressed to `replyTo` and, since PR #19, also call `deliverReplyTo`. The
`approval_response` tool additionally returns the resumed reply in its
`resumed` payload so the caller (the Teams connector) can post it to the
conversation where the card was clicked. When the caller is the `replyTo`
target, both paths deliver to the same chat.

## 3. Fix

### 3.1 Mark delivery-only messages as internal

Add `internal?: boolean` to `MessageData`. `dispatchApprovalRequests` sets it
on the approval notice. `AgentRuntime` omits internal messages from provider
context unless the message is the participant's current incoming message:

- The requester resuming its own turn does not see the notice.
- A target agent handling the notice still sees it as its incoming turn.

`resume` and `generate` still select the latest incoming turn regardless of the
flag. This keeps their existing semantics: an internal notice that is genuinely
the participant's latest incoming turn (for example, a target agent that paused
while handling one) is resumed normally. The flag only changes what the model
sees, not which turn is resumed.

### 3.2 Report whether the router delivered a resumed reply

`deliverReplyTo` now returns whether it invoked the target runtime and the
delivery succeeded. The resume paths record this on the router result:

```ts
responseRecipientId?: string; // who the persisted reply is addressed to
replyToDelivered?: boolean;   // the router already delivered it
```

The fields survive the approval registry's terminal-result snapshot.

### 3.3 Do not return a reply the caller already received

`approval_response` omits a resumed reply from its `resumed` payload when all
hold:

1. the caller is a `type: 'user'` participant,
2. the router delivered the reply (`replyToDelivered`), and
3. the reply is addressed to the caller (`responseRecipientId`).

This keeps one delivery for the reported case, while preserving the old
fallback: if router delivery fails, or the caller is a different participant
from the `replyTo` target, the reply is still returned so the connector can
post it.

## 4. Behavior matrix

| Caller         | ReplyTo target | Router delivery | `resumed` reply                   |
| -------------- | -------------- | --------------- | --------------------------------- |
| connector user | same user      | succeeded       | omitted (router delivered)        |
| connector user | same user      | failed          | returned (connector fallback)     |
| connector user | different user | succeeded       | returned (show to approver)       |
| agent          | agent          | any             | returned (agent sees tool result) |

## 5. Tests

- `approval-flow.integration.test.ts`: the agent's resumed provider context
  excludes the approval notice and contains the original task.
- `approval-flow.integration.test.ts`: the resumed reply is omitted when the
  caller is the `replyTo` target and returned when it is not.
- `approval-response-tool.test.ts`: `resumed` dedup for same and different
  targets.
- `AgentRuntime.test.ts`: internal messages are filtered unless incoming.
- `MessageRouter.test.ts`: the approval notice is internal; `resume` still
  selects an internal notice when it is the latest incoming turn.
- `PendingApprovalRegistry.test.ts`: the terminal result preserves the new
  delivery metadata.

## 6. Follow-up: paused text and empty resumed replies (issue #22)

### 6.1 Problems

The assistant turn that pauses for approval often carries the text explaining
the gated call (for example the full SQL). That message is addressed to the
requester, so routed `replyTo` delivery never sees it; the approver gets only
the notice and the card. Separately, the resumed turn may have no further text,
yet `deliverReplyTo` still sends the empty message, which connectors such as
Teams reject with a 400.

### 6.2 Fix

- `dispatchApprovalRequests` finds the paused assistant message — the one whose
  `pending_approval` tool results include the approval IDs being dispatched —
  and prefixes its non-empty content to the routed notice as
  `<paused text>\n\n<approval notice>`. Delivery payload content is sent before
  approval cards, so the approver sees the text above the card, matching a
  connector-started turn. A paused turn with no text produces the notice alone.
- `deliverReplyTo` skips delivery when the response content is empty or
  whitespace, returning `false`.
- `approval_response` treats a whitespace-only resumed response as no reply, so
  `resumed` is omitted instead of carrying `response: ''`.

The empty assistant message remains in the conversation as the resumed turn's
terminal record; only delivery and the `resumed` payload are suppressed.

### 6.3 Behavior matrix

| Case                            | Result                                    |
| ------------------------------- | ----------------------------------------- |
| Paused text + routed approval   | Text delivered, then the card             |
| Paused turn with no text        | Card only (unchanged)                     |
| Resumed turn has text           | Delivered once (unchanged)                |
| Resumed turn has no text        | Nothing delivered, no `resumed` entry     |
| `replyToDelivery: 'all'` target | Text also appears in the notice, as above |

### 6.4 Tests

- `approval-flow.integration.test.ts`: the paused turn's text is delivered with
  the approval notice to the `replyTo` target.
- `approval-flow.integration.test.ts`: an empty resumed reply is neither
  delivered nor returned, while the turn record remains.
- Existing tests still cover a non-empty resumed reply being delivered once.
