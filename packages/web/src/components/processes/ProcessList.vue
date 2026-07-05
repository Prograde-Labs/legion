<script setup lang="ts">
import { useRouter } from 'vue-router';
import { computed } from 'vue';
import type { ProcessHandle } from '@legion/types';
import ProcessStatusDot from './ProcessStatusDot.vue';

const props = defineProps<{
  processes: ProcessHandle[];
  activeId: string | null;
}>();

const router = useRouter();

function elapsed(p: ProcessHandle): string {
  const start = new Date(p.startedAt).getTime();
  const end = p.exitedAt ? new Date(p.exitedAt).getTime() : Date.now();
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const sorted = computed(() =>
  [...props.processes].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  ),
);
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div
      class="flex items-center justify-between px-3 py-2.5 border-b border-navy-800 flex-shrink-0"
    >
      <span class="text-xs uppercase tracking-wider text-slate-500">Processes</span>
      <button
        class="text-xs px-2 py-0.5 rounded bg-cyan-800 text-cyan-200 hover:bg-cyan-700"
        @click="router.push('/processes')"
      >
        + New
      </button>
    </div>

    <!-- List -->
    <div class="flex-1 overflow-y-auto">
      <div
        v-for="p in sorted"
        :key="p.id"
        class="px-3 py-2.5 cursor-pointer border-b border-navy-900 hover:bg-navy-850 transition-colors"
        :class="[
          p.id === activeId ? 'bg-navy-800 border-l-2 border-l-cyan-600' : '',
          p.status !== 'running' && p.status !== 'starting' ? 'opacity-50' : '',
        ]"
        @click="router.push(`/processes/${p.id}`)"
      >
        <div class="flex items-center gap-2 min-w-0">
          <ProcessStatusDot :status="p.status" />
          <span class="text-xs text-slate-200 font-mono truncate flex-1">
            {{ p.name ?? p.command }}
          </span>
        </div>
        <div class="mt-0.5 pl-4 text-[10px] text-navy-500 truncate">
          {{ elapsed(p) }}
          <span v-if="p.exitCode !== null"> · exit {{ p.exitCode }}</span>
        </div>
      </div>

      <div v-if="sorted.length === 0" class="px-3 py-6 text-xs text-navy-600 text-center">
        No processes yet
      </div>
    </div>
  </div>
</template>
