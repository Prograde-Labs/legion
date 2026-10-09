<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ConversationList from './ConversationList.vue';
import Thread from './Thread.vue';
import Composer from './Composer.vue';
import SearchableCombobox from '../components/common/SearchableCombobox.vue';
import DockPanel from '../panels/DockPanel.vue';
import { useDock, lookupPanel, CommunicatePanel } from '../panels/registry.js';
import { useConversations } from '../composables/useConversations.js';
import { useReadState } from '../composables/useReadState.js';
import { useApprovals } from '../composables/useApprovals.js';
import { useParticipants } from '../composables/useParticipants.js';

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

// Right dock (spec §5): one dock per ChatView; conversation switches restore
// that conversation's persisted tab set. Watch extends the route->store glue
// above rather than adding a second watcher on the same source.
const dock = useDock();
watch(
  () => store.activeId.value,
  (id) => {
    dock.setConversation(id);
  },
  { immediate: true },
);

// Draft mode (spec §4.4): no route id means a new conversation. The recipient
// picker lists active agents; the first communicate (Composer @sent) creates
// the conversation server-side and the new id arrives with the sent event,
// at which point the route replaces /chat → /chat/<id>.
const recipientId = ref<string | null>(null);
const isDraft = computed(() => !route.params.id);

const { participants } = useParticipants();

// Recipient options read the shared participants store; fetch it on first mount
// (the same store feeds the participants view, so this is a no-op if already loaded).
onMounted(
  () =>
    void useParticipants()
      .load()
      .catch(() => {}),
);

const recipientOptions = computed(() =>
  participants.value
    .filter((p) => p.type === 'agent' && p.status !== 'retired')
    .map((p) => ({ value: p.id, label: p.name || p.id })),
);

// Composer Stop flag; Thread owns its internal isStreaming (not cross-wired in
// this slice — 12c keeps the two states independent).
const streaming = ref(false);
const branchLabel = ref<string | undefined>(undefined);

// Thread exposes cancelStream (step 3d) so Composer's Stop also cancels the
// in-flight communicate stream via useToolStream.cancel().
const threadRef = ref<InstanceType<typeof Thread> | null>(null);

function onSent(conversationId: string | null): void {
  if (isDraft.value && conversationId) {
    // First send on a draft: communicate created the conversation server-side;
    // replace (not push) so back doesn't return to the empty /chat draft.
    void router.replace(`/chat/${conversationId}`);
    return;
  }
  // Thread reloads via its own stream:done path
}

async function onStop(): Promise<void> {
  streaming.value = false;
  await threadRef.value?.cancelStream();
}

// Thread `open` events (ToolCallChip inspect, Task 7) land in the dock now:
// a panel entry is looked up per tool and opened as a dock tab. `communicate`
// opens the CommunicatePanel sub-chat; anything else falls back to the
// ToolDetailPanel entry (registry fallback, 13a).
function onChipOpen(tool: string, payload: Record<string, unknown>): void {
  const entry = lookupPanel(tool);
  dock.open({
    kind: entry.component === CommunicatePanel ? 'communicate' : 'tool-detail',
    title: entry.title(payload),
    icon: '🔧',
    payload: { ...payload, tool },
  });
}

function onDockJump(messageId: string): void {
  void messageId; // Task 14+ message-focus wiring; breadcrumb lands here today
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
      <Thread v-if="!isDraft" ref="threadRef" :conversation-id="activeId" @open="onChipOpen" />
      <div v-else class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p class="text-sm text-muted">Start a new conversation — pick a recipient.</p>
        <div class="w-64" data-test="recipient-picker">
          <SearchableCombobox
            :options="recipientOptions"
            placeholder="Search agents…"
            :model-value="recipientId"
            @select="recipientId = $event"
            @update:model-value="recipientId = $event"
          />
        </div>
      </div>
      <Composer
        :conversation-id="activeId"
        :recipient-id="recipientId"
        :branch-label="branchLabel"
        :streaming="streaming"
        @sent="onSent"
        @stop="onStop"
      />
    </div>
    <!-- Right dock edge toggle (desktop affordance; dock covers full screen on mobile) -->
    <button
      type="button"
      data-test="dock-toggle"
      class="shrink-0 rounded-l-md border border-r-0 border-line px-1 py-3 text-xs text-muted hover:bg-surface"
      aria-label="Toggle dock"
      @click="dock.isOpen.value = !dock.isOpen.value"
    >
      ▸
    </button>
    <DockPanel v-if="dock.isOpen.value" class="shrink-0" @jump="onDockJump" />
  </div>
</template>
