<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ProcessList from '../components/processes/ProcessList.vue';
import ProcessStartForm from '../components/processes/ProcessStartForm.vue';
import ProcessDetail from '../components/processes/ProcessDetail.vue';
import { useProcesses } from '../composables/useProcesses.js';

const route = useRoute();
const router = useRouter();
const { processes, loading, error, refresh } = useProcesses();

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
      <ProcessList
        v-if="!loading || processes.length > 0"
        :processes="processes"
        :active-id="activeId"
      />
      <div v-else data-test="processes-loading" class="px-3 py-6 text-xs text-faint text-center">
        Loading…
      </div>
    </div>

    <!-- Right: start form or process detail -->
    <div class="flex-1 flex flex-col min-w-0">
      <div
        v-if="error"
        data-test="processes-error"
        role="alert"
        class="border-b border-line px-4 py-2 text-xs text-danger"
      >
        {{ error }}
      </div>
      <ProcessDetail v-if="activeId" :key="activeId" :process-id="activeId" @deleted="onDeleted" />
      <ProcessStartForm v-else @started="onStarted" />
    </div>
  </div>
</template>
