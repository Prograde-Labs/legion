<script setup lang="ts">
import { ref } from 'vue';
import type { MessageWithAlternates } from '../../composables/useConversation.js';

const DEFAULT_INSTRUCTION =
  'Summarise the following conversation segment concisely, preserving key decisions, facts, and outcomes.';

defineProps<{
  messages: MessageWithAlternates[];
  agents: Array<{ id: string; name: string }>;
}>();

const emit = defineEmits<{
  compact: [agentId: string, instruction: string];
  cancel: [];
}>();

const selectedAgentId = ref('');
const instruction = ref(DEFAULT_INSTRUCTION);
const advancedOpen = ref(false);
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
    <div class="w-full max-w-lg rounded-xl border border-navy-700 bg-navy-900 p-4 shadow-xl">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold text-slate-100">
          Compacting {{ messages.length }} messages
        </h2>
        <button type="button" class="text-slate-500 hover:text-slate-200" @click="emit('cancel')">
          x
        </button>
      </div>

      <div class="mt-3 rounded-lg border border-navy-800 bg-navy-950 p-3 text-xs text-slate-400">
        <div>{{ messages[0]?.role }}: {{ messages[0]?.content.slice(0, 80) }}</div>
        <div v-if="messages.length > 2" class="my-2 text-center text-slate-600">
          ... {{ messages.length - 2 }} more ...
        </div>
        <div v-if="messages.length > 1">
          {{ messages[messages.length - 1]?.role }}:
          {{ messages[messages.length - 1]?.content.slice(0, 80) }}
        </div>
      </div>

      <button
        type="button"
        class="mt-3 text-xs text-cyan-400 hover:text-cyan-300"
        @click="advancedOpen = !advancedOpen"
      >
        Advanced {{ advancedOpen ? '^' : 'v' }}
      </button>

      <div v-show="advancedOpen" class="mt-3 flex flex-col gap-3">
        <label class="text-xs text-slate-400">
          Agent
          <select
            v-model="selectedAgentId"
            class="mt-1 w-full rounded border border-navy-700 bg-navy-950 px-2 py-1.5 text-sm text-slate-200"
          >
            <option value="">Select agent...</option>
            <option v-for="agent in agents" :key="agent.id" :value="agent.id">
              {{ agent.name }}
            </option>
          </select>
        </label>

        <label class="text-xs text-slate-400">
          Instruction
          <textarea
            v-model="instruction"
            rows="4"
            class="mt-1 w-full rounded border border-navy-700 bg-navy-950 px-2 py-1.5 text-sm text-slate-200"
          />
        </label>
      </div>

      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="px-3 py-1.5 text-sm text-slate-400" @click="emit('cancel')">
          Cancel
        </button>
        <button
          data-compact
          type="button"
          :disabled="!selectedAgentId"
          class="rounded px-3 py-1.5 text-sm font-medium"
          :class="
            selectedAgentId
              ? 'bg-cyan-700 text-white hover:bg-cyan-600'
              : 'bg-navy-800 text-slate-600 cursor-not-allowed'
          "
          @click="emit('compact', selectedAgentId, instruction)"
        >
          Compact
        </button>
      </div>
    </div>
  </div>
</template>
