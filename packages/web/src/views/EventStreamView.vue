<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppLayout from '../components/layout/AppLayout.vue';
import EventDetailPanel from '../components/events/EventDetailPanel.vue';
import TypeBadge from '../components/common/TypeBadge.vue';
import StatusDot from '../components/common/StatusDot.vue';
import { useToolStream } from '../composables/useToolStream.js';
import { useWebSocket } from '../composables/useWebSocket.js';

interface LiveEvent {
  id: string;
  type: string;
  event: string;
  data: unknown;
  time: string;
}

const events = ref<LiveEvent[]>([]);
const selected = ref<LiveEvent | null>(null);
const paused = ref(false);
const filters = ref(new Set(['message:sent', 'tool:call', 'tool:result', 'error']));
const search = ref('');

let idSeq = 0;
const activityStream = useToolStream('watch_activity', () => ({}), {
  onChunk: (chunk) => {
    if (paused.value) return;
    const le: LiveEvent = {
      id: String(idSeq++),
      type: 'event',
      event: chunk.type,
      data: (chunk as { data?: unknown }).data ?? chunk,
      time: new Date().toLocaleTimeString(),
    };
    events.value.unshift(le);
    if (events.value.length > 500) events.value.splice(500);
  },
});

const ws = useWebSocket();
watch(
  () => ws.getConnectionId(),
  (id) => {
    if (id) void activityStream.start();
  },
  { immediate: true },
);

const chips = [
  { label: 'message', events: ['message:sent', 'message:delivered'] },
  { label: 'tool', events: ['tool:call', 'tool:result'] },
  { label: 'error', events: ['error'] },
  {
    label: 'system',
    events: ['conversation:created', 'participant:active', 'participant:retired', 'process:ready'],
  },
];

function toggleChip(chip: (typeof chips)[number]) {
  for (const e of chip.events) {
    if (filters.value.has(e)) filters.value.delete(e);
    else filters.value.add(e);
  }
}

function chipActive(chip: (typeof chips)[number]) {
  return chip.events.some((e) => filters.value.has(e));
}

const visible = computed(() =>
  events.value.filter(
    (e) =>
      filters.value.has(e.event) &&
      (!search.value || JSON.stringify(e.data).includes(search.value)),
  ),
);

function summary(e: LiveEvent): string {
  const d = e.data as Record<string, unknown>;
  if (d.participantId) return `${d.participantId as string}`;
  if (d.conversationId) return `conv ${d.conversationId as string}`;
  return '';
}
</script>

<template>
  <AppLayout>
    <div class="flex flex-col h-full">
      <!-- Toolbar -->
      <div
        class="flex items-center gap-3 px-4 py-2.5 border-b border-navy-600 bg-navy-900 flex-wrap"
      >
        <div class="flex items-center gap-1.5">
          <StatusDot :status="paused ? 'retired' : 'live'" />
          <span :class="['text-xs font-semibold', paused ? 'text-navy-400' : 'text-cyan-400']">
            {{ paused ? 'Paused' : 'Live' }}
          </span>
        </div>
        <div class="w-px h-4 bg-navy-600" />
        <span class="text-[10px] text-navy-500">Filter:</span>
        <button
          v-for="chip in chips"
          :key="chip.label"
          @click="toggleChip(chip)"
          :class="[
            'text-[10px] px-2.5 py-1 rounded-full border transition-colors',
            chipActive(chip)
              ? 'bg-cyan-400 text-navy-950 border-transparent font-semibold'
              : 'border-navy-600 text-navy-400',
          ]"
        >
          {{ chip.label }}
        </button>
        <input
          v-model="search"
          placeholder="filter by participant or conv…"
          class="bg-navy-950 border border-navy-600 rounded px-2.5 py-1 text-xs text-slate-300 outline-none w-48"
        />
        <button
          @click="paused = !paused"
          class="ml-auto text-xs px-3 py-1.5 rounded border"
          :class="
            paused ? 'border-amber-400/30 text-amber-400' : 'border-cyan-400/30 text-cyan-400'
          "
        >
          {{ paused ? '▶ Resume' : '⏸ Pause' }}
        </button>
      </div>

      <div class="flex flex-1 min-h-0">
        <!-- Event list -->
        <div class="flex-1 overflow-y-auto">
          <table class="w-full border-collapse text-xs">
            <thead class="sticky top-0 bg-navy-950">
              <tr>
                <th
                  v-for="h in ['Time', 'Event', 'Detail', 'Conv']"
                  :key="h"
                  class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-3 py-2 font-semibold border-b border-navy-700"
                >
                  {{ h }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="e in visible"
                :key="e.id"
                @click="selected = e"
                :class="[
                  'border-b border-navy-900 cursor-pointer hover:bg-navy-800/40',
                  selected?.id === e.id ? 'bg-navy-800/60' : '',
                ]"
              >
                <td class="px-3 py-1.5 font-mono text-[10px] text-navy-500 whitespace-nowrap">
                  {{ e.time }}
                </td>
                <td class="px-3 py-1.5"><TypeBadge :type="e.event" /></td>
                <td class="px-3 py-1.5 text-slate-400 truncate max-w-xs">{{ summary(e) }}</td>
                <td class="px-3 py-1.5 font-mono text-[9px] text-navy-600 whitespace-nowrap">
                  {{ (e.data as any).conversationId ?? '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <EventDetailPanel :event="selected" />
      </div>
    </div>
  </AppLayout>
</template>
