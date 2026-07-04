<script setup lang="ts">
import { ref, computed } from 'vue';
import type { RoutingConfig } from '@legion/types';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  scope: 'system' | 'workspace';
  routing: RoutingConfig;
  providerNames: string[];
}>();
const emit = defineEmits<{ saved: [] }>();
const { execute } = useExecute();

const rows = ref<Array<{ model: string; providers: string[] }>>(
  Object.entries(props.routing.models ?? {}).map(([model, providers]) => ({ model, providers })),
);

const newModelId = ref('');
const saving = ref(false);

function addRow() {
  const id = newModelId.value.trim();
  if (!id || rows.value.some((r) => r.model === id)) return;
  rows.value.push({ model: id, providers: [] });
  newModelId.value = '';
}

function removeRow(index: number) {
  rows.value.splice(index, 1);
}

function moveProviderUp(rowIndex: number, provIndex: number) {
  if (provIndex === 0) return;
  const providers = rows.value[rowIndex].providers;
  [providers[provIndex - 1], providers[provIndex]] = [
    providers[provIndex],
    providers[provIndex - 1],
  ];
}

function moveProviderDown(rowIndex: number, provIndex: number) {
  const providers = rows.value[rowIndex].providers;
  if (provIndex === providers.length - 1) return;
  [providers[provIndex], providers[provIndex + 1]] = [
    providers[provIndex + 1],
    providers[provIndex],
  ];
}

function addProvider(rowIndex: number, providerName: string) {
  const providers = rows.value[rowIndex].providers;
  if (!providers.includes(providerName)) {
    providers.push(providerName);
  }
}

function removeProvider(rowIndex: number, provIndex: number) {
  rows.value[rowIndex].providers.splice(provIndex, 1);
}

const availableForRow = computed(() => (rowIndex: number) => {
  const used = rows.value[rowIndex].providers;
  return props.providerNames.filter((p) => !used.includes(p));
});

async function save() {
  saving.value = true;
  try {
    const models: Record<string, string[]> = {};
    for (const row of rows.value) {
      if (row.model && row.providers.length > 0) {
        models[row.model] = row.providers;
      }
    }
    await execute('save_routing', { scope: props.scope, routing: { models } });
    emit('saved');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-3">
    <div
      v-for="(row, rowIndex) in rows"
      :key="row.model"
      class="border border-navy-700 rounded p-3 space-y-2"
    >
      <div class="flex items-center justify-between">
        <span class="font-mono text-xs text-slate-100">{{ row.model }}</span>
        <button @click="removeRow(rowIndex)" class="text-[10px] text-red-400 hover:text-red-300">
          Remove
        </button>
      </div>
      <div class="space-y-1">
        <div v-for="(prov, provIndex) in row.providers" :key="prov" class="flex items-center gap-1">
          <span class="text-[10px] text-navy-400 w-4">{{ provIndex + 1 }}.</span>
          <span
            class="flex-1 text-[10px] font-mono bg-cyan-400/10 border border-cyan-400/20 text-cyan-400 px-2 py-0.5 rounded"
          >
            {{ prov }}
          </span>
          <button
            @click="moveProviderUp(rowIndex, provIndex)"
            :disabled="provIndex === 0"
            class="text-[10px] text-navy-400 hover:text-slate-200 disabled:opacity-30 px-1"
          >
            ↑
          </button>
          <button
            @click="moveProviderDown(rowIndex, provIndex)"
            :disabled="provIndex === row.providers.length - 1"
            class="text-[10px] text-navy-400 hover:text-slate-200 disabled:opacity-30 px-1"
          >
            ↓
          </button>
          <button
            @click="removeProvider(rowIndex, provIndex)"
            class="text-[10px] text-red-400 hover:text-red-300 px-1"
          >
            ×
          </button>
        </div>
        <p v-if="row.providers.length === 0" class="text-[10px] text-navy-600 italic">
          No providers — add one below.
        </p>
      </div>
      <select
        v-if="availableForRow(rowIndex).length > 0"
        @change="
          (e) => {
            addProvider(rowIndex, (e.target as HTMLSelectElement).value);
            (e.target as HTMLSelectElement).value = '';
          }
        "
        class="w-full bg-navy-900 border border-navy-600 rounded px-2 py-1 text-[10px] text-navy-400"
      >
        <option value="">+ Add provider…</option>
        <option v-for="p in availableForRow(rowIndex)" :key="p" :value="p">{{ p }}</option>
      </select>
    </div>

    <div class="flex gap-2">
      <input
        v-model="newModelId"
        placeholder="model-id (e.g. claude-sonnet-4-5)"
        @keyup.enter="addRow"
        class="flex-1 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-xs text-slate-100 font-mono outline-none"
      />
      <button
        @click="addRow"
        class="text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded"
      >
        + Add model
      </button>
    </div>

    <div class="flex justify-end pt-2">
      <button
        @click="save"
        :disabled="saving"
        class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50"
      >
        {{ saving ? 'Saving…' : `Save ${scope} routing` }}
      </button>
    </div>
  </div>
</template>
