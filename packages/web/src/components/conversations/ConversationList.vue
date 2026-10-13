<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ConversationMeta } from '@legion-collective/types';

const props = defineProps<{
  conversations: ConversationMeta[];
  activeId: string | null;
  myParticipantId: string;
  mode: 'mine' | 'all';
  status: 'active' | 'archived' | 'all';
  tags: string[];
  pendingApprovalIds?: Set<string>;
}>();

const emit = defineEmits<{
  select: [id: string];
  'update:mode': [mode: 'mine' | 'all'];
  'update:status': [status: 'active' | 'archived' | 'all'];
  'update:tags': [tags: string[]];
  delete: [id: string];
}>();

function updateTags(value: string) {
  emit('update:tags', [
    ...new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]);
}

// Local input state so in-progress typing survives re-renders; syncs from prop
// when tags change externally.
const tagInput = ref(props.tags.join(', '));
watch(
  () => props.tags,
  (tags) => {
    tagInput.value = tags.join(', ');
  },
);

const router = useRouter();
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2.5 border-b border-line flex-shrink-0">
      <span class="text-xs uppercase tracking-wider text-slate-500">Conversations</span>
      <button
        class="text-xs px-2 py-0.5 rounded bg-cyan-800 text-cyan-200 hover:bg-cyan-700"
        @click="router.push('/conversations/new')"
      >
        + New
      </button>
    </div>

    <!-- Mine / All toggle -->
    <div class="flex gap-1 px-3 py-2 border-b border-line flex-shrink-0">
      <button
        class="text-xs px-3 py-0.5 rounded-full transition-colors"
        :class="
          mode === 'mine'
            ? 'bg-cyan-800 text-cyan-200'
            : 'text-slate-500 border border-line hover:text-slate-300'
        "
        @click="emit('update:mode', 'mine')"
      >
        Mine
      </button>
      <button
        class="text-xs px-3 py-0.5 rounded-full transition-colors"
        :class="
          mode === 'all'
            ? 'bg-cyan-800 text-cyan-200'
            : 'text-slate-500 border border-line hover:text-slate-300'
        "
        @click="emit('update:mode', 'all')"
      >
        All
      </button>
    </div>

    <!-- Status / tag filters -->
    <div class="border-b border-line px-3 py-2">
      <div class="flex gap-1">
        <button
          v-for="value in ['active', 'archived', 'all'] as const"
          :key="value"
          :data-status="value"
          class="rounded px-2 py-0.5 text-[10px] capitalize"
          :class="status === value ? 'bg-cyan-800 text-cyan-200' : 'text-slate-500'"
          @click="emit('update:status', value)"
        >
          {{ value }}
        </button>
      </div>
      <input
        v-model="tagInput"
        data-tag-filter
        placeholder="Tags: alpha, beta"
        class="mt-2 w-full rounded border border-line bg-surface-raised px-2 py-1 text-[10px] text-slate-300"
        @change="updateTags(tagInput)"
      />
    </div>

    <!-- Conversation list -->
    <div class="flex-1 overflow-y-auto">
      <div
        v-for="conv in conversations"
        :key="conv.id"
        class="relative px-3 py-2.5 cursor-pointer border-b border-line hover:bg-surface transition-colors group"
        :class="conv.id === activeId ? 'bg-surface border-l-2 border-l-cyan-600' : ''"
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
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
            />
          </svg>
        </button>

        <div data-conversation-title class="text-sm text-slate-200 truncate pr-8">
          {{
            conv.title ??
            (conv.participants.filter((p) => p !== myParticipantId).join(', ') || conv.id)
          }}
        </div>
        <div class="text-xs text-slate-600 mt-0.5 font-mono truncate">
          {{ conv.id }}
        </div>
      </div>

      <div v-if="conversations.length === 0" class="px-3 py-6 text-xs text-slate-600 text-center">
        No conversations yet
      </div>
    </div>
  </div>
</template>
