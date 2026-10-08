<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useAuth } from '../composables/useAuth.js';
import ToolPolicyEditor, {
  type ToolOverride,
} from '../components/participants/ToolPolicyEditor.vue';
import MiddlewareEditor from '../components/participants/MiddlewareEditor.vue';
import type { MiddlewareInstanceConfig } from '@legion-collective/types';

const props = defineProps<{ participantId: string | 'new' }>();

const emit = defineEmits<{ saved: [id: string]; retired: [] }>();

const { execute } = useLegionApi();
const auth = useAuth();

const name = ref('');
const modelText = ref('');
const systemPrompt = ref('');
const maxIterations = ref(20);
const overrides = ref<ToolOverride[]>([]);
const availableTools = ref<string[]>([]);
const modelOptions = ref<{ provider: string; model: { model: string } }[]>([]);
const middleware = ref<MiddlewareInstanceConfig[]>([]);
const middlewareDefinitions = ref<never[]>([]);
const authorityWildcard = ref(false);
const authorityTools = ref<Record<string, boolean>>({});
const loaded = ref<{ protected?: boolean } | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const confirmingRetire = ref(false);

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'agent'
  );
}

function overridesToToolsMap(list: ToolOverride[]): Record<string, 'auto' | 'requires_approval'> {
  return Object.fromEntries(
    list
      .filter((o) => o.enabled)
      .map((o) => [o.tool, o.requireApproval ? 'requires_approval' : 'auto']),
  );
}

async function load(): Promise<void> {
  error.value = null;
  if (props.participantId === 'new') {
    loaded.value = null;
    return;
  }
  try {
    const p = await execute<Record<string, unknown>>('get_participant', {
      id: props.participantId,
    });
    loaded.value = p;
    name.value = String(p['name'] ?? '');
    const model = p['model'] as { model?: string } | undefined;
    modelText.value = model?.model ?? '';
    systemPrompt.value = String(p['systemPrompt'] ?? '');
    maxIterations.value = Number(p['maxIterations'] ?? 20);
    const toolsMap = (p['tools'] ?? {}) as Record<string, string>;
    overrides.value = Object.entries(toolsMap).map(([tool, policy]) => ({
      tool,
      source: 'built-in',
      enabled: true,
      requireApproval: policy === 'requires_approval',
    }));
    middleware.value = (p['middleware'] as MiddlewareInstanceConfig[]) ?? [];
    const authority = p['approvalAuthority'] as { tools?: Record<string, boolean> | '*' } | null;
    authorityWildcard.value = authority?.tools === '*';
    authorityTools.value = authority?.tools === '*' ? {} : (authority?.tools ?? {});
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
  void execute<string[]>('list_tools', {})
    .then((tools) => {
      availableTools.value = tools;
      overrides.value = [
        ...overrides.value.filter((o) => tools.includes(o.tool) || o.enabled),
        ...tools
          .filter((t) => !overrides.value.some((o) => o.tool === t))
          .map((t) => ({ tool: t, source: 'built-in', enabled: false, requireApproval: false })),
      ];
    })
    .catch(() => {});
  void execute<{ provider: string; model: { model: string } }[]>('list_models', {})
    .then((models) => (modelOptions.value = models))
    .catch(() => {});
  void execute<{ definitions: never[] }>('list_middleware', {})
    .then((data) => (middlewareDefinitions.value = data.definitions))
    .catch(() => {});
}

watch(
  () => props.participantId,
  () => void load(),
  { immediate: true },
);

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    if (props.participantId === 'new') {
      const result = await execute<{ id: string }>('create_agent', {
        id: slugify(name.value),
        name: name.value,
        systemPrompt: systemPrompt.value,
        model: { model: modelText.value },
        tools: overridesToToolsMap(overrides.value),
        maxIterations: maxIterations.value,
      });
      emit('saved', result.id);
    } else {
      await execute('modify_agent', {
        id: props.participantId,
        name: name.value,
        systemPrompt: systemPrompt.value,
        model: { model: modelText.value },
        tools: overridesToToolsMap(overrides.value),
        maxIterations: maxIterations.value,
      });
      emit('saved', props.participantId);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function saveAuthority(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await execute('set_approval_authority', {
      participantId: props.participantId,
      authority: authorityWildcard.value ? { tools: '*' } : { tools: authorityTools.value },
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function retire(): Promise<void> {
  if (!confirmingRetire.value) {
    confirmingRetire.value = true;
    return;
  }
  busy.value = true;
  try {
    await execute('retire_agent', { id: props.participantId });
    emit('retired');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
    confirmingRetire.value = false;
  }
}

const groupedModels = computed(() => {
  const groups = new Map<string, string[]>();
  for (const entry of modelOptions.value) {
    const list = groups.get(entry.provider) ?? [];
    list.push(entry.model.model);
    groups.set(entry.provider, list);
  }
  return [...groups.entries()];
});
</script>

<template>
  <div class="mx-auto flex max-w-2xl flex-col gap-3 p-4 text-sm">
    <div
      v-if="error"
      data-test="agent-error"
      class="rounded border border-line px-2 py-1 text-xs text-danger"
    >
      {{ error }}
    </div>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">Name</span>
      <input
        v-model="name"
        data-test="agent-name"
        class="rounded border border-line bg-surface px-2 py-1"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">Model</span>
      <select
        v-if="groupedModels.length"
        v-model="modelText"
        data-test="agent-model"
        class="rounded border border-line bg-surface px-2 py-1"
      >
        <optgroup v-for="[provider, models] in groupedModels" :key="provider" :label="provider">
          <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
        </optgroup>
      </select>
      <input
        v-else
        v-model="modelText"
        data-test="agent-model"
        class="rounded border border-line bg-surface px-2 py-1"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">System prompt</span>
      <textarea
        v-model="systemPrompt"
        data-test="agent-system-prompt"
        rows="5"
        class="rounded border border-line bg-surface px-2 py-1"
        >{{ systemPrompt }}</textarea>
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">Max iterations</span>
      <input
        v-model.number="maxIterations"
        type="number"
        data-test="agent-max-iterations"
        class="rounded border border-line bg-surface px-2 py-1"
      />
    </label>
    <div v-if="availableTools.length" class="flex flex-col gap-1">
      <span class="text-xs text-faint">Tool policies</span>
      <ToolPolicyEditor
        :available-tools="availableTools"
        :overrides="overrides"
        @update:overrides="overrides = $event"
      />
    </div>
    <div class="flex flex-col gap-1">
      <span class="text-xs text-faint">Middleware</span>
      <MiddlewareEditor
        v-model="middleware"
        :definitions="middlewareDefinitions"
        :skills="[]"
        :credential-keys="[]"
      />
    </div>
    <div class="flex flex-col gap-1 rounded-md border border-line p-2">
      <span class="text-xs text-faint">Approval authority</span>
      <label class="flex items-center gap-2 text-xs">
        <input v-model="authorityWildcard" type="checkbox" data-test="authority-wildcard" />
        May approve any tool (wildcard)
      </label>
      <div v-if="!authorityWildcard" class="flex flex-col gap-1">
        <label v-for="t in availableTools" :key="t" class="flex items-center gap-2 text-xs">
          <input v-model="authorityTools[t]" type="checkbox" :data-test="`authority-tool-${t}`" />
          <span class="font-mono">{{ t }}</span>
        </label>
      </div>
      <button
        type="button"
        data-test="authority-save"
        :disabled="busy"
        class="self-start rounded bg-accent-soft px-3 py-1 text-xs text-accent"
        @click="saveAuthority"
      >
        Save authority
      </button>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        data-test="agent-save"
        :disabled="busy"
        class="rounded bg-accent-soft px-3 py-1 font-medium text-accent"
        @click="save"
      >
        Save
      </button>
      <button
        v-if="loaded && participantId !== 'new' && !loaded?.['protected']"
        type="button"
        data-test="agent-retire"
        :disabled="busy || participantId === auth.participantId.value"
        class="rounded border border-line px-3 py-1 text-danger disabled:opacity-50"
        @click="retire"
      >
        {{ confirmingRetire ? 'Confirm retire' : 'Retire' }}
      </button>
    </div>
  </div>
</template>
