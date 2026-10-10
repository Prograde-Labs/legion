<script setup lang="ts">
defineProps<{
  tool: string;
  status: 'running' | 'done' | 'error';
  payload?: Record<string, unknown>;
}>();

const emit = defineEmits<{ open: [tool: string, payload: Record<string, unknown>] }>();
</script>

<template>
  <button
    type="button"
    data-test="tool-chip"
    class="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted hover:bg-surface-raised"
    @click="emit('open', tool, payload ?? {})"
  >
    <span
      v-if="status === 'running'"
      class="size-1.5 animate-pulse rounded-full bg-accent"
      aria-hidden="true"
    />
    <span v-else-if="status === 'error'" class="text-danger">✕</span>
    <span class="truncate font-mono">{{ tool }}</span>
  </button>
</template>
