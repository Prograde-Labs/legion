<script setup lang="ts">
import { computed } from 'vue';
import { lookupRenderer } from '../renderers/registry.js';

defineOptions({ name: 'ToolDetailPanel' }); // SFCs get __name, not name, from plugin-vue

const props = defineProps<{ payload: Record<string, unknown> }>();

const tool = computed(() => String(props.payload['tool'] ?? 'tool'));
const args = computed(() => props.payload['args']);
const result = computed(
  () => props.payload['result'] as { status?: string; data?: unknown; error?: string } | undefined,
);
const argsJson = computed(() => JSON.stringify(args.value ?? {}, null, 2));
const status = computed(() => (result.value ? (result.value.status ?? 'done') : 'pending'));
</script>

<template>
  <div class="flex h-full flex-col gap-2 overflow-y-auto p-3 text-sm">
    <div data-test="panel-tool" class="font-mono text-xs text-muted">{{ tool }}</div>
    <details class="rounded-md border border-line bg-surface px-2 py-1.5">
      <summary class="cursor-pointer text-xs text-faint">Inputs</summary>
      <pre class="overflow-x-auto font-mono text-xs">{{ argsJson }}</pre>
    </details>
    <div class="flex items-center gap-2 text-xs">
      <span
        data-test="panel-status"
        class="rounded-full px-2 py-0.5"
        :class="status === 'error' ? 'bg-danger/10 text-danger' : 'bg-accent-soft text-accent'"
        >{{ status }}</span
      >
      <span v-if="result?.error" class="truncate text-danger">{{ result.error }}</span>
    </div>
    <details v-if="result" class="rounded-md border border-line bg-surface px-2 py-1.5">
      <summary class="cursor-pointer text-xs text-faint">Result</summary>
      <component
        :is="lookupRenderer(tool)"
        :tool="tool"
        :args="args"
        :result="result.data ?? result"
      />
    </details>
  </div>
</template>
