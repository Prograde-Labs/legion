import { ref, computed, onMounted } from 'vue';
import { useExecute } from './useExecute.js';
import { useEventStream } from './useEventStream.js';
import type { MessageData } from '@legion/types';

export interface SubThreadData {
  id: string;
  title?: string;
  messages: MessageData[];
  parentConversationId?: string;
  parentToolCallId?: string;
}

// Shape returned by the get_conversation tool (messages already as ordered array)
interface ConversationResponse {
  id: string;
  title?: string;
  messages: MessageData[];
  subThreads?: Record<string, SubThreadData>;
}

export function useConversation(conversationId: string | null) {
  const { execute } = useExecute();
  const { on } = useEventStream();

  const messages = ref<MessageData[]>([]);
  const subThreads = ref<Record<string, SubThreadData>>({});
  const loading = ref(conversationId !== null);
  const error = ref<string | null>(null);
  const isThinkingLocal = ref(false); // set when user sends in this tab
  const iterationFired = ref(false); // set when iteration event arrives
  let loadSeq = 0; // prevents stale concurrent load() responses from overwriting newer data

  const isThinking = computed(() => {
    if (isThinkingLocal.value || iterationFired.value) return true;
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
    isThinkingLocal.value = true;
  }

  if (conversationId) {
    on(
      'message:sent',
      () => {
        // Outgoing user message confirmed — keep thinking indicator active.
        void load();
      },
      { conversationId },
    );

    // message:delivered fires when the agent's async reply is persisted and
    // delivered back to the operator. This is the primary "reply arrived" signal.
    on(
      'message:delivered',
      () => {
        isThinkingLocal.value = false;
        iterationFired.value = false;
        void load();
      },
      { conversationId },
    );

    on(
      'iteration',
      () => {
        // iteration events are scoped to the agent's participantId on the server,
        // so the operator only receives them if they ARE the agent (not typical).
        // We still set iterationFired in case the scope rules change.
        iterationFired.value = true;
      },
      { conversationId },
    );

    on(
      'approval:requested',
      () => {
        isThinkingLocal.value = false;
        iterationFired.value = false;
        void load(); // reload to get the pending_approval tool result
      },
      { conversationId },
    );

    on(
      'approval:resolved',
      () => {
        iterationFired.value = true; // agent will resume
        void load();
      },
      { conversationId },
    );

    on(
      'tool:result',
      () => {
        void load(); // keep tool call blocks in sync
      },
      { conversationId },
    );

    onMounted(() => {
      void load();
    });
  }

  return { messages, subThreads, loading, error, isThinking, load, markSent };
}
