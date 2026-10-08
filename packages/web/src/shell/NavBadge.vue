<script setup lang="ts">
defineOptions({ name: 'NavBadge' });

defineProps<{ count: number; targetConversationId: string | null }>();
const emit = defineEmits<{ activate: [] }>();
</script>
<template>
  <button
    v-if="count > 0"
    type="button"
    data-test="nav-badge"
    class="ml-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent hover:bg-surface"
    @click="emit('activate')"
  >
    {{ count }}
  </button>
</template>
