<script setup lang="ts">
import type { MessageData } from '@legion-collective/types';
import MarkdownContent from '../components/MarkdownContent.vue';

defineProps<{ message: MessageData }>();
</script>

<template>
  <div
    data-test="compaction-notice"
    class="mx-auto max-w-md rounded border border-line bg-surface/60 px-3 py-2 text-center text-xs text-muted"
  >
    <div class="font-medium">Conversation compacted</div>
    <MarkdownContent v-if="message.content" :content="message.content" class="mt-1 text-left" />
  </div>
</template>
