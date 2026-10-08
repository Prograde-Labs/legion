<script setup lang="ts">
import { computed } from 'vue';
import { useConversations } from '../composables/useConversations.js';
import { useApprovals } from '../composables/useApprovals.js';
import { useAuth } from '../composables/useAuth.js';

const store = useConversations();
const approvals = useApprovals();
const { participantId } = useAuth();

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

function initials(names: string[]): string[] {
  return names
    .filter((p) => p !== participantId.value)
    .slice(0, 3)
    .map((p) => p.slice(0, 2));
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
      <button
        v-for="c in sorted"
        :key="c.id"
        type="button"
        data-test="conv-row"
        :data-id="c.id"
        :data-pending="approvals.pendingByConversation.value.has(c.id) ? 'true' : 'false'"
        class="flex w-full flex-col gap-0.5 border-b border-line px-3 py-2 text-left hover:bg-surface"
        @click="emit('select', c.id)"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="truncate text-sm font-medium text-ink">{{ c.title ?? c.id }}</span>
          <span class="shrink-0 text-xs text-faint">{{ timeAgo(c.updatedAt) }}</span>
        </div>
        <div class="flex items-center gap-1 text-xs text-muted">
          <span
            v-for="initial in initials(c.participants)"
            :key="initial"
            class="rounded-full bg-accent-soft px-1.5 py-0.5 text-accent"
            >{{ initial }}</span
          >
          <span class="truncate">{{ c.participants.join(', ') }}</span>
        </div>
      </button>
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
