<script setup lang="ts">
import type { ProcessStatus } from '@legion/types';

defineProps<{ status: ProcessStatus }>();

const colours: Record<ProcessStatus, string> = {
  running: 'bg-cyan-400 animate-pulse',
  starting: 'bg-amber-400',
  exited: 'bg-slate-500',
  killed: 'bg-red-400',
  abandoned: 'bg-navy-500',
};
</script>

<template>
  <span :class="['inline-block w-2 h-2 rounded-full', colours[status] ?? 'bg-navy-500']" />
</template>
