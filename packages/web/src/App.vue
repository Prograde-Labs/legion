<script setup lang="ts">
import { watch } from 'vue';
import { useAuth } from './composables/useAuth.js';
import { useWebSocket } from './composables/useWebSocket.js';

const { isAuthenticated } = useAuth();
const { connect, disconnect } = useWebSocket();

watch(
  isAuthenticated,
  (authed) => {
    if (authed) connect();
    else disconnect();
  },
  { immediate: true },
);
</script>
<template><RouterView /></template>
