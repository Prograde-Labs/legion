<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { FailureMode, JSONValue, MiddlewareInstanceConfig } from '@legion-collective/types';
import MiddlewareSchemaForm from './MiddlewareSchemaForm.vue';
import SkillsSelector from './SkillsSelector.vue';
import type {
  MiddlewareDefinitionInfo,
  MiddlewareDiagnosticInfo,
  SkillInfo,
} from './middleware-ui-types.js';

const props = defineProps<{
  modelValue: MiddlewareInstanceConfig[];
  definitions: MiddlewareDefinitionInfo[];
  diagnostics?: MiddlewareDiagnosticInfo[];
  skills: SkillInfo[];
  credentialKeys: string[];
}>();
const emit = defineEmits<{
  'update:modelValue': [value: MiddlewareInstanceConfig[]];
  validation: [errors: string[]];
}>();
const addType = ref('');
const fieldErrors = ref<Record<string, string[]>>({});
const definitionMap = computed(() => new Map(props.definitions.map((item) => [item.type, item])));
const errors = computed(() => Object.values(fieldErrors.value).flat());
watch(errors, (value) => emit('validation', value), { immediate: true });
watch(
  () => props.modelValue.map((instance) => instance.id),
  (ids) => {
    const retained = Object.fromEntries(
      Object.entries(fieldErrors.value).filter(([instanceId]) => ids.includes(instanceId)),
    );
    if (Object.keys(retained).length !== Object.keys(fieldErrors.value).length) {
      fieldErrors.value = retained;
    }
  },
);

function replace(index: number, patch: Partial<MiddlewareInstanceConfig>) {
  const next = props.modelValue.map((item, itemIndex) =>
    itemIndex === index ? { ...item, ...patch } : item,
  );
  emit('update:modelValue', next);
}
function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= props.modelValue.length) return;
  const next = [...props.modelValue];
  [next[index], next[target]] = [next[target], next[index]];
  emit('update:modelValue', next);
}
function remove(index: number) {
  const id = props.modelValue[index].id;
  const nextErrors = { ...fieldErrors.value };
  delete nextErrors[id];
  fieldErrors.value = nextErrors;
  emit(
    'update:modelValue',
    props.modelValue.filter((_, itemIndex) => itemIndex !== index),
  );
}
function setFieldErrors(instanceId: string, value: string[]) {
  fieldErrors.value = { ...fieldErrors.value, [instanceId]: value };
}
function add() {
  const definition = definitionMap.value.get(addType.value);
  if (!definition) return;
  const stem = definition.type.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const used = new Set(props.modelValue.map((item) => item.id));
  let suffix = 1;
  while (used.has(`${stem}-${suffix}`)) suffix += 1;
  emit('update:modelValue', [
    ...props.modelValue,
    { id: `${stem}-${suffix}`, type: definition.type, config: {} },
  ]);
  addType.value = '';
}
function updateSkills(index: number, value: string[]) {
  replace(index, { config: { ...props.modelValue[index].config, skills: value } });
}
function updateConfig(index: number, value: JSONValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  replace(index, { config: value });
}
function setFailure(index: number, value: string) {
  const current = props.modelValue[index];
  const next = { ...current };
  if (value) next.failureMode = value as FailureMode;
  else delete next.failureMode;
  replace(index, next);
}
function diagnosticMessages(instance: MiddlewareInstanceConfig): string[] {
  return (props.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.type === instance.type)
    .flatMap((diagnostic) => [
      ...(diagnostic.error ? [diagnostic.error] : []),
      ...diagnostic.configurationErrors
        .filter((error) => error.instanceId === instance.id)
        .flatMap((error) => error.errors),
    ]);
}
</script>

<template>
  <div class="space-y-3 p-5">
    <div
      v-for="(instance, index) in modelValue"
      :key="instance.id"
      class="rounded-lg border border-navy-700 bg-navy-900 p-3"
    >
      <div class="flex items-center gap-2">
        <div>
          <div class="text-xs font-semibold text-slate-100">
            {{ definitionMap.get(instance.type)?.displayName ?? instance.type }}
          </div>
          <div class="font-mono text-[10px] text-navy-500">{{ instance.id }}</div>
        </div>
        <button
          type="button"
          :data-move-up="instance.id"
          :disabled="index === 0"
          @click="move(index, -1)"
        >
          ↑
        </button>
        <button type="button" :disabled="index === modelValue.length - 1" @click="move(index, 1)">
          ↓
        </button>
        <label class="ml-auto text-xs text-slate-400">
          <input
            :data-enabled="instance.id"
            type="checkbox"
            :checked="instance.enabled !== false"
            :disabled="!definitionMap.has(instance.type)"
            @change="replace(index, { enabled: ($event.target as HTMLInputElement).checked })"
          />
          Enabled
        </label>
        <button
          type="button"
          :data-remove="instance.id"
          class="text-xs text-red-400"
          @click="remove(index)"
        >
          Remove
        </button>
      </div>

      <div v-if="!definitionMap.has(instance.type)" :data-unknown="instance.id" class="mt-3">
        <p class="text-xs text-amber-400">
          Definition unavailable. Disabled configuration is preserved.
        </p>
        <p
          v-for="diagnostic in diagnosticMessages(instance)"
          :key="diagnostic"
          class="mt-1 text-[10px] text-amber-400"
        >
          {{ diagnostic }}
        </p>
        <pre
          :data-raw-config="instance.id"
          class="mt-2 overflow-auto rounded bg-navy-950 p-2 text-[10px] text-slate-400"
          >{{ JSON.stringify(instance.config, null, 2) }}</pre
        >
      </div>
      <template v-else>
        <label class="mt-3 block text-[10px] uppercase tracking-wider text-navy-400"
          >Failure mode</label
        >
        <select
          :data-failure="instance.id"
          :value="instance.failureMode ?? ''"
          class="mt-1 rounded border border-navy-600 bg-navy-950 px-2 py-1 text-xs text-slate-200"
          @change="setFailure(index, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">
            Inherited: {{ definitionMap.get(instance.type)!.defaultFailureMode }}
          </option>
          <option value="open">Override: open</option>
          <option value="closed">Override: closed</option>
        </select>
        <div class="mt-3">
          <SkillsSelector
            v-if="instance.type === 'builtin:skills'"
            :model-value="(instance.config.skills as string[] | undefined) ?? []"
            :skills="skills"
            @update:model-value="updateSkills(index, $event)"
          />
          <MiddlewareSchemaForm
            v-else
            :schema="definitionMap.get(instance.type)!.configSchema"
            :model-value="instance.config"
            :credential-keys="credentialKeys"
            @update:model-value="updateConfig(index, $event)"
            @validation="setFieldErrors(instance.id, $event)"
          />
        </div>
        <p
          v-for="diagnostic in diagnosticMessages(instance)"
          :key="diagnostic"
          class="mt-2 text-[10px] text-amber-400"
        >
          {{ diagnostic }}
        </p>
      </template>
    </div>

    <div class="flex gap-2">
      <select
        v-model="addType"
        class="flex-1 rounded border border-navy-600 bg-navy-950 px-2 py-1.5 text-xs text-slate-200"
      >
        <option value="">Add middleware...</option>
        <option v-for="definition in definitions" :key="definition.type" :value="definition.type">
          {{ definition.displayName }}
        </option>
      </select>
      <button
        type="button"
        :disabled="!addType"
        class="rounded bg-cyan-700 px-3 py-1.5 text-xs text-white"
        @click="add"
      >
        Add
      </button>
    </div>
  </div>
</template>
