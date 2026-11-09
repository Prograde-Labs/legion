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
  /** Render the current policies without allowing edits. */
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

const STRING_CONSTRAINT_KEYS = ['enum', 'pattern', 'minLength', 'maxLength', 'pathPrefix'] as const;
const NUMERIC_CONSTRAINT_KEYS = ['min', 'max'] as const;

type ScopeKind = 'string' | 'number' | 'unsupported';

/** Remembers an explicit Text/Number choice for tools with no declared arg type. */
const kindOverrides = ref<Record<string, 'string' | 'number'>>({});

function argumentSchema(tool: string, arg: string): JSONSchema | undefined {
  const properties = props.parameters?.[tool]?.properties;
  if (!properties || typeof properties !== 'object') return undefined;
  return (properties as Record<string, JSONSchema>)[arg];
}

function declaredKind(tool: string, arg: string): ScopeKind | undefined {
  const type = argumentSchema(tool, arg)?.type;
  if (type === 'string') return 'string';
  if (type === 'integer' || type === 'number') return 'number';
  if (type !== undefined) return 'unsupported';
  return undefined;
}

function hasStringConstraints(rule: ArgScope): boolean {
  return STRING_CONSTRAINT_KEYS.some((key) => rule[key] !== undefined);
}

function hasNumericConstraints(rule: ArgScope): boolean {
  return NUMERIC_CONSTRAINT_KEYS.some((key) => rule[key] !== undefined);
}

function scopeKind(tool: string, arg: string, rule: ArgScope): ScopeKind {
  const declared = declaredKind(tool, arg);
  if (declared) return declared;
  const override = kindOverrides.value[`${tool}:${arg}`];
  if (override) return override;
  if (hasNumericConstraints(rule)) return 'number';
  if (hasStringConstraints(rule)) return 'string';
  return 'string';
}

function setKind(tool: string, arg: string, kind: 'string' | 'number') {
  const override = props.overrides.find((o) => o.tool === tool);
  if (!override) return;
  kindOverrides.value = { ...kindOverrides.value, [`${tool}:${arg}`]: kind };
  const rule = { ...(override.scope?.[arg] ?? {}) };
  const remove = kind === 'string' ? NUMERIC_CONSTRAINT_KEYS : STRING_CONSTRAINT_KEYS;
  for (const key of remove) delete rule[key];
  updateScope(tool, { ...(override.scope ?? {}), [arg]: rule });
}

function onKind(tool: string, arg: string, event: Event) {
  setKind(tool, arg, (event.target as HTMLSelectElement).value as 'string' | 'number');
}

function argumentNameOptions(tool: string, current: string): string[] {
  const names = declaredArgumentNames(tool);
  return names.includes(current) ? names : [...names, current];
}

function canAddArgument(tool: string): boolean {
  const names = declaredArgumentNames(tool);
  if (names.length === 0) return true;
  const override = props.overrides.find((o) => o.tool === tool);
  const used = new Set(Object.keys(override?.scope ?? {}));
  return names.some((name) => !used.has(name));
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
    // A tool that declares arguments only accepts declared names, so adding
    // beyond them would create a rule the server rejects.
    if (declared.length > 0) return;
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
  const control = event.target as HTMLInputElement | HTMLSelectElement;
  // A rejected rename leaves state untouched, so reset the control to the name
  // that is actually stored (otherwise it would display an unsaved value).
  if (!renameArgument(tool, from, control.value)) control.value = from;
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
  const value = raw === '' ? undefined : Number(raw);
  updateRule(tool, arg, {
    [key]: value !== undefined && Number.isFinite(value) ? value : undefined,
  });
}

/** Lightweight mirror of the server rules for immediate feedback (spec §9). */
function scopeError(tool: string, arg: string, rule: ArgScope): string | null {
  const declaredNames = declaredArgumentNames(tool);
  if (declaredNames.length > 0 && !declaredNames.includes(arg)) {
    return 'unknown argument for this tool';
  }

  const declared = declaredKind(tool, arg);
  const hasString = hasStringConstraints(rule);
  const hasNumeric = hasNumericConstraints(rule);

  if (declared === 'unsupported') {
    if (hasString || hasNumeric) return 'constraints are not supported for this argument type';
    return null;
  }
  if (declared === 'string' && hasNumeric) {
    return 'numeric constraints require a number argument';
  }
  if (declared === 'number' && hasString) {
    return 'string constraints require a string argument';
  }
  if (hasString && hasNumeric) return 'cannot combine string and numeric constraints';

  if (rule.pattern !== undefined) {
    try {
      new RegExp(rule.pattern);
    } catch {
      return 'invalid pattern';
    }
  }
  for (const key of ['minLength', 'maxLength'] as const) {
    const bound = rule[key];
    if (bound !== undefined && (!Number.isInteger(bound) || bound < 0)) {
      return key === 'minLength'
        ? 'min length must be a non-negative integer'
        : 'max length must be a non-negative integer';
    }
  }
  if (
    rule.minLength !== undefined &&
    rule.maxLength !== undefined &&
    rule.minLength > rule.maxLength
  ) {
    return 'min length exceeds max length';
  }
  for (const key of ['min', 'max'] as const) {
    const bound = rule[key];
    if (bound !== undefined && !Number.isFinite(bound)) {
      return key === 'min' ? 'min must be a finite number' : 'max must be a finite number';
    }
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
        <div
          v-for="[arg, rule] in scopeRows(override)"
          :key="arg"
          data-scope-row
          class="grid grid-cols-2 gap-1 items-center"
        >
          <select
            v-if="declaredArgumentNames(tool).length"
            :value="arg"
            :disabled="readonly"
            data-arg-name
            class="rounded border border-line bg-surface px-1 py-0.5 font-mono text-[10px]"
            @change="onArgName(tool, arg, $event)"
          >
            <option v-for="name in argumentNameOptions(tool, arg)" :key="name" :value="name">
              {{ name }}
            </option>
          </select>
          <input
            v-else
            :value="arg"
            :disabled="readonly"
            data-arg-name
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
          <select
            v-if="!declaredKind(tool, arg)"
            :value="scopeKind(tool, arg, rule)"
            :disabled="readonly"
            data-scope-kind
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onKind(tool, arg, $event)"
          >
            <option value="string">Text</option>
            <option value="number">Number</option>
          </select>
          <template v-if="scopeKind(tool, arg, rule) === 'string'">
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
          </template>
          <template v-else-if="scopeKind(tool, arg, rule) === 'number'">
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
          </template>
          <p v-else class="col-span-2 text-[9px] text-faint" data-scope-unsupported>
            This argument type does not support scope constraints.
          </p>
          <button
            type="button"
            :disabled="readonly"
            class="text-[9px] px-2 py-0.5 rounded border border-line text-faint"
            @click="removeArgument(tool, arg)"
          >
            remove
          </button>
          <p
            v-if="scopeError(tool, arg, rule)"
            data-scope-error
            class="col-span-2 text-[9px] text-warning"
          >
            {{ scopeError(tool, arg, rule) }}
          </p>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            :disabled="readonly || !canAddArgument(tool)"
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
        <p v-if="!canAddArgument(tool)" class="text-[9px] text-faint">
          Every declared argument is already scoped.
        </p>
      </div>
    </div>
    <p v-if="availableTools.length === 0" class="text-[10px] text-faint italic py-2">
      No tools registered.
    </p>
  </div>
</template>
