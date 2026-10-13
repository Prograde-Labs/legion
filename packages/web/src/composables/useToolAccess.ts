import { ref } from 'vue';
import { useLegionApi } from './useLegionApi.js';

export type ToolAccessPolicy = 'auto' | 'requires_approval';

const access = ref<Record<string, ToolAccessPolicy>>({});
const loaded = ref(false);

export function useToolAccess() {
  async function refresh(): Promise<void> {
    const { execute } = useLegionApi();
    const data = await execute<{ tools: string[]; callerPolicy: Record<string, ToolAccessPolicy> }>(
      'list_tools',
      {},
    );
    access.value = data.callerPolicy ?? {};
    loaded.value = true;
  }
  function can(tool: string): 'auto' | 'requires_approval' | 'hidden' {
    if (!loaded.value) return 'hidden'; // fail closed before first fetch lands
    return access.value[tool] ?? 'hidden';
  }
  function __resetForTests(): void {
    access.value = {};
    loaded.value = false;
  }
  return { can, refresh, access, __resetForTests };
}
