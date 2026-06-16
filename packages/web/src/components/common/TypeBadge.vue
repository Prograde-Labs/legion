<script setup lang="ts">
defineProps<{ type: string }>();
const colours: Record<string, string> = {
  'message:sent': 'bg-cyan-400/10 text-cyan-400 border-cyan-400/20',
  'tool:call': 'bg-violet-400/10 text-violet-400 border-violet-400/20',
  'tool:result': 'bg-green-400/10 text-green-400 border-green-400/20',
  error: 'bg-red-400/10 text-red-400 border-red-400/20',
  delegation: 'bg-amber-400/10 text-amber-400 border-amber-400/20',
};
const cls = (t: string) => colours[t] ?? 'bg-navy-700/50 text-navy-400 border-navy-600';
</script>
<template>
  <span
    :class="['inline-block text-[9px] font-bold font-mono px-1.5 py-0.5 rounded border', cls(type)]"
  >
    {{ type }}
  </span>
</template>
