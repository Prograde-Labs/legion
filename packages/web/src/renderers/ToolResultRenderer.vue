<script setup lang="ts">
import { computed } from 'vue';
import { lookupRenderer } from './registry.js';

const props = defineProps<{ tool: string; args?: unknown; result?: unknown }>();
const renderer = computed(() => lookupRenderer(props.tool));
</script>
<template>
  <component :is="renderer" :tool="tool" :args="args" :result="result" />
</template>
