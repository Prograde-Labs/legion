<script setup lang="ts">
import { ref, computed } from 'vue';

export interface ToolOverride {
  tool: string;
  source: string;
  enabled: boolean;
  requireApproval: boolean;
}

const props = defineProps<{
  defaultPolicy: 'allow' | 'require-approval' | 'deny';
  overrides: ToolOverride[];
  availableTools: string[];
}>();

const emit = defineEmits<{
  'update:defaultPolicy': [value: string];
  'update:overrides': [value: ToolOverride[]];
}>();

const policies = ['allow', 'require-approval', 'deny'] as const;

function toggleEnabled(index: number) {
  const next = props.overrides.map((o, i) => (i === index ? { ...o, enabled: !o.enabled } : o));
  emit('update:overrides', next);
}

function toggleApproval(index: number) {
  const next = props.overrides.map((o, i) =>
    i === index ? { ...o, requireApproval: !o.requireApproval } : o,
  );
  emit('update:overrides', next);
}

function removeOverride(index: number) {
  emit(
    'update:overrides',
    props.overrides.filter((_, i) => i !== index),
  );
}

function addTool(toolName: string) {
  if (!toolName || props.overrides.find((o) => o.tool === toolName)) return;
  emit('update:overrides', [
    ...props.overrides,
    { tool: toolName, source: 'built-in', enabled: true, requireApproval: false },
  ]);
}

const grouped = computed(() => {
  const map = new Map<string, ToolOverride[]>();
  for (const o of props.overrides) {
    const src = o.source;
    if (!map.has(src)) map.set(src, []);
    map.get(src)!.push(o);
  }
  return map;
});

const addingTool = ref('');
</script>

<template>
  <div class="space-y-4 p-5">
    <!-- Default policy -->
    <div>
      <p class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold mb-2">
        Default policy
      </p>
      <div class="flex gap-2">
        <button
          v-for="p in policies"
          :key="p"
          @click="emit('update:defaultPolicy', p)"
          :class="[
            'text-xs px-3 py-1.5 rounded border transition-colors',
            defaultPolicy === p
              ? 'bg-cyan-400/10 border-cyan-400/30 text-cyan-400'
              : 'border-navy-600 text-navy-400 hover:text-slate-200',
          ]"
        >
          {{ p }}
        </button>
      </div>
    </div>

    <!-- Per-tool overrides -->
    <div>
      <p class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold mb-2">
        Per-tool overrides
      </p>
      <template v-for="[source, items] in grouped" :key="source">
        <p class="text-[9px] uppercase tracking-wider text-navy-500 font-semibold py-1.5">
          {{ source }}
        </p>
        <div
          v-for="override in items"
          :key="override.tool"
          data-tool-row
          class="flex items-center gap-2 py-1.5 border-b border-navy-900"
        >
          <input
            type="checkbox"
            :checked="override.enabled"
            @change="toggleEnabled(props.overrides.indexOf(override))"
            class="accent-cyan-400"
          />
          <span
            :class="[
              'flex-1 font-mono text-xs',
              override.enabled ? 'text-slate-100' : 'text-navy-500',
            ]"
          >
            {{ override.tool }}
          </span>
          <button
            v-if="override.enabled"
            @click="toggleApproval(props.overrides.indexOf(override))"
            :class="[
              'text-[9px] px-2 py-0.5 rounded border transition-colors',
              override.requireApproval
                ? 'bg-amber-400/10 border-amber-400/30 text-amber-400'
                : 'border-navy-600 text-navy-500',
            ]"
          >
            require approval
          </button>
          <button
            @click="removeOverride(props.overrides.indexOf(override))"
            class="text-navy-600 hover:text-red-400 text-sm leading-none"
          >
            ×
          </button>
        </div>
      </template>

      <!-- Add tool -->
      <div class="flex gap-2 mt-3">
        <select
          v-model="addingTool"
          class="flex-1 bg-navy-900 border border-navy-600 rounded text-xs text-navy-400 px-2 py-1.5 font-mono"
        >
          <option value="">— add tool override —</option>
          <option v-for="t in availableTools" :key="t" :value="t">{{ t }}</option>
        </select>
        <button
          @click="
            addTool(addingTool);
            addingTool = '';
          "
          class="text-xs px-3 py-1.5 bg-cyan-400/10 border border-cyan-400/30 text-cyan-400 rounded"
        >
          Add
        </button>
      </div>
    </div>
  </div>
</template>
