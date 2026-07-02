<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useExecute } from '../composables/useExecute.js';
import { useAuth } from '../composables/useAuth.js';
import { useEventStream } from '../composables/useEventStream.js';
import ConversationList from '../components/conversations/ConversationList.vue';
import ConversationThread from '../components/conversations/ConversationThread.vue';
import SearchableCombobox from '../components/common/SearchableCombobox.vue';
import type { ConversationMeta, BaseParticipant } from '@legion/types';

const route = useRoute();
const router = useRouter();
const { execute } = useExecute();
const { participantId: myParticipantId } = useAuth();

const listMode = ref<'mine' | 'all'>('mine');
const conversations = ref<ConversationMeta[]>([]);
const participants = ref<BaseParticipant[]>([]);
const pendingApprovalIds = ref<Set<string>>(new Set());

const isDraft = computed(() => route.path === '/conversations/new');
const activeId = computed(() => isDraft.value ? null : (route.params.id as string | undefined) ?? null);

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

async function loadConversations() {
  const filter = listMode.value === 'mine' && myParticipantId.value
    ? { participantId: myParticipantId.value }
    : {};
  conversations.value = await execute<ConversationMeta[]>('list_conversations', filter);
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

// Refresh list when mode changes
watch(listMode, loadConversations);

// Subscribe to conversation events to keep list fresh
const { on } = useEventStream();
on('conversation:created', () => void loadConversations());

// Track pending approvals for amber dot
on('approval:requested', (payload) => {
  pendingApprovalIds.value = new Set([...pendingApprovalIds.value, (payload as any).conversationId]);
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

<template>
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
      />
    </div>

    <!-- Right: thread -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- Draft: "To:" header bar -->
      <div v-if="isDraft" class="flex items-center gap-3 px-4 py-2.5 border-b border-navy-800 flex-shrink-0">
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
        :conversation-id="activeId"
        :mode="threadMode"
        :my-participant-id="myParticipantId ?? ''"
        :recipient-id="recipientId ?? undefined"
        :recipient-name="recipientName ?? undefined"
        @sent="onMessageSent"
      />

      <!-- No selection -->
      <div v-else class="flex-1 flex items-center justify-center text-slate-600 text-sm">
        Select a conversation or start a new one
      </div>
    </div>
  </div>
</template>
