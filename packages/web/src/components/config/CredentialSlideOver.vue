<script setup lang="ts">
import { ref, watch } from 'vue';
import type { CredentialInfo } from '@legion/types';
import SlideOver from '../common/SlideOver.vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{ open: boolean; credential: CredentialInfo | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const key = ref('');
const value = ref('');
const saving = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    key.value = props.credential?.key ?? '';
    value.value = '';
  },
);

async function save() {
  saving.value = true;
  try {
    await execute('set_credential_with_meta', {
      key: key.value,
      value: value.value,
      usedBy: props.credential?.usedBy ?? [],
    });
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
    :title="!credential ? 'Add credential' : 'Rotate credential'"
    @close="emit('close')"
  >
    <div class="p-5 space-y-4">
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Key name</label
        >
        <input
          v-model="key"
          :readonly="!!credential"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 outline-none"
        />
        <p v-if="credential" class="text-[10px] text-navy-500 mt-1">Delete and re-add to rename.</p>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">
          {{ !credential ? 'Value' : 'New value' }}
        </label>
        <input
          v-model="value"
          type="password"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 outline-none"
        />
        <p class="text-[10px] text-navy-500 mt-1">Write-only. Current value cannot be retrieved.</p>
      </div>
      <div v-if="credential" class="bg-navy-900 border border-navy-600 rounded p-3">
        <p class="text-[10px] text-navy-400 mb-2">Used by</p>
        <span
          v-for="p in credential.usedBy"
          :key="p"
          class="inline-block text-[10px] font-mono bg-cyan-400/10 border border-cyan-400/20 text-cyan-400 px-2 py-0.5 rounded mr-1"
        >
          {{ p }}
        </span>
        <p class="text-[10px] text-navy-500 mt-2">
          Saving takes effect immediately — no restart required.
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
          :disabled="saving || !value"
          class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </template>
  </SlideOver>
</template>
