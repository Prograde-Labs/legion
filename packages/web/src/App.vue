<script setup lang="ts">
import { watch } from 'vue';
import { useAuth } from './composables/useAuth.js';
import { useToolAccess } from './composables/useToolAccess.js';
import { useWebSocket } from './composables/useWebSocket.js';
import { useApprovals } from './composables/useApprovals.js';
import { useParticipants } from './composables/useParticipants.js';
import { useConversations } from './composables/useConversations.js';
import { useProcesses } from './composables/useProcesses.js';
import { useReadState } from './composables/useReadState.js';
import AppShell from './shell/AppShell.vue';

const { isAuthenticated } = useAuth();
const { connect, disconnect } = useWebSocket();
const { refresh: refreshToolAccess, reset: resetToolAccess } = useToolAccess();
const { reset: resetApprovals } = useApprovals();
const { reset: resetParticipants } = useParticipants();
const { reset: resetConversations } = useConversations();
const { reset: resetProcesses } = useProcesses();
const { reset: resetReadState } = useReadState();

watch(
  isAuthenticated,
  (authed) => {
    if (authed) {
      connect();
      void refreshToolAccess().catch(() => {});
    } else {
      disconnect();
      // Fail closed across identity switches: drop every module store so the next
      // identity never sees the previous user's policy, approvals, roster, list,
      // processes or read markers.
      resetToolAccess();
      resetApprovals();
      resetParticipants();
      resetConversations();
      resetProcesses();
      resetReadState();
    }
  },
  { immediate: true },
);
</script>
<template><AppShell /></template>
