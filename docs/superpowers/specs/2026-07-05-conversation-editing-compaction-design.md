# Conversation Editing, Pruning, Compaction & Branch Navigation

**Date:** 2026-07-05  
**Status:** Approved  
**Scope:** Expose the conversation tree operations defined in `docs/conversation-tree-spec.md` to the frontend through new management tools and updated UI components.

---

## Overview

The conversation tree data model (schemaVersion 2.0) and all core operations (`editMessage`, `pruneMessage`, `compactRange`, `getActiveChain`) are already implemented in `packages/core/src/conversation/conversation-ops.ts`. No new storage-layer type changes are needed — `MessageData` on disk is unchanged. The web-facing response type gains an optional `alternates` field (assembled at query time), and `validateConversation` gets a narrowed root invariant to support compacting to the start of a conversation.

What is missing:

1. **Management tools** — the operations are not yet exposed as callable tools
2. **Frontend UI** — no way for a user to trigger edit, prune, compact, or branch-switch from the web interface

This design adds both layers.

---

## Backend: New Management Tools

All tools are added to `packages/core/src/tools/management-tools.ts` and registered in the `managementTools[]` array. All follow the same error-handling conventions as existing tools.

---

### `edit_message`

Rewrites the content of a past message, creating a new branch node per the tree spec.

**Args:** `{ conversationId: string, messageId: string, newContent: string }`

**Flow:**

1. Load conversation from store
2. Call `editMessage(conversation, messageId, newContent)` — creates a new node with `editOf`, marks original `superseded`
3. Save updated conversation
4. Return `{ newMessageId: string, activeBranchHead: string }`

Does not trigger agent re-run. Re-run is initiated separately by the frontend calling `generate`.

---

### `prune_message`

Removes a message from the active chain while preserving it in storage.

**Args:** `{ conversationId: string, messageId: string }`

**Flow:**

1. Load conversation from store
2. Call `pruneMessage(conversation, messageId, context.participant.id)` — sets `status: "pruned"`, walks `activeBranchHead` back to parent if needed
3. Save updated conversation
4. Return `{ activeBranchHead: string }`

---

### `generate`

Triggers the agent runtime to respond to the current `activeBranchHead` without adding a new user message. This is the mechanism for "re-run after edit" and is composable into a "regenerate" workflow.

**Args:** `{ conversationId: string, agentId: string }`

**Flow:**

1. Look up the agent participant by `agentId` in the collective
2. Trigger the agent's runtime against the current `activeBranchHead` of the conversation (same entry point as when a `communicate` message is delivered, but without prepending a new message node)
3. Agent generates a response appended to the active chain; the `message:delivered` event fires when complete (same as `communicate`)
4. Return `{ status: 'success' }` immediately after triggering — the frontend's existing `message:delivered` listener handles reload, no need to await the response

**Emergent capability — Regenerate:** `prune_message` on the last assistant message (walks head back to the preceding user message) followed by `generate` produces a fresh response to the same prompt. No dedicated regenerate tool is needed.

---

### `compact_conversation`

Collapses a span of messages into a summary node using a Legion agent for summarisation, staying fully within Legion's participant/communicate model.

**Args:**

```ts
{
  conversationId: string,
  messageIds: string[],       // ordered IDs of messages to compact
  agentId?: string,           // which participant performs summarisation
  instruction?: string        // overrides the default summarisation prompt
}
```

**Flow:**

1. Load conversation from store
2. Format the target messages as a readable transcript (role: content, one per line)
3. Build prompt using `instruction` if provided, otherwise the default:
   > "Summarise the following conversation segment concisely, preserving key decisions, facts, and outcomes."
4. Call `agentId` via the MessageRouter sync communicate pathway (same mechanism as the `communicate` tool's blocking request-response) with the formatted transcript + prompt
5. Use the agent's reply content as `summaryContent`
6. Call `compactRange(conversation, messageIds, summaryContent)` — creates summary node, marks compacted messages, rewires parentId chain
7. Save updated conversation
8. Return `{ summaryMessageId: string, activeBranchHead: string }`

**If `agentId` is not specified** and no workspace default is configured, returns `{ status: 'error', error: 'No summarisation agent specified' }`. The frontend prevents submitting the compact dialog without an agent selected.

---

### `switch_branch`

Switches the active branch to a sibling node (same `parentId`). Handles both edit branches (superseded siblings) and compaction undo (compacted siblings of a summary node).

**Args:** `{ conversationId: string, messageId: string }`

**Flow:**

1. Load conversation, verify `messageId` exists
2. Determine if target is a **compacted** node (the sibling is a compacted message, meaning the active chain has a summary node at this position):
   - If yes (**uncompact path**):
     - Find the summary node whose `compacts` array contains `messageId`
     - Mark all messages in `compacts` as `status: "active"`
     - Mark the summary node as `status: "superseded"`
     - Repoint the message whose `parentId === summaryNode.id` back to the last compacted message's ID
     - If `activeBranchHead === summaryNode.id` (summary was the leaf — i.e. the compacted span reached the end of the conversation), set `activeBranchHead` to the last message in `compacts`. Otherwise leave `activeBranchHead` unchanged — the existing head is already beyond the summary node, and the chain now routes correctly through the restored messages.
   - If no (**edit branch path**):
     - Find the current active sibling (the node with the same `parentId` as `messageId` that is currently `status: "active"`)
     - Mark that sibling as `status: "superseded"`
     - Mark `messageId` as `status: "active"`
     - Walk forward from `messageId`: find all descendants whose `status === "active"` by scanning for messages with `parentId === messageId`, then their children, until no more active children exist. Set `activeBranchHead` to the deepest such descendant, or to `messageId` itself if none exist.
3. Save updated conversation
4. Return `{ activeBranchHead: string }`

**Why this works for compaction:** `compactRange` sets the summary node's `parentId = first.parentId`, making the summary and the original first compacted message siblings. `get_conversation` surfaces this as an alternate on the summary bubble. The branch navigator (`‹ ›`) on a summary node therefore lets the user switch back to the original message chain — no separate uncompact tool needed.

---

## Extended `get_conversation` Response

The existing `get_conversation` tool is updated to include alternate versions for messages in the active chain.

For each message returned in the active chain, the tool inspects `conversation.messages` for siblings — other nodes with the same `parentId` that are not on the current active chain (status `superseded`, `compacted`, or `active` on a different branch). This means summary nodes surface the original compacted message chain as an alternate, enabling undo via the branch navigator.

If siblings exist, the message response includes:

```ts
alternates?: {
  id: string,
  content: string,   // preview text (may be truncated for display)
  timestamp: string
}[]
```

Alternates are sorted by `timestamp` ascending. For a summary node, the single alternate is the original first compacted message — `switch_branch` on that ID triggers the uncompact path which restores the full chain.

This field is assembled at query time and is never stored on disk. It does not appear on `MessageData` in storage — only in the `get_conversation` tool response. The web-facing `MessageData` type (used by the frontend composable) is extended with this optional field.

---

## Frontend

### `MessageBubble.vue` — ⋮ button, context menu, edit state, prune confirm, branch navigator

**Metadata row** (below bubble, alongside sender name) gains two new elements:

**1. Branch navigator** — shown only when `message.alternates` is non-empty:

```
‹  2/2  ›
```

- `alternates` is sorted by `timestamp` ascending — index 0 is the oldest version, last is newest
- The current message is always the one on the active chain; its position in the full ordered list (current + alternates) determines the `N/M` count
- `‹` calls `switchBranch(alternates[currentIndex - 1].id)`, then reloads. Disabled at oldest version.
- `›` calls `switchBranch(alternates[currentIndex + 1].id)`, then reloads. Disabled at newest version.

**2. ⋮ context menu trigger** — always visible, small pill button. Opens a dropdown menu:

| Item            | Action                                                     |
| --------------- | ---------------------------------------------------------- |
| ✏ Edit          | Enter inline edit state                                    |
| ✕ Prune         | Show inline prune confirm                                  |
| _(divider)_     |                                                            |
| ⊞ Compact above | Open compact dialog, pre-range set to start → this message |

**Inline edit state:**

The bubble's content area is replaced in-place with a `<textarea>` pre-filled with `message.content`. Below the textarea:

- **Save & re-run** (primary, cyan) — calls `editMessage`, then `generate(recipientId)`, then reloads; thinking indicator shown immediately
- **Save only** (secondary) — calls `editMessage`, reloads; an `edited` badge appears on the new bubble
- **Cancel** (ghost) — restores original bubble, no changes

The `edited` badge is shown on any message where `message.editOf` is set (i.e. it is a replacement, not the original).

**Inline prune confirm:**

The context menu swaps its content to:

- **Confirm prune** (red text)
- **Cancel**

Clicking "Confirm prune" calls `pruneMessage(message.id)` and reloads.

---

### `ConversationThread.vue` — header compact button, compact dialog

A **⊞ Compact** button is added to the conversation header alongside the existing delete button. Clicking it opens the compact dialog with the full active chain as the pre-selected range.

**`CompactDialog.vue`** (new component):

- Displays: "Compacting N messages"
- Range preview: first message (role + content truncated) · · · M more · · · last message
- **Compact** (primary) and **Cancel** buttons
- **Advanced ▾** collapsed section containing:
  - Agent selector — dropdown populated from `list_participants` filtered to `type: "agent"` participants only, required before Compact is enabled
  - Instruction textarea — pre-filled with the default summarisation prompt, fully editable

The "Compact above" context menu item sets the range to `[firstMessageId … thisMessageId]` and opens the same dialog.

---

### `useConversation.ts` — new composable functions

Five new functions added, all following the existing pattern of `execute()` → `load()`:

```ts
async function editMessage(messageId: string, newContent: string): Promise<string>;
// returns newMessageId; caller decides whether to then call generate()

async function generate(agentId: string): Promise<void>;
// triggers agent; markSent()-style thinking indicator shown immediately

async function pruneMessage(messageId: string): Promise<void>;

async function compactConversation(
  messageIds: string[],
  agentId?: string,
  instruction?: string,
): Promise<void>;

async function switchBranch(messageId: string): Promise<void>;
```

---

## Interaction Flows

### Edit → Save & re-run

1. User clicks ⋮ → Edit on a user message
2. Bubble becomes textarea; user modifies content
3. User clicks "Save & re-run"
4. `editMessage(messageId, newContent)` — returns `newMessageId`; messages below original disappear from active chain
5. `generate(recipientId)` — agent responds from new head; thinking indicator shown
6. `load()` — conversation reloaded; edited badge visible, agent response appears

### Edit → Save only

Steps 1–4 same, step 5 skipped. Edited badge shown, no agent loop triggered.

### Regenerate (emergent)

1. User clicks ⋮ → Prune on the last assistant message
2. Confirm prune — head moves to preceding user message
3. User clicks ⋮ → (or a future "Regenerate" shortcut) which calls `generate(agentId)`
4. Agent produces a fresh response

### Compact (from header)

1. User clicks ⊞ Compact in header
2. Compact dialog opens, full active chain pre-selected
3. User optionally expands Advanced, selects agent, adjusts instruction
4. User clicks Compact
5. `compactConversation(allActiveIds, agentId, instruction?)`
6. Agent summarises; summary node replaces span in active chain; `load()` reloads

### Branch switch

1. User sees `‹ 2/2 ›` on an edited message
2. Clicks `‹`
3. `switchBranch(alternateId)` — `activeBranchHead` moves to the alternate branch
4. `load()` — full conversation reloads showing the previous version and its descendants

---

## Summary Node Display

Summary nodes (`type: "summary"`) appear in the active chain in place of the compacted messages. They must be visually distinct from regular bubbles so the user understands the content is compressed.

Rendering in `MessageBubble.vue`:

- A **"Summary"** label/badge above the bubble content (e.g. small pill: `⊞ Summary`)
- Slightly different bubble background (e.g. `bg-navy-700` with a left accent border in cyan) to distinguish from regular messages
- The branch navigator (`‹ 1/2 ›`) appears in the metadata row as with edited messages — clicking `‹` invokes `switch_branch` with the original first compacted message, which triggers the uncompact path

The summary bubble's content is the summarisation text produced by the agent.

---

## Compacting to the Start of the Conversation

Compaction may include the first message (the root, `parentId: null`). In this case both the summary node and the original first compacted message will have `parentId: null`.

The current `validateConversation` invariant ("exactly one root") must be updated to: **exactly one non-compacted message has `parentId: null`**. Compacted messages are permitted to be roots; they are no longer part of the active chain and do not affect traversal.

This update is applied to `conversation-ops.ts:validateConversation`.

---

## UI Sync

All composable operations follow the same pattern for keeping the UI in sync:

- **Synchronous ops** (`editMessage`, `pruneMessage`, `switchBranch`, `compactConversation`): call `execute()` → await result → call `load()`. The conversation reloads immediately after the tool completes.
- **`generate`**: calls `execute('generate', ...)` then relies on the existing `message:delivered` SSE event → `load()` path, identical to how `communicate` works today. The thinking indicator is shown immediately (via `markSent()`-style flag) while the agent loop runs.

No additional event types are needed.

---

## What Is Not In Scope

- **Automated compaction** — no middleware hooks, no auto-trigger on context-window threshold
- **Regenerate shortcut** — emergent from prune + generate; no dedicated UI button in this design
- **Per-edit agent override** — re-run always uses the conversation's existing recipient; no per-edit agent selector
- **Prune recovery UI** — pruned nodes are preserved in storage but not surfaced in the UI
- **Compaction of sub-threads** — only the top-level conversation active chain is targeted
- **Dedicated uncompact tool** — undo is handled via `switch_branch` on the summary node's branch navigator

---

## Files Touched

| File                                                               | Change                                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/conversation/conversation-ops.ts`               | Update `validateConversation` root invariant to allow compacted messages with `parentId: null`                                |
| `packages/core/src/tools/management-tools.ts`                      | Add `edit_message`, `prune_message`, `compact_conversation`, `generate`, `switch_branch`; register all in `managementTools[]` |
| `packages/core/src/tools/management-tools.test.ts`                 | Tests for all five new tools                                                                                                  |
| `packages/web/src/components/conversations/MessageBubble.vue`      | ⋮ button, context menu, edit state, prune confirm, branch navigator                                                           |
| `packages/web/src/components/conversations/MessageBubble.test.ts`  | Tests for new UI states                                                                                                       |
| `packages/web/src/components/conversations/ConversationThread.vue` | Header compact button, wire compact dialog                                                                                    |
| `packages/web/src/components/conversations/CompactDialog.vue`      | New compact confirmation component                                                                                            |
| `packages/web/src/composables/useConversation.ts`                  | Five new functions                                                                                                            |
| `packages/web/src/composables/useConversation.test.ts`             | Tests for new composable functions                                                                                            |
