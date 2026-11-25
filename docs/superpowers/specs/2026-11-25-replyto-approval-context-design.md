# ReplyTo Approval Context and Delivery Dedup Design

**Date:** 2026-11-25
**Status:** Fixes issues #20, #22, and #24
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

### 3.3 Do not return a reply the router already delivered

`approval_response` omits a resumed reply from its `resumed` payload whenever
the router delivered it (`replyToDelivered`), regardless of who calls. The
router has already delivered it to the `replyTo` target and persisted it in
the conversation, so returning it would let a connector post it a second time.

The original condition also required the caller to be the `replyTo` target.
That left a duplicate when an approver in a different participant clicked the
card in the same conversation: the router delivered the reply, and the
connector posted the returned copy into the card's conversation as well (see
section 7).

If router delivery did not happen (`replyToDelivered` is false), the reply is
still returned so the connector can post it as a fallback.

## 4. Behavior matrix

| Caller         | ReplyTo target | Router delivery | `resumed` reply               |
| -------------- | -------------- | --------------- | ----------------------------- |
| connector user | same user      | succeeded       | omitted (router delivered)    |
| connector user | same user      | failed          | returned (connector fallback) |
| connector user | different user | succeeded       | omitted (router delivered)    |
| connector user | different user | failed          | returned (connector fallback) |
| agent          | any            | succeeded       | omitted (router delivered)    |
| agent          | any            | failed          | returned (caller sees result) |

## 5. Tests

- `approval-flow.integration.test.ts`: the agent's resumed provider context
  excludes the approval notice and contains the original task.
- `approval-flow.integration.test.ts`: the resumed reply is omitted whenever
  the router delivered it and returned when delivery failed.
- `approval-response-tool.test.ts`: `resumed` dedup for same and different
  targets, including an agent caller.
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

## 7. Follow-up: cross-caller resumed-reply dedup (issue #24)

### 7.1 Problem

The dedup from section 3.3 only fired when the approval caller was also the
`replyTo` target. A group chat is paired as its own participant, so a human
approver is a different participant. When that human approved the card in the
group chat, both paths posted the resumed reply there: the router delivered it
to the group participant (the `replyTo` target), and `approval_response`
returned it in `resumed` because the caller was not the recipient. The Teams
connector then posted the returned copy into the conversation where the card
was clicked — the same group chat.

### 7.2 Fix

`approval_response` now omits a resumed reply from `resumed` whenever the
router delivered it (`replyToDelivered`), with no caller-type or recipient
comparison. The router already delivered the reply to the participant that the
turn was addressed to. Successor approval cards are still returned in
`resumed` so the connector can post them where the card was clicked.

If router delivery fails or is skipped, `replyToDelivered` is false and the
reply is still returned as the connector fallback.

### 7.3 Tests

- `approval-response-tool.test.ts`: a reply delivered to a different target is
  omitted; the same holds for an agent caller; a reply with no delivery flag is
  still returned.
- `approval-flow.integration.test.ts`: an approver who is not the `replyTo`
  target does not receive the resumed reply in `resumed` after the router
  delivers it.
