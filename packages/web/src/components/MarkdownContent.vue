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

const copyResetTimeouts = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

function resetCopyButton(btn: HTMLButtonElement): void {
  const timeout = copyResetTimeouts.get(btn);
  if (timeout) {
    clearTimeout(timeout);
    copyResetTimeouts.delete(btn);
  }
  btn.textContent = 'Copy';
}

function onRootClick(e: MouseEvent): void {
  if (!(e.target instanceof Element)) return;

  const btn = e.target.closest<HTMLButtonElement>('[data-copy-code]');
  if (!btn) return;

  const pre = btn.closest('.code-block')?.querySelector('pre');
  if (!pre) return;

  const text = pre.textContent ?? '';
  try {
    if (!navigator.clipboard) {
      resetCopyButton(btn);
      return;
    }

    navigator.clipboard.writeText(text).then(() => {
      const timeout = copyResetTimeouts.get(btn);
      if (timeout) clearTimeout(timeout);

      btn.textContent = 'Copied!';
      copyResetTimeouts.set(btn, setTimeout(() => {
        btn.textContent = 'Copy';
        copyResetTimeouts.delete(btn);
      }, 2000));
    }).catch(() => {
      resetCopyButton(btn);
    });
  } catch {
    resetCopyButton(btn);
  }
}
</script>

<template>
  <!-- class="md-content" provides prose styles; parent classes are passed through via inheritAttrs -->
  <div class="md-content" v-html="rendered" @click="onRootClick" />
</template>
