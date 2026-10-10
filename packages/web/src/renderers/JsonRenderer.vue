<script setup lang="ts">
defineOptions({ name: 'JsonRenderer' });
defineProps<{ tool: string; args?: unknown; result?: unknown }>();
function fmt(v: unknown) {
  return JSON.stringify(v, null, 2);
}
</script>
<template>
  <pre
    class="text-[10px] font-mono text-muted p-3 overflow-x-auto leading-relaxed whitespace-pre-wrap"
    >{{ fmt(result ?? args) }}</pre>
</template>
