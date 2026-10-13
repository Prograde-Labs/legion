<script setup lang="ts">
import type { ProcessStatus } from '@legion-collective/types';

defineProps<{ status: ProcessStatus }>();

const colours: Record<ProcessStatus, string> = {
  running: 'bg-accent animate-pulse',
  starting: 'bg-warning',
  exited: 'bg-faint',
  killed: 'bg-danger',
  abandoned: 'bg-faint',
};
</script>
<template>
  <span :class="['inline-block w-2 h-2 rounded-full', colours[status] ?? 'bg-faint']" />
</template>
