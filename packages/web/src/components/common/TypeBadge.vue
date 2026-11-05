<script setup lang="ts">
defineProps<{ type: string }>();
const colours: Record<string, string> = {
  agent: 'bg-accent-soft text-accent border-accent/20',
  user: 'bg-success/10 text-success border-success/20',
  service: 'bg-warning/10 text-warning border-warning/20',
  mock: 'bg-surface-raised text-muted border-line',
};
const cls = (t: string) => colours[t] ?? 'bg-surface-raised text-muted border-line';
</script>
<template>
  <span
    :class="['inline-block text-[9px] font-bold font-mono px-1.5 py-0.5 rounded border', cls(type)]"
  >
    {{ type }}
  </span>
</template>
