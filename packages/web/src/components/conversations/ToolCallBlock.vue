<script setup lang="ts">
import { ref } from 'vue';
import TypeBadge from '../common/TypeBadge.vue';
import ToolResultRenderer from '../../renderers/ToolResultRenderer.vue';

export interface ToolCallEntry {
  id: string;
  tool: string;
  type: 'tool:call' | 'tool:result' | 'delegation';
  args?: unknown;
  result?: unknown;
  timestamp: string;
  subThread?: MessageEntry[];
}

export interface MessageEntry {
  id: string;
  author: string;
  authorColour: string;
  content: string;
  timestamp: string;
  toolCalls?: ToolCallEntry[];
}

defineProps<{ entry: ToolCallEntry }>();
const open = ref(false);
</script>

<template>
  <div
    :class="[
      'border rounded-md my-1.5 overflow-hidden',
      entry.type === 'delegation' ? 'border-amber-400/30' : 'border-navy-600',
    ]"
  >
    <button
      @click="open = !open"
      class="flex items-center gap-2 px-3 py-1.5 w-full hover:bg-white/[.02] text-left"
    >
      <span :class="['text-[9px] transition-transform', open ? 'rotate-90' : '']">▶</span>
      <TypeBadge :type="entry.type" />
      <span class="font-mono text-[11px] text-slate-100">{{ entry.tool }}</span>
      <span class="ml-auto text-[9px] text-navy-500">{{ entry.timestamp }}</span>
    </button>
    <div v-if="open" class="border-t border-navy-700">
      <template v-if="entry.type === 'delegation' && entry.subThread">
        <div class="border-l-2 border-amber-400/30 ml-3 my-2">
          <SubThreadBlock :messages="entry.subThread" />
        </div>
      </template>
      <template v-else>
        <ToolResultRenderer :tool="entry.tool" :args="entry.args" :result="entry.result" />
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import SubThreadBlock from './SubThreadBlock.vue';
</script>
