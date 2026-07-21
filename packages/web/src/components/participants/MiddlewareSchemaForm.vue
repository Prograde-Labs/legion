<script setup lang="ts">
import { computed, watch } from 'vue';
import type { JSONValue } from '@legion/types';
import type { MiddlewareSchemaNode } from './middleware-ui-types.js';

const props = defineProps<{
  schema: MiddlewareSchemaNode;
  modelValue: JSONValue;
  credentialKeys: string[];
  path?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: JSONValue];
  validation: [errors: string[]];
}>();

const fields = computed(() => Object.entries(props.schema.properties ?? {}));
const objectValue = computed<Record<string, JSONValue>>(() =>
  props.modelValue && typeof props.modelValue === 'object' && !Array.isArray(props.modelValue)
    ? (props.modelValue as Record<string, JSONValue>)
    : {},
);
const fieldPath = (name: string) => (props.path ? `${props.path}.${name}` : name);
const fieldLabel = (name: string, node: MiddlewareSchemaNode) => node.title ?? name;
const credentialOptions = (value: JSONValue | undefined) => [
  ...new Set([...props.credentialKeys, ...(typeof value === 'string' && value ? [value] : [])]),
];

function validate(
  schema: MiddlewareSchemaNode,
  value: JSONValue | undefined,
  label: string,
  required = false,
): string[] {
  if (value === undefined || value === '') return required ? [`${label} is required`] : [];
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [`${label} must be an object`];
    }
    return Object.entries(schema.properties ?? {}).flatMap(([name, child]) =>
      validate(
        child,
        (value as Record<string, JSONValue>)[name],
        label === 'Configuration' ? fieldLabel(name, child) : `${label}.${fieldLabel(name, child)}`,
        schema.required?.includes(name) ?? false,
      ),
    );
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${label} must be an array`];
    const duplicateErrors =
      schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length
        ? [`${label} entries must be unique`]
        : [];
    return duplicateErrors.concat(
      value.flatMap((item, index) =>
        validate(schema.items ?? {}, item, `${label}[${index}]`, true),
      ),
    );
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${label} must be text`];
    if (schema.enum && !schema.enum.includes(value)) {
      return [`${label} must be one of ${schema.enum.join(', ')}`];
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return [`${label} must contain at least ${schema.minLength} characters`];
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return [`${label} must contain at most ${schema.maxLength} characters`];
    }
    return [];
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${label} must be a number`];
    if (schema.type === 'integer' && !Number.isInteger(value))
      return [`${label} must be an integer`];
    if (schema.minimum !== undefined && value < schema.minimum)
      return [`${label} must be at least ${schema.minimum}`];
    if (schema.maximum !== undefined && value > schema.maximum)
      return [`${label} must be at most ${schema.maximum}`];
    return [];
  }
  if (schema.type === 'boolean') {
    return typeof value === 'boolean' ? [] : [`${label} must be true or false`];
  }
  return [`${label} uses unsupported schema type ${schema.type ?? 'missing'}`];
}

const errors = computed(() =>
  validate(props.schema, props.modelValue, props.schema.title ?? 'Configuration', true),
);

watch(errors, (value) => emit('validation', value), { immediate: true });

function update(name: string, node: MiddlewareSchemaNode, raw: JSONValue) {
  let value: JSONValue;
  if (node.type === 'boolean') value = Boolean(raw);
  else if (node.type === 'integer' || node.type === 'number') value = Number(raw);
  else if (node.type === 'array') {
    value = String(raw)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  } else if (node.type === 'object') value = raw;
  else value = String(raw);
  emit('update:modelValue', { ...objectValue.value, [name]: value });
}
</script>

<template>
  <div class="space-y-3">
    <div v-for="[name, node] in fields" :key="name">
      <label class="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-navy-400">
        {{ fieldLabel(name, node) }}
      </label>
      <MiddlewareSchemaForm
        v-if="node.type === 'object'"
        :schema="node"
        :model-value="objectValue[name] ?? {}"
        :credential-keys="credentialKeys"
        :path="fieldPath(name)"
        @update:model-value="update(name, node, $event)"
      />
      <select
        v-else-if="node.format === 'credential-reference'"
        :data-field="fieldPath(name)"
        :value="objectValue[name] ?? ''"
        class="w-full rounded border border-navy-600 bg-navy-950 px-2 py-1.5 text-xs text-slate-200"
        @change="update(name, node, ($event.target as HTMLSelectElement).value)"
      >
        <option value="">Select credential...</option>
        <option v-for="key in credentialOptions(objectValue[name])" :key="key" :value="key">
          {{ key }}
        </option>
      </select>
      <select
        v-else-if="node.enum"
        :data-field="fieldPath(name)"
        :value="objectValue[name] ?? ''"
        class="w-full rounded border border-navy-600 bg-navy-950 px-2 py-1.5 text-xs text-slate-200"
        @change="update(name, node, ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="option in node.enum" :key="option" :value="option">{{ option }}</option>
      </select>
      <input
        v-else-if="node.type === 'boolean'"
        :data-field="fieldPath(name)"
        type="checkbox"
        :checked="objectValue[name] === true"
        @change="update(name, node, ($event.target as HTMLInputElement).checked)"
      />
      <input
        v-else-if="node.type === 'number' || node.type === 'integer'"
        :data-field="fieldPath(name)"
        type="number"
        :min="node.minimum"
        :max="node.maximum"
        :step="node.type === 'integer' ? 1 : 'any'"
        :value="objectValue[name] ?? ''"
        class="w-full rounded border border-navy-600 bg-navy-950 px-2 py-1.5 text-xs text-slate-200"
        @input="update(name, node, ($event.target as HTMLInputElement).value)"
      />
      <input
        v-else-if="node.type === 'string' || node.type === 'array'"
        :data-field="fieldPath(name)"
        type="text"
        :value="
          Array.isArray(objectValue[name])
            ? (objectValue[name] as string[]).join(', ')
            : (objectValue[name] ?? '')
        "
        class="w-full rounded border border-navy-600 bg-navy-950 px-2 py-1.5 text-xs text-slate-200"
        @input="update(name, node, ($event.target as HTMLInputElement).value)"
      />
      <p v-else class="text-xs text-amber-400">
        {{ fieldLabel(name, node) }} uses unsupported schema type {{ node.type }}
      </p>
      <p v-if="node.description" class="mt-1 text-[10px] text-navy-500">{{ node.description }}</p>
    </div>
    <p v-for="error in errors" :key="error" class="text-[10px] text-red-400">{{ error }}</p>
  </div>
</template>
