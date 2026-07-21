<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SkillInfo } from './middleware-ui-types.js';

const props = defineProps<{ modelValue: string[]; skills: SkillInfo[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();
const search = ref('');
const filtered = computed(() => {
  const query = search.value.toLowerCase();
  return props.skills.filter(
    (skill) =>
      !props.modelValue.includes(skill.name) &&
      (skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query)),
  );
});
const byName = computed(() => new Map(props.skills.map((skill) => [skill.name, skill])));
function add(name: string) {
  if (!props.modelValue.includes(name)) emit('update:modelValue', [...props.modelValue, name]);
}
function remove(name: string) {
  emit(
    'update:modelValue',
    props.modelValue.filter((selected) => selected !== name),
  );
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="name in modelValue"
      :key="name"
      :data-selected-skill="name"
      class="flex items-center gap-2 rounded border border-navy-700 bg-navy-950 px-2 py-1.5"
    >
      <span class="text-xs font-medium text-slate-200">{{ name }}</span>
      <span class="text-[10px] text-navy-500">{{ byName.get(name)?.scope ?? 'unavailable' }}</span>
      <button
        type="button"
        :data-remove-skill="name"
        class="ml-auto text-xs text-red-400"
        @click="remove(name)"
      >
        Remove
      </button>
    </div>
    <input
      v-model="search"
      data-skill-search
      placeholder="Search skills..."
      class="w-full rounded border border-navy-600 bg-navy-950 px-2 py-1.5 text-xs text-slate-200"
    />
    <button
      v-for="skill in filtered"
      :key="skill.name"
      type="button"
      :data-skill-option="skill.name"
      class="block w-full rounded border border-navy-700 px-2 py-2 text-left hover:bg-navy-800"
      @click="add(skill.name)"
    >
      <span class="block text-xs text-slate-200">{{ skill.name }}</span>
      <span class="block text-[10px] text-navy-500"
        >{{ skill.description }} · {{ skill.scope }}</span
      >
    </button>
  </div>
</template>
