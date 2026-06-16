<script setup lang="ts">
defineOptions({ name: 'SearchResultRenderer' });
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
defineProps<{ tool: string; args?: unknown; result?: unknown }>();
const results = (r: { result?: unknown }) => (r.result as SearchResult[] | null) ?? [];
</script>
<template>
  <div class="p-3 space-y-2">
    <div
      v-for="r in results($props)"
      :key="r.url"
      class="bg-navy-950 border border-navy-600 rounded p-2.5"
    >
      <p class="text-[11px] font-medium text-cyan-300 mb-0.5">{{ r.title }}</p>
      <p class="text-[9px] font-mono text-navy-500 mb-1">{{ r.url }}</p>
      <p class="text-[10px] text-slate-500 leading-relaxed">{{ r.snippet }}</p>
    </div>
  </div>
</template>
