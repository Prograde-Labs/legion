<script setup lang="ts">
import { ref, watch } from 'vue';
import SlideOver from '../common/SlideOver.vue';
import ToolPolicyEditor, { type ToolOverride } from './ToolPolicyEditor.vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  open: boolean;
  participantId: string | null;
  availableTools: string[];
  providers: { name: string }[];
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const tab = ref<'basic' | 'tools'>('basic');
const name = ref('');
const model = ref('');
const providerId = ref('');
const systemPrompt = ref('');
const maxIterations = ref(20);
const defaultPolicy = ref<'allow' | 'require-approval' | 'deny'>('allow');
const overrides = ref<ToolOverride[]>([]);
const saving = ref(false);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    tab.value = 'basic';
    if (props.participantId) {
      // Load existing — in a real app fetch participant details
    } else {
      name.value = '';
      model.value = '';
      providerId.value = '';
      systemPrompt.value = '';
      maxIterations.value = 20;
      defaultPolicy.value = 'allow';
      overrides.value = [];
    }
  },
);

async function save() {
  saving.value = true;
  try {
    const toolPolicies = Object.fromEntries(
      overrides.value.map((o) => [
        o.tool,
        o.requireApproval ? 'require-approval' : o.enabled ? 'allow' : 'deny',
      ]),
    );
    if (props.participantId) {
      await execute('modify_agent', {
        id: props.participantId,
        name: name.value,
        model: model.value,
        systemPrompt: systemPrompt.value,
        maxIterations: maxIterations.value,
        toolPolicies,
      });
    } else {
      await execute('create_agent', {
        name: name.value,
        model: model.value,
        providerId: providerId.value,
        systemPrompt: systemPrompt.value,
        maxIterations: maxIterations.value,
        toolPolicies,
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
    <!-- Tabs -->
    <div class="flex border-b border-navy-600 bg-navy-900">
      <button
        v-for="t in ['basic', 'tools'] as const"
        :key="t"
        @click="tab = t"
        :class="[
          'px-4 py-2 text-xs font-medium border-b-2 transition-colors',
          tab === t
            ? 'text-cyan-400 border-cyan-400'
            : 'text-navy-400 border-transparent hover:text-slate-200',
        ]"
      >
        {{ t === 'basic' ? 'Basic' : 'Tool policies' }}
      </button>
    </div>

    <!-- Basic tab -->
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
          >Provider</label
        >
        <select
          v-model="providerId"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100"
        >
          <option v-for="p in providers" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Model</label
        >
        <input
          v-model="model"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none focus:border-cyan-400/40"
        />
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

    <!-- Tools tab -->
    <ToolPolicyEditor
      v-else
      :default-policy="defaultPolicy"
      :overrides="overrides"
      :available-tools="availableTools"
      @update:default-policy="(v) => (defaultPolicy = v as typeof defaultPolicy)"
      @update:overrides="(v) => (overrides = v)"
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
            @click="save"
            :disabled="saving"
            class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </template>
  </SlideOver>
</template>
