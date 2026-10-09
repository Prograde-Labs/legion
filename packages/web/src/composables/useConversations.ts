import { computed, ref, watch } from 'vue';
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

export function useConversations() {
  async function load(): Promise<void> {
    loading.value = true;
    try {
      const { execute } = useLegionApi();
      const result = await execute<{ conversations: ConversationMeta[] }>('list_conversations', {
        status: filter.value.status,
      });
      conversations.value = result.conversations;
    } finally {
      loading.value = false;
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

  // Live list (spec §4.1 sorted by recent activity): one module-scoped
  // watch_conversations stream reloads the list on every lifecycle event —
  // creation, message activity, status change. Started once when the socket
  // connects; matches the legacy ConversationsView wiring this rewrite replaced.
  if (!watchStarted) {
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
    __resetForTests() {
      conversations.value = [];
      loading.value = false;
      activeId.value = null;
      filter.value = { status: 'active', search: '' };
    },
    __setConversationsForTests(list: ConversationMeta[]) {
      conversations.value = list;
    },
  };
}
