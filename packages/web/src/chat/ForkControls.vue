<script setup lang="ts">
import { computed, ref } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';

const props = defineProps<{
  conversationId: string;
  message: { id: string; content?: string; alternates?: Array<{ id: string; content: string }> };
}>();

const emit = defineEmits<{ switched: [] }>();

const { execute } = useLegionApi();

// Position: 0 = the message itself, 1..n = its alternates
const index = ref(0);

const siblings = computed(() => [
  { id: props.message.id, content: props.message.content ?? '' },
  ...(props.message.alternates ?? []),
]);

async function go(delta: number): Promise<void> {
  const next = (index.value + delta + siblings.value.length) % siblings.value.length;
  if (next === index.value) return;
  index.value = next;
  await execute('switch_branch', {
    conversationId: props.conversationId,
    messageId: siblings.value[next]!.id,
  });
  emit('switched');
}

async function jump(alternateId: string): Promise<void> {
  const target = siblings.value.findIndex((s) => s.id === alternateId);
  if (target < 0) return;
  index.value = target;
  await execute('switch_branch', { conversationId: props.conversationId, messageId: alternateId });
  emit('switched');
}
</script>

<template>
  <div v-if="(message.alternates?.length ?? 0) > 0" class="flex flex-wrap items-center gap-1.5">
    <div data-test="fork-pager" class="flex items-center text-xs text-muted">
      <button
        type="button"
        data-test="fork-prev"
        aria-label="Previous version"
        class="px-0.5 hover:text-accent"
        @click="go(-1)"
      >
        ‹{{ ' ' }}
      </button>
      <span>{{ index + 1 }}/{{ siblings.length }}</span>
      <button
        type="button"
        data-test="fork-next"
        aria-label="Next version"
        class="px-0.5 hover:text-accent"
        @click="go(1)"
      >
        {{ ' ' }}›
      </button>
    </div>
    <button
      v-for="alt in message.alternates"
      :key="alt.id"
      type="button"
      data-test="branch-chip"
      class="max-w-40 truncate rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-faint hover:bg-surface-raised"
      :title="alt.content"
      @click="jump(alt.id)"
    >
      ⎇ {{ alt.content.slice(0, 24) }}
    </button>
  </div>
</template>
