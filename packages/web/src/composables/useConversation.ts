import { ref, computed, watch, onMounted } from 'vue';
import { useExecute } from './useExecute.js';
import { useToolStream } from './useToolStream.js';
import { useWebSocket } from './useWebSocket.js';
import type { MessageData, StreamChunk } from '@legion/types';

export type MessageWithAlternates = MessageData & {
  alternates?: Array<{ id: string; content: string; timestamp: string; status: string }>;
};

export interface SubThreadData {
  id: string;
  title?: string;
  messages: MessageWithAlternates[];
  parentConversationId?: string;
  parentToolCallId?: string;
}

// Shape returned by the get_conversation tool (messages already as ordered array)
interface ConversationResponse {
  id: string;
  title?: string;
  messages: MessageWithAlternates[];
  subThreads?: Record<string, SubThreadData>;
}

export function useConversation(conversationId: string | null) {
  const { execute } = useExecute();

  const messages = ref<MessageWithAlternates[]>([]);
  const subThreads = ref<Record<string, SubThreadData>>({});
  const loading = ref(conversationId !== null);
  const error = ref<string | null>(null);
  const isThinkingLocal = ref(false); // set when user sends in this tab
  const iterationFired = ref(false); // set when iteration event arrives
  const stoppedLocal = ref(false); // set when user stops the run in this tab
  const streamingText = ref('');
  const streamingReasoning = ref('');
  const sentConversationId = ref<string | null>(null);
  let loadSeq = 0; // prevents stale concurrent load() responses from overwriting newer data

  const isThinking = computed(() => {
    if (stoppedLocal.value) return false;
    if (isThinkingLocal.value || iterationFired.value) return true;
    if (error.value) return false;
    // Indeterminate: last message is user with no assistant reply
    const last = messages.value.at(-1);
    return !!last && last.role === 'user' ? 'indeterminate' : false;
  });

  async function load() {
    if (!conversationId) return;
    loading.value = true;
    error.value = null;
    const seq = ++loadSeq;
    try {
      const data = await execute<ConversationResponse>('get_conversation', { conversationId });
      // Discard if a newer load() has already started
      if (seq !== loadSeq) return;
      messages.value = data.messages;
      subThreads.value = data.subThreads ?? {};
    } catch (err) {
      if (seq === loadSeq) {
        error.value = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (seq === loadSeq) {
        loading.value = false;
      }
    }
  }

  function markSent() {
    error.value = null;
    isThinkingLocal.value = true;
    stoppedLocal.value = false;
  }

  async function editMessage(messageId: string, newContent: string): Promise<string> {
    if (!conversationId) throw new Error('conversationId required');
    const result = await execute<{ newMessageId: string }>('edit_message', {
      conversationId,
      messageId,
      newContent,
    });
    await load();
    return result.newMessageId;
  }

  async function generate(agentId: string): Promise<void> {
    if (!conversationId) throw new Error('conversationId required');
    markSent();
    await execute('generate', { conversationId, agentId });
  }

  async function pruneMessage(messageId: string): Promise<void> {
    if (!conversationId) throw new Error('conversationId required');
    await execute('prune_message', { conversationId, messageId });
    await load();
  }

  async function compactConversation(
    messageIds: string[],
    agentId?: string,
    instruction?: string,
  ): Promise<void> {
    if (!conversationId) throw new Error('conversationId required');
    await execute('compact_conversation', { conversationId, messageIds, agentId, instruction });
    await load();
  }

  async function switchBranch(messageId: string): Promise<void> {
    if (!conversationId) throw new Error('conversationId required');
    await execute('switch_branch', { conversationId, messageId });
    await load();
  }

  let pendingCommunicateArgs: {
    to: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
  } = {
    to: '',
    message: '',
  };

  const communicateStream = useToolStream('communicate', () => pendingCommunicateArgs, {
    cancelOnUnmount: false,
    onChunk: (chunk: StreamChunk) => {
      if (chunk.type === 'iteration_start') {
        streamingText.value = '';
        streamingReasoning.value = '';
      } else if (chunk.type === 'message_snapshot') {
        streamingText.value = chunk.content;
        streamingReasoning.value = chunk.reasoning ?? '';
      } else if (chunk.type === 'reasoning_delta') {
        streamingReasoning.value += chunk.delta;
      } else if (chunk.type === 'text_delta') {
        streamingText.value += chunk.delta;
      }
    },
  });

  async function send(
    targetId: string,
    message: string,
    myParticipantId: string,
  ): Promise<string | null> {
    pendingCommunicateArgs = {
      to: targetId,
      message,
      conversationId: conversationId ?? undefined,
    };
    streamingText.value = '';
    streamingReasoning.value = '';
    markSent();

    // Optimistic user message for new conversation (no server to load from yet)
    if (!conversationId) {
      messages.value = [
        {
          id: 'optimistic-user',
          parentId: null,
          conversationId: 'pending',
          senderId: myParticipantId,
          recipientId: targetId,
          role: 'user',
          content: message,
          type: 'message',
          status: 'active',
          timestamp: new Date().toISOString(),
        },
      ];
    }

    await communicateStream.start();
    return conversationId;
  }

  const isStreaming = communicateStream.active;

  async function stop(): Promise<void> {
    await communicateStream.cancel();
    isThinkingLocal.value = false;
    iterationFired.value = false;
    stoppedLocal.value = true;
    streamingText.value = '';
    streamingReasoning.value = '';
  }

  watch(
    () => communicateStream.done.value,
    (done) => {
      if (!done) return;
      streamingText.value = '';
      streamingReasoning.value = '';
      const result = communicateStream.result.value as {
        data?: { conversationId?: string };
      } | null;
      const newConvId = result?.data?.conversationId;
      if (newConvId && !conversationId) {
        sentConversationId.value = newConvId;
      }
    },
  );

  watch(
    () => communicateStream.error.value,
    (streamError) => {
      if (!streamError) return;
      error.value = streamError;
      isThinkingLocal.value = false;
      iterationFired.value = false;
      streamingText.value = '';
      streamingReasoning.value = '';
    },
  );

  if (conversationId) {
    const ws = useWebSocket();

    const msgStream = useToolStream('watch_conversation', () => ({ conversationId }), {
      onChunk: (chunk) => {
        if (chunk.type === 'message:sent') {
          void load();
        } else if (chunk.type === 'message:delivered') {
          isThinkingLocal.value = false;
          iterationFired.value = false;
          streamingText.value = '';
          streamingReasoning.value = '';
          void load();
        }
      },
    });

    const activityStream = useToolStream('watch_activity', () => ({ conversationId }), {
      onChunk: (chunk) => {
        if (chunk.type === 'iteration') {
          iterationFired.value = true;
        } else if (chunk.type === 'approval:requested') {
          isThinkingLocal.value = false;
          iterationFired.value = false;
          void load();
        } else if (chunk.type === 'approval:resolved') {
          iterationFired.value = true;
          void load();
        } else if (chunk.type === 'tool:result') {
          void load();
        }
      },
    });

    watch(
      () => ws.getConnectionId(),
      async (id) => {
        if (!id) return;
        await Promise.all([msgStream.start(), activityStream.start()]);
      },
      { immediate: true },
    );

    onMounted(() => {
      void load();
    });
  }

  return {
    messages,
    subThreads,
    loading,
    error,
    isThinking,
    isStreaming,
    streamingText,
    streamingReasoning,
    sentConversationId,
    load,
    markSent,
    send,
    stop,
    editMessage,
    generate,
    pruneMessage,
    compactConversation,
    switchBranch,
  };
}
