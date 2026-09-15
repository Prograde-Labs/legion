<script setup lang="ts">
import TypeBadge from '../common/TypeBadge.vue';
defineProps<{ event: { type: string; event: string; data: unknown } | null }>();
function fmt(v: unknown) {
  return JSON.stringify(v, null, 2);
}
</script>
<template>
  <div class="w-72 shrink-0 border-l border-navy-600 flex flex-col bg-navy-800/40">
    <div class="px-4 py-3 border-b border-navy-600 flex items-center justify-between">
      <span class="text-xs font-semibold text-slate-100">Event detail</span>
      <TypeBadge v-if="event" :type="event.event" />
    </div>
    <pre
      v-if="event"
      class="flex-1 text-[10px] font-mono text-navy-400 p-4 overflow-auto leading-relaxed whitespace-pre-wrap"
      >{{ fmt(event.data) }}</pre>
    <div v-else class="flex-1 flex items-center justify-center text-navy-600 text-xs">
      Select an event
    </div>
  </div>
</template>
