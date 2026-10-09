<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useToolStream } from '../composables/useToolStream.js';
import MessagePart from './MessagePart.vue';
import ForkControls from './ForkControls.vue';
import MessageActions from './MessageActions.vue';
import ApprovalCard from './ApprovalCard.vue';
import { useApprovals, type PendingApproval } from '../composables/useApprovals.js';
import type { MessageData, StreamChunk } from '@legion-collective/types';

// Shape returned by the get_conversation tool (messages already as ordered array).
// Mirrors useConversation.ts's exported type.
type MessageWithAlternates = MessageData & {
  alternates?: Array<{ id: string; content: string; timestamp: string; status: string }>;
};

const props = defineProps<{
  conversationId: string | null;
  highlight?: { outboundMessageId?: string; replyMessageId?: string } | null;
}>();

const emit = defineEmits<{ open: [tool: string, payload: Record<string, unknown>] }>();

const { execute } = useLegionApi();

const approvals = useApprovals();

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
const streamError = ref<string | null>(null);
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

function approvalsFor(message: MessageWithAlternates): PendingApproval[] {
  if (!props.conversationId) return [];
  return approvals.pending.value.filter(
    (p) =>
      p.conversationId === props.conversationId &&
      (message.toolCalls ?? []).some((tc) => tc.name === p.tool),
  );
}

function onResolved(approvalId: string): void {
  approvals.removeLocal(approvalId);
}

const inlineApprovalIds = computed(
  () => new Set(messages.value.flatMap((m) => approvalsFor(m).map((a) => a.approvalId))),
);
const tailApprovals = computed(() =>
  props.conversationId
    ? approvals.pending.value.filter(
        (p) =>
          p.conversationId === props.conversationId && !inlineApprovalIds.value.has(p.approvalId),
      )
    : [],
);

// Live tokens: stream the communicate tool the carried-over way. Final-review
// C1/I1 fix: ChatView drives sends through the exposed send(); conversationId
// is required here or the backend creates a NEW conversation instead of
// appending to the viewed one.
let pendingArgs: { to: string; message: string; conversationId?: string } = {
  to: '',
  message: '',
};
const stream = useToolStream('communicate', () => pendingArgs, {
  cancelOnUnmount: false,
  onChunk: (chunk: StreamChunk) => {
    if (chunk.type === 'iteration_start') {
      isStreaming.value = true;
      streamError.value = null;
      streamingText.value = '';
      streamingReasoning.value = '';
    } else if (chunk.type === 'message_snapshot') {
      isStreaming.value = true;
      streamingText.value = chunk.content;
      streamingReasoning.value = chunk.reasoning ?? '';
    } else if (chunk.type === 'text_delta') {
      isStreaming.value = true;
      streamingText.value += chunk.delta;
    } else if (chunk.type === 'stream:done' || chunk.type === 'stream:error') {
      isStreaming.value = false;
      void load();
    }
  },
});

// stream:done / stream:error are lifecycle chunks consumed inside useToolStream
// (they never reach onChunk), so surface its terminal state here: error ref on
// failure; done watch resets isStreaming and reloads the thread so the sent
// message + final reply render. Cleared on the next iteration_start above.
watch(stream.done, (isDone) => {
  if (isDone) {
    isStreaming.value = false;
    void load();
  }
});
watch(stream.error, (err) => {
  if (err) {
    streamError.value = err;
    isStreaming.value = false;
  }
});

// Step 3d + final-review C1/I1 fix: ChatView drives sends through the exposed
// send() — it populates pendingArgs and starts the streaming communicate POST
// (start() IS the send; Composer hands off instead of executing itself).
// `streaming` covers both the POST window (stream.active) and the chunk window
// (isStreaming) so Composer's Stop button is visible the whole time.
defineExpose({
  cancelStream: (): Promise<void> => stream.cancel(),
  send: async (to: string, message: string): Promise<void> => {
    pendingArgs = { to, message, conversationId: props.conversationId ?? undefined };
    await stream.start();
  },
  streaming: computed(() => stream.active.value || isStreaming.value),
});

watch(
  () => props.conversationId,
  () => void load(),
  { immediate: true },
);

// Highlight scroll: when a highlight lands, the count watch tail scrolls it into
// view (guarded so plain tail-scrolls stay unchanged); else plain bottom-scroll.
watch(
  () => messages.value.length,
  async () => {
    await nextTick();
    if (tailEl.value) tailEl.value.scrollTop = tailEl.value.scrollHeight;
    if (props.highlight?.replyMessageId) {
      tailEl.value?.querySelector('[data-highlight="true"]')?.scrollIntoView({ block: 'center' });
    }
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div v-if="error" class="px-4 py-2 text-sm text-danger">{{ error }}</div>
    <div v-if="streamError" data-test="stream-error" class="px-4 py-2 text-sm text-danger">
      {{ streamError }}
    </div>
    <div ref="tailEl" class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div class="mx-auto flex max-w-3xl flex-col gap-4">
        <div v-for="m in messages" :key="m.id" class="flex flex-col gap-2">
          <div
            :data-highlight="
              highlight &&
              (m.id === highlight.outboundMessageId || m.id === highlight.replyMessageId)
                ? 'true'
                : undefined
            "
            :class="{
              'ring-1 ring-accent':
                highlight &&
                (m.id === highlight.outboundMessageId || m.id === highlight.replyMessageId),
            }"
          >
            <MessagePart :message="m" @open="(tool, payload) => emit('open', tool, payload)">
              <template v-if="conversationId" #actions="{ message: msg }">
                <div class="mt-1 flex flex-wrap items-center gap-2">
                  <ForkControls :conversation-id="conversationId" :message="msg" @switched="load" />
                  <MessageActions
                    :conversation-id="conversationId"
                    :message="msg"
                    @mutated="load"
                  />
                </div>
              </template>
            </MessagePart>
            <ApprovalCard
              v-for="a in approvalsFor(m)"
              :key="a.approvalId"
              :approval="a"
              @resolved="onResolved(a.approvalId)"
            />
          </div>
        </div>
        <ApprovalCard
          v-for="a in tailApprovals"
          :key="a.approvalId"
          :approval="a"
          @resolved="onResolved(a.approvalId)"
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
