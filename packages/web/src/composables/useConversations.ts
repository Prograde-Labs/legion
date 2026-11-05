import { computed, getCurrentInstance, ref, watch } from 'vue';
import { useLegionApi } from './useLegionApi.js';
import { useToolStream } from './useToolStream.js';
import { useWebSocket } from './useWebSocket.js';
import type { ConversationMeta } from '@legion-collective/types';

const conversations = ref<ConversationMeta[]>([]);
const loading = ref(false);
const activeId = ref<string | null>(null);
const filter = ref<{ status: 'active' | 'archived' | 'all'; search: string }>({
  status: 'active',
  search: '',
});

let watchStarted = false;
/** Bumped on reset so an in-flight load cannot repopulate the store after logout. */
let generation = 0;

export function useConversations() {
  async function load(): Promise<void> {
    const requestGeneration = generation;
    loading.value = true;
    try {
      const { execute } = useLegionApi();
      const result = await execute<{ conversations: ConversationMeta[] }>('list_conversations', {
        status: filter.value.status,
      });
      if (requestGeneration !== generation) return; // reset while in flight — stale identity
      conversations.value = result.conversations;
    } finally {
      if (requestGeneration === generation) loading.value = false;
    }
  }
  const visible = computed(() => {
    const q = filter.value.search.trim().toLowerCase();
    if (!q) return conversations.value;
    return conversations.value.filter(
      (c) =>
        (c.title ?? c.id).toLowerCase().includes(q) ||
        c.participants.some((p) => p.toLowerCase().includes(q)),
    );
  });

  /** Drop the previous identity's list, selection and filter on logout. */
  function reset(): void {
    generation += 1;
    conversations.value = [];
    loading.value = false;
    activeId.value = null;
    filter.value = { status: 'active', search: '' };
  }

  // Live list (spec §4.1 sorted by recent activity): one module-scoped
  // watch_conversations stream reloads the list on every lifecycle event —
  // creation, message activity, status change. Started once when the socket
  // connects; matches the legacy ConversationsView wiring this rewrite replaced.
  // Only wire the stream watch from a component: useToolStream registers
  // onUnmounted, which warns when called outside a component instance.
  if (!watchStarted && getCurrentInstance()) {
    watchStarted = true;
    const ws = useWebSocket();
    const stream = useToolStream('watch_conversations', () => ({ status: filter.value.status }), {
      cancelOnUnmount: false,
      onChunk: () => void load(),
    });
    watch(
      () => ws.getConnectionId(),
      (id) => {
        if (id) void stream.start();
      },
      { immediate: true },
    );
  }

  return {
    conversations: visible,
    loading,
    load,
    filter,
    activeId,
    select(id: string | null) {
      activeId.value = id;
    },
    remove(id: string) {
      // Optimistic row drop after a successful delete_conversation call; the
      // watch_conversations stream reconciles the full list on the next event.
      conversations.value = conversations.value.filter((c) => c.id !== id);
    },
    reset,
    __resetForTests() {
      reset();
    },
    __setConversationsForTests(list: ConversationMeta[]) {
      conversations.value = list;
    },
  };
}
