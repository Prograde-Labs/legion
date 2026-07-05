# Chat Interface Design — Plan 12

**Date:** 2026-06-17  
**Status:** Approved  
**Scope:** Extend the Conversations view into a full chat interface that lets the operator send messages to agents, receive responses in real-time, and handle approval requests inline.

---

## 1. Overview

The Conversations view is transformed from a read-only monitoring surface into the operator's primary chat interface. The Events view remains the firehose for auditing. The Conversations view becomes "your conversations" — where you talk to agents, watch them work, and approve or deny tool calls as they arise.

This is Plan 12. It builds entirely on infrastructure already implemented in Plans 1–11. The only backend primitive change beyond tool/type extensions is participant-scoped event filtering on the WebSocket bridge.

---

## 2. Goals

- Send messages to any active agent from the web UI
- See agent responses appear in real-time as chat bubbles
- Handle `pending_approval` tool results inline in the conversation thread
- Start new conversations via a clean draft state
- Filter the conversation list to "Mine" (conversations the operator participates in) or "All" (full monitoring view)
- Maintain a clean composable architecture that separates transport, event subscription, and conversation state
- Scope server-sent events to the authenticated participant — no user receives another participant's private conversation events

---

## 3. Out of Scope (Future)

- Participant view shortcut to start a conversation with a specific agent (deferred, low LOE once Plan 12 is done)
- "New messages" nudge when scrolled up in a long thread (good UX improvement, not needed for MVP)
- Server-side event subscription protocol (client declares which event types / conversationIds it wants) — client-side filtering within the participant-scoped stream is sufficient at current volume
- Global sidebar badge for pending approvals across all conversations (amber dot on list item is sufficient for now)
- Dashboard / overview screen

---

## 4. Backend Changes

### 4.1 `communicate` in operator tool policy

`communicate` is added to the bootstrap operator's allowed tools in `default-participants.ts`. It is not an agent-only tool — it is the universal message-passing primitive for all participants. The operator calling it through `POST /api/execute` sends a message as themselves into a conversation.

The operator always calls `communicate` with `replyTo` set to their own `participantId`. This triggers fire-and-forget mode — `send` returns immediately with `{ conversationId, status: 'dispatched' }` — while the agent processes asynchronously and the response arrives via the WebSocket event stream.

### 4.2 `ConversationMeta.participants` field

`ConversationMeta` in `@legion/types` gains a `participants: string[]` field — the set of unique participant IDs that appear as either `senderId` or `recipientId` on any message in that conversation.

Both fields must be scanned. A conversation where Atlas sent a fire-and-forget to the operator (`replyTo: 'operator'`) must appear in the operator's "Mine" list, because the operator's ID appears as `recipientId` on the reply message.

`FileConversationStore.list()` populates this field by scanning the messages map of each stored conversation when building `ConversationMeta`.

### 4.3 `list_conversations` participantId filter

The `list_conversations` management tool gains an optional `participantId` parameter. When provided, only conversations where that participant ID appears in `ConversationMeta.participants` are returned. When absent, all conversations are returned (existing "All" behaviour).

The web UI passes the operator's own `participantId` for "Mine" mode and omits it for "All" mode. Filtering always happens on the backend — the client never receives more data than it needs.

### 4.4 Participant-scoped WebSocket event filtering

Currently `WebConnector` registers an `onAny` handler per authenticated socket that forwards every EventBus event to every connected client unconditionally. With multiple users connected this is both a privacy problem (user B receives user A's conversation events) and a scalability problem (event volume multiplies across all clients).

An `isRelevantToParticipant(event, payload, participantId)` function is added to `WebConnector`. It is called inside the `onAny` handler before `socket.send` — if it returns `false` the event is silently dropped for that socket.

Relevance rules by event type:

| Event                  | Relevant when                                               |
| ---------------------- | ----------------------------------------------------------- |
| `process:ready`        | Always                                                      |
| `conversation:created` | Always                                                      |
| `participant:active`   | Always                                                      |
| `participant:retired`  | Always                                                      |
| `error`                | Always                                                      |
| `message:sent`         | `payload.senderId === pid` OR `payload.recipientId === pid` |
| `message:delivered`    | `payload.recipientId === pid`                               |
| `tool:call`            | `payload.participantId === pid`                             |
| `tool:result`          | `payload.participantId === pid`                             |
| `iteration`            | `payload.participantId === pid`                             |
| `approval:requested`   | `payload.requesterId === pid` OR participant is an operator |
| `approval:resolved`    | `payload.requesterId === pid` OR participant is an operator |

Approval events are broadcast to all operators because operators are the approval authority. The `isRelevantToParticipant` function receives an `isOperator: boolean` flag resolved at auth time from the `Collective` — no per-event authority lookup needed.

**Acknowledged debt:** This is a domain-driven `switch` over event names that must be updated whenever a new event type is added to `LegionEventMap`. The correct long-term solution is event metadata — each event type declaring its own relevance predicate, or events carrying explicit `scope` fields — so the routing logic doesn't need to know each event's payload shape. This is noted as a future improvement.

---

## 5. Composable Architecture

The existing composable layer is refactored into three distinct layers. A known memory leak in `ParticipantsView` (where `subscribe()` return value is discarded and no `onUnmounted` cleanup is registered) is fixed as part of this refactor.

### 5.1 `useWebSocket`

Extracted from the current `useEventStream`. Owns the raw WebSocket connection lifecycle:

- Connection establishment and JWT auth handshake (`{ type: 'auth', token }`)
- Exponential backoff reconnect (1s → 30s max)
- Module-level singleton — one connection shared across the entire app
- Exposes `onMessage(handler): () => void` for raw message subscription

This is a pure transport layer. It knows nothing about event types or conversation state.

### 5.2 `useEventStream`

Refactored to subscribe to `useWebSocket` rather than owning the WebSocket directly. Provides typed, filtered event subscriptions:

```ts
const { on } = useEventStream();
on('message:sent', handler); // all message:sent events
on('message:sent', handler, { conversationId }); // filtered to one conversation
on('iteration', handler, { conversationId });
```

**Lifecycle safety:** when called inside a Vue component's `setup()` context, subscriptions are automatically cleaned up on `onUnmounted` — the composable detects the component context via `getCurrentInstance()` and registers cleanup itself. Callers do not need to manage unsubscribe closures manually. This eliminates the class of leak present in `ParticipantsView` today.

The Events view uses `useEventStream` directly with no filters (it wants the full participant-scoped stream). `useConversation` uses it with a `conversationId` filter.

### 5.3 `useConversation(id: string | null)`

The stateful composable for a single conversation thread. Accepts a `conversationId` or `null` for the draft state.

When given a real `conversationId`:

1. Loads the full conversation via `get_conversation` tool through `POST /api/execute` on mount — this is the authoritative initial state, not the event stream
2. Subscribes to `useEventStream` filtered to that `conversationId` for: `message:sent`, `iteration`, `tool:call`, `tool:result`, `approval:requested`, `approval:resolved`
3. Appends incoming events to local state — the event stream is a source of updates only, never a source of truth

When `id` is `null` (draft state): returns empty state, no subscriptions.

**Thinking indicator logic:**

- Show animated "thinking..." when: the user just sent a message in this tab, OR an `iteration` event fires for this `conversationId`
- Hide thinking when: `message:sent` (assistant role) fires, OR `approval:requested` fires for this `conversationId`
- On initial load: if the last message in the active chain is `role: 'user'` with no subsequent assistant reply and no `pending_approval` tool results, show a static indeterminate "..." indicator — the agent may be processing or may have died mid-flight; we cannot distinguish after a restart

---

## 6. Routes and Navigation

| Route                | State         | Description                                 |
| -------------------- | ------------- | ------------------------------------------- |
| `/conversations`     | list only     | No conversation selected                    |
| `/conversations/new` | draft         | Empty thread, "To:" header, composer active |
| `/conversations/:id` | active thread | Chat view for existing conversation         |

The "Mine / All" toggle and "+ New" button live in the conversation list header. "+ New" navigates to `/conversations/new`.

---

## 7. New Conversation Flow (`/conversations/new`)

The thread pane renders in draft state:

- A "To:" header bar sits above the empty thread area with a `SearchableCombobox` populated by `list_participants` (active agents only)
- The thread area shows an empty state: a subtle icon and "Send a message to start the conversation"
- The composer is active immediately — the user can type before selecting a recipient
- The Send button is disabled until both a recipient is selected AND the message field is non-empty
- The composer placeholder reads "Type a message..."

On Send:

1. Call `communicate` via `POST /api/execute` with `{ to: recipientId, message, replyTo: operatorParticipantId }`
2. The response returns immediately with `{ conversationId, status: 'dispatched' }`
3. Navigate to `/conversations/<conversationId>`
4. `useConversation` loads the thread (the sent message is already persisted) and shows the thinking indicator immediately

---

## 8. Chat Thread Rendering

### 8.1 Bubble layout

Messages render as bubbles:

- **Your messages** (operator): right-aligned, cyan background (`bg-cyan-700` / `bg-cyan-600`), white text, `border-radius: 12px 12px 3px 12px`
- **Agent messages**: left-aligned, slate background (`bg-navy-800` / `bg-slate-800`), light text, `border-radius: 12px 12px 12px 3px`
- Each bubble shows sender name and relative timestamp beneath it
- Tool call blocks and approval cards appear inline beneath the agent bubble they belong to, within the same agent turn, before the next bubble

### 8.2 Tool call blocks

Existing `ToolCallBlock` component rendering is preserved — compact, shows tool name and status. In chat mode these sit between agent bubbles within the same turn rather than in a separate sub-thread block.

### 8.3 Approval cards (`ApprovalCard.vue`)

Rendered for any tool result with `status: 'pending_approval'`. Shows:

- Tool name and formatted args (collapsed, expandable)
- Allow / Deny buttons
- Optional `message` text field — always visible, encouraged for Deny, optional for Allow
- On submission: calls `approval_response` tool via `useExecute`, passes `approvalId`, `decision`, and `message`
- After resolution: the card updates to show the decision outcome (approved / denied + reason) rather than disappearing — the conversation history must remain readable

### 8.4 Thinking indicator

A subtle animated "..." appears as a left-aligned pseudo-bubble beneath the last agent bubble when the agent is processing. Hidden when idle. A static non-animated "..." appears when the last message is a user message with no reply and no events have fired since page load (indeterminate post-restart state).

---

## 9. New Components

### `MessageBubble.vue`

Single message bubble. Props: `message: MessageData`, `isOwn: boolean`. Renders content, sender, timestamp. Slots for tool call blocks and approval cards beneath the bubble.

### `ApprovalCard.vue`

Inline approval request. Props: `toolResult: ToolCallResult`, `approvalId: string`, `toolName: string`, `args: Record<string, unknown>`. Emits resolution via `useExecute`. Shows decision outcome after resolution.

### `SearchableCombobox.vue`

Reusable filtered dropdown. Props: `options: { value: string, label: string }[]`, `placeholder: string`. Emits `select(value)`. Filters options as the user types. Keyboard navigable. Used for recipient picker; reusable elsewhere across the app.

---

## 10. Modified Components

### `ConversationsView.vue`

- Handles `/conversations/new` route (draft state)
- Passes `mode: 'read' | 'chat'` to `ConversationThread` — chat mode when the operator is a participant or it is a draft; read mode when viewing "All" conversations the operator is not part of
- Manages `useConversation` lifecycle (mount/unmount on route change)

### `ConversationList.vue`

- "+ New" button in header navigates to `/conversations/new`
- "Mine / All" toggle — Mine passes `participantId` to `list_conversations`, All omits it
- Amber dot indicator on list items where the last message has a `pending_approval` tool result

### `ConversationThread.vue`

- Accepts `mode` prop
- In chat mode: renders `MessageBubble` components instead of flat message rows, shows composer at bottom, shows thinking indicator, wires `useConversation`
- In read mode: existing rendering unchanged

---

## 11. Composer

A `textarea` with auto-expand (up to ~4 lines), then scrolls. Send button to the right. Keyboard shortcut: `Ctrl+Enter` / `Cmd+Enter` to send (Enter for newlines). Placeholder is contextual: "Message [agent name]..." when a conversation is open, "Type a message..." on new draft.

---

## 12. Thinking Indicator Triggers

| Condition                                               | Indicator shown                                |
| ------------------------------------------------------- | ---------------------------------------------- |
| User just sent a message in this tab                    | Animated "thinking..."                         |
| `iteration` event fires for this `conversationId`       | Animated "thinking..."                         |
| `message:sent` (assistant) fires                        | Hide indicator                                 |
| `approval:requested` fires                              | Hide indicator (approval card appears instead) |
| Initial load: last message is user, no reply, no events | Static indeterminate "..."                     |
| Initial load: last message is assistant                 | No indicator                                   |

---

## 13. Testing

### Unit / component tests

- `useWebSocket` — connection lifecycle, reconnect backoff, auth handshake
- `useEventStream` — filter parameter behaviour, auto-cleanup on unmount, no handler leak across multiple mounts
- `useConversation` — initial load, event appending, thinking indicator state transitions
- `isRelevantToParticipant` — all event types, operator flag, boundary cases
- `SearchableCombobox` — filtering, keyboard navigation, selection
- `ApprovalCard` — renders pending state, submits correctly, shows outcome after resolution
- `MessageBubble` — own vs other alignment, timestamp formatting

### E2E tests (new specs in `packages/e2e`)

- Send a message to an agent, see thinking indicator, see response appear in thread
- Start a new conversation via "+ New", pick recipient, send first message, redirect to conversation
- Approve a tool call — card updates to approved state, agent continues
- Deny a tool call with a reason — card updates to denied state with reason shown
- Mine / All toggle — Mine shows only operator conversations, All shows everything
- Amber dot appears on conversation with pending approval
- Thinking indicator appears when `iteration` event fires from another tab (simulate via API)

---

## 14. Future Improvements (Noted, Not Scheduled)

- "New messages" nudge button when scrolled up in a long thread
- Server-side event subscription protocol — client declares which event types / conversationIds it wants, eliminating remaining client-side fan-out entirely
- Event metadata / scope fields on `LegionEventMap` so `isRelevantToParticipant` can be replaced with a data-driven routing layer rather than a domain switch
- Global sidebar badge for pending approvals
- Shortcut from Participants view to start a conversation with a specific agent
- `message:processing` event emitted by `MessageRouter` for a clean "started" signal (currently inferred from `iteration` i=0)
