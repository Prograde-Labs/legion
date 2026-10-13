import { ref } from 'vue';
import { useLegionApi } from './useLegionApi.js';

export type ToolAccessPolicy = 'auto' | 'requires_approval';

const access = ref<Record<string, ToolAccessPolicy>>({});
const loaded = ref(false);
/** Bumped on reset so a refresh response that was in flight across a logout cannot land. */
let generation = 0;

export function useToolAccess() {
  async function refresh(): Promise<void> {
    const requestGeneration = generation;
    const { execute } = useLegionApi();
    const data = await execute<{ tools: string[]; callerPolicy: Record<string, ToolAccessPolicy> }>(
      'list_tools',
      {},
    );
    if (requestGeneration !== generation) return; // reset while in flight — stale identity's response is dropped
    access.value = data.callerPolicy ?? {};
    loaded.value = true;
  }
  function reset(): void {
    generation += 1;
    access.value = {};
    loaded.value = false;
  }
  function can(tool: string): 'auto' | 'requires_approval' | 'hidden' {
    if (!loaded.value) return 'hidden'; // fail closed before first fetch lands
    return access.value[tool] ?? 'hidden';
  }
  function __resetForTests(): void {
    access.value = {};
    loaded.value = false;
  }
  return { can, refresh, access, reset, __resetForTests };
}
