<script setup lang="ts">
import { computed } from 'vue';

export interface ToolOverride {
  tool: string;
  source: string;
  enabled: boolean;
  requireApproval: boolean;
}

const props = defineProps<{
  overrides: ToolOverride[];
  availableTools: string[];
}>();

const emit = defineEmits<{
  'update:overrides': [value: ToolOverride[]];
}>();

// Build a unified list: every available tool, with its current state
const rows = computed(() => {
  const overrideMap = new Map(props.overrides.map((o) => [o.tool, o]));
  return props.availableTools.map((tool) => ({
    tool,
    override: overrideMap.get(tool) ?? null,
  }));
});

function setEnabled(tool: string, enabled: boolean) {
  const existing = props.overrides.find((o) => o.tool === tool);
  if (enabled) {
    if (existing) {
      emit(
        'update:overrides',
        props.overrides.map((o) => (o.tool === tool ? { ...o, enabled: true } : o)),
      );
    } else {
      emit('update:overrides', [
        ...props.overrides,
        { tool, source: 'built-in', enabled: true, requireApproval: false },
      ]);
    }
  } else {
    // Remove from overrides entirely — absent = hidden
    emit(
      'update:overrides',
      props.overrides.filter((o) => o.tool !== tool),
    );
  }
}

function toggleApproval(tool: string) {
  emit(
    'update:overrides',
    props.overrides.map((o) =>
      o.tool === tool ? { ...o, requireApproval: !o.requireApproval } : o,
    ),
  );
}
</script>

<template>
  <div class="space-y-1 p-5">
    <p class="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3">Tool access</p>
    <div
      v-for="{ tool, override } in rows"
      :key="tool"
      data-tool-row
      class="flex items-center gap-2 py-1.5 border-b border-line"
    >
      <input
        type="checkbox"
        :checked="override?.enabled ?? false"
        @change="setEnabled(tool, !override?.enabled)"
        class="accent-cyan-400"
      />
      <span
        :class="['flex-1 font-mono text-xs', override?.enabled ? 'text-slate-100' : 'text-faint']"
      >
        {{ tool }}
      </span>
      <button
        v-if="override?.enabled"
        @click="toggleApproval(tool)"
        :class="[
          'text-[9px] px-2 py-0.5 rounded border transition-colors',
          override.requireApproval
            ? 'bg-amber-400/10 border-amber-400/30 text-amber-400'
            : 'border-line text-faint',
        ]"
      >
        require approval
      </button>
    </div>
    <p v-if="availableTools.length === 0" class="text-[10px] text-faint italic py-2">
      No tools registered.
    </p>
  </div>
</template>
