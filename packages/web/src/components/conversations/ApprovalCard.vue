<script setup lang="ts">
import { ref } from 'vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  resolved: boolean;
  decision: 'approve' | 'reject' | null;
  resolvedMessage?: string;
}>();

const emit = defineEmits<{ resolved: [] }>();

const { execute } = useExecute();
const message = ref('');
const submitting = ref(false);
const expanded = ref(false);

async function submit(decision: 'approve' | 'reject') {
  submitting.value = true;
  try {
    await execute('approval_response', {
      decisions: [{ approvalId: props.approvalId, decision, message: message.value }],
    });
    emit('resolved');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <!-- Pending state -->
  <div
    v-if="!resolved"
    class="border border-amber-800 bg-amber-950/40 rounded-lg p-3 flex flex-col gap-2"
  >
    <div class="flex items-center gap-2">
      <span class="text-amber-400 text-xs">⚠</span>
      <span class="text-amber-300 text-xs font-semibold">Approval required</span>
    </div>

    <div class="text-slate-400 text-xs">
      Agent wants to call
      <code class="text-slate-200 font-mono">{{ toolName }}</code>
    </div>

    <div
      class="bg-navy-950 rounded p-2 font-mono text-xs text-slate-500 cursor-pointer"
      @click="expanded = !expanded"
    >
      <div v-if="!expanded" class="truncate">
        {{ JSON.stringify(args) }}
      </div>
      <pre v-else class="whitespace-pre-wrap break-all">{{ JSON.stringify(args, null, 2) }}</pre>
    </div>

    <textarea
      v-model="message"
      rows="2"
      placeholder="Reason (optional for Allow, recommended for Deny)"
      class="w-full bg-navy-900 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-300 placeholder-slate-600 resize-none focus:outline-none focus:border-cyan-700"
    />

    <div class="flex gap-2">
      <button
        data-allow
        :disabled="submitting"
        class="px-3 py-1 text-xs rounded bg-emerald-900 text-emerald-300 hover:bg-emerald-800 disabled:opacity-50"
        @click="submit('approve')"
      >
        Allow
      </button>
      <button
        data-deny
        :disabled="submitting"
        class="px-3 py-1 text-xs rounded bg-red-950 text-red-400 hover:bg-red-900 disabled:opacity-50"
        @click="submit('reject')"
      >
        Deny
      </button>
    </div>
  </div>

  <!-- Resolved state -->
  <div
    v-else
    class="border rounded-lg p-3 flex flex-col gap-1"
    :class="
      decision === 'approve'
        ? 'border-emerald-900 bg-emerald-950/20'
        : 'border-red-950 bg-red-950/20'
    "
  >
    <div class="flex items-center gap-2">
      <span class="text-xs font-mono text-slate-400">{{ toolName }}</span>
      <span
        class="text-xs font-semibold ml-auto"
        :class="decision === 'approve' ? 'text-emerald-400' : 'text-red-400'"
      >
        {{ decision === 'approve' ? 'Approved' : 'Denied' }}
      </span>
    </div>
    <div v-if="resolvedMessage" class="text-xs text-slate-500 italic">
      {{ resolvedMessage }}
    </div>
  </div>
</template>
