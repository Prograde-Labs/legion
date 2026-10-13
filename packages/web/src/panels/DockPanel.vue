<script setup lang="ts">
import { computed } from 'vue';
import { lookupPanel, useDock } from './registry.js';

const dock = useDock();

const activeTab = computed(() => dock.tabs.value.find((t) => t.id === dock.activeId.value) ?? null);
const activeEntry = computed(() =>
  activeTab.value ? lookupPanel(activeTab.value.payload['tool'] as string) : null,
);

let dragFrom = -1;
function onDragStart(index: number): void {
  dragFrom = index;
}
function onDrop(index: number): void {
  if (dragFrom >= 0) dock.reorder(dragFrom, index);
  dragFrom = -1;
}

function startResize(event: MouseEvent): void {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = dock.width.value;
  const move = (e: MouseEvent): void => {
    dock.width.value = Math.max(280, startWidth - (e.clientX - startX));
  };
  const up = (): void => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
</script>

<template>
  <aside
    data-test="dock-root"
    class="flex flex-col border-l border-line bg-bg max-md:fixed max-md:inset-0 max-md:z-40"
    :style="{ width: `${dock.width.value}px` }"
  >
    <div class="flex items-center overflow-x-auto border-b border-line">
      <button
        v-for="(tab, index) in dock.tabs.value"
        :key="tab.id"
        type="button"
        data-test="dock-tab"
        draggable="true"
        class="flex shrink-0 items-center gap-1 border-b-2 px-2.5 py-1.5 text-xs"
        :class="
          tab.id === dock.activeId.value
            ? 'border-accent text-ink'
            : 'border-transparent text-muted hover:text-ink'
        "
        @click="dock.activeId.value = tab.id"
        @dragstart="onDragStart(index)"
        @dragover.prevent
        @drop="onDrop(index)"
      >
        <span aria-hidden="true">{{ tab.icon }}</span>
        <span class="max-w-32 truncate">{{ tab.title }}</span>
        <span
          data-test="dock-tab-close"
          class="ml-1 text-faint hover:text-danger"
          role="button"
          tabindex="0"
          @click.stop="dock.close(tab.id)"
          >×</span
        >
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-hidden">
      <component
        v-if="activeTab && activeEntry"
        :is="activeEntry.component"
        :payload="activeTab.payload"
      />
    </div>
    <div
      data-test="dock-resize"
      class="absolute inset-y-0 left-0 w-1 cursor-ew-resize hover:bg-accent/20"
      @mousedown="startResize"
    />
  </aside>
</template>
