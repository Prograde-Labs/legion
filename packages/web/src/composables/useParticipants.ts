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
  /** Drop the previous identity's roster on logout. */
  function reset(): void {
    participants.value = [];
    loading.value = false;
  }
  return {
    participants,
    loading,
    load,
    byId: (id: string): BaseParticipant | undefined => byId.value(id),
    reset,
    __resetForTests() {
      reset();
    },
    __setParticipantsForTests(list: BaseParticipant[]) {
      participants.value = list;
    },
  };
}
