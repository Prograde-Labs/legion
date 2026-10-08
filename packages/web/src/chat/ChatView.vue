<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ConversationList from './ConversationList.vue';
import Thread from './Thread.vue';
import Composer from './Composer.vue';
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

// Ref values nested in a template expression do not auto-unwrap (only top-level
// bindings do), so bind the thread/composer through this computed.
const activeId = computed(() => store.activeId.value);

// TODO(task-13/14): recipient selection via @-mentions/dock targeting. The send
// path is real; the default routes to agent-a like the e2e flow does today.
const recipientId = ref<string | null>('agent-a');

// Composer Stop flag; Thread owns its internal isStreaming (not cross-wired in
// this slice — 12c keeps the two states independent).
const streaming = ref(false);
const branchLabel = ref<string | undefined>(undefined);

// Thread exposes cancelStream (step 3d) so Composer's Stop also cancels the
// in-flight communicate stream via useToolStream.cancel().
const threadRef = ref<InstanceType<typeof Thread> | null>(null);

function onSent(conversationId: string | null): void {
  void conversationId; // Thread reloads via its own stream:done path
}

async function onStop(): Promise<void> {
  streaming.value = false;
  await threadRef.value?.cancelStream();
}

// Thread `open` events (ToolCallChip inspect, Task 7) have no consumer yet —
// Task 13 mounts DockPanel here. Dead end by design in this slice.
function onToolOpen(tool: string, payload: Record<string, unknown>): void {
  void tool;
  void payload;
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
      <Thread ref="threadRef" :conversation-id="activeId" @open="onToolOpen" />
      <Composer
        :conversation-id="activeId"
        :recipient-id="recipientId"
        :branch-label="branchLabel"
        :streaming="streaming"
        @sent="onSent"
        @stop="onStop"
      />
    </div>
  </div>
</template>
