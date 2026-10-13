<script setup lang="ts">
import { watch } from 'vue';
import { useAuth } from './composables/useAuth.js';
import { useToolAccess } from './composables/useToolAccess.js';
import { useWebSocket } from './composables/useWebSocket.js';
import AppShell from './shell/AppShell.vue';

const { isAuthenticated } = useAuth();
const { connect, disconnect } = useWebSocket();

watch(
  isAuthenticated,
  (authed) => {
    if (authed) {
      connect();
      void useToolAccess()
        .refresh()
        .catch(() => {});
    } else disconnect();
  },
  { immediate: true },
);
</script>
<template><AppShell /></template>
