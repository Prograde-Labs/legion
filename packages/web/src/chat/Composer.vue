<script setup lang="ts">
import { computed, ref } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useParticipants } from '../composables/useParticipants.js';
import { useAuth } from '../composables/useAuth.js';

const props = defineProps<{
  conversationId: string | null;
  recipientId: string | null;
  branchLabel?: string;
  streaming?: boolean;
}>();

const emit = defineEmits<{
  sent: [conversationId: string | null];
  stop: [];
  streamSend: [payload: { to: string | null; message: string }];
}>();

const { execute } = useLegionApi();
const { participants } = useParticipants();
const auth = useAuth();

const draft = ref('');
const mentionQuery = ref<string | null>(null);

const agents = computed(() =>
  participants.value.filter(
    (p) => p.type === 'agent' && (p as { status?: string }).status !== 'retired',
  ),
);

const mentionList = computed(() => {
  if (mentionQuery.value === null) return [];
  const q = mentionQuery.value.toLowerCase();
  return agents.value.filter((a) => a.id.toLowerCase().includes(q));
});

const toolHints = computed<string[]>(() => {
  const me = auth.participantId; // OQ4: hints derive from the user's own tools map when available
  const tools = (auth as { tools?: { value?: string[] } }).tools?.value;
  if (!tools) return []; // hidden, never guessed (open question 4 default)
  void me;
  return tools;
});

function onInput(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  draft.value = value;
  const match = /(?:^|\s)@([\w-]*)$/.exec(value);
  mentionQuery.value = match ? (match[1] ?? '') : null;
}

function pickMention(id: string): void {
  draft.value = draft.value.replace(/@([\w-]*)$/, `@${id} `);
  mentionQuery.value = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

async function send(): Promise<void> {
  const message = draft.value.trim();
  if (!message || !props.recipientId) return;
  // Existing conversation: hand off to Thread.send → the streaming communicate
  // POST (final-review C1/I1 fix). Executing communicate here as well would
  // send the message twice — the streaming POST is the send.
  if (props.conversationId) {
    draft.value = '';
    mentionQuery.value = null;
    emit('streamSend', { to: props.recipientId, message });
    return;
  }
  let sentConversationId: string | null = props.conversationId ?? null;
  try {
    // Draft sends (conversationId undefined) create the conversation server-side;
    // the tool returns its id (communicate → data.conversationId).
    const data = await execute<{ conversationId?: string }>('communicate', {
      to: props.recipientId,
      message,
      conversationId: props.conversationId ?? undefined,
    });
    sentConversationId = data?.conversationId ?? sentConversationId;
  } finally {
    draft.value = '';
    mentionQuery.value = null;
  }
  emit('sent', sentConversationId);
}
</script>

<template>
  <div data-test="composer" class="flex flex-col gap-1 border-t border-line px-4 py-2">
    <div v-if="branchLabel" data-test="branch-indicator" class="text-xs text-faint">
      ⎇ replying on branch {{ branchLabel }}
    </div>
    <div
      v-if="mentionList.length"
      data-test="mention-list"
      class="rounded-md border border-line bg-surface-raised p-1 text-xs"
    >
      <button
        v-for="a in mentionList"
        :key="a.id"
        type="button"
        class="block w-full rounded px-2 py-1 text-left hover:bg-surface"
        @click="pickMention(a.id)"
      >
        @{{ a.id }}
      </button>
    </div>
    <div v-if="toolHints.length" class="flex flex-wrap gap-1 text-xs text-faint">
      <span v-for="t in toolHints" :key="t" class="rounded bg-surface px-1.5 py-0.5 font-mono">{{
        t
      }}</span>
    </div>
    <textarea
      :value="draft"
      rows="2"
      data-test="composer-input"
      placeholder="Message…  (@ to mention, Enter to send)"
      class="w-full resize-none rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-faint"
      @input="onInput"
      @keydown="onKeydown"
    />
    <div class="flex items-center justify-end gap-2">
      <button
        v-if="streaming"
        type="button"
        data-test="composer-stop"
        class="rounded border border-line px-3 py-1 text-xs text-danger hover:bg-surface"
        @click="emit('stop')"
      >
        Stop
      </button>
    </div>
  </div>
</template>
