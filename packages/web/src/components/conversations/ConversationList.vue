<script setup lang="ts">
import type { ConversationSummary } from '@legion/types';
defineProps<{ conversations: ConversationSummary[]; activeId: string | null }>();
const emit = defineEmits<{ select: [id: string] }>();
function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
</script>
<template>
  <div class="w-60 shrink-0 border-r border-navy-600 bg-navy-900/50 flex flex-col">
    <div class="px-4 py-3 border-b border-navy-600 flex items-center justify-between">
      <span class="text-sm font-semibold text-slate-100">Conversations</span>
      <span class="text-[9px] text-navy-500">{{ conversations.length }} total</span>
    </div>
    <div class="flex-1 overflow-y-auto">
      <button
        v-for="c in conversations"
        :key="c.id"
        @click="emit('select', c.id)"
        :class="[
          'w-full text-left px-4 py-3 border-b border-navy-900 hover:bg-navy-800/40',
          activeId === c.id ? 'bg-navy-800/60 border-l-2 border-cyan-400 !pl-[14px]' : '',
        ]"
      >
        <div class="flex items-center gap-2 mb-1">
          <StatusDot :status="c.status === 'active' ? 'live' : 'complete'" />
          <span class="font-mono text-[11px] text-slate-100 truncate">{{ c.id }}</span>
          <span class="ml-auto text-[9px] text-navy-500 shrink-0">{{ ago(c.updatedAt) }}</span>
        </div>
        <p class="text-[10px] text-navy-400 pl-4 truncate">{{ c.participantIds.join(' · ') }}</p>
      </button>
    </div>
  </div>
</template>
<script>
import StatusDot from '../common/StatusDot.vue';
</script>
