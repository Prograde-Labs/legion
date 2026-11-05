<script setup lang="ts">
defineProps<{ status: 'active' | 'retired' | 'live' | 'complete' }>();
const colours: Record<string, string> = {
  active: 'bg-accent',
  live: 'bg-accent animate-pulse',
  complete: 'bg-success',
  retired: 'bg-faint',
};
</script>
<template>
  <span :class="['inline-block w-2 h-2 rounded-full', colours[status] ?? 'bg-faint']" />
</template>
