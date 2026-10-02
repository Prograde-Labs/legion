import { ref, onUnmounted, getCurrentInstance } from 'vue';
import type { Ref } from 'vue';
import { useExecute } from './useExecute.js';
import type { ProcessHandle } from '@legion-collective/types';

const processes: Ref<ProcessHandle[]> = ref([]);
const loading: Ref<boolean> = ref(false);
const error: Ref<string | null> = ref(null);
let consumerCount = 0;
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  const { execute } = useExecute();
  loading.value = true;
  try {
    processes.value = await execute<ProcessHandle[]>('list_processes', { status: 'all' });
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

export function useProcesses() {
  consumerCount++;
  void refresh();

  if (!pollInterval) {
    pollInterval = setInterval(() => void refresh(), 5000);
  }

  if (getCurrentInstance()) {
    onUnmounted(() => {
      consumerCount--;
      if (consumerCount === 0 && pollInterval !== null) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    });
  }

  return { processes, loading, error, refresh };
}
