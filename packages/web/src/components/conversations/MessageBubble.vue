<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MessageWithAlternates } from '../../composables/useConversation.js';
import MarkdownContent from '../MarkdownContent.vue';

const props = defineProps<{
  message: MessageWithAlternates;
  isOwn: boolean;
  senderName: string;
}>();

const emit = defineEmits<{
  edit: [messageId: string, content: string, rerun: boolean];
  prune: [messageId: string];
  compactAbove: [messageId: string];
  switchBranch: [messageId: string];
}>();

const menuOpen = ref(false);
const editing = ref(false);
const confirmingPrune = ref(false);
const editContent = ref(props.message.content);

const versions = computed(() =>
  [
    ...(props.message.alternates ?? []),
    { id: props.message.id, content: props.message.content, timestamp: props.message.timestamp },
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
);

const currentIndex = computed(() =>
  versions.value.findIndex((version) => version.id === props.message.id),
);
const hasAlternates = computed(() => (props.message.alternates?.length ?? 0) > 0);

function startEdit() {
  editContent.value = props.message.content;
  editing.value = true;
  menuOpen.value = false;
}

function save(rerun: boolean) {
  emit('edit', props.message.id, editContent.value, rerun);
  editing.value = false;
}

function switchRelative(delta: number) {
  const next = versions.value[currentIndex.value + delta];
  if (next && next.id !== props.message.id) emit('switchBranch', next.id);
}
</script>

<template>
  <div data-bubble class="flex flex-col gap-1" :class="isOwn ? 'items-end' : 'items-start'">
    <!-- Metadata row -->
    <div
      class="flex items-center gap-2 text-xs text-navy-600"
      :class="isOwn ? 'flex-row-reverse' : ''"
    >
      <span>{{ senderName }}</span>
      <span
        v-if="message.editOf"
        class="rounded bg-navy-800 px-1.5 py-0.5 text-[10px] text-slate-400"
      >
        edited
      </span>
      <div v-if="hasAlternates" class="flex items-center gap-1 rounded bg-navy-900 px-1.5 py-0.5">
        <button
          data-branch-prev
          type="button"
          :disabled="currentIndex <= 0"
          class="text-slate-500 disabled:opacity-30"
          @click="switchRelative(-1)"
        >
          &lt;
        </button>
        <span>{{ currentIndex + 1 }}/{{ versions.length }}</span>
        <button
          data-branch-next
          type="button"
          :disabled="currentIndex >= versions.length - 1"
          class="text-slate-500 disabled:opacity-30"
          @click="switchRelative(1)"
        >
          &gt;
        </button>
      </div>
      <div class="relative">
        <button
          data-menu
          type="button"
          class="rounded px-1.5 hover:bg-navy-800"
          @click="menuOpen = !menuOpen"
        >
          ...
        </button>
        <div
          v-if="menuOpen"
          class="absolute z-20 mt-1 min-w-36 rounded border border-navy-700 bg-navy-900 p-1 text-slate-300 shadow-lg"
        >
          <button
            data-edit
            type="button"
            class="block w-full rounded px-2 py-1 text-left hover:bg-navy-800"
            @click="startEdit"
          >
            Edit
          </button>
          <button
            data-prune
            type="button"
            class="block w-full rounded px-2 py-1 text-left hover:bg-navy-800"
            @click="confirmingPrune = true"
          >
            Prune
          </button>
          <div class="my-1 border-t border-navy-700"></div>
          <button
            type="button"
            class="block w-full rounded px-2 py-1 text-left hover:bg-navy-800"
            @click="
              emit('compactAbove', message.id);
              menuOpen = false;
            "
          >
            Compact above
          </button>
          <div v-if="confirmingPrune" class="mt-1 border-t border-navy-700 pt-1">
            <button
              data-confirm-prune
              type="button"
              class="block w-full rounded px-2 py-1 text-left text-red-400 hover:bg-navy-800"
              @click="
                emit('prune', message.id);
                menuOpen = false;
                confirmingPrune = false;
              "
            >
              Confirm prune
            </button>
            <button
              type="button"
              class="block w-full rounded px-2 py-1 text-left hover:bg-navy-800"
              @click="confirmingPrune = false"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Summary badge -->
    <div
      v-if="message.type === 'summary'"
      class="mb-1 text-[10px] font-medium uppercase tracking-wide text-cyan-400"
    >
      [S] Summary
    </div>

    <!-- Inline editor or message bubble -->
    <div v-if="editing" class="flex w-full max-w-[72%] flex-col gap-2">
      <textarea
        v-model="editContent"
        rows="4"
        class="rounded-lg border border-cyan-800 bg-navy-950 px-3 py-2 text-sm text-slate-200"
      />
      <div class="flex gap-2 text-xs">
        <button class="rounded bg-cyan-700 px-2 py-1 text-white" @click="save(true)">
          Save &amp; re-run
        </button>
        <button
          data-save-only
          class="rounded bg-navy-800 px-2 py-1 text-slate-200"
          @click="save(false)"
        >
          Save only
        </button>
        <button class="px-2 py-1 text-slate-500" @click="editing = false">Cancel</button>
      </div>
    </div>
    <MarkdownContent
      v-else-if="message.content?.trim()"
      :content="message.content.trim()"
      class="max-w-[72%] px-3 py-2 text-sm leading-relaxed break-words"
      :class="
        message.type === 'summary'
          ? 'border-l-2 border-cyan-500 bg-navy-700 text-slate-200 rounded-[12px]'
          : isOwn
            ? 'bg-cyan-700 text-white rounded-[12px_12px_3px_12px]'
            : 'bg-navy-800 text-slate-200 rounded-[12px_12px_12px_3px]'
      "
    />

    <!-- Tool calls / approval cards slot -->
    <div v-if="$slots.tools" class="max-w-[72%] flex flex-col gap-1.5">
      <slot name="tools" />
    </div>
  </div>
</template>
