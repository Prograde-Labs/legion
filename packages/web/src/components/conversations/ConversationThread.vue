<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import { useExecute } from '../../composables/useExecute.js';
import { useConversation } from '../../composables/useConversation.js';
import MessageBubble from './MessageBubble.vue';
import ToolCallBlock, { type ToolCallEntry, type MessageEntry } from './ToolCallBlock.vue';
import ApprovalCard from './ApprovalCard.vue';
import type { MessageData } from '@legion/types';

const props = defineProps<{
  conversationId: string | null;
  mode: 'read' | 'chat';
  myParticipantId: string;
  recipientName?: string;
  recipientId?: string;
}>();

const emit = defineEmits<{ sent: [conversationId: string] }>();

const { execute } = useExecute();
const { messages, subThreads, loading, isThinking, markSent } = useConversation(props.conversationId);

const composerText = ref('');
const sending = ref(false);
const threadEl = ref<HTMLElement | null>(null);

const canSend = computed(() =>
  props.mode === 'chat' &&
  composerText.value.trim().length > 0 &&
  (props.recipientId !== undefined || props.recipientName !== undefined),
);

async function send(targetId: string) {
  if (!canSend.value || sending.value || !targetId) return;
  sending.value = true;
  const text = composerText.value.trim();
  composerText.value = '';
  markSent();
  try {
    const result = await execute<{ conversationId: string }>('communicate', {
      to: targetId,
      message: text,
      conversationId: props.conversationId ?? undefined,
      replyTo: props.myParticipantId,
    });
    emit('sent', result.conversationId);
  } finally {
    sending.value = false;
  }
}

function onKeydown(e: KeyboardEvent, targetId: string) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    void send(targetId);
  }
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
    </div>

    <!-- Messages -->
    <div ref="threadEl" class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
      <div v-if="loading" class="text-xs text-slate-600 text-center">Loading...</div>

      <template v-else-if="mode === 'chat'">
        <!-- Empty state for draft -->
        <div v-if="messages.length === 0 && !conversationId" class="flex-1 flex items-center justify-center">
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
              v-for="tr in msg.toolResults?.filter(tr => tr.result.status === 'pending_approval')"
              :key="tr.id"
              :approval-id="tr.result.approvalId ?? ''"
              :tool-name="tr.name"
              :args="msg.toolCalls?.find(tc => tc.id === tr.id)?.arguments ?? {}"
              :resolved="false"
              :decision="null"
            />
            <!-- Resolved approval cards -->
            <ApprovalCard
              v-for="tr in msg.toolResults?.filter(tr => tr.result.status === 'rejected')"
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

        <!-- Thinking indicator -->
        <div v-if="isThinking" class="flex items-start gap-2">
          <div
            class="px-3 py-2 text-sm rounded-[12px_12px_12px_3px] bg-navy-800 text-slate-500"
            :class="isThinking === 'indeterminate' ? '' : 'animate-pulse'"
          >
            ...
          </div>
        </div>
      </template>

      <!-- Read-only mode — existing flat rendering (unchanged) -->
      <template v-else>
        <div v-for="msg in messages" :key="msg.id" class="text-sm text-slate-300">
          <span class="text-slate-500 text-xs">{{ msg.senderId }}</span>
          <p class="mt-0.5">{{ msg.content }}</p>
        </div>
      </template>
    </div>

    <!-- Composer — chat mode only, and only when we know the recipient -->
    <div v-if="mode === 'chat'" class="px-4 py-3 border-t border-navy-800 flex-shrink-0">
      <div class="flex gap-2 items-end">
        <textarea
          v-model="composerText"
          rows="1"
          :placeholder="recipientName ? `Message ${recipientName}...` : 'Type a message...'"
          class="flex-1 bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-cyan-700 max-h-24 overflow-y-auto"
          @keydown="(e) => onKeydown(e, recipientId ?? recipientName ?? '')"
        />
        <button
          :disabled="!canSend || sending"
          class="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
          :class="canSend ? 'bg-cyan-700 text-white hover:bg-cyan-600' : 'bg-navy-800 text-slate-600 cursor-not-allowed'"
          @click="send(recipientId ?? recipientName ?? '')"
        >
          Send
        </button>
      </div>
      <div class="text-xs text-slate-700 mt-1">Ctrl+Enter to send</div>
    </div>
  </div>
</template>
