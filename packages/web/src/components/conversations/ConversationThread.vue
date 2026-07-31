<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import { useExecute } from '../../composables/useExecute.js';
import { useConversation } from '../../composables/useConversation.js';
import type { MessageWithAlternates } from '../../composables/useConversation.js';
import MessageBubble from './MessageBubble.vue';
import ReasoningDisclosure from './ReasoningDisclosure.vue';
import CompactDialog from './CompactDialog.vue';
import ToolCallBlock, { type ToolCallEntry, type MessageEntry } from './ToolCallBlock.vue';
import ApprovalCard from './ApprovalCard.vue';
import type { MessageData } from '@legion/types';

const textareaEl = ref<HTMLTextAreaElement | null>(null);

function autoResize() {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

const props = defineProps<{
  conversationId: string | null;
  mode: 'read' | 'chat';
  myParticipantId: string;
  recipientName?: string;
  recipientId?: string;
}>();

const emit = defineEmits<{
  sent: [conversationId: string];
  delete: [conversationId: string];
}>();

const { execute } = useExecute();
const {
  messages,
  subThreads,
  loading,
  error,
  isThinking,
  isStreaming,
  isCancelling,
  streamingText,
  streamingReasoning,
  sentConversationId,
  send: sendStream,
  stop,
  editMessage,
  generate,
  pruneMessage,
  compactConversation,
  switchBranch,
} = useConversation(props.conversationId);

const composerText = ref('');
const sending = ref(false);
const threadEl = ref<HTMLElement | null>(null);

const trimmedStreamingText = computed(() => streamingText.value.trim());
const trimmedStreamingReasoning = computed(() => streamingReasoning.value.trim());
const hasStreamingResponse = computed(
  () => !!trimmedStreamingText.value || !!trimmedStreamingReasoning.value,
);

const compactOpen = ref(false);
const compactRange = ref<MessageWithAlternates[]>([]);
const compacting = ref(false);
const participants = ref<Array<{ id: string; name: string; type: string }>>([]);

const agents = computed(() =>
  participants.value
    .filter((participant) => participant.type === 'agent')
    .map((participant) => ({ id: participant.id, name: participant.name })),
);

async function loadParticipants() {
  const result = await execute<Array<{ id: string; name: string; type: string }>>(
    'list_participants',
    {},
  );
  participants.value = result ?? [];
}

async function openCompact(range: MessageWithAlternates[]) {
  compactRange.value = range;
  compactOpen.value = true;
  await loadParticipants();
}

async function handleEdit(messageId: string, content: string, rerun: boolean) {
  await editMessage(messageId, content);
  if (rerun && props.recipientId) {
    await generate(props.recipientId);
  }
}

function handleCompactAbove(messageId: string) {
  const idx = messages.value.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  void openCompact(messages.value.slice(0, idx + 1));
}

async function handleCompact(agentId: string, instruction: string) {
  compacting.value = true;
  try {
    await compactConversation(
      compactRange.value.map((message) => message.id),
      agentId,
      instruction,
    );
    compactOpen.value = false;
  } finally {
    compacting.value = false;
  }
}

async function handleRegenerate(messageId: string) {
  await pruneMessage(messageId);
  if (props.recipientId) {
    await generate(props.recipientId);
  }
}

const canSend = computed(
  () =>
    props.mode === 'chat' &&
    composerText.value.trim().length > 0 &&
    (props.recipientId !== undefined || props.recipientName !== undefined),
);

async function send(targetId: string) {
  if (!canSend.value || sending.value || isStreaming.value || isCancelling.value || !targetId)
    return;
  sending.value = true;
  const text = composerText.value.trim();
  composerText.value = '';
  await nextTick();
  autoResize();
  try {
    const convId = await sendStream(targetId, text, props.myParticipantId);
    if (convId) emit('sent', convId);
  } finally {
    sending.value = false;
  }
}

watch(sentConversationId, (id) => {
  if (id) {
    sentConversationId.value = null;
    emit('sent', id);
  }
});

function onKeydown(e: KeyboardEvent, targetId: string) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send(targetId);
  }
  // Shift+Enter falls through to default behavior (newline)
  nextTick(() => autoResize());
}

// Scroll to bottom when new messages arrive
watch(messages, async () => {
  await nextTick();
  threadEl.value?.scrollTo({ top: threadEl.value.scrollHeight, behavior: 'smooth' });
});

function isOwnMessage(msg: MessageData): boolean {
  return msg.senderId === props.myParticipantId;
}

function subThreadForToolCall(toolCallId: string): ToolCallEntry | null {
  const st = subThreads.value[toolCallId];
  if (!st) return null;
  const entries: MessageEntry[] = st.messages.map((m) => ({
    id: m.id,
    author: m.senderId,
    authorColour: '#f59e0b',
    content: m.content,
    timestamp: new Date(m.timestamp).toLocaleTimeString(),
  }));
  return {
    id: toolCallId,
    tool: 'communicate',
    type: 'delegation',
    args: undefined,
    result: undefined,
    timestamp: '',
    subThread: entries,
  };
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Thread header -->
    <div class="flex items-center gap-2 px-4 py-3 border-b border-navy-800 flex-shrink-0">
      <span v-if="conversationId" class="text-sm font-medium text-slate-200">
        {{ recipientName ?? conversationId }}
      </span>
      <span v-else class="text-sm text-slate-500">New conversation</span>
      <div v-if="conversationId" class="ml-auto flex gap-2">
        <button
          v-if="messages.length > 0"
          type="button"
          class="rounded border border-navy-700 px-2 py-1 text-xs text-cyan-400 hover:bg-navy-800"
          @click="openCompact(messages)"
        >
          Compact
        </button>
        <button
          type="button"
          class="text-slate-500 hover:text-red-400 transition-colors"
          title="Delete conversation"
          @click="emit('delete', conversationId)"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
            />
          </svg>
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div ref="threadEl" class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
      <div v-if="loading" class="text-xs text-slate-600 text-center">Loading...</div>

      <template v-else-if="mode === 'chat'">
        <!-- Empty state for draft -->
        <div
          v-if="messages.length === 0 && !conversationId"
          class="flex-1 flex items-center justify-center"
        >
          <div class="text-center text-slate-600 text-sm">
            Send a message to start the conversation
          </div>
        </div>

        <!-- Chat bubbles -->
        <MessageBubble
          v-for="msg in messages"
          :key="msg.id"
          :message="msg"
          :is-own="isOwnMessage(msg)"
          :sender-name="isOwnMessage(msg) ? 'you' : (recipientName ?? msg.senderId)"
          @edit="handleEdit"
          @prune="pruneMessage"
          @regenerate="handleRegenerate"
          @switch-branch="switchBranch"
          @compact-above="handleCompactAbove"
        >
          <template v-if="msg.toolCalls?.length" #tools>
            <!-- Tool call indicators: nested sub-thread for delegations, compact for others -->
            <template v-for="tc in msg.toolCalls" :key="tc.id">
              <ToolCallBlock
                v-if="subThreadForToolCall(tc.id)"
                :entry="subThreadForToolCall(tc.id)!"
              />
              <div
                v-else
                class="text-xs font-mono text-slate-500 px-2 py-1 bg-navy-900 rounded border border-navy-700"
              >
                {{ tc.name }}({{ JSON.stringify(tc.arguments).slice(0, 60) }}…)
              </div>
            </template>
            <!-- Approval card for pending_approval tool results -->
            <ApprovalCard
              v-for="tr in msg.toolResults?.filter((tr) => tr.result.status === 'pending_approval')"
              :key="tr.id"
              :approval-id="tr.result.approvalId ?? ''"
              :tool-name="tr.name"
              :args="msg.toolCalls?.find((tc) => tc.id === tr.id)?.arguments ?? {}"
              :resolved="false"
              :decision="null"
            />
            <!-- Resolved approval cards -->
            <ApprovalCard
              v-for="tr in msg.toolResults?.filter((tr) => tr.result.status === 'rejected')"
              :key="`resolved-${tr.id}`"
              :approval-id="''"
              :tool-name="tr.name"
              :args="{}"
              :resolved="true"
              decision="reject"
              :resolved-message="tr.result.message"
            />
          </template>
        </MessageBubble>

        <!-- Streaming response bubble -->
        <div v-if="hasStreamingResponse" data-streaming-message class="flex flex-col gap-1">
          <span class="text-xs text-slate-500 ml-1">{{ recipientName ?? 'Assistant' }}</span>
          <div
            class="px-3 py-2 text-sm rounded-[12px_12px_3px_12px] bg-navy-800 text-slate-200 max-w-[80%]"
          >
            <ReasoningDisclosure
              v-if="trimmedStreamingReasoning"
              :content="trimmedStreamingReasoning"
              :streaming="true"
            />
            <p v-if="trimmedStreamingText" data-streaming-answer class="whitespace-pre-wrap">
              {{ trimmedStreamingText }}<span class="animate-pulse">▋</span>
            </p>
          </div>
        </div>

        <!-- Thinking indicator -->
        <div v-if="isThinking && !hasStreamingResponse" class="flex items-start gap-2">
          <div
            class="px-3 py-2 text-sm rounded-[12px_12px_12px_3px] bg-navy-800 text-slate-500"
            :class="isThinking === 'indeterminate' ? '' : 'animate-pulse'"
          >
            ...
          </div>
        </div>
      </template>

      <!-- Read-only mode -->
      <template v-else>
        <div v-for="msg in messages" :key="msg.id" class="text-sm text-slate-300">
          <span class="text-slate-500 text-xs">{{ msg.senderId }}</span>
          <div
            v-if="msg.content?.trim() || (msg.role === 'assistant' && msg.reasoning?.trim())"
            data-read-only-body
            class="mt-0.5 max-w-[80%] rounded bg-navy-800 px-3 py-2"
          >
            <ReasoningDisclosure
              v-if="msg.role === 'assistant' && msg.reasoning?.trim()"
              :content="msg.reasoning.trim()"
              :streaming="false"
            />
            <p v-if="msg.content?.trim()">{{ msg.content }}</p>
          </div>
        </div>
      </template>
    </div>

    <!-- Composer — chat mode only, and only when we know the recipient -->
    <div v-if="mode === 'chat'" class="px-4 py-3 border-t border-navy-800 flex-shrink-0">
      <div class="flex gap-2 items-end">
        <textarea
          ref="textareaEl"
          v-model="composerText"
          rows="1"
          :placeholder="recipientName ? `Message ${recipientName}...` : 'Type a message...'"
          class="flex-1 bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-cyan-700 max-h-48 overflow-y-auto"
          @keydown="(e) => onKeydown(e, recipientId ?? recipientName ?? '')"
          @input="autoResize"
        />
        <button
          v-if="isStreaming || isCancelling"
          data-stop-button
          :disabled="isCancelling"
          class="px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-red-800 text-white hover:bg-red-700"
          @click="stop()"
        >
          Stop
        </button>
        <button
          v-else
          data-send-button
          :disabled="!canSend || sending"
          class="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
          :class="
            canSend
              ? 'bg-cyan-700 text-white hover:bg-cyan-600'
              : 'bg-navy-800 text-slate-600 cursor-not-allowed'
          "
          @click="send(recipientId ?? recipientName ?? '')"
        >
          Send
        </button>
      </div>
      <div v-if="error" data-composer-error class="mt-1 text-xs text-red-400">{{ error }}</div>
      <div class="text-xs text-slate-700 mt-1">Enter to send · Shift+Enter for new line</div>
    </div>

    <CompactDialog
      v-if="compactOpen"
      :messages="compactRange"
      :agents="agents"
      :loading="compacting"
      @compact="handleCompact"
      @cancel="compactOpen = false"
    />
  </div>
</template>
