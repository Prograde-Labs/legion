<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useAuth } from '../composables/useAuth.js';
import { useApprovals } from '../composables/useApprovals.js';
import NavBadge from './NavBadge.vue';
import AccountSlideOver from './AccountSlideOver.vue';

const router = useRouter();
const { logout } = useLegionApi();
const { participantId } = useAuth();
const { pendingCount, oldest } = useApprovals();
const accountOpen = ref(false);
const menuOpen = ref(false);

function badgeClick() {
  if (oldest.value) void router.push(`/chat/${oldest.value.conversationId}`);
}

function onLogout(): void {
  logout();
  void router.push('/login');
}
</script>
<template>
  <div class="flex h-screen flex-col bg-bg text-ink">
    <nav class="flex items-center gap-1 border-b border-line px-3 py-2">
      <RouterLink to="/chat" class="px-3 py-1.5 rounded-md text-sm hover:bg-surface">
        <span aria-hidden="true">💬</span><span class="ml-1.5 max-md:hidden">Chat</span>
      </RouterLink>
      <RouterLink to="/participants" class="px-3 py-1.5 rounded-md text-sm hover:bg-surface">
        <span aria-hidden="true">👥</span><span class="ml-1.5 max-md:hidden">Participants</span>
      </RouterLink>
      <RouterLink to="/processes" class="px-3 py-1.5 rounded-md text-sm hover:bg-surface">
        <span aria-hidden="true">🗂</span><span class="ml-1.5 max-md:hidden">Processes</span>
      </RouterLink>
      <RouterLink to="/config" class="px-3 py-1.5 rounded-md text-sm hover:bg-surface">
        <span aria-hidden="true">⚙️</span><span class="ml-1.5 max-md:hidden">Config</span>
      </RouterLink>
      <NavBadge
        :count="pendingCount"
        :target-conversation-id="oldest?.conversationId ?? null"
        @activate="badgeClick"
      />
      <div class="ml-auto relative">
        <button
          type="button"
          data-test="avatar"
          class="rounded-full size-8 bg-accent-soft text-accent"
          @click="menuOpen = !menuOpen"
        >
          {{ (participantId ?? '?').slice(0, 1).toUpperCase() }}
        </button>
        <div
          v-if="menuOpen"
          class="absolute right-0 mt-1 rounded-md border border-line bg-surface-raised py-1 text-sm"
        >
          <button
            type="button"
            class="block w-full px-3 py-1.5 text-left hover:bg-surface"
            @click="
              accountOpen = true;
              menuOpen = false;
            "
          >
            Account…
          </button>
          <button
            type="button"
            class="block w-full px-3 py-1.5 text-left hover:bg-surface"
            @click="onLogout"
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
    <main class="min-h-0 flex-1"><RouterView /></main>
    <AccountSlideOver v-model:open="accountOpen" />
  </div>
</template>
<style scoped>
/* Active nav tab state (spec §3.1). Tokens only — no raw hex. */
.router-link-active {
  background-color: var(--color-surface);
  color: var(--color-accent);
}
</style>
