<script setup lang="ts">
import { ref } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';

const props = defineProps<{
  conversationId: string;
  message: { id: string; content?: string };
}>();

const emit = defineEmits<{ mutated: [] }>();

const { execute } = useLegionApi();

const open = ref(false);
const editing = ref(false);
const draft = ref('');
const confirmingPrune = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

// Menu toggle doubles as the error-dismiss: closing the menu clears a stale
// error (mirrors ApprovalCard's clear-on-next-action pattern).
function toggleMenu(): void {
  open.value = !open.value;
  if (!open.value) error.value = null;
}

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await action();
    open.value = false;
    editing.value = false;
    confirmingPrune.value = false;
    emit('mutated');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function startEdit(): void {
  draft.value = props.message.content ?? '';
  editing.value = true;
  open.value = false;
  error.value = null;
}

function saveEdit(): void {
  void run(() =>
    execute('edit_message', {
      conversationId: props.conversationId,
      messageId: props.message.id,
      newContent: draft.value,
    }),
  );
}

function rerun(): void {
  void run(() => execute('generate', { conversationId: props.conversationId }));
}

function prune(): void {
  if (!confirmingPrune.value) {
    confirmingPrune.value = true;
    return;
  }
  void run(() =>
    execute('prune_message', { conversationId: props.conversationId, messageId: props.message.id }),
  );
}
</script>

<template>
  <div class="relative inline-flex items-center gap-1" data-test="message-actions">
    <button
      type="button"
      data-test="actions-toggle"
      class="rounded px-1 text-xs text-faint hover:bg-surface hover:text-accent"
      aria-label="Message actions"
      @click="toggleMenu"
    >
      ⋯
    </button>
    <div
      v-if="open"
      class="absolute left-0 top-6 z-10 w-44 rounded-md border border-line bg-surface-raised py-1 text-xs"
    >
      <button
        v-if="!editing"
        type="button"
        data-test="action-edit"
        class="block w-full px-2 py-1 text-left hover:bg-surface"
        @click="startEdit"
      >
        Edit as new branch
      </button>
      <button
        v-if="!editing"
        type="button"
        data-test="action-rerun"
        :disabled="busy"
        class="block w-full px-2 py-1 text-left hover:bg-surface"
        @click="rerun"
      >
        Re-run
      </button>
      <button
        v-if="!editing"
        type="button"
        data-test="action-prune"
        class="block w-full px-2 py-1 text-left text-danger hover:bg-surface"
        @click="prune"
      >
        {{ confirmingPrune ? 'Confirm prune' : 'Prune' }}
      </button>
    </div>
    <div v-if="error" data-test="actions-error" class="px-1 text-xs text-danger">{{ error }}</div>
    <div v-if="editing" data-test="edit-area" class="flex w-full flex-col gap-1">
      <textarea
        v-model="draft"
        data-test="edit-textarea"
        class="min-h-16 rounded border border-line bg-surface px-2 py-1 text-sm outline-none"
      />
      <div class="flex gap-1">
        <button
          type="button"
          data-test="edit-save"
          :disabled="busy"
          class="rounded bg-accent-soft px-2 py-0.5 text-xs text-accent"
          @click="saveEdit"
        >
          Save
        </button>
        <button
          type="button"
          data-test="edit-cancel"
          class="rounded px-2 py-0.5 text-xs text-faint"
          @click="editing = false"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
</template>
