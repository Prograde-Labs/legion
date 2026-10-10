import { computed, ref } from 'vue';
import { useLegionApi } from './useLegionApi.js';
import type { BaseParticipant } from '@legion-collective/types';

const participants = ref<BaseParticipant[]>([]);
const loading = ref(false);

export function useParticipants() {
  async function load(): Promise<void> {
    loading.value = true;
    try {
      const { execute } = useLegionApi();
      participants.value = await execute<BaseParticipant[]>('list_participants', {});
    } finally {
      loading.value = false;
    }
  }
  const byId = computed(() => {
    const map = new Map<string, BaseParticipant>();
    for (const p of participants.value) map.set(p.id, p);
    return (id: string): BaseParticipant | undefined => map.get(id);
  });
  return {
    participants,
    loading,
    load,
    byId: (id: string): BaseParticipant | undefined => byId.value(id),
    __resetForTests() {
      participants.value = [];
      loading.value = false;
    },
    __setParticipantsForTests(list: BaseParticipant[]) {
      participants.value = list;
    },
  };
}
