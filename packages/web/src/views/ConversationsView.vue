<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useExecute } from '../composables/useExecute.js';
import { useAuth } from '../composables/useAuth.js';
import { useToolStream } from '../composables/useToolStream.js';
import { useWebSocket } from '../composables/useWebSocket.js';
import AppLayout from '../components/layout/AppLayout.vue';
import ConversationList from '../components/conversations/ConversationList.vue';
import ConversationThread from '../components/conversations/ConversationThread.vue';
import SearchableCombobox from '../components/common/SearchableCombobox.vue';
import type { ConversationMeta, BaseParticipant } from '@legion/types';

const route = useRoute();
const router = useRouter();
const { execute } = useExecute();
const { participantId: myParticipantId } = useAuth();

const listMode = ref<'mine' | 'all'>('mine');
const statusFilter = ref<'active' | 'archived' | 'all'>('active');
const tagFilter = ref<string[]>([]);
const conversationFilter = computed(() => ({
  ...(listMode.value === 'mine' && myParticipantId.value
    ? { participantId: myParticipantId.value }
    : {}),
  status: statusFilter.value,
  tags: tagFilter.value,
}));
const conversations = ref<ConversationMeta[]>([]);
const participants = ref<BaseParticipant[]>([]);
const pendingApprovalIds = ref<Set<string>>(new Set());

const isDraft = computed(() => route.path === '/conversations/new');
const activeId = computed(() =>
  isDraft.value ? null : ((route.params.id as string | undefined) ?? null),
);

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
  const result = await execute<{ conversations: ConversationMeta[] }>(
    'list_conversations',
    conversationFilter.value,
  );
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

watch(
  [listMode, statusFilter, tagFilter],
  async (newVal, oldVal) => {
    if (JSON.stringify(newVal) === JSON.stringify(oldVal)) return;
    await loadConversations();
    if (!ws.getConnectionId()) return;
    await convStream.cancel();
    await convStream.start();
  },
  { deep: true },
);

const ws = useWebSocket();

const convStream = useToolStream('watch_conversations', () => conversationFilter.value, {
  onChunk: () => void loadConversations(),
});

const activityStream = useToolStream('watch_activity', () => ({}), {
  onChunk: (chunk) => {
    if (chunk.type === 'approval:requested') {
      const p = (chunk as any).data as { conversationId: string };
      pendingApprovalIds.value = new Set([...pendingApprovalIds.value, p.conversationId]);
    } else if (chunk.type === 'approval:resolved') {
      const p = (chunk as any).data as { conversationId: string };
      const next = new Set(pendingApprovalIds.value);
      next.delete(p.conversationId);
      pendingApprovalIds.value = next;
    }
  },
});

watch(
  () => ws.getConnectionId(),
  async (id) => {
    if (!id) return;
    await Promise.all([convStream.start(), activityStream.start()]);
  },
  { immediate: true },
);

onMounted(async () => {
  await Promise.all([loadConversations(), loadParticipants()]);
});
</script>

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
          :status="statusFilter"
          :tags="tagFilter"
          :pending-approval-ids="pendingApprovalIds"
          @select="selectConversation"
          @update:mode="listMode = $event"
          @update:status="statusFilter = $event"
          @update:tags="tagFilter = $event"
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
