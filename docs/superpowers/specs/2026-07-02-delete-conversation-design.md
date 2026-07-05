# Delete Conversation — Design

**Date:** 2026-07-02
**Status:** Proposed
**Scope:** Add the ability to permanently delete a conversation from the chat web interface, cascading to any nested sub-threads (agent-to-agent delegations).

---

## 1. Overview

The chat interface has no way to remove a conversation. Over time the sidebar fills with stale or test threads that the operator can no longer act on but cannot clear. This spec adds a `delete_conversation` management tool and wires two UI affordances (sidebar hover icon + thread header button) behind a confirm dialog.

Deletion is **hard** (the conversation file is removed from storage) and **cascading** (sub-threads spawned by `communicate` delegations are deleted along with their parent). A confirm dialog surfaces the cascade so the operator understands the blast radius before confirming.

---

## 2. Goals

- An operator can permanently delete any conversation from the sidebar or the open thread.
- Deleting a parent conversation also removes its sub-threads; the operator is told how many conversations will be removed.
- After deletion the UI navigates away from a deleted active conversation and refreshes the list.
- The new tool is governed by the existing tool-policy system (default `auto` for the operator).

## 3. Out of Scope

- Bulk delete / multi-select.
- Soft delete / archive / undo.
- Deleting a sub-thread independently of its parent (sub-threads are not standalone list entries today; they are reached through their parent).
- The "Mine / All" toggle behavior — that is functioning as designed and is not changed here.

---

## 4. Backend

### 4.1 `ConversationStore.delete`

The `ConversationStore` interface (`packages/core/src/conversation/ConversationStore.ts`) gains:

```ts
delete(conversationId: string): Promise<void>;
```

Semantics: remove the conversation identified by `conversationId` and **all of its descendants** (sub-threads whose `parentConversationId` is this conversation, recursively). No error is raised if the id does not exist (idempotent). Implementations must not leave orphaned sub-threads.

`FileConversationStore` (`packages/core/src/conversation/FileConversationStore.ts`) implements `delete` by:

1. `load(conversationId)` — if absent, return immediately (idempotent).
2. `listByParent(conversationId)` — collect direct children.
3. Recurse into each child (depth-first) so descendants are deleted before their parent.
4. `storage.delete(this.key(conversationId))` for each conversation.

`Storage.delete` already exists on both `FileStorage` and `MemoryStorage`, so no Storage-layer change is required.

The existing `listByParent` already does the heavy lifting (scanning the conversations directory for children of a given parent); `delete` reuses it for the cascade walk.

### 4.2 `delete_conversation` tool

A new management tool in `packages/core/src/tools/management-tools.ts`:

```ts
export const deleteConversationTool: Tool = {
  name: 'delete_conversation',
  description:
    'Permanently delete a conversation and any nested sub-threads (agent-to-agent delegations).',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'The conversation to delete.' },
    },
    required: ['conversationId'],
  },
  async execute(args: { conversationId: string }, context: ToolContext): Promise<ToolResult> {
    // ... delegates to context.conversationStore!.delete(args.conversationId)
  },
};
```

Returns `{ status: 'success', data: { deleted: true } }`. The cascade count is computed client-side from the loaded `subThreads` for the active conversation (see §5.3); the tool does not need to return the list of deleted ids.

Error handling follows the existing pattern: a thrown error is caught and returned as `{ status: 'error', error: message }`.

`deleteConversationTool` is added to the exported `managementTools` array and to `createManagementTools`.

### 4.3 Tool policy

`delete_conversation` is added to the operator's `auto` policy:

- `packages/core/src/collective/default-participants.ts` — append `'delete_conversation'` to the `MANAGEMENT_TOOLS` array so freshly-seeded operators get it.
- `.legion/collective/participants/operator.json` — add `"delete_conversation": "auto"` to the `tools` map so the existing workspace operator can use it without a reseed.

Other participants do not receive the tool by default; operators can grant it via `set_tool_policy` if needed.

---

## 5. Frontend

### 5.1 `ConversationList.vue` — hover trash icon

Each conversation row gains a trash icon that appears on hover, positioned at the right edge of the row (mirroring the amber approval dot's absolute placement). Clicking the icon:

1. Stops propagation (so the row's `select` handler does not also fire).
2. Emits a new `delete` event with the conversation id.

Sub-thread rows (those with `parentConversationId` set, if/when they appear in the list) are not given a separate delete icon — they are deleted as part of their parent's cascade. This matches §3 (no independent sub-thread delete).

### 5.2 `ConversationThread.vue` — header trash button

The thread header bar (currently showing just the recipient name) gains a trash icon button on the right, visible only when a real conversation is open (`conversationId` is truthy and the mode is not the draft). Clicking emits a new `delete` event with the current `conversationId`.

### 5.3 `ConversationsView.vue` — confirm dialog + handler

`ConversationsView.vue` owns the deletion flow:

1. A `pendingDeleteId` ref holds the id of a conversation awaiting confirmation (set by either `delete` event).
2. When set, a small modal renders: title "Delete conversation?", body text describing the cascade ("This will permanently delete this conversation and any nested delegations. This cannot be undone."), and Cancel / Delete buttons. The Delete button uses the destructive red styling already present in the Tailwind palette.
3. On confirm:
   - `execute('delete_conversation', { conversationId: pendingDeleteId })`.
   - If the deleted id is the active conversation, `router.push('/conversations')` to drop the selection.
   - `loadConversations()` to refresh the sidebar.
   - Clear `pendingDeleteId`.
4. On cancel: clear `pendingDeleteId`, no API call.

The dialog's wording is generic ("and any nested delegations") rather than a precise count, because the sidebar list rows do not carry child-count information and fetching it per-row would be wasteful. The cascade is handled entirely server-side.

---

## 6. Testing

### 6.1 Vitest unit tests

In `packages/core/src/conversation/FileConversationStore.test.ts` (new file, or extend an existing conversation-store test file if one exists):

- `delete` removes a conversation with no children (idempotent on the file system).
- `delete` cascades to direct children (sub-threads whose `parentConversationId` matches).
- `delete` cascades recursively to grandchildren.
- `delete` is idempotent when the id does not exist (no throw, no side effects).
- After cascade delete, `list({ includeSubThreads: true })` no longer returns the parent or any descendant.

In `packages/core/src/tools/management-tools.test.ts`:

- `delete_conversation` returns success and removes the conversation from a subsequent `list_conversations` call.
- `delete_conversation` cascades: a parent with one sub-thread is deleted, and the sub-thread is also gone from `list({ includeSubThreads: true })`.
- `delete_conversation` on a non-existent id still returns success (idempotent).
- `delete_conversation` requires `conversationId` (schema validation / missing-arg error path).

### 6.2 Manual browser verification

After implementation, against the running server:

1. Open the chat interface, identify a conversation with a known sub-thread (e.g. an `assistant→researcher` delegation).
2. Click the trash icon on the sidebar row → confirm dialog appears → confirm.
3. Confirm the conversation disappears from the sidebar and the thread pane returns to the placeholder.
4. Check `.legion/conversations/` on disk: both the parent and child JSON files are gone.
5. Open a conversation via the thread header trash button → confirm → same outcome.
6. Click Cancel on the dialog → no deletion, conversation remains selected.

---

## 7. Affected Files

**Backend:**

- `packages/core/src/conversation/ConversationStore.ts` — add `delete` to interface.
- `packages/core/src/conversation/FileConversationStore.ts` — implement `delete` (recursive cascade via `listByParent`).
- `packages/core/src/tools/management-tools.ts` — add `deleteConversationTool`; register in `managementTools` and `createManagementTools`.
- `packages/core/src/collective/default-participants.ts` — add `'delete_conversation'` to `MANAGEMENT_TOOLS`.
- `.legion/collective/participants/operator.json` — add `"delete_conversation": "auto"`.

**Frontend:**

- `packages/web/src/components/conversations/ConversationList.vue` — hover trash icon; emit `delete`.
- `packages/web/src/components/conversations/ConversationThread.vue` — header trash button; emit `delete`.
- `packages/web/src/views/ConversationsView.vue` — `pendingDeleteId` state, confirm modal, `deleteConversation` handler, list refresh + navigation.

**Tests:**

- `packages/core/src/conversation/FileConversationStore.test.ts` (new or extended) — store-level delete tests.
- `packages/core/src/tools/management-tools.test.ts` — `delete_conversation` tool tests.

---

## 8. Risks & Mitigations

- **Data loss is permanent.** Mitigated by the confirm dialog and by scoping the tool to the operator's `auto` policy by default; other participants do not receive it.
- **Cascade surprises.** The dialog explicitly mentions nested delegations; the operator is not surprised that sub-threads vanish with the parent. We do not offer independent sub-thread delete (out of scope, §3), which avoids partial-tree orphans.
- **Race with active agent.** If an agent is mid-flight in a conversation being deleted, the conversation file is removed but the in-memory `AgentRuntime` may still attempt to append. This is an existing class of race (compaction/prune have the same shape) and is out of scope for this spec; the runtime's append-on-missing-store path already throws `ConversationNotFoundError`, which the agent loop handles as a fatal turn error.
