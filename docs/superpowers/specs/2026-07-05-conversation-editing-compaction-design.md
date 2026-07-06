# Conversation Editing, Pruning, Compaction & Branch Navigation

**Date:** 2026-07-05  
**Status:** Approved  
**Scope:** Expose the conversation tree operations defined in `docs/conversation-tree-spec.md` to the frontend through new management tools and updated UI components.

---

## Overview

The conversation tree data model (schemaVersion 2.0) and all core operations (`editMessage`, `pruneMessage`, `compactRange`, `getActiveChain`) are already implemented in `packages/core/src/conversation/conversation-ops.ts`. No new storage or type changes are needed.

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

Switches the active branch to a different version of a message (a sibling node with the same `parentId`).

**Args:** `{ conversationId: string, messageId: string }`

**Flow:**
1. Load conversation, verify `messageId` exists
2. Walk forward from `messageId` to find the deepest active-status descendant on that branch (if any exist from a prior switch)
3. Set `activeBranchHead` to that leaf (or `messageId` itself if no descendants)
4. Save updated conversation
5. Return `{ activeBranchHead: string }`

---

## Extended `get_conversation` Response

The existing `get_conversation` tool is updated to include alternate versions for messages in the active chain.

For each message returned in the active chain, the tool inspects `conversation.messages` for siblings — other nodes with the same `parentId` that are not on the current active chain (status `superseded` or `active` on a different branch).

If siblings exist, the message response includes:

```ts
alternates?: {
  id: string,
  content: string,
  timestamp: string
}[]
```

This field is assembled at query time and is never stored on disk. It does not appear on `MessageData` in storage — only in the `get_conversation` tool response. The web type `MessageData` (as used by the frontend) is extended with this optional field.

---

## Frontend

### `MessageBubble.vue` — ⋮ button, context menu, edit state, prune confirm, branch navigator

**Metadata row** (below bubble, alongside sender name) gains two new elements:

**1. Branch navigator** — shown only when `message.alternates` is non-empty:

```
‹  2/2  ›
```

- `‹` calls `switchBranch(alternate.id)`, then reloads. Disabled (greyed) at oldest version.
- `›` navigates toward the newest version. Disabled at newest.
- The count reflects position among all versions (original + edits).

**2. ⋮ context menu trigger** — always visible, small pill button. Opens a dropdown menu:

| Item | Action |
|---|---|
| ✏ Edit | Enter inline edit state |
| ✕ Prune | Show inline prune confirm |
| *(divider)* | |
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
  - Agent selector — dropdown populated from `list_participants` (all participants), required before Compact is enabled
  - Instruction textarea — pre-filled with the default summarisation prompt, fully editable

The "Compact above" context menu item sets the range to `[firstMessageId … thisMessageId]` and opens the same dialog.

---

### `useConversation.ts` — new composable functions

Five new functions added, all following the existing pattern of `execute()` → `load()`:

```ts
async function editMessage(messageId: string, newContent: string): Promise<string>
// returns newMessageId; caller decides whether to then call generate()

async function generate(agentId: string): Promise<void>
// triggers agent; markSent()-style thinking indicator shown immediately

async function pruneMessage(messageId: string): Promise<void>

async function compactConversation(
  messageIds: string[],
  agentId?: string,
  instruction?: string,
): Promise<void>

async function switchBranch(messageId: string): Promise<void>
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

## What Is Not In Scope

- **Automated compaction** — no middleware hooks, no auto-trigger on context-window threshold
- **Regenerate shortcut** — emergent from prune + generate; no dedicated UI button in this design
- **Per-edit agent override** — re-run always uses the conversation's existing recipient; no per-edit agent selector
- **Prune recovery UI** — pruned nodes are preserved in storage but not surfaced in the UI
- **Compaction of sub-threads** — only the top-level conversation active chain is targeted

---

## Files Touched

| File | Change |
|---|---|
| `packages/core/src/tools/management-tools.ts` | Add `edit_message`, `prune_message`, `compact_conversation`, `generate`, `switch_branch`; register all in `managementTools[]` |
| `packages/core/src/tools/management-tools.test.ts` | Tests for all five new tools |
| `packages/web/src/components/conversations/MessageBubble.vue` | ⋮ button, context menu, edit state, prune confirm, branch navigator |
| `packages/web/src/components/conversations/MessageBubble.test.ts` | Tests for new UI states |
| `packages/web/src/components/conversations/ConversationThread.vue` | Header compact button, wire compact dialog |
| `packages/web/src/components/conversations/CompactDialog.vue` | New compact confirmation component |
| `packages/web/src/composables/useConversation.ts` | Five new functions |
| `packages/web/src/composables/useConversation.test.ts` | Tests for new composable functions |
