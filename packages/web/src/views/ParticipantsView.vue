<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { BaseParticipant } from '@legion/types';
import AppLayout from '../components/layout/AppLayout.vue';
import ParticipantSlideOver from '../components/participants/ParticipantSlideOver.vue';
import { useEventStream } from '../composables/useEventStream.js';
import { useExecute } from '../composables/useExecute.js';

const { execute } = useExecute();
const { subscribe } = useEventStream();

const participants = ref<BaseParticipant[]>([]);
const allTools = ref<string[]>([]);
const providers = ref<{ name: string }[]>([]);
const slideOpen = ref(false);
const editingId = ref<string | null>(null);

async function load() {
  participants.value = await execute<BaseParticipant[]>('list_participants', {});
  allTools.value = await execute<string[]>('list_tools', {});
  providers.value = await execute<{ name: string }[]>('list_providers', {});
}

onMounted(async () => {
  await load();
  subscribe((evt) => {
    if (evt.event === 'participant:active' || evt.event === 'participant:retired') load();
  });
});

function openCreate() {
  editingId.value = null;
  slideOpen.value = true;
}
function openEdit(id: string) {
  editingId.value = id;
  slideOpen.value = true;
}
</script>

<template>
  <AppLayout>
    <div class="flex items-center justify-between px-5 py-3.5 border-b border-navy-600">
      <h1 class="text-sm font-semibold text-slate-100">Participants</h1>
      <button
        @click="openCreate"
        class="text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded hover:border-cyan-400/40"
      >
        + New agent
      </button>
    </div>

    <table class="w-full border-collapse text-xs">
      <thead>
        <tr class="border-b border-navy-700">
          <th
            class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold"
          >
            Status
          </th>
          <th
            class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold"
          >
            Name
          </th>
          <th
            class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold"
          >
            Model
          </th>
          <th
            class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold"
          >
            Provider
          </th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in participants"
          :key="p.id"
          :class="[
            'border-b border-navy-900 hover:bg-navy-800/40',
            p.status === 'retired' ? 'opacity-35' : '',
          ]"
        >
          <td class="px-4 py-2.5">
            <div class="flex items-center gap-2">
              <StatusDot :status="p.status === 'active' ? 'active' : 'retired'" />
              <span :class="p.status === 'active' ? 'text-cyan-400' : 'text-navy-500'">
                {{ p.status === 'active' ? 'Active' : 'Retired' }}
              </span>
            </div>
          </td>
          <td class="px-4 py-2.5 text-slate-100 font-medium">{{ p.name }}</td>
          <td class="px-4 py-2.5 text-navy-400 font-mono">{{ (p as any).model ?? '—' }}</td>
          <td class="px-4 py-2.5 text-navy-400 font-mono">{{ (p as any).providerId ?? '—' }}</td>
          <td class="px-4 py-2.5 text-right">
            <button
              v-if="p.status === 'active'"
              @click="openEdit(p.id)"
              class="text-navy-400 hover:text-slate-200 mr-3"
            >
              Edit
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <ParticipantSlideOver
      :open="slideOpen"
      :participant-id="editingId"
      :available-tools="allTools"
      :providers="providers"
      @close="slideOpen = false"
      @saved="load"
    />
  </AppLayout>
</template>

<script>
import StatusDot from '../components/common/StatusDot.vue';
</script>
