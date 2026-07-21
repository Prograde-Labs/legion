<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MiddlewareInstanceConfig } from '@legion/types';
import SlideOver from '../common/SlideOver.vue';
import ToolPolicyEditor, { type ToolOverride } from './ToolPolicyEditor.vue';
import MiddlewareEditor from './MiddlewareEditor.vue';
import type {
  MiddlewareDefinitionInfo,
  MiddlewareDiagnosticInfo,
  SkillInfo,
} from './middleware-ui-types.js';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  open: boolean;
  participantId: string | null;
  availableTools: string[];
  availableModels: Array<{ id: string; name?: string; provider: string }>;
  middlewareDefinitions: MiddlewareDefinitionInfo[];
  middlewareDiagnostics: MiddlewareDiagnosticInfo[];
  skills: SkillInfo[];
  credentialKeys: string[];
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const tab = ref<'basic' | 'tools' | 'middleware'>('basic');
const name = ref('');
const model = ref('');
const modelSearch = ref('');
const selectedModel = ref('');
const showModelDropdown = ref(false);
const systemPrompt = ref('');
const maxIterations = ref(20);
const overrides = ref<ToolOverride[]>([]);
const middleware = ref<MiddlewareInstanceConfig[]>([]);
const middlewareErrors = ref<string[]>([]);
const saving = ref(false);

const filteredModels = computed(() =>
  props.availableModels.filter(
    (m) =>
      !modelSearch.value ||
      m.id.toLowerCase().includes(modelSearch.value.toLowerCase()) ||
      (m.name ?? '').toLowerCase().includes(modelSearch.value.toLowerCase()) ||
      m.provider.toLowerCase().includes(modelSearch.value.toLowerCase()),
  ),
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    tab.value = 'basic';
    if (props.participantId) {
      try {
        const p = await execute<Record<string, unknown>>('get_participant', {
          id: props.participantId,
        });
        name.value = (p.name as string) ?? '';
        const modelCfg = p.model as { model: string } | undefined;
        selectedModel.value = modelCfg?.model ?? '';
        model.value = modelCfg?.model ?? '';
        systemPrompt.value = (p.systemPrompt as string) ?? '';
        maxIterations.value = (p.maxIterations as number) ?? 20;

        const tools = (p.tools as Record<string, string>) ?? {};
        overrides.value = Object.entries(tools).map(([tool, policy]) => ({
          tool,
          source: 'built-in',
          enabled: true,
          requireApproval: policy === 'requires_approval',
        }));
        middleware.value = (p.middleware as MiddlewareInstanceConfig[] | undefined) ?? [];
      } catch {
        // Fallback: empty form
      }
    } else {
      name.value = '';
      model.value = '';
      selectedModel.value = '';
      systemPrompt.value = '';
      maxIterations.value = 20;
      overrides.value = [];
      middleware.value = [];
      middlewareErrors.value = [];
    }
  },
);

async function save() {
  saving.value = true;
  try {
    const tools = Object.fromEntries(
      overrides.value
        .filter((o) => o.enabled)
        .map((o) => [o.tool, o.requireApproval ? 'requires_approval' : 'auto']),
    );
    if (props.participantId) {
      await execute('modify_agent', {
        id: props.participantId,
        name: name.value,
        model: { model: selectedModel.value || model.value },
        systemPrompt: systemPrompt.value,
        maxIterations: maxIterations.value,
        tools,
      });
      await execute('set_participant_middleware', {
        participantId: props.participantId,
        middleware: middleware.value,
      });
    } else {
      const id =
        name.value
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-]/g, '') || `agent-${Date.now()}`;
      await execute('create_agent', {
        id,
        name: name.value,
        systemPrompt: systemPrompt.value || 'You are a helpful agent.',
        model: { model: selectedModel.value || model.value },
        tools,
        middleware: middleware.value,
      });
    }
    emit('saved');
    emit('close');
  } finally {
    saving.value = false;
  }
}

async function retire() {
  if (!props.participantId) return;
  await execute('retire_agent', { id: props.participantId });
  emit('saved');
  emit('close');
}
</script>

<template>
  <SlideOver
    :open="open"
    :title="participantId ? 'Edit agent' : 'New agent'"
    @close="emit('close')"
  >
    <div class="flex border-b border-navy-600 bg-navy-900">
      <button
        v-for="t in ['basic', 'tools', 'middleware'] as const"
        :key="t"
        :data-tab="t"
        @click="tab = t"
        :class="[
          'px-4 py-2 text-xs font-medium border-b-2 transition-colors',
          tab === t
            ? 'text-cyan-400 border-cyan-400'
            : 'text-navy-400 border-transparent hover:text-slate-200',
        ]"
      >
        {{ t === 'basic' ? 'Basic' : t === 'tools' ? 'Tool policies' : 'Middleware' }}
      </button>
    </div>

    <div v-if="tab === 'basic'" class="p-5 space-y-4">
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Name</label
        >
        <input
          v-model="name"
          :readonly="!!participantId"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
        />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Model</label
        >
        <div v-if="selectedModel && !showModelDropdown" class="flex items-center gap-2">
          <span
            class="flex-1 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono"
          >
            {{ selectedModel }}
          </span>
          <button
            @click="
              showModelDropdown = true;
              modelSearch = '';
            "
            class="text-[10px] text-navy-400 hover:text-slate-200 border border-navy-600 rounded px-2 py-1.5"
          >
            Change
          </button>
        </div>
        <div v-else class="space-y-1">
          <input
            v-model="modelSearch"
            placeholder="Search models… or type model ID"
            @focus="showModelDropdown = true"
            class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none focus:border-cyan-400/40"
          />
          <div
            v-if="showModelDropdown"
            class="border border-navy-600 rounded bg-navy-950 max-h-48 overflow-y-auto"
          >
            <button
              v-if="modelSearch && !filteredModels.some((m) => m.id === modelSearch)"
              @click="
                selectedModel = modelSearch;
                model = modelSearch;
                showModelDropdown = false;
              "
              class="w-full text-left px-3 py-2 text-xs text-navy-400 hover:bg-navy-800 font-mono border-b border-navy-700"
            >
              Use "{{ modelSearch }}" (not in discovery list)
            </button>
            <button
              v-for="m in filteredModels"
              :key="m.id"
              @click="
                selectedModel = m.id;
                model = m.id;
                modelSearch = '';
                showModelDropdown = false;
              "
              class="w-full text-left px-3 py-2 hover:bg-navy-800"
            >
              <span class="text-xs font-mono text-slate-100">{{ m.id }}</span>
              <span class="text-[10px] text-navy-500 ml-2">{{ m.provider }}</span>
            </button>
            <p
              v-if="filteredModels.length === 0 && !modelSearch"
              class="px-3 py-2 text-[10px] text-navy-600 italic"
            >
              No models discovered. Configure providers first.
            </p>
          </div>
        </div>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >System prompt</label
        >
        <textarea
          v-model="systemPrompt"
          rows="6"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-xs text-slate-200 font-mono resize-none outline-none focus:border-cyan-400/40"
        />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Max iterations</label
        >
        <input
          v-model.number="maxIterations"
          type="number"
          class="w-20 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none"
        />
      </div>
    </div>

    <ToolPolicyEditor
      v-else-if="tab === 'tools'"
      :overrides="overrides"
      :available-tools="availableTools"
      @update:overrides="(v) => (overrides = v)"
    />

    <MiddlewareEditor
      v-else
      v-model="middleware"
      :definitions="middlewareDefinitions"
      :diagnostics="middlewareDiagnostics"
      :skills="skills"
      :credential-keys="credentialKeys"
      @validation="middlewareErrors = $event"
    />

    <template #footer>
      <div class="flex items-center justify-between px-5 py-3">
        <button
          v-if="participantId"
          @click="retire"
          class="text-xs px-3 py-1.5 border border-red-900 text-red-400 rounded hover:border-red-700"
        >
          Retire agent
        </button>
        <div v-else />
        <div class="flex gap-2">
          <button
            @click="emit('close')"
            class="text-xs px-3 py-1.5 border border-navy-600 text-navy-400 rounded hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            data-save-participant
            @click="save"
            :disabled="saving || middlewareErrors.length > 0"
            class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </template>
  </SlideOver>
</template>
