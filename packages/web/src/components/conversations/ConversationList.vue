<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import type { ConversationMeta } from '@legion/types';

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
}>();

const router = useRouter();
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2.5 border-b border-navy-800 flex-shrink-0">
      <span class="text-xs uppercase tracking-wider text-slate-500">Conversations</span>
      <button
        class="text-xs px-2 py-0.5 rounded bg-cyan-800 text-cyan-200 hover:bg-cyan-700"
        @click="router.push('/conversations/new')"
      >
        + New
      </button>
    </div>

    <!-- Mine / All toggle -->
    <div class="flex gap-1 px-3 py-2 border-b border-navy-800 flex-shrink-0">
      <button
        class="text-xs px-3 py-0.5 rounded-full transition-colors"
        :class="mode === 'mine' ? 'bg-cyan-800 text-cyan-200' : 'text-slate-500 border border-navy-700 hover:text-slate-300'"
        @click="emit('update:mode', 'mine')"
      >
        Mine
      </button>
      <button
        class="text-xs px-3 py-0.5 rounded-full transition-colors"
        :class="mode === 'all' ? 'bg-cyan-800 text-cyan-200' : 'text-slate-500 border border-navy-700 hover:text-slate-300'"
        @click="emit('update:mode', 'all')"
      >
        All
      </button>
    </div>

    <!-- Conversation list -->
    <div class="flex-1 overflow-y-auto">
      <div
        v-for="conv in conversations"
        :key="conv.id"
        class="relative px-3 py-2.5 cursor-pointer border-b border-navy-900 hover:bg-navy-850 transition-colors"
        :class="conv.id === activeId ? 'bg-navy-800 border-l-2 border-l-cyan-600' : ''"
        @click="emit('select', conv.id)"
      >
        <!-- Amber dot for pending approval -->
        <div
          v-if="props.pendingApprovalIds?.has(conv.id)"
          class="absolute right-2.5 top-3 w-2 h-2 rounded-full bg-amber-400"
        />

        <div class="text-sm text-slate-200 truncate pr-4">
          {{ conv.participants.filter(p => p !== myParticipantId).join(', ') || conv.id }}
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
