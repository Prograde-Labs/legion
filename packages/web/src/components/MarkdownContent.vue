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
const copyOperations = new WeakMap<HTMLButtonElement, symbol>();

function clearCopyResetTimeout(btn: HTMLButtonElement): void {
  const timeout = copyResetTimeouts.get(btn);
  if (timeout) {
    clearTimeout(timeout);
    copyResetTimeouts.delete(btn);
  }
}

function resetCopyButton(btn: HTMLButtonElement): void {
  clearCopyResetTimeout(btn);
  btn.textContent = 'Copy';
}

function beginCopyOperation(btn: HTMLButtonElement): symbol {
  clearCopyResetTimeout(btn);
  const operation = Symbol('copy-operation');
  copyOperations.set(btn, operation);
  return operation;
}

function isCurrentCopyOperation(btn: HTMLButtonElement, operation: symbol): boolean {
  return copyOperations.get(btn) === operation;
}

function onRootClick(e: MouseEvent): void {
  if (!(e.target instanceof Element)) return;

  const btn = e.target.closest<HTMLButtonElement>('[data-copy-code]');
  if (!btn) return;

  const pre = btn.closest('.code-block')?.querySelector('pre');
  if (!pre) return;

  const text = pre.textContent ?? '';
  const operation = beginCopyOperation(btn);
  try {
    if (!navigator.clipboard) {
      resetCopyButton(btn);
      copyOperations.delete(btn);
      return;
    }

    navigator.clipboard
      .writeText(text)
      .then(() => {
        if (!isCurrentCopyOperation(btn, operation)) return;

        btn.textContent = 'Copied!';
        copyResetTimeouts.set(
          btn,
          setTimeout(() => {
            if (!isCurrentCopyOperation(btn, operation)) return;

            btn.textContent = 'Copy';
            copyResetTimeouts.delete(btn);
            copyOperations.delete(btn);
          }, 2000),
        );
      })
      .catch(() => {
        if (!isCurrentCopyOperation(btn, operation)) return;

        resetCopyButton(btn);
        copyOperations.delete(btn);
      });
  } catch {
    if (isCurrentCopyOperation(btn, operation)) {
      resetCopyButton(btn);
      copyOperations.delete(btn);
    }
  }
}
</script>

<template>
  <!-- class="md-content" provides prose styles; parent classes are passed through via inheritAttrs -->
  <div class="md-content" v-html="rendered" @click="onRootClick" />
</template>
