<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{
  options: { value: string; label: string }[];
  placeholder?: string;
  modelValue?: string | null;
}>();

const emit = defineEmits<{
  select: [value: string];
  'update:modelValue': [value: string];
}>();

const query = ref('');
const open = ref(false);
const selectedLabel = ref('');

const filtered = computed(() =>
  props.options.filter((o) =>
    o.label.toLowerCase().includes(query.value.toLowerCase()),
  ),
);

function onFocus() {
  open.value = true;
}

function onBlur() {
  // Delay so click on option fires first
  setTimeout(() => { open.value = false; }, 150);
}

function select(option: { value: string; label: string }) {
  selectedLabel.value = option.label;
  query.value = '';
  open.value = false;
  emit('select', option.value);
  emit('update:modelValue', option.value);
}
</script>

<template>
  <div class="relative">
    <input
      :value="open ? query : selectedLabel"
      :placeholder="selectedLabel || placeholder"
      class="w-full bg-navy-900 border border-navy-700 rounded px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-600"
      @input="query = ($event.target as HTMLInputElement).value"
      @focus="onFocus"
      @blur="onBlur"
    />
    <ul
      v-if="open"
      class="absolute z-50 mt-1 w-full bg-navy-800 border border-navy-700 rounded shadow-lg max-h-48 overflow-y-auto"
    >
      <li
        v-for="option in filtered"
        :key="option.value"
        data-option
        class="px-3 py-2 text-sm text-slate-200 hover:bg-navy-700 cursor-pointer"
        @mousedown.prevent="select(option)"
      >
        {{ option.label }}
      </li>
      <li v-if="filtered.length === 0" class="px-3 py-2 text-sm text-slate-500">
        No results
      </li>
    </ul>
  </div>
</template>
