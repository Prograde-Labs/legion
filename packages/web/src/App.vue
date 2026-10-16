<script setup lang="ts">
import { watch } from 'vue';
import { useAuth } from './composables/useAuth.js';
import { useToolAccess } from './composables/useToolAccess.js';
import { useWebSocket } from './composables/useWebSocket.js';
import AppShell from './shell/AppShell.vue';

const { isAuthenticated } = useAuth();
const { connect, disconnect } = useWebSocket();
const { refresh: refreshToolAccess, reset: resetToolAccess } = useToolAccess();

watch(
  isAuthenticated,
  (authed) => {
    if (authed) {
      connect();
      void refreshToolAccess().catch(() => {});
    } else {
      disconnect();
      // Fail closed across identity switches: drop the previous user's policy map so
      // can() returns 'hidden' until the next identity's refresh resolves.
      resetToolAccess();
    }
  },
  { immediate: true },
);
</script>
<template><AppShell /></template>
