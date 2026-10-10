<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { AnsiUp } from 'ansi_up';

const props = defineProps<{ chunks: string[] }>();

const ansiUp = new AnsiUp();
const renderedHtml = ref('');
const preEl = ref<HTMLPreElement | null>(null);
const atBottom = ref(true);
let processed = 0;

function processNewChunks(): void {
  const newChunks = props.chunks.slice(processed);
  if (newChunks.length === 0) return;
  for (const chunk of newChunks) {
    renderedHtml.value += ansiUp.ansi_to_html(chunk);
  }
  processed = props.chunks.length;
  void nextTick(() => {
    if (atBottom.value && preEl.value) {
      preEl.value.scrollTop = preEl.value.scrollHeight;
    }
  });
}

function onScroll(): void {
  if (!preEl.value) return;
  atBottom.value = preEl.value.scrollHeight - preEl.value.scrollTop - preEl.value.clientHeight < 50;
}

function scrollToBottom(): void {
  if (!preEl.value) return;
  preEl.value.scrollTop = preEl.value.scrollHeight;
  atBottom.value = true;
}

watch(() => props.chunks.length, processNewChunks);

onMounted(() => {
  preEl.value?.addEventListener('scroll', onScroll);
  processNewChunks();
});

onUnmounted(() => {
  preEl.value?.removeEventListener('scroll', onScroll);
});
</script>

<template>
  <div class="relative flex-1 min-h-0 overflow-hidden">
    <pre
      ref="preEl"
      class="h-full overflow-y-auto m-0 rounded bg-bg text-ink font-mono text-[11.5px] leading-relaxed px-4 py-3.5"
      v-html="renderedHtml"
    />
    <button
      v-if="!atBottom"
      class="absolute bottom-3 right-3 text-[10px] px-2 py-1 rounded bg-surface-raised text-muted hover:text-ink border border-line"
      @click="scrollToBottom"
    >
      ↓ scroll to bottom
    </button>
  </div>
</template>
