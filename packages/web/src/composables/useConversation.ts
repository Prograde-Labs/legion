import { ref, computed, onMounted } from 'vue';
import { useExecute } from './useExecute.js';
import { useEventStream } from './useEventStream.js';
import type { ConversationData, MessageData } from '@legion/types';

function buildActiveChain(data: ConversationData): MessageData[] {
  const messages = data.messages;
  const chain: MessageData[] = [];
  let currentId: string | null = data.activeBranchHead;

  while (currentId) {
    const msg = messages[currentId];
    if (!msg || msg.status !== 'active') break;
    chain.unshift(msg);
    currentId = msg.parentId;
  }

  return chain;
}

export function useConversation(conversationId: string | null) {
  const { execute } = useExecute();
  const { on } = useEventStream();

  const messages = ref<MessageData[]>([]);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const isThinkingLocal = ref(false); // set when user sends in this tab
  const iterationFired = ref(false);  // set when iteration event arrives

  const isThinking = computed(() => {
    if (isThinkingLocal.value || iterationFired.value) return true;
    // Indeterminate: last message is user with no assistant reply
    const last = messages.value.at(-1);
    return !!last && last.role === 'user' && !iterationFired.value && !isThinkingLocal.value
      ? 'indeterminate'
      : false;
  });

  async function load() {
    if (!conversationId) return;
    loading.value = true;
    error.value = null;
    try {
      const data = await execute<ConversationData>('get_conversation', { conversationId });
      messages.value = buildActiveChain(data);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function markSent() {
    isThinkingLocal.value = true;
  }

  if (conversationId) {
    on('message:sent', (payload) => {
      // Reload conversation to get the new message in correct chain order
      void load();
      // If assistant message arrived, clear thinking state
      if ((payload as any).role === 'assistant') {
        isThinkingLocal.value = false;
        iterationFired.value = false;
      }
    }, { conversationId });

    on('iteration', () => {
      iterationFired.value = true;
    }, { conversationId });

    on('approval:requested', () => {
      isThinkingLocal.value = false;
      iterationFired.value = false;
      void load(); // reload to get the pending_approval tool result
    }, { conversationId });

    on('approval:resolved', () => {
      iterationFired.value = true; // agent will resume
      void load();
    }, { conversationId });

    on('tool:result', () => {
      void load(); // keep tool call blocks in sync
    }, { conversationId });

    onMounted(() => { void load(); });
  }

  return { messages, loading, error, isThinking, load, markSent };
}
