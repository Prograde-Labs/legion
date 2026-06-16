<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ConversationSummary } from '@legion/types';
import AppLayout from '../components/layout/AppLayout.vue';
import ConversationList from '../components/conversations/ConversationList.vue';
import ConversationThread from '../components/conversations/ConversationThread.vue';
import { useExecute } from '../composables/useExecute.js';

const { execute } = useExecute();
const route = useRoute();
const router = useRouter();

const conversations = ref<ConversationSummary[]>([]);
const activeId = ref<string | null>((route.params.id as string) ?? null);

onMounted(async () => {
  conversations.value = await execute<ConversationSummary[]>('list_conversations', {});
});

async function select(id: string) {
  activeId.value = id;
  await router.push(`/conversations/${id}`);
}
</script>

<template>
  <AppLayout>
    <div class="flex h-full">
      <ConversationList :conversations="conversations" :active-id="activeId" @select="select" />
      <ConversationThread :conversation-id="activeId" />
    </div>
  </AppLayout>
</template>
