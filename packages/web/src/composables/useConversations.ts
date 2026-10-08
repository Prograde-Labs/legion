import { computed, ref } from 'vue';
import { useLegionApi } from './useLegionApi.js';
import type { ConversationMeta } from '@legion-collective/types';

const conversations = ref<ConversationMeta[]>([]);
const loading = ref(false);
const activeId = ref<string | null>(null);
const filter = ref<{ status: 'active' | 'archived' | 'all'; search: string }>({
  status: 'active',
  search: '',
});

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
