<script setup lang="ts">
import { ref } from 'vue';
import Thread from '../chat/Thread.vue';

const props = defineProps<{ payload: Record<string, unknown> }>();

const emit = defineEmits<{ jump: [messageId: string] }>();

const conversationId = ref<string>(String(props.payload['conversationId'] ?? ''));
const highlight = ref({
  outboundMessageId: props.payload['outboundMessageId'] as string | undefined,
  replyMessageId: props.payload['replyMessageId'] as string | undefined,
});
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted">
      <span>Sub-chat {{ conversationId }}</span>
      <button
        v-if="highlight.replyMessageId"
        type="button"
        data-test="jump-to-message"
        class="ml-auto rounded bg-surface px-2 py-0.5 hover:bg-surface-raised"
        @click="emit('jump', highlight.replyMessageId!)"
      >
        Jump to message in main thread
      </button>
    </div>
    <div class="min-h-0 flex-1">
      <Thread :conversation-id="conversationId" :highlight="highlight" />
    </div>
  </div>
</template>
