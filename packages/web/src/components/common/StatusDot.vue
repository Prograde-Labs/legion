<script setup lang="ts">
defineProps<{ status: 'active' | 'retired' | 'live' | 'complete' }>();
const colours: Record<string, string> = {
  active: 'bg-cyan-400',
  live: 'bg-cyan-400 animate-pulse',
  complete: 'bg-green-400',
  retired: 'bg-faint',
};
</script>
<template>
  <span :class="['inline-block w-2 h-2 rounded-full', colours[status] ?? 'bg-faint']" />
</template>
