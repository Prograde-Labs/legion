<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ProviderConfig } from '@legion/types';
import SlideOver from '../common/SlideOver.vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  open: boolean;
  provider: ProviderConfig | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const name = ref('');
const type = ref<ProviderConfig['type']>('openai-compatible');
const baseUrl = ref('');
const apiKey = ref('');
const priority = ref(10);
const saving = ref(false);
const apiKeyPlaceholder = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    name.value = props.provider?.name ?? '';
    type.value = props.provider?.type ?? 'openai-compatible';
    baseUrl.value = props.provider?.baseUrl ?? '';
    priority.value = props.provider?.priority ?? 10;
    apiKey.value = '';
    apiKeyPlaceholder.value = props.provider?.apiKey ? '••••••••' : '';
  },
);

async function save() {
  saving.value = true;
  try {
    const payload: ProviderConfig = {
      name: name.value,
      type: type.value,
      priority: priority.value,
    };
    if (baseUrl.value) payload.baseUrl = baseUrl.value;
    if (apiKey.value) {
      payload.apiKey = apiKey.value;
    } else if (props.provider?.apiKey) {
      payload.apiKey = props.provider.apiKey;
    }
    await execute('save_provider', payload);
    emit('saved');
    emit('close');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <SlideOver
    :open="open"
    :title="provider ? 'Edit provider' : 'Add provider'"
    @close="emit('close')"
  >
    <div class="p-5 space-y-4">
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Name</label
        >
        <input
          v-model="name"
          :readonly="!!provider"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none"
        />
        <p class="text-[10px] text-navy-500 mt-1">Cannot change after creation.</p>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Type</label
        >
        <select
          v-model="type"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100"
        >
          <option>openai-compatible</option>
          <option>anthropic</option>
          <option>copilot</option>
          <option>codex</option>
        </select>
      </div>
      <div v-if="type === 'openai-compatible'">
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Base URL</label
        >
        <input
          v-model="baseUrl"
          placeholder="https://api.openai.com/v1"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none"
        />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >API Key</label
        >
        <input
          v-model="apiKey"
          type="password"
          :placeholder="apiKeyPlaceholder || 'sk-...'"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none"
        />
        <p v-if="provider?.apiKey" class="text-[10px] text-navy-500 mt-1">
          Leave blank to keep existing key.
        </p>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Priority</label
        >
        <input
          v-model.number="priority"
          type="number"
          min="1"
          class="w-20 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none"
        />
        <p class="text-[10px] text-navy-500 mt-1">
          Lower number = higher priority (used for auto-routing).
        </p>
      </div>
    </div>
    <template #footer>
      <div class="flex justify-end gap-2 px-5 py-3">
        <button
          @click="emit('close')"
          class="text-xs px-3 py-1.5 border border-navy-600 text-navy-400 rounded"
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
    </template>
  </SlideOver>
</template>
