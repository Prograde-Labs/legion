<script setup lang="ts">
import { computed } from 'vue';
import type { MessageData } from '@legion-collective/types';
import MarkdownContent from '../components/MarkdownContent.vue';
import ReasoningDisclosure from '../components/conversations/ReasoningDisclosure.vue';
import ToolCallChip from './ToolCallChip.vue';
import { lookupRenderer } from '../renderers/registry.js';

const props = defineProps<{ message: MessageData; streaming?: boolean }>();

type ToolCallData = NonNullable<MessageData['toolCalls']>[number];
type ToolCallResult = NonNullable<MessageData['toolResults']>[number];

const emit = defineEmits<{ open: [tool: string, payload: Record<string, unknown>] }>();

const toolPairs = computed(() => {
  const calls: ToolCallData[] = props.message.toolCalls ?? [];
  const results = new Map<string, ToolCallResult>(
    (props.message.toolResults ?? []).map((r) => [r.id, r]),
  );
  return calls.map((c) => ({
    call: c,
    result: results.get(c.id),
  }));
});

function chipStatus(result?: ToolCallResult): 'running' | 'done' | 'error' {
  if (!result) return 'running';
  return result.result.status === 'error' ? 'error' : 'done';
}
</script>

<template>
  <article data-test="msg" class="flex flex-col gap-2">
    <ReasoningDisclosure
      v-if="message.reasoning"
      :content="message.reasoning"
      :streaming="streaming ?? false"
    />
    <MarkdownContent v-if="message.content" :content="message.content" class="md-content" />
    <div v-if="toolPairs.length" class="flex flex-col gap-1.5">
      <div v-for="pair in toolPairs" :key="pair.call.id" class="flex flex-col gap-1">
        <ToolCallChip
          :tool="pair.call.name"
          :status="chipStatus(pair.result)"
          :payload="{
            tool: pair.call.name,
            args: pair.call.arguments,
            result: pair.result?.result,
          }"
          @open="(tool, payload) => emit('open', tool, payload)"
        />
        <details v-if="pair.result" class="rounded-md border border-line bg-surface px-2 py-1.5">
          <summary class="cursor-pointer text-xs text-faint">Result</summary>
          <component
            :is="lookupRenderer(pair.call.name)"
            :tool="pair.call.name"
            :args="pair.call.arguments"
            :result="pair.result.result"
          />
        </details>
      </div>
    </div>
    <slot name="actions" :message="message" />
  </article>
</template>
