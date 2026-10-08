<script setup lang="ts">
import { computed, ref } from 'vue';
import { useParticipants } from '../composables/useParticipants.js';
import TypeBadge from '../components/common/TypeBadge.vue';
import StatusDot from '../components/common/StatusDot.vue';

const emit = defineEmits<{ select: [id: string | null] }>();

const { participants } = useParticipants();
const search = ref('');

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return participants.value;
  return participants.value.filter((p) => p.name.toLowerCase().includes(q));
});

function modelLabel(p: { type: string; model?: { model?: string } }): string {
  return p.type === 'agent' ? (p.model?.model ?? '') : '';
}
</script>

<template>
  <div class="flex h-full flex-col">
    <input
      v-model="search"
      type="search"
      data-test="participant-search"
      placeholder="Search participants"
      class="border-b border-line bg-transparent px-3 py-2 text-sm outline-none placeholder:text-faint"
    />
    <div class="min-h-0 flex-1 overflow-y-auto">
      <button
        v-for="p in filtered"
        :key="p.id"
        type="button"
        data-test="participant-row"
        class="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left hover:bg-surface"
        @click="emit('select', p.id)"
      >
        <StatusDot :status="p.status as 'active' | 'retired' | 'live' | 'complete'" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-ink">{{ p.name }}</span>
          <span v-if="modelLabel(p)" class="block truncate font-mono text-xs text-faint">{{
            modelLabel(p)
          }}</span>
        </span>
        <span data-test="type-badge"><TypeBadge :type="p.type" /></span>
      </button>
    </div>
    <button
      type="button"
      data-test="new-agent"
      class="border-t border-line px-3 py-2 text-left text-sm text-accent hover:bg-surface"
      @click="emit('select', 'new')"
    >
      ＋ New agent
    </button>
    <button
      type="button"
      data-test="new-user"
      class="border-t border-line px-3 py-2 text-left text-sm text-accent hover:bg-surface"
      @click="emit('select', 'new-user')"
    >
      ＋ New user
    </button>
  </div>
</template>
