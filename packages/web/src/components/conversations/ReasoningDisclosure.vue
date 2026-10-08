<script setup lang="ts">
import MarkdownContent from '../MarkdownContent.vue';

defineOptions({ name: 'ReasoningDisclosure' });
defineProps<{ content: string; streaming: boolean }>();
</script>

<template>
  <div
    v-if="streaming"
    data-reasoning
    data-streaming-reasoning
    class="mb-2 rounded border border-line bg-surface/60 px-2.5 py-2 text-slate-400"
  >
    <div class="mb-1 text-xs font-medium text-cyan-500">Reasoning</div>
    <MarkdownContent :content="content" class="text-xs leading-relaxed" />
  </div>
  <details
    v-else
    data-reasoning
    class="mb-2 rounded border border-line bg-surface/60 px-2.5 py-2 text-slate-400"
  >
    <summary class="cursor-pointer select-none text-xs font-medium text-cyan-500">
      Reasoning
    </summary>
    <MarkdownContent :content="content" class="mt-2 text-xs leading-relaxed" />
  </details>
</template>
