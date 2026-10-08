<script setup lang="ts">
import { computed } from 'vue';
import { useParticipants } from '../composables/useParticipants.js';
import { useParticipantSelection } from './useParticipantSelection.js';
import ParticipantsList from './ParticipantsList.vue';
import AgentEditor from './AgentEditor.vue';

const { byId, load } = useParticipants();
const { selectedId, select } = useParticipantSelection();

const selected = computed(() => (selectedId.value ? byId(selectedId.value) : undefined));

const detailKind = computed<'new' | 'agent' | 'user' | 'other' | 'none'>(() => {
  if (selectedId.value === 'new') return 'new';
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
    <div class="w-72 shrink-0 border-r border-line">
      <ParticipantsList @select="select" />
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
      <div
        v-else-if="detailKind === 'user'"
        data-test="user-editor-placeholder"
        class="p-6 text-sm text-faint"
      >
        User editor lands in the next milestone (Task 15)
      </div>
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
