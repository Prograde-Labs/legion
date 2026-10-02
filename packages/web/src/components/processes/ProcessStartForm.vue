<script setup lang="ts">
import { ref, computed } from 'vue';
import { useExecute } from '../../composables/useExecute.js';
import type { ProcessHandle } from '@legion-collective/types';

const emit = defineEmits<{ started: [id: string] }>();

const { execute } = useExecute();

const command = ref('');
const argsStr = ref('');
const name = ref('');
const cwd = ref('');
const tty = ref(false);
const shell = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);

const canSubmit = computed(() => command.value.trim().length > 0 && !submitting.value);

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const args = argsStr.value
      .trim()
      .split(/\s+/)
      .filter((a) => a.length > 0);
    const handle = await execute<ProcessHandle>('start_process', {
      command: command.value.trim(),
      args,
      ...(name.value.trim() ? { name: name.value.trim() } : {}),
      ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
      tty: tty.value,
      shell: shell.value,
    });
    emit('started', handle.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col items-center justify-center p-8">
    <div class="w-full max-w-lg">
      <h2 class="text-sm font-semibold text-slate-100 mb-5">Start a process</h2>

      <div class="space-y-3">
        <div>
          <label class="block text-[10px] uppercase tracking-wider text-navy-500 mb-1"
            >Command</label
          >
          <input
            v-model="command"
            placeholder="command e.g. npm"
            class="w-full bg-navy-950 border border-navy-600 rounded px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/50 font-mono"
            @keydown.enter="onSubmit"
          />
        </div>

        <div>
          <label class="block text-[10px] uppercase tracking-wider text-navy-500 mb-1">Args</label>
          <input
            v-model="argsStr"
            placeholder="args e.g. run dev"
            class="w-full bg-navy-950 border border-navy-600 rounded px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/50 font-mono"
            @keydown.enter="onSubmit"
          />
        </div>

        <div class="flex gap-3">
          <div class="flex-1">
            <label class="block text-[10px] uppercase tracking-wider text-navy-500 mb-1"
              >Name (optional)</label
            >
            <input
              v-model="name"
              placeholder="display name"
              class="w-full bg-navy-950 border border-navy-600 rounded px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/50"
            />
          </div>
          <div class="flex-1">
            <label class="block text-[10px] uppercase tracking-wider text-navy-500 mb-1"
              >Working dir (optional)</label
            >
            <input
              v-model="cwd"
              placeholder="/path/to/dir"
              class="w-full bg-navy-950 border border-navy-600 rounded px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/50 font-mono"
            />
          </div>
        </div>

        <div class="flex gap-5 text-xs text-slate-400">
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input v-model="tty" type="checkbox" class="accent-cyan-400" />
            <span>TTY (pseudo-terminal)</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input v-model="shell" type="checkbox" class="accent-cyan-400" />
            <span>Shell (<code>/bin/sh -c</code>)</span>
          </label>
        </div>

        <div
          v-if="error"
          class="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded px-3 py-2"
        >
          {{ error }}
        </div>

        <button
          type="submit"
          :disabled="!canSubmit"
          class="w-full px-4 py-2 text-xs font-semibold rounded border transition-colors"
          :class="
            canSubmit
              ? 'bg-cyan-400/10 border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/20'
              : 'border-navy-700 text-navy-600 cursor-not-allowed'
          "
          @click="onSubmit"
        >
          {{ submitting ? 'Starting…' : '▶ Start process' }}
        </button>
      </div>
    </div>
  </div>
</template>
