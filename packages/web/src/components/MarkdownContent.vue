<script setup lang="ts">
import { ref, computed } from 'vue';
import { ensureReady, render } from '../lib/markdown.js';

const props = defineProps<{ content: string }>();

// ready flips to true when ensureReady() resolves.
// The computed below reads it to establish a reactive dependency,
// so the rendered HTML re-evaluates once Shiki is available.
const ready = ref(false);
ensureReady().then(() => {
  ready.value = true;
});

const rendered = computed(() => {
  void ready.value; // establish dependency
  return render(props.content);
});

function onRootClick(e: MouseEvent): void {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
  if (!btn) return;

  const pre = btn.closest('.code-block')?.querySelector('pre');
  if (!pre) return;

  const text = pre.textContent ?? '';
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 2000);
  }).catch(() => {
    btn.textContent = 'Copy';
  });
}
</script>

<template>
  <!-- class="md-content" provides prose styles; parent classes are passed through via inheritAttrs -->
  <div class="md-content" v-html="rendered" @click="onRootClick" />
</template>
