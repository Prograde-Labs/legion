<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { BaseParticipant } from '@legion-collective/types';
import AppLayout from '../components/layout/AppLayout.vue';
import ParticipantSlideOver from '../components/participants/ParticipantSlideOver.vue';
import type {
  MiddlewareDefinitionInfo,
  MiddlewareDiagnosticInfo,
  SkillInfo,
} from '../components/participants/middleware-ui-types.js';
import { useToolStream } from '../composables/useToolStream.js';
import { useWebSocket } from '../composables/useWebSocket.js';
import { useExecute } from '../composables/useExecute.js';
import StatusDot from '../components/common/StatusDot.vue';

const { execute } = useExecute();
const ws = useWebSocket();
const participantStream = useToolStream('watch_participants', () => ({}), {
  onChunk: () => void load(),
});

const participants = ref<BaseParticipant[]>([]);
const allTools = ref<string[]>([]);
const availableModels = ref<Array<{ id: string; name?: string; provider: string }>>([]);
const middlewareDefinitions = ref<MiddlewareDefinitionInfo[]>([]);
const middlewareDiagnostics = ref<MiddlewareDiagnosticInfo[]>([]);
const skills = ref<SkillInfo[]>([]);
// Current runtime has no named-credential listing API. Existing configured references remain
// selectable because MiddlewareSchemaForm merges its current value into these options.
const credentialKeys: string[] = [];
const slideOpen = ref(false);
const editingId = ref<string | null>(null);
const loadError = ref<string | null>(null);

async function load() {
  try {
    const list = await execute<{ id: string; name: string; type: string; status: string }[]>(
      'list_participants',
      {},
    );
    const fullConfigs = await Promise.all(
      list.map((p) =>
        execute<Record<string, unknown>>('get_participant', { id: p.id }).catch(() => null),
      ),
    );
    participants.value = list.map((p, i) => {
      const full = fullConfigs[i];
      return {
        ...p,
        model: (full?.model as { model?: string })?.model,
      };
    }) as any;
    allTools.value = await execute<string[]>('list_tools', {});
    const raw = await execute<Array<{ provider: string; model: { id: string; name?: string } }>>(
      'list_models',
      {},
    );
    availableModels.value = raw.map((r) => ({
      id: r.model.id,
      name: r.model.name,
      provider: r.provider,
    }));
    const [middlewareResult, skillResult] = await Promise.all([
      execute<{
        definitions: MiddlewareDefinitionInfo[];
        diagnostics: MiddlewareDiagnosticInfo[];
      }>('list_middleware', {}),
      execute<{ skills: SkillInfo[]; diagnostics: unknown[] }>('list_skills', {}),
    ]);
    middlewareDefinitions.value = middlewareResult.definitions;
    middlewareDiagnostics.value = middlewareResult.diagnostics;
    skills.value = skillResult.skills;
    loadError.value = null;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

watch(
  () => ws.getConnectionId(),
  async (id) => {
    if (id) await participantStream.start();
  },
  { immediate: true },
);

onMounted(async () => {
  await load();
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
      :available-models="availableModels"
      :middleware-definitions="middlewareDefinitions"
      :middleware-diagnostics="middlewareDiagnostics"
      :skills="skills"
      :credential-keys="credentialKeys"
      @close="slideOpen = false"
      @saved="load"
    />
  </AppLayout>
</template>
