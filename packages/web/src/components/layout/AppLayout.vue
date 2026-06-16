<script setup lang="ts">
import AppSidebar from './AppSidebar.vue';
</script>
<template>
  <div class="flex h-screen bg-navy-950 text-slate-200 overflow-hidden">
    <AppSidebar />
    <main class="flex-1 min-w-0 overflow-y-auto"><slot /></main>
  </div>
</template>
