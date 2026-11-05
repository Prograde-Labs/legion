<script setup lang="ts">
defineOptions({ name: 'FileTreeRenderer' });
interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
}
defineProps<{ tool: string; args?: unknown; result?: unknown }>();
const entries = (r: { result?: unknown }) => (r.result as FileEntry[] | null) ?? [];
</script>
<template>
  <div class="p-3 font-mono text-[10px] space-y-0.5">
    <div
      v-for="e in entries($props)"
      :key="e.name"
      class="flex items-center gap-2 text-muted hover:text-ink"
    >
      <span>{{ e.type === 'dir' ? '📁' : '📄' }}</span>
      <span :class="e.type === 'dir' ? 'text-accent' : ''">{{ e.name }}</span>
      <span v-if="e.size" class="ml-auto text-faint">{{ e.size }}B</span>
    </div>
  </div>
</template>
