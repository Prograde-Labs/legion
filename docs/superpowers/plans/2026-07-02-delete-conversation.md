# Delete Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ability to permanently delete a conversation (and its nested sub-threads) from the chat web interface, via a confirm dialog triggered from the sidebar list or the thread header.

**Architecture:** Backend first: a new `delete` method on `ConversationStore` (recursive cascade via existing `listByParent`) plus a `delete_conversation` management tool that delegates to it. Frontend second: two new UI affordances (hover trash icon on list rows, trash button in the thread header) both emit `delete` up to `ConversationsView`, which owns the confirm dialog and the actual `execute('delete_conversation', ...)` call. After deletion the view refreshes the sidebar list and drops the active selection if it was deleted.

**Tech Stack:** TypeScript (ESM), Vitest, Vue 3 `<script setup>` + Tailwind, `@vue/test-utils` for component tests.

**Spec:** `docs/superpowers/specs/2026-07-02-delete-conversation-design.md`

---

## File Structure

**Backend (create/modify):**

- `packages/core/src/conversation/ConversationStore.ts` — add `delete` to the interface.
- `packages/core/src/conversation/FileConversationStore.ts` — implement recursive cascade delete.
- `packages/core/src/conversation/FileConversationStore.test.ts` — add delete tests.
- `packages/core/src/tools/management-tools.ts` — add `deleteConversationTool`; register it in `managementTools` and `createManagementTools`.
- `packages/core/src/tools/management-tools.test.ts` — add `delete_conversation` tool tests.
- `packages/core/src/collective/default-participants.ts` — add `'delete_conversation'` to `MANAGEMENT_TOOLS`.
- `.legion/collective/participants/operator.json` — add `"delete_conversation": "auto"` to `tools`.

**Frontend (modify):**

- `packages/web/src/components/conversations/ConversationList.vue` — hover trash icon on each row; emit `delete`.
- `packages/web/src/components/conversations/ConversationThread.vue` — header trash button; emit `delete`.
- `packages/web/src/views/ConversationsView.vue` — `pendingDeleteId` state, confirm modal, `deleteConversation` handler, list refresh + navigation.

---

## Task 1: Add `delete` to `ConversationStore` interface

**Files:**

- Modify: `packages/core/src/conversation/ConversationStore.ts`

- [ ] **Step 1: Add the `delete` method signature to the interface**

Add to the `ConversationStore` interface, immediately after `listByParent`:

```ts
  /** Delete a conversation and all of its descendants. Idempotent: no error if the id does not exist. */
  delete(conversationId: string): Promise<void>;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: TypeScript errors in `FileConversationStore.ts` complaining that `delete` is missing from the class (this is the point — it confirms the interface change took effect).

---

## Task 2: Implement `FileConversationStore.delete` with recursive cascade

**Files:**

- Modify: `packages/core/src/conversation/FileConversationStore.ts`
- Test: `packages/core/src/conversation/FileConversationStore.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/core/src/conversation/FileConversationStore.test.ts`:

```ts
it('delete removes a childless conversation', async () => {
  const created = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  expect(await store.exists(created.id)).toBe(true);

  await store.delete(created.id);

  expect(await store.exists(created.id)).toBe(false);
  expect(await store.load(created.id)).toBeNull();
});

it('delete cascades to direct children', async () => {
  const parent = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  const child = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    parentConversationId: parent.id,
    parentToolCallId: 'tc-a',
  });
  await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });

  await store.delete(parent.id);

  expect(await store.exists(parent.id)).toBe(false);
  expect(await store.exists(child.id)).toBe(false);
  const remaining = await store.list({ includeSubThreads: true });
  expect(remaining.map((m) => m.id)).not.toContain(parent.id);
  expect(remaining.map((m) => m.id)).not.toContain(child.id);
});

it('delete cascades recursively to grandchildren', async () => {
  const root = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  const child = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    parentConversationId: root.id,
    parentToolCallId: 'tc-1',
  });
  const grandchild = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    parentConversationId: child.id,
    parentToolCallId: 'tc-2',
  });
  await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });

  await store.delete(root.id);

  expect(await store.exists(root.id)).toBe(false);
  expect(await store.exists(child.id)).toBe(false);
  expect(await store.exists(grandchild.id)).toBe(false);
});

it('delete is idempotent when the id does not exist', async () => {
  await expect(store.delete('conv-missing')).resolves.toBeUndefined();
});

it('delete leaves unrelated conversations intact', async () => {
  const a = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  const b = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });

  await store.delete(a.id);

  expect(await store.exists(b.id)).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/conversation/FileConversationStore.test.ts -t "delete"`
Expected: FAIL with errors like `store.delete is not a function` or TypeScript "Property 'delete' does not exist on type 'FileConversationStore'".

- [ ] **Step 3: Implement `delete` on `FileConversationStore`**

Add to `packages/core/src/conversation/FileConversationStore.ts` immediately after `listByParent`:

```ts
  async delete(conversationId: string): Promise<void> {
    const conversation = await this.load(conversationId);
    if (!conversation) return;

    const children = await this.listByParent(conversationId);
    for (const child of children) {
      await this.delete(child.id);
    }
    await this.storage.delete(this.key(conversationId));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/conversation/FileConversationStore.test.ts -t "delete"`
Expected: PASS — all 5 new tests pass.

- [ ] **Step 5: Run the full conversation store test file to confirm no regressions**

Run: `npx vitest run packages/core/src/conversation/FileConversationStore.test.ts`
Expected: PASS — all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/conversation/ConversationStore.ts packages/core/src/conversation/FileConversationStore.ts packages/core/src/conversation/FileConversationStore.test.ts
git commit -m "feat(core): FileConversationStore.delete cascades to sub-threads"
```

---

## Task 3: Add `delete_conversation` management tool

**Files:**

- Modify: `packages/core/src/tools/management-tools.ts`
- Test: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/core/src/tools/management-tools.test.ts`:

1. Update the import block at the top to include `deleteConversationTool`:

```ts
import {
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  getConversationTool,
  setToolPolicyTool,
  setCredentialTool,
  modifyAgentTool,
  listConversationsTool,
  deleteConversationTool,
  managementTools,
} from './management-tools.js';
```

2. Append a new `describe` block at the end of the file:

```ts
describe('delete_conversation', () => {
  it('removes a conversation from the store', async () => {
    const { context, conversationStore } = await makeContext();
    const conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    const result = await deleteConversationTool.execute({ conversationId: conv.id }, context);
    expect(result.status).toBe('success');
    expect(await conversationStore.exists(conv.id)).toBe(false);
  });

  it('cascades to sub-threads', async () => {
    const { context, conversationStore } = await makeContext();
    const parent = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const child = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: parent.id,
      parentToolCallId: 'tc-1',
    });

    const result = await deleteConversationTool.execute({ conversationId: parent.id }, context);
    expect(result.status).toBe('success');
    expect(await conversationStore.exists(parent.id)).toBe(false);
    expect(await conversationStore.exists(child.id)).toBe(false);
    const all = await conversationStore.list({ includeSubThreads: true });
    expect(all.map((c) => c.id)).not.toContain(child.id);
  });

  it('returns success when the id does not exist', async () => {
    const { context } = await makeContext();
    const result = await deleteConversationTool.execute(
      { conversationId: 'conv-missing' },
      context,
    );
    expect(result.status).toBe('success');
  });

  it('returns success data shape { deleted: true }', async () => {
    const { context, conversationStore } = await makeContext();
    const conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    const result = await deleteConversationTool.execute({ conversationId: conv.id }, context);
    expect(result.status).toBe('success');
    expect((result as { data: { deleted: boolean } }).data).toEqual({ deleted: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts -t "delete_conversation"`
Expected: FAIL — import error for `deleteConversationTool`.

- [ ] **Step 3: Add `deleteConversationTool` to `management-tools.ts`**

Add to `packages/core/src/tools/management-tools.ts` immediately after the `listConversationsTool` block (before `export const managementTools`):

```ts
export const deleteConversationTool: Tool = {
  name: 'delete_conversation',
  description:
    'Permanently delete a conversation and any nested sub-threads (agent-to-agent delegations).',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation to delete.',
      },
    },
    required: ['conversationId'],
  },
  async execute(args: { conversationId: string }, context: ToolContext): Promise<ToolResult> {
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    const { conversationId } = args;
    try {
      await context.conversationStore.delete(conversationId);
      return { status: 'success', data: { deleted: true } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

Add `deleteConversationTool` to the `managementTools` array so the exported array becomes:

```ts
export const managementTools: Tool[] = [
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  setToolPolicyTool,
  getConversationTool,
  setCredentialTool,
  modifyAgentTool,
  listToolsTool,
  listConversationsTool,
  deleteConversationTool,
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts -t "delete_conversation"`
Expected: PASS — all 4 new tests pass.

- [ ] **Step 5: Run the full management-tools test file to confirm no regressions**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: PASS — all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts
git commit -m "feat(core): add delete_conversation management tool"
```

---

## Task 4: Grant `delete_conversation` to the operator by default

**Files:**

- Modify: `packages/core/src/collective/default-participants.ts`
- Modify: `.legion/collective/participants/operator.json`

- [ ] **Step 1: Add `'delete_conversation'` to the `MANAGEMENT_TOOLS` array**

In `packages/core/src/collective/default-participants.ts`, append `'delete_conversation'` to the array, immediately after `'get_conversation'`:

```ts
const MANAGEMENT_TOOLS = [
  'communicate',
  'create_agent',
  'modify_agent',
  'retire_agent',
  'list_participants',
  'get_participant',
  'list_tools',
  'list_conversations',
  'get_conversation',
  'delete_conversation',
  'set_tool_policy',
  'set_credential',
  // runtime / config tools (registered by WebConnector layer)
  'list_providers',
  'configure_provider',
  'list_credentials',
  'set_credential_with_meta',
] as const;
```

- [ ] **Step 2: Add the policy to the existing operator.json**

Edit `.legion/collective/participants/operator.json` to add `"delete_conversation": "auto"` to the `tools` map, immediately after `"get_conversation"`:

```json
{
  "id": "operator",
  "name": "Operator",
  "type": "user",
  "tools": {
    "communicate": "auto",
    "create_agent": "auto",
    "modify_agent": "auto",
    "retire_agent": "auto",
    "list_participants": "auto",
    "get_participant": "auto",
    "list_tools": "auto",
    "list_conversations": "auto",
    "get_conversation": "auto",
    "delete_conversation": "auto",
    "set_tool_policy": "auto",
    "set_credential": "auto",
    "list_providers": "auto",
    "configure_provider": "auto",
    "list_credentials": "auto",
    "set_credential_with_meta": "auto",
    "approval_response": "auto"
  },
  "operator": true,
  "protected": true,
  "status": "active",
  "approvalAuthority": {
    "tools": "*",
    "participants": "*"
  },
  "identities": [
    {
      "connector": "web",
      "externalId": "operator"
    }
  ]
}
```

- [ ] **Step 3: Run the full core test suite to confirm nothing breaks**

Run: `npx vitest run packages/core/src`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/collective/default-participants.ts .legion/collective/participants/operator.json
git commit -m "feat: grant delete_conversation tool to operator by default"
```

---

## Task 5: Sidebar hover trash icon on `ConversationList.vue`

**Files:**

- Modify: `packages/web/src/components/conversations/ConversationList.vue`

- [ ] **Step 1: Extend the component's emits and add the trash icon**

Replace the `<script setup lang="ts">` block in `packages/web/src/components/conversations/ConversationList.vue` with:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router';
import type { ConversationMeta } from '@legion-collective/types';

const props = defineProps<{
  conversations: ConversationMeta[];
  activeId: string | null;
  myParticipantId: string;
  mode: 'mine' | 'all';
  pendingApprovalIds?: Set<string>;
}>();

const emit = defineEmits<{
  select: [id: string];
  'update:mode': [mode: 'mine' | 'all'];
  delete: [id: string];
}>();

const router = useRouter();
</script>
```

Replace the conversation list item template block (the `v-for="conv in conversations"` block) with:

```vue
      <div
        v-for="conv in conversations"
        :key="conv.id"
        class="relative px-3 py-2.5 cursor-pointer border-b border-navy-900 hover:bg-navy-850 transition-colors group"
        :class="conv.id === activeId ? 'bg-navy-800 border-l-2 border-l-cyan-600' : ''"
        @click="emit('select', conv.id)"
      >
        <!-- Amber dot for pending approval -->
        <div
          v-if="props.pendingApprovalIds?.has(conv.id)"
          class="absolute right-2.5 top-3 w-2 h-2 rounded-full bg-amber-400"
        />

        <!-- Delete button (visible on hover) -->
        <button
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity text-slate-500 hover:text-red-400"
          title="Delete conversation"
          @click.stop="emit('delete', conv.id)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>

        <div class="text-sm text-slate-200 truncate pr-8">
          {{ conv.participants.filter(p => p !== myParticipantId).join(', ') || conv.id }}
        </div>
        <div class="text-xs text-slate-600 mt-0.5 font-mono truncate">
          {{ conv.id }}
        </div>
      </div>
```

Note: `@click.stop` prevents the row's `select` handler from firing when the trash button is clicked. The `pr-8` on the title row prevents text overlap with the icon.

- [ ] **Step 2: Verify the web package type-checks**

Run: `npx vue-tsc --noEmit -p packages/web/tsconfig.json`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/conversations/ConversationList.vue
git commit -m "feat(web): hover trash icon on conversation list rows"
```

---

## Task 6: Thread header trash button on `ConversationThread.vue`

**Files:**

- Modify: `packages/web/src/components/conversations/ConversationThread.vue`

- [ ] **Step 1: Extend emits and add the header button**

Update the `defineEmits` line in `packages/web/src/components/conversations/ConversationThread.vue` to include `delete`:

```ts
const emit = defineEmits<{
  sent: [conversationId: string];
  delete: [conversationId: string];
}>();
```

Replace the existing thread header block (currently just showing `recipientName`):

```vue
<!-- Thread header -->
<div class="flex items-center gap-2 px-4 py-3 border-b border-navy-800 flex-shrink-0">
      <span v-if="conversationId" class="text-sm font-medium text-slate-200">
        {{ recipientName ?? conversationId }}
      </span>
      <span v-else class="text-sm text-slate-500">New conversation</span>
      <button
        v-if="conversationId"
        type="button"
        class="ml-auto text-slate-500 hover:text-red-400 transition-colors"
        title="Delete conversation"
        @click="emit('delete', conversationId)"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </div>
```

The button is rendered only when `conversationId` is truthy (not the draft/new conversation), so the trash icon is absent from the draft screen.

- [ ] **Step 2: Verify the web package type-checks**

Run: `npx vue-tsc --noEmit -p packages/web/tsconfig.json`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/conversations/ConversationThread.vue
git commit -m "feat(web): delete button in conversation thread header"
```

---

## Task 7: Confirm dialog and deletion flow in `ConversationsView.vue`

**Files:**

- Modify: `packages/web/src/views/ConversationsView.vue`

- [ ] **Step 1: Wire up the delete flow**

Replace the `<script setup lang="ts">` block in `packages/web/src/views/ConversationsView.vue` with:

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useExecute } from '../composables/useExecute.js';
import { useAuth } from '../composables/useAuth.js';
import { useEventStream } from '../composables/useEventStream.js';
import AppLayout from '../components/layout/AppLayout.vue';
import ConversationList from '../components/conversations/ConversationList.vue';
import ConversationThread from '../components/conversations/ConversationThread.vue';
import SearchableCombobox from '../components/common/SearchableCombobox.vue';
import type { ConversationMeta, BaseParticipant } from '@legion-collective/types';

const route = useRoute();
const router = useRouter();
const { execute } = useExecute();
const { participantId: myParticipantId } = useAuth();

const listMode = ref<'mine' | 'all'>('mine');
const conversations = ref<ConversationMeta[]>([]);
const participants = ref<BaseParticipant[]>([]);
const pendingApprovalIds = ref<Set<string>>(new Set());

const isDraft = computed(() => route.path === '/conversations/new');
const activeId = computed(() =>
  isDraft.value ? null : ((route.params.id as string | undefined) ?? null),
);

// Resolved recipient for existing conversations or draft
const draftRecipientId = ref<string | null>(null);
const draftRecipientName = ref<string | null>(null);

const recipientId = computed<string | null>(() => {
  if (isDraft.value) return draftRecipientId.value;
  if (!activeId.value) return null;
  const conv = conversations.value.find((c) => c.id === activeId.value);
  if (!conv) return null;
  return conv.participants.find((p) => p !== myParticipantId.value) ?? null;
});

const recipientName = computed<string | null>(() => {
  if (isDraft.value) return draftRecipientName.value;
  const id = recipientId.value;
  if (!id) return null;
  return participants.value.find((p) => p.id === id)?.name ?? id;
});

const threadMode = computed<'read' | 'chat'>(() => {
  if (isDraft.value) return 'chat';
  if (!activeId.value) return 'read';
  const conv = conversations.value.find((c) => c.id === activeId.value);
  if (!conv) return 'read';
  return conv.participants.includes(myParticipantId.value ?? '') ? 'chat' : 'read';
});

const agentOptions = computed(() =>
  participants.value
    .filter((p) => p.type === 'agent' && p.status !== 'retired')
    .map((p) => ({ value: p.id, label: p.name })),
);

// --- Delete flow ---
const pendingDeleteId = ref<string | null>(null);
const deleting = ref(false);

async function loadConversations() {
  const filter =
    listMode.value === 'mine' && myParticipantId.value
      ? { participantId: myParticipantId.value }
      : {};
  const result = await execute<{ conversations: ConversationMeta[] }>('list_conversations', filter);
  conversations.value = result.conversations;
}

async function loadParticipants() {
  participants.value = await execute<BaseParticipant[]>('list_participants', {});
}

function selectConversation(id: string) {
  router.push(`/conversations/${id}`);
}

function onDraftRecipientSelect(id: string) {
  draftRecipientId.value = id;
  draftRecipientName.value = participants.value.find((p) => p.id === id)?.name ?? id;
}

function onMessageSent(conversationId: string) {
  if (isDraft.value) {
    router.push(`/conversations/${conversationId}`);
  }
  void loadConversations();
}

function requestDelete(id: string) {
  pendingDeleteId.value = id;
}

async function confirmDelete() {
  const id = pendingDeleteId.value;
  if (!id) return;
  deleting.value = true;
  try {
    await execute('delete_conversation', { conversationId: id });
    if (id === activeId.value) {
      await router.push('/conversations');
    }
    await loadConversations();
  } finally {
    deleting.value = false;
    pendingDeleteId.value = null;
  }
}

function cancelDelete() {
  pendingDeleteId.value = null;
}

// Refresh list when mode changes
watch(listMode, loadConversations);

// Subscribe to conversation events to keep list fresh
const { on } = useEventStream();
on('conversation:created', () => void loadConversations());

// Track pending approvals for amber dot
on('approval:requested', (payload) => {
  pendingApprovalIds.value = new Set([
    ...pendingApprovalIds.value,
    (payload as any).conversationId,
  ]);
});
on('approval:resolved', (payload) => {
  const next = new Set(pendingApprovalIds.value);
  next.delete((payload as any).conversationId);
  pendingApprovalIds.value = next;
});

onMounted(async () => {
  await Promise.all([loadConversations(), loadParticipants()]);
});
</script>
```

Replace the `<template>` block with:

```vue
<template>
  <AppLayout>
    <div class="flex h-full">
      <!-- Left: conversation list -->
      <div class="w-52 flex-shrink-0 border-r border-navy-800 flex flex-col">
        <ConversationList
          :conversations="conversations"
          :active-id="activeId"
          :my-participant-id="myParticipantId ?? ''"
          :mode="listMode"
          :pending-approval-ids="pendingApprovalIds"
          @select="selectConversation"
          @update:mode="listMode = $event"
          @delete="requestDelete"
        />
      </div>

      <!-- Right: thread -->
      <div class="flex-1 flex flex-col min-w-0">
        <!-- Draft: "To:" header bar -->
        <div
          v-if="isDraft"
          class="flex items-center gap-3 px-4 py-2.5 border-b border-navy-800 flex-shrink-0"
        >
          <span class="text-xs text-slate-500 flex-shrink-0">To:</span>
          <div class="flex-1 max-w-xs">
            <SearchableCombobox
              :options="agentOptions"
              placeholder="Select agent..."
              @select="onDraftRecipientSelect"
            />
          </div>
        </div>

        <!-- Thread pane -->
        <ConversationThread
          v-if="activeId || isDraft"
          :key="activeId ?? 'draft'"
          :conversation-id="activeId"
          :mode="threadMode"
          :my-participant-id="myParticipantId ?? ''"
          :recipient-id="recipientId ?? undefined"
          :recipient-name="recipientName ?? undefined"
          @sent="onMessageSent"
          @delete="requestDelete"
        />

        <!-- No selection -->
        <div v-else class="flex-1 flex items-center justify-center text-slate-600 text-sm">
          Select a conversation or start a new one
        </div>
      </div>

      <!-- Delete confirmation modal -->
      <div
        v-if="pendingDeleteId"
        class="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
        @click.self="cancelDelete"
      >
        <div class="bg-navy-900 border border-navy-700 rounded-lg shadow-xl max-w-sm w-full mx-4">
          <div class="px-4 py-3 border-b border-navy-800">
            <span class="text-sm font-medium text-slate-200">Delete conversation?</span>
          </div>
          <div class="px-4 py-4 text-sm text-slate-400">
            This will permanently delete this conversation and any nested delegations. This cannot
            be undone.
          </div>
          <div class="px-4 py-3 flex justify-end gap-2 border-t border-navy-800">
            <button
              type="button"
              class="text-xs px-3 py-1.5 rounded border border-navy-700 text-slate-400 hover:text-slate-200 hover:bg-navy-800 transition-colors"
              :disabled="deleting"
              @click="cancelDelete"
            >
              Cancel
            </button>
            <button
              type="button"
              class="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
              :disabled="deleting"
              @click="confirmDelete"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
```

- [ ] **Step 2: Verify the web package type-checks**

Run: `npx vue-tsc --noEmit -p packages/web/tsconfig.json`
Expected: PASS — no errors.

- [ ] **Step 3: Run the full web test suite to confirm no regressions**

Run: `npm test --workspace packages/web`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/views/ConversationsView.vue
git commit -m "feat(web): confirm dialog and delete flow for conversations"
```

---

## Task 8: Full build and manual browser verification

- [ ] **Step 1: Build the full project**

Run: `npm run build`
Expected: Build succeeds for both `core` and `web`.

- [ ] **Step 2: Run all unit tests across the repo**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Restart the live server with a fresh process**

```bash
# Stop any running instance bound to port 3000
kill -9 $(lsof -t -i:3000) 2>/dev/null || true
# Start a fresh process in the background
setsid nohup node packages/runtime/bin/legion.js > /tmp/legion-server.log 2>&1 &
sleep 2
# Verify it came up
curl -s http://127.0.0.1:3000/api/health
echo
# Confirm it's a new PID
lsof -i:3000 | head -3
```

Expected: `/api/health` returns `{"status":"ok"}`, and a new PID is listening on port 3000.

- [ ] **Step 4: Manual browser verification**

Log into the chat interface at http://127.0.0.1:3000/ using the operator's password (printed in the server log). Verify each step in the browser:

1. Open the Conversations page — confirm the sidebar shows the existing conversations.
2. Hover over a conversation row — confirm the trash icon appears on the right.
3. Click the trash icon — confirm the confirm dialog appears with the destructive styling.
4. Click Cancel — confirm the dialog disappears and nothing is deleted.
5. Click the trash icon again and confirm the dialog; click Delete — confirm:
   - The dialog disappears.
   - The conversation disappears from the sidebar.
   - The thread pane returns to the placeholder state ("Select a conversation or start a new one").
6. Open a remaining conversation via the sidebar — confirm the thread header shows the trash icon on the right.
7. Click the header trash button — confirm the dialog appears.
8. Confirm the dialog — confirm the same outcome as step 5.
9. Open a conversation that has sub-threads (an `assistant → researcher` delegation visible in the thread). Delete it via the header button — confirm it disappears from the sidebar.
10. Verify the cascade by checking disk:
    ```bash
    ls .legion/conversations/ | grep -c "<deleted-id>"
    ```
    Expected: 0 matches for both the deleted parent id and its sub-thread id.

If any step fails, stop and report which step failed before proceeding to a fix.

---

## Task 9: Final review and PR prep

- [ ] **Step 1: Confirm the full commit history is clean and meaningful**

Run: `git log --oneline -10`
Expected: All commits in this branch follow the existing conventional-commit style (`feat:` / `docs:`).

- [ ] **Step 2: Confirm no stray files are staged or untracked**

Run: `git status`
Expected: Clean working tree, no untracked files introduced by this work.

---

## Verification commands reference

| Task               | Command                                                                                    | Expected   |
| ------------------ | ------------------------------------------------------------------------------------------ | ---------- |
| Store delete tests | `npx vitest run packages/core/src/conversation/FileConversationStore.test.ts -t "delete"`  | All 5 pass |
| Tool tests         | `npx vitest run packages/core/src/tools/management-tools.test.ts -t "delete_conversation"` | All 4 pass |
| Core suite         | `npx vitest run packages/core/src`                                                         | All pass   |
| Web typecheck      | `npx vue-tsc --noEmit -p packages/web/tsconfig.json`                                       | No errors  |
| Web tests          | `npm test --workspace packages/web`                                                        | All pass   |
| Full build         | `npm run build`                                                                            | Succeeds   |
| Full test suite    | `npm test`                                                                                 | All pass   |
