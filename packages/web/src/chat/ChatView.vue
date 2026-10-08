<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ConversationList from './ConversationList.vue';
import { useConversations } from '../composables/useConversations.js';
import { useReadState } from '../composables/useReadState.js';
import { useApprovals } from '../composables/useApprovals.js';

const route = useRoute();
const router = useRouter();
const store = useConversations();

// Badge initial load on the home surface (WS subscription alone does not fetch).
onMounted(
  () =>
    void useApprovals()
      .refresh()
      .catch(() => {}),
);

const drawerOpen = ref(false);

// Route param -> shared activeId
watch(
  () => route.params.id as string | undefined,
  (id) => {
    store.select(id ?? null);
    if (id) {
      drawerOpen.value = false;
      // Reading a conversation marks it read (spec §4.1 unread dot clears).
      useReadState().markRead(id);
    }
  },
  { immediate: true },
);

// Shared activeId -> route
watch(
  () => store.activeId.value,
  (id) => {
    const target = id ? `/chat/${id}` : '/chat';
    if (route.path !== target) void router.push(target);
  },
);

function onSelect(id: string | null): void {
  void router.push(id ? `/chat/${id}` : '/chat');
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- Mobile backdrop -->
    <div
      v-if="drawerOpen"
      data-test="drawer-backdrop"
      class="fixed inset-0 z-30 bg-black/50 md:hidden"
      @click="drawerOpen = false"
    />
    <!-- Conversation column: static on desktop, off-canvas drawer on mobile -->
    <aside
      class="flex w-[17rem] flex-col border-r border-line bg-bg max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-72 max-md:-translate-x-full max-md:transition-transform"
      :class="{ 'max-md:translate-x-0': drawerOpen }"
    >
      <ConversationList @select="onSelect" />
    </aside>
    <!-- Main thread column -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-2 border-b border-line px-3 py-2 md:hidden">
        <button
          type="button"
          data-test="drawer-toggle"
          aria-label="Toggle conversations"
          class="rounded-md px-2 py-1 text-sm hover:bg-surface"
          @click="drawerOpen = true"
        >
          ☰
        </button>
        <span class="text-sm text-muted">Conversations</span>
      </header>
      <div class="min-h-0 flex-1" data-test="thread-placeholder" />
    </div>
  </div>
</template>
