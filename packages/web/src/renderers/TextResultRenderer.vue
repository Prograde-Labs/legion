<script setup lang="ts">
import { computed } from 'vue';
import { AnsiUp } from 'ansi_up';

const props = defineProps<{ tool: string; args?: unknown; result?: unknown }>();

const html = computed(() => {
  const r = props.result;
  if (typeof r === 'string') return new AnsiUp().ansi_to_html(r);
  return null;
});
const text = computed(() => {
  const r = props.result;
  if (typeof r === 'string') return null;
  return JSON.stringify(r, null, 2);
});
</script>

<template>
  <pre v-if="html !== null" class="max-w-full overflow-x-auto font-mono text-xs" v-html="html" />
  <pre v-else class="max-w-full overflow-x-auto font-mono text-xs">{{ text }}</pre>
</template>
