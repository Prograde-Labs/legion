<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  modelValue: { tools?: Record<string, boolean> | '*'; participants?: string[] | '*' } | null;
  availableTools: string[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: { tools: Record<string, boolean> | '*' }];
}>();

const isWildcard = computed(() => props.modelValue?.tools === '*');

const toolState = computed<Record<string, boolean>>(() =>
  isWildcard.value || !props.modelValue?.tools
    ? {}
    : (props.modelValue.tools as Record<string, boolean>),
);

function emitWildcard(value: boolean): void {
  emit('update:modelValue', { tools: value ? '*' : {} });
}

function emitTool(tool: string, value: boolean): void {
  emit('update:modelValue', { tools: { ...toolState.value, [tool]: value } });
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <label class="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        data-test="wildcard"
        :checked="isWildcard"
        @change="emitWildcard(($event.target as HTMLInputElement).checked)"
      />
      May approve any tool (wildcard)
    </label>
    <div v-if="!isWildcard" class="flex flex-col gap-1">
      <label v-for="t in availableTools" :key="t" class="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          :data-test="`tool-${t}`"
          :checked="toolState[t] ?? false"
          @change="emitTool(t, ($event.target as HTMLInputElement).checked)"
        />
        <span class="font-mono">{{ t }}</span>
      </label>
    </div>
  </div>
</template>
