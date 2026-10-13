import { ref } from 'vue';

const selectedId = ref<string | null>(null);

export function useParticipantSelection() {
  function select(id: string | null): void {
    selectedId.value = id;
  }

  function __resetForTests(): void {
    selectedId.value = null;
  }

  return { selectedId, select, __resetForTests };
}
