import { ref, onUnmounted, getCurrentInstance } from 'vue';
import type { Ref } from 'vue';
import { useLegionApi } from './useLegionApi.js';
import type { ProcessHandle } from '@legion-collective/types';

const processes: Ref<ProcessHandle[]> = ref([]);
const loading: Ref<boolean> = ref(false);
const error: Ref<string | null> = ref(null);
let consumerCount = 0;
let pollInterval: ReturnType<typeof setInterval> | null = null;
/** Bumped on reset so an in-flight refresh cannot repopulate the store after logout. */
let generation = 0;

async function refresh(): Promise<void> {
  const requestGeneration = generation;
  const { execute } = useLegionApi();
  loading.value = true;
  try {
    const result = await execute<ProcessHandle[]>('list_processes', { status: 'all' });
    if (requestGeneration !== generation) return; // reset while in flight — stale identity
    processes.value = result;
    error.value = null;
  } catch (e) {
    if (requestGeneration !== generation) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (requestGeneration === generation) loading.value = false;
  }
}

/**
 * Drop the previous identity's processes on logout. Standalone so App can reset
 * without becoming a polling consumer (no refresh, no interval, no consumerCount).
 */
export function resetProcesses(): void {
  generation += 1;
  processes.value = [];
  loading.value = false;
  error.value = null;
}

export function useProcesses() {
  consumerCount++;
  void refresh();

  if (!pollInterval) {
    pollInterval = setInterval(() => {
      // Background tabs do not need fresh process lists; resume on the next tick
      // after visibility returns.
      if (typeof document !== 'undefined' && document.hidden) return;
      void refresh();
    }, 5000);
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

  return { processes, loading, error, refresh, reset: resetProcesses };
}
