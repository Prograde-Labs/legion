<script setup lang="ts">
import type { MessageEntry } from './ToolCallBlock.vue';
import ToolCallBlock from './ToolCallBlock.vue';
import MarkdownContent from '../MarkdownContent.vue';

defineProps<{ messages: MessageEntry[] }>();
</script>

<template>
  <div class="py-2 px-3 space-y-3">
    <div v-for="msg in messages" :key="msg.id">
      <div class="flex items-baseline gap-2 mb-1">
        <span :style="{ color: msg.authorColour }" class="text-xs font-bold">{{ msg.author }}</span>
        <span class="text-[10px] text-navy-500">{{ msg.timestamp }}</span>
      </div>
      <MarkdownContent :content="msg.content" class="text-[11px] text-slate-300 leading-relaxed" />
      <ToolCallBlock v-for="tc in msg.toolCalls ?? []" :key="tc.id" :entry="tc" />
    </div>
  </div>
</template>
