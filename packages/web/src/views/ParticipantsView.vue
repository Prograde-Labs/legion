<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useParticipants } from '../composables/useParticipants.js';
import { useParticipantSelection } from './useParticipantSelection.js';
import ParticipantsList from './ParticipantsList.vue';
import TopologyMap from './TopologyMap.vue';
import AgentEditor from './AgentEditor.vue';
import UserEditor from './UserEditor.vue';

const { byId, load } = useParticipants();
const { selectedId, select } = useParticipantSelection();

// Initial population of the shared participants store: the list, recipient
// picker, and participant editors all read from it, but nothing else fetches.
onMounted(() => void load().catch(() => {}));

const viewMode = ref<'list' | 'map'>('list');

const selected = computed(() => (selectedId.value ? byId(selectedId.value) : undefined));

const detailKind = computed<'new' | 'new-user' | 'agent' | 'user' | 'other' | 'none'>(() => {
  if (selectedId.value === 'new') return 'new';
  if (selectedId.value === 'new-user') return 'new-user';
  const p = selected.value;
  if (!p) return selectedId.value ? 'other' : 'none';
  if (p.type === 'agent') return 'agent';
  if (p.type === 'user') return 'user';
  return 'other';
});

// byId returns the broad BaseParticipant type; model/module are agent/service fields.
// Casts live here (script) because vue-tsc's template parser rejects inline `as` expressions.
const modelValue = computed(() => {
  if (detailKind.value !== 'other') return undefined;
  const s = selected.value;
  if (!s) return undefined;
  return (s as { model?: { model?: string } }).model?.model;
});

const moduleValue = computed(() => {
  if (detailKind.value !== 'other') return undefined;
  const s = selected.value;
  if (!s) return undefined;
  return (s as { module?: string }).module;
});

function onSaved(id: string): void {
  select(id);
  void load();
}

function onRetired(): void {
  select(null);
  void load();
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <div class="flex w-72 shrink-0 flex-col border-r border-line">
      <div class="flex border-b border-line text-xs" role="tablist">
        <button
          type="button"
          data-test="view-list"
          class="flex-1 py-1.5"
          :class="viewMode === 'list' ? 'bg-surface text-ink' : 'text-muted'"
          @click="viewMode = 'list'"
        >
          List
        </button>
        <button
          type="button"
          data-test="view-map"
          class="flex-1 py-1.5"
          :class="viewMode === 'map' ? 'bg-surface text-ink' : 'text-muted'"
          @click="viewMode = 'map'"
        >
          Map
        </button>
      </div>
      <TopologyMap v-if="viewMode === 'map'" class="min-h-0 flex-1" @select="select" />
      <ParticipantsList v-else class="min-h-0 flex-1" @select="select" />
    </div>
    <div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div
        v-if="detailKind === 'none'"
        data-test="participant-empty"
        class="p-6 text-sm text-faint"
      >
        Select a participant
      </div>
      <AgentEditor
        v-else-if="detailKind === 'new'"
        participant-id="new"
        @saved="onSaved"
        @retired="onRetired"
      />
      <AgentEditor
        v-else-if="detailKind === 'agent'"
        :key="selectedId ?? undefined"
        :participant-id="selectedId!"
        @saved="onSaved"
        @retired="onRetired"
      />
      <UserEditor
        v-else-if="detailKind === 'user'"
        :key="selectedId ?? undefined"
        :participant-id="selectedId!"
        @saved="onSaved"
        @retired="onRetired"
      />
      <UserEditor
        v-else-if="detailKind === 'new-user'"
        participant-id="new"
        @saved="onSaved"
        @retired="onRetired"
      />
      <dl
        v-else-if="detailKind === 'other' && selected"
        data-test="participant-detail"
        class="max-w-md p-6 text-sm"
      >
        <div class="flex justify-between border-b border-line py-1">
          <dt class="text-faint">Name</dt>
          <dd>{{ selected.name }}</dd>
        </div>
        <div class="flex justify-between border-b border-line py-1">
          <dt class="text-faint">Type</dt>
          <dd>{{ selected.type }}</dd>
        </div>
        <div class="flex justify-between border-b border-line py-1">
          <dt class="text-faint">Status</dt>
          <dd>{{ selected.status }}</dd>
        </div>
        <div v-if="modelValue" class="flex justify-between border-b border-line py-1">
          <dt class="text-faint">Model</dt>
          <dd class="font-mono">{{ modelValue }}</dd>
        </div>
        <div v-if="moduleValue" class="flex justify-between border-b border-line py-1">
          <dt class="text-faint">Module</dt>
          <dd class="font-mono">{{ moduleValue }}</dd>
        </div>
      </dl>
    </div>
  </div>
</template>
