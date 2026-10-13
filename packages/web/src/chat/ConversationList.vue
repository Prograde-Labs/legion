<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConversations } from '../composables/useConversations.js';
import { useApprovals } from '../composables/useApprovals.js';
import { useReadState } from '../composables/useReadState.js';
import { useAuth } from '../composables/useAuth.js';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useToolAccess } from '../composables/useToolAccess.js';

const store = useConversations();
const approvals = useApprovals();
const { isUnread } = useReadState();
const { participantId } = useAuth();
const { execute } = useLegionApi();
const toolAccess = useToolAccess();
const canDelete = computed(() => toolAccess.can('delete_conversation') === 'auto');
const deletingId = ref<string | null>(null);
// Destructive-action failures must be visible: the row stays (honest state),
// but the user who confirmed the delete gets feedback (mirrors MessageActions'
// actions-error convention).
const deleteError = ref<string | null>(null);

async function removeConversation(id: string): Promise<void> {
  if (!window.confirm('Delete conversation?')) return;
  deletingId.value = id;
  deleteError.value = null;
  try {
    await execute('delete_conversation', { conversationId: id });
    // Drop the row immediately; the watch_conversations stream reconciles the
    // full list on the next lifecycle event.
    store.remove(id);
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    deletingId.value = null;
  }
}

const emit = defineEmits<{ select: [id: string | null] }>();

const sorted = computed(() =>
  [...store.conversations.value].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  ),
);

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function initials(participants: string[]): Array<{ id: string; text: string }> {
  return participants
    .filter((p) => p !== participantId.value)
    .slice(0, 3)
    .map((p) => ({ id: p, text: p.slice(0, 2) }));
}

function onSearch(event: Event): void {
  store.filter.value = {
    ...store.filter.value,
    search: (event.target as HTMLInputElement).value,
  };
}
</script>

<template>
  <div class="flex h-full flex-col">
    <input
      type="search"
      data-test="conv-search"
      :value="store.filter.value.search"
      placeholder="Search conversations"
      class="border-b border-line bg-transparent px-3 py-2 text-sm outline-none placeholder:text-faint"
      @input="onSearch"
    />
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div
        v-if="deleteError"
        data-test="conv-delete-error"
        role="alert"
        class="border-b border-line px-3 py-2 text-xs text-danger"
      >
        {{ deleteError }}
      </div>
      <div
        v-for="c in sorted"
        :key="c.id"
        data-test="conv-row"
        :data-id="c.id"
        :data-pending="approvals.pendingByConversation.value.has(c.id) ? 'true' : 'false'"
        class="flex w-full cursor-pointer flex-col gap-0.5 border-b border-line px-3 py-2 text-left hover:bg-surface"
        role="button"
        tabindex="0"
        @click="emit('select', c.id)"
        @keydown.enter="emit('select', c.id)"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="truncate text-sm font-medium text-ink">{{ c.title ?? c.id }}</span>
          <span class="shrink-0 text-xs text-faint">{{ timeAgo(c.updatedAt) }}</span>
          <span
            v-if="(approvals.pendingByConversation.value.get(c.id) ?? 0) > 0"
            data-test="conv-pending"
            class="shrink-0 text-xs text-danger"
            >⚠ {{ approvals.pendingByConversation.value.get(c.id) }}</span
          >
          <span
            v-if="isUnread(c.id, c.updatedAt)"
            data-test="conv-unread"
            class="size-2 shrink-0 rounded-full bg-accent"
            aria-hidden="true"
          />
          <button
            v-if="canDelete"
            type="button"
            data-test="conv-delete"
            :disabled="deletingId === c.id"
            class="shrink-0 rounded px-1 text-xs text-faint hover:text-danger disabled:opacity-50"
            :aria-label="`Delete conversation ${c.title ?? c.id}`"
            title="Delete conversation"
            @click.stop="removeConversation(c.id)"
          >
            🗑
          </button>
        </div>
        <div class="flex items-center gap-1 text-xs text-muted">
          <span
            v-for="initial in initials(c.participants)"
            :key="initial.id"
            class="rounded-full bg-accent-soft px-1.5 py-0.5 text-accent"
            >{{ initial.text }}</span
          >
          <span class="truncate">{{ c.participants.join(', ') }}</span>
        </div>
      </div>
    </div>
    <button
      type="button"
      data-test="new-conv"
      class="border-t border-line px-3 py-2 text-left text-sm text-accent hover:bg-surface"
      @click="emit('select', null)"
    >
      ＋ New conversation
    </button>
  </div>
</template>
