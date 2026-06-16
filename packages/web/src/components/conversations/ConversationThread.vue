<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import type { MessageEntry } from './ToolCallBlock.vue';
import SubThreadBlock from './SubThreadBlock.vue';
import { useEventStream } from '../../composables/useEventStream.js';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{ conversationId: string | null }>();
const { execute } = useExecute();
const { subscribe } = useEventStream();

const messages = ref<MessageEntry[]>([]);
const isLive = ref(false);

async function load(id: string) {
  const authorColours: Record<string, string> = {};
  const palette = ['#22d3ee', '#f59e0b', '#a78bfa', '#4ade80', '#f87171'];
  let colourIdx = 0;
  function colourFor(author: string) {
    if (!authorColours[author]) authorColours[author] = palette[colourIdx++ % palette.length]!;
    return authorColours[author]!;
  }

  const data = await execute<{ messages: any[] }>('get_conversation', { id });
  messages.value = (data.messages ?? []).map((m: any) => ({
    id: m.id,
    author: m.participantId,
    authorColour: colourFor(m.participantId),
    content: m.content ?? '',
    timestamp: new Date(m.createdAt).toLocaleTimeString(),
    toolCalls: (m.toolCalls ?? []).map((tc: any) => ({
      id: tc.callId,
      tool: tc.tool,
      type: tc.tool === 'send_message' ? 'delegation' : 'tool:call',
      args: tc.arguments,
      timestamp: '',
    })),
  }));
}

let off: (() => void) | null = null;

watch(
  () => props.conversationId,
  async (id) => {
    if (!id) return;
    await load(id);
    isLive.value = true;
    if (off) off();
    off = subscribe((evt) => {
      if (evt.event === 'message:sent' && (evt.data as any).conversationId === props.conversationId) {
        if (props.conversationId) load(props.conversationId);
      }
    });
  },
);

onUnmounted(() => off?.());
</script>

<template>
  <div v-if="conversationId" class="flex-1 flex flex-col min-h-0">
    <div class="px-5 py-3 border-b border-navy-600 bg-navy-900 flex items-center gap-3">
      <span class="font-mono text-xs font-semibold text-slate-100">{{ conversationId }}</span>
      <StatusDot v-if="isLive" status="live" />
      <span v-if="isLive" class="text-[10px] text-cyan-400">Live</span>
    </div>
    <div class="flex-1 overflow-y-auto px-5 py-4">
      <SubThreadBlock :messages="messages" />
    </div>
    <div class="px-5 py-2.5 border-t border-navy-600 bg-navy-900">
      <span class="text-[10px] text-navy-500 italic">Read-only monitoring view.</span>
    </div>
  </div>
  <div v-else class="flex-1 flex items-center justify-center">
    <p class="text-navy-500 text-sm">Select a conversation</p>
  </div>
</template>
<script lang="ts">
import StatusDot from '../common/StatusDot.vue';
</script>
