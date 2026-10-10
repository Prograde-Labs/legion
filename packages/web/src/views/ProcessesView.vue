<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ProcessList from '../components/processes/ProcessList.vue';
import ProcessStartForm from '../components/processes/ProcessStartForm.vue';
import ProcessDetail from '../components/processes/ProcessDetail.vue';
import { useProcesses } from '../composables/useProcesses.js';

const route = useRoute();
const router = useRouter();
const { processes, refresh } = useProcesses();

const activeId = computed(() => (route.params.id as string | undefined) ?? null);

async function onStarted(id: string): Promise<void> {
  await refresh();
  await router.push(`/processes/${id}`);
}

async function onDeleted(): Promise<void> {
  await refresh();
  await router.push('/processes');
}
</script>

<template>
  <div class="flex h-full">
    <!-- Left: process list sidebar -->
    <div class="w-52 flex-shrink-0 border-r border-line flex flex-col">
      <ProcessList :processes="processes" :active-id="activeId" />
    </div>

    <!-- Right: start form or process detail -->
    <div class="flex-1 flex flex-col min-w-0">
      <ProcessDetail v-if="activeId" :key="activeId" :process-id="activeId" @deleted="onDeleted" />
      <ProcessStartForm v-else @started="onStarted" />
    </div>
  </div>
</template>
