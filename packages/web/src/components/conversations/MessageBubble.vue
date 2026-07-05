<script setup lang="ts">
import type { MessageData } from '@legion/types';
import MarkdownContent from '../MarkdownContent.vue';

defineProps<{
  message: MessageData;
  isOwn: boolean;
  senderName: string;
}>();
</script>

<template>
  <div data-bubble class="flex flex-col gap-1" :class="isOwn ? 'items-end' : 'items-start'">
    <MarkdownContent
      v-if="message.content?.trim()"
      :content="message.content.trim()"
      class="max-w-[72%] px-3 py-2 text-sm leading-relaxed break-words"
      :class="
        isOwn
          ? 'bg-cyan-700 text-white rounded-[12px_12px_3px_12px]'
          : 'bg-navy-800 text-slate-200 rounded-[12px_12px_12px_3px]'
      "
    />

    <!-- Tool calls / approval cards slot — rendered beneath the bubble -->
    <div v-if="$slots.tools" class="max-w-[72%] flex flex-col gap-1.5">
      <slot name="tools" />
    </div>

    <span class="text-xs text-navy-600">
      {{ senderName }}
    </span>
  </div>
</template>
