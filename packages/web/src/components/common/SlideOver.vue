<script setup lang="ts">
defineProps<{ title: string; open: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>
<template>
  <Teleport to="body">
    <Transition name="slide">
      <div v-if="open" class="fixed inset-0 z-40 flex justify-end">
        <div class="flex-1 bg-black/60" @click="emit('close')" />
        <div class="w-96 bg-surface border-l border-line flex flex-col shadow-2xl">
          <div class="flex items-center justify-between px-5 py-4 border-b border-line">
            <span class="text-sm font-semibold text-slate-100">{{ title }}</span>
            <button
              @click="emit('close')"
              class="text-muted hover:text-slate-200 text-lg leading-none"
            >
              ✕
            </button>
          </div>
          <div class="flex-1 overflow-y-auto"><slot /></div>
          <div v-if="$slots.footer" class="border-t border-line bg-bg">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
<style scoped>
.slide-enter-from .w-96,
.slide-leave-to .w-96 {
  transform: translateX(100%);
}
.slide-enter-active .w-96,
.slide-leave-active .w-96 {
  transition: transform 0.2s ease;
}
</style>
