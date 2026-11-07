<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ArgScope, JSONSchema, ToolScope } from '@legion-collective/types';

export interface ToolOverride {
  tool: string;
  source: string;
  enabled: boolean;
  requireApproval: boolean;
  scope?: ToolScope;
}

const props = defineProps<{
  overrides: ToolOverride[];
  availableTools: string[];
  parameters?: Record<string, JSONSchema>;
  /** Render the current policies without letting a non-operator mutate them. */
  readonly?: boolean;
}>();

const emit = defineEmits<{
  'update:overrides': [value: ToolOverride[]];
}>();

const expanded = ref<Record<string, boolean>>({});

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

function toggleScope(tool: string) {
  expanded.value = { ...expanded.value, [tool]: !expanded.value[tool] };
}

function scopeRows(override: ToolOverride): Array<[string, ArgScope]> {
  return Object.entries(override.scope ?? {});
}

function declaredArgumentNames(tool: string): string[] {
  const properties = props.parameters?.[tool]?.properties;
  if (!properties || typeof properties !== 'object') return [];
  return Object.keys(properties as Record<string, unknown>).filter((name) => name !== '');
}

function scopeCount(override: ToolOverride): number {
  return Object.keys(override.scope ?? {}).length;
}

function replaceOverride(tool: string, patch: Partial<ToolOverride>) {
  emit(
    'update:overrides',
    props.overrides.map((o) => (o.tool === tool ? { ...o, ...patch } : o)),
  );
}

function updateScope(tool: string, scope: ToolScope) {
  replaceOverride(tool, { scope });
}

function addArgument(tool: string) {
  const override = props.overrides.find((o) => o.tool === tool);
  if (!override) return;
  const existing = override.scope ?? {};
  const used = new Set(Object.keys(existing));
  const declared = declaredArgumentNames(tool);
  let next = declared.find((name) => !used.has(name));
  if (!next) {
    // Fallback names must not collide with an existing rule (e.g. scope { arg2 }
    // with no declared parameters must yield arg3, not overwrite arg2).
    let index = Object.keys(existing).length + 1;
    while (used.has(`arg${index}`)) index += 1;
    next = `arg${index}`;
  }
  updateScope(tool, { ...existing, [next]: {} });
}

function removeArgument(tool: string, arg: string) {
  const override = props.overrides.find((o) => o.tool === tool);
  if (!override) return;
  const next = { ...(override.scope ?? {}) };
  delete next[arg];
  updateScope(tool, next);
}

function renameArgument(tool: string, from: string, to: string): boolean {
  const override = props.overrides.find((o) => o.tool === tool);
  if (!override || to === '' || from === to) return false;
  const scope = override.scope ?? {};
  // Refuse to rename onto an existing key: the server would accept the
  // resulting scope, silently discarding the other argument's rule.
  if (Object.prototype.hasOwnProperty.call(scope, to)) return false;
  const next: ToolScope = {};
  for (const [key, rule] of Object.entries(scope)) {
    next[key === from ? to : key] = rule;
  }
  updateScope(tool, next);
  return true;
}

function updateRule(tool: string, arg: string, patch: Partial<ArgScope>) {
  const override = props.overrides.find((o) => o.tool === tool);
  if (!override) return;
  const merged = { ...(override.scope?.[arg] ?? {}), ...patch };
  const clean = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as ArgScope;
  updateScope(tool, { ...(override.scope ?? {}), [arg]: clean });
}

function onArgName(tool: string, from: string, event: Event) {
  const input = event.target as HTMLInputElement;
  // A rejected rename leaves state untouched, so reset the input to the name
  // that is actually stored (otherwise it would display an unsaved value).
  if (!renameArgument(tool, from, input.value)) input.value = from;
}

function onRequired(tool: string, arg: string, event: Event) {
  updateRule(tool, arg, {
    required: (event.target as HTMLInputElement).checked || undefined,
  });
}

function onEnum(tool: string, arg: string, event: Event) {
  const values = (event.target as HTMLInputElement).value
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  updateRule(tool, arg, { enum: values.length ? values : undefined });
}

function onText(tool: string, arg: string, key: 'pattern' | 'pathPrefix', event: Event) {
  const value = (event.target as HTMLInputElement).value;
  updateRule(tool, arg, { [key]: value === '' ? undefined : value });
}

function onNumber(
  tool: string,
  arg: string,
  key: 'minLength' | 'maxLength' | 'min' | 'max',
  event: Event,
) {
  const raw = (event.target as HTMLInputElement).value;
  updateRule(tool, arg, { [key]: raw === '' ? undefined : Number(raw) });
}

/** Lightweight mirror of the server rules for immediate feedback (spec §9). */
function scopeError(rule: ArgScope): string | null {
  if (rule.pattern !== undefined) {
    try {
      new RegExp(rule.pattern);
    } catch {
      return 'invalid pattern';
    }
  }
  if (
    rule.minLength !== undefined &&
    rule.maxLength !== undefined &&
    rule.minLength > rule.maxLength
  ) {
    return 'min length exceeds max length';
  }
  if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) {
    return 'min exceeds max';
  }
  return null;
}
</script>

<template>
  <div class="space-y-1 p-5">
    <p class="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3">Tool access</p>
    <div
      v-for="{ tool, override } in rows"
      :key="tool"
      data-tool-row
      class="flex items-center gap-2 py-1.5 border-b border-line flex-wrap"
    >
      <input
        type="checkbox"
        :checked="override?.enabled ?? false"
        :disabled="readonly"
        @change="setEnabled(tool, !override?.enabled)"
        class="accent-accent disabled:opacity-60"
      />
      <span :class="['flex-1 font-mono text-xs', override?.enabled ? 'text-ink' : 'text-faint']">
        {{ tool }}
      </span>
      <button
        v-if="override?.enabled"
        type="button"
        :disabled="readonly"
        @click="toggleApproval(tool)"
        :class="[
          'text-[9px] px-2 py-0.5 rounded border transition-colors',
          override.requireApproval
            ? 'bg-warning/10 border-warning/30 text-warning'
            : 'border-line text-faint',
        ]"
      >
        require approval
      </button>
      <button
        v-if="override?.enabled"
        type="button"
        data-scope-toggle
        class="text-[9px] px-2 py-0.5 rounded border border-line text-faint"
        @click="toggleScope(tool)"
      >
        scope<span data-scope-count v-if="scopeCount(override) > 0">
          {{ scopeCount(override) }}</span
        >
      </button>
      <div
        v-if="override?.enabled && expanded[tool]"
        data-scope-editor
        class="w-full mt-1 space-y-1 rounded border border-line bg-surface p-2"
      >
        <datalist :id="`scope-args-${tool}`">
          <option v-for="name in declaredArgumentNames(tool)" :key="name" :value="name" />
        </datalist>
        <div
          v-for="[arg, rule] in scopeRows(override)"
          :key="arg"
          data-scope-row
          class="grid grid-cols-2 gap-1 items-center"
        >
          <input
            :value="arg"
            :list="`scope-args-${tool}`"
            :disabled="readonly"
            placeholder="argument name"
            class="rounded border border-line bg-surface px-1 py-0.5 font-mono text-[10px]"
            @change="onArgName(tool, arg, $event)"
          />
          <label class="flex items-center gap-1 text-[10px] text-faint">
            <input
              type="checkbox"
              :checked="rule.required ?? false"
              :disabled="readonly"
              @change="onRequired(tool, arg, $event)"
            />
            required
          </label>
          <input
            placeholder="enum (comma separated)"
            :value="rule.enum?.join(', ') ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onEnum(tool, arg, $event)"
          />
          <input
            placeholder="pattern"
            :value="rule.pattern ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onText(tool, arg, 'pattern', $event)"
          />
          <input
            type="number"
            placeholder="min"
            :value="rule.min ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onNumber(tool, arg, 'min', $event)"
          />
          <input
            type="number"
            placeholder="max"
            :value="rule.max ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onNumber(tool, arg, 'max', $event)"
          />
          <input
            type="number"
            placeholder="min length"
            :value="rule.minLength ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onNumber(tool, arg, 'minLength', $event)"
          />
          <input
            type="number"
            placeholder="max length"
            :value="rule.maxLength ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onNumber(tool, arg, 'maxLength', $event)"
          />
          <input
            placeholder="path prefix"
            :value="rule.pathPrefix ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onText(tool, arg, 'pathPrefix', $event)"
          />
          <button
            type="button"
            :disabled="readonly"
            class="text-[9px] px-2 py-0.5 rounded border border-line text-faint"
            @click="removeArgument(tool, arg)"
          >
            remove
          </button>
          <p v-if="scopeError(rule)" data-scope-error class="col-span-2 text-[9px] text-warning">
            {{ scopeError(rule) }}
          </p>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            :disabled="readonly"
            data-add-arg
            class="text-[9px] px-2 py-0.5 rounded border border-line text-faint"
            @click="addArgument(tool)"
          >
            add argument
          </button>
          <button
            type="button"
            :disabled="readonly"
            class="text-[9px] px-2 py-0.5 rounded border border-line text-faint"
            @click="updateScope(tool, {})"
          >
            clear scope
          </button>
        </div>
      </div>
    </div>
    <p v-if="availableTools.length === 0" class="text-[10px] text-faint italic py-2">
      No tools registered.
    </p>
  </div>
</template>
