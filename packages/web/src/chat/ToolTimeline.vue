<script setup lang="ts">
import type { DetailLevel } from '@legion-collective/types';

interface ToolCallView {
  index: number;
  name: string;
  args: string;
}

const props = defineProps<{ calls: ToolCallView[]; detail: DetailLevel }>();

function summary(args: string): string {
  const trimmed = args.trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 80)}…`;
}
</script>

<template>
  <div
    v-if="props.detail !== 'minimal' && props.calls.length > 0"
    data-test="tool-timeline"
    class="flex flex-col gap-1 text-xs text-muted"
  >
    <div v-for="call in props.calls" :key="call.index" data-test="tool-call">
      <span class="font-mono">🔧 {{ call.name }}</span>
      <span
        v-if="props.detail === 'full' && summary(call.args)"
        data-test="tool-args"
        class="ml-2 font-mono text-faint"
      >
        {{ summary(call.args) }}
      </span>
    </div>
  </div>
</template>
