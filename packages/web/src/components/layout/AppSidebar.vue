<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuth } from '../../composables/useAuth.js';

const { logout } = useAuth();
const router = useRouter();

const nav = [
  { label: 'Participants', icon: '👤', to: '/participants' },
  { label: 'Conversations', icon: '💬', to: '/conversations' },
  { label: 'Events', icon: '⚡', to: '/events' },
  { label: 'Processes', icon: '⚙', to: '/processes' },
  { label: 'Config', icon: '⚙️', to: '/config' },
];

async function handleLogout() {
  logout();
  await router.push('/login');
}
</script>
<template>
  <aside class="w-[200px] shrink-0 bg-navy-900 border-r border-navy-600 flex flex-col h-full">
    <div class="flex items-center gap-2 px-4 py-3.5 border-b border-navy-600">
      <div
        class="w-[22px] h-[22px] bg-cyan-400 rounded flex items-center justify-center text-[11px] font-black text-navy-950"
      >
        L
      </div>
      <span class="text-sm font-bold text-slate-100">Legion</span>
    </div>
    <nav class="flex-1 p-2 space-y-0.5">
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="flex items-center gap-2.5 px-3 py-1.5 rounded text-xs text-navy-400 hover:text-slate-200"
        active-class="bg-cyan-400/10 text-cyan-300 border-l-2 border-cyan-400 !pl-[10px]"
      >
        <span>{{ item.icon }}</span
        >{{ item.label }}
      </RouterLink>
    </nav>
    <div class="p-2 border-t border-navy-600">
      <button
        @click="handleLogout"
        class="flex items-center gap-2 px-3 py-1.5 w-full text-xs text-navy-400 hover:text-slate-200"
      >
        <span class="w-5 h-5 rounded-full bg-navy-600 flex items-center justify-center text-[10px]"
          >A</span
        >
        admin <span class="ml-auto text-navy-600">logout</span>
      </button>
    </div>
  </aside>
</template>
