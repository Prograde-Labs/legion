<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useProcess } from '../../composables/useProcess.js';
import ProcessStatusDot from './ProcessStatusDot.vue';
import AnsiOutput from './AnsiOutput.vue';

const props = defineProps<{ processId: string }>();
const emit = defineEmits<{ deleted: [] }>();

const { handle, chunks, error, stop, send, del } = useProcess(props.processId);

// Elapsed timer
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

function startTimer(): void {
  if (!timer)
    timer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
}
function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

watch(
  () => handle.value?.status,
  (status) => {
    if (status === 'running') startTimer();
    else stopTimer();
  },
  { immediate: true },
);

onUnmounted(stopTimer);

const elapsed = computed(() => {
  if (!handle.value) return '';
  const start = new Date(handle.value.startedAt).getTime();
  const end = handle.value.exitedAt ? new Date(handle.value.exitedAt).getTime() : now.value;
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
});

const isRunning = computed(() => handle.value?.status === 'running');

// Stdin
const stdinInput = ref('');
const sending = ref(false);
const stopping = ref(false);
const deleting = ref(false);

async function onSend(): Promise<void> {
  if (!stdinInput.value) return;
  sending.value = true;
  try {
    await send(stdinInput.value);
    stdinInput.value = '';
  } finally {
    sending.value = false;
  }
}

async function onStop(): Promise<void> {
  stopping.value = true;
  try {
    await stop();
  } finally {
    stopping.value = false;
  }
}

async function onDelete(): Promise<void> {
  deleting.value = true;
  try {
    await del();
    emit('deleted');
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- Loading state -->
    <div
      v-if="!handle && !error"
      class="flex-1 flex items-center justify-center text-faint text-xs"
    >
      Loading…
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="flex-1 flex items-center justify-center text-danger text-xs">
      {{ error }}
    </div>

    <!-- Detail view -->
    <template v-else-if="handle">
      <!-- Header bar -->
      <div class="flex items-center gap-3 px-4 py-2.5 border-b border-line flex-shrink-0">
        <ProcessStatusDot :status="handle.status" />
        <span class="text-xs font-semibold text-ink font-mono truncate">
          {{ handle.name ?? handle.command }}
          <span v-if="handle.args.length" class="text-faint font-normal">
            {{ handle.args.join(' ') }}</span
          >
        </span>
        <span class="text-[10px] text-faint">pid {{ handle.pid }}</span>
        <span class="text-[10px] text-faint">{{ elapsed }}</span>
        <span
          v-if="handle.exitCode !== null"
          class="text-[10px]"
          :class="handle.exitCode === 0 ? 'text-success' : 'text-danger'"
        >
          exit {{ handle.exitCode }}
        </span>

        <div class="ml-auto flex items-center gap-2">
          <button
            :disabled="!isRunning || stopping"
            class="text-xs px-3 py-1 rounded border transition-colors"
            :class="
              isRunning
                ? 'border-danger/40 text-danger hover:bg-danger/10'
                : 'border-line text-faint cursor-not-allowed'
            "
            @click="onStop"
          >
            {{ stopping ? 'Stopping…' : '■ Stop' }}
          </button>
          <button
            :disabled="isRunning || deleting"
            class="text-xs px-3 py-1 rounded border transition-colors"
            :class="
              !isRunning
                ? 'border-line text-muted hover:text-ink hover:border-line-strong'
                : 'border-line text-faint cursor-not-allowed'
            "
            @click="onDelete"
          >
            {{ deleting ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </div>

      <!-- Terminal output -->
      <AnsiOutput :chunks="chunks" class="flex-1 min-h-0" />

      <!-- Stdin footer — only when running -->
      <div
        v-if="isRunning"
        class="flex items-center gap-2 px-4 py-2.5 border-t border-line flex-shrink-0"
      >
        <input
          v-model="stdinInput"
          placeholder="stdin…"
          class="flex-1 bg-bg border border-line rounded px-3 py-1.5 text-xs text-ink outline-none focus:border-accent/50 font-mono"
          @keydown.enter="onSend"
        />
        <button
          :disabled="!stdinInput || sending"
          class="text-xs px-3 py-1.5 rounded border border-line text-muted hover:text-ink hover:border-line-strong disabled:opacity-40"
          @click="onSend"
        >
          Send
        </button>
      </div>
    </template>
  </div>
</template>
