<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useToolStream } from '../composables/useToolStream.js';
import MessagePart from './MessagePart.vue';
import type { MessageData, StreamChunk } from '@legion-collective/types';

// Shape returned by the get_conversation tool (messages already as ordered array).
// Mirrors useConversation.ts's exported type.
type MessageWithAlternates = MessageData & {
  alternates?: Array<{ id: string; content: string; timestamp: string; status: string }>;
};

const props = defineProps<{ conversationId: string | null }>();

const emit = defineEmits<{ open: [tool: string, payload: Record<string, unknown>] }>();

const { execute } = useLegionApi();

interface ConversationResponse {
  id: string;
  title?: string;
  messages: MessageWithAlternates[];
}

const messages = ref<MessageWithAlternates[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const streamingText = ref('');
const streamingReasoning = ref('');
const isStreaming = ref(false);
const tailEl = ref<HTMLElement | null>(null);
let loadSeq = 0;

async function load(): Promise<void> {
  if (!props.conversationId) {
    messages.value = [];
    return;
  }
  loading.value = true;
  error.value = null;
  const seq = ++loadSeq;
  try {
    const data = await execute<ConversationResponse>('get_conversation', {
      conversationId: props.conversationId,
    });
    if (seq !== loadSeq) return;
    messages.value = data.messages;
  } catch (err) {
    if (seq === loadSeq) error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

// Live tokens: stream the communicate tool the carried-over way. Task 12 wires
// send/stop; this task renders loaded + streamed state correctly.
let pendingArgs: { to: string; message: string } = { to: '', message: '' };
useToolStream('communicate', () => pendingArgs, {
  cancelOnUnmount: false,
  onChunk: (chunk: StreamChunk) => {
    if (chunk.type === 'iteration_start') {
      streamingText.value = '';
      streamingReasoning.value = '';
    } else if (chunk.type === 'message_snapshot') {
      streamingText.value = chunk.content;
      streamingReasoning.value = chunk.reasoning ?? '';
    } else if (chunk.type === 'text_delta') {
      streamingText.value += chunk.delta;
    } else if (chunk.type === 'stream:done' || chunk.type === 'stream:error') {
      isStreaming.value = false;
      void load();
    }
  },
});

watch(
  () => props.conversationId,
  () => void load(),
  { immediate: true },
);

watch(
  () => messages.value.length,
  async () => {
    await nextTick();
    if (tailEl.value) tailEl.value.scrollTop = tailEl.value.scrollHeight;
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div v-if="error" class="px-4 py-2 text-sm text-danger">{{ error }}</div>
    <div ref="tailEl" class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div class="mx-auto flex max-w-3xl flex-col gap-4">
        <MessagePart
          v-for="m in messages"
          :key="m.id"
          :message="m"
          @open="(tool, payload) => emit('open', tool, payload)"
        />
        <div v-if="isStreaming" data-test="streaming-part" class="flex flex-col gap-2">
          <MessagePart
            v-if="streamingReasoning || streamingText"
            :message="{
              id: 'streaming',
              parentId: null,
              conversationId: 'streaming',
              senderId: 'assistant',
              recipientId: 'user',
              role: 'assistant',
              content: streamingText,
              reasoning: streamingReasoning || undefined,
              timestamp: new Date().toISOString(),
              status: 'active',
            }"
            streaming
          />
        </div>
      </div>
    </div>
  </div>
</template>
