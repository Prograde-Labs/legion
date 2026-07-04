<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ProviderConfig, RoutingConfig } from '@legion/types';
import AppLayout from '../components/layout/AppLayout.vue';
import ProviderSlideOver from '../components/config/ProviderSlideOver.vue';
import RoutingEditor from '../components/config/RoutingEditor.vue';
import { useExecute } from '../composables/useExecute.js';

const { execute } = useExecute();
const activeTab = ref<'providers' | 'routing'>('providers');

const providers = ref<ProviderConfig[]>([]);
const systemRouting = ref<RoutingConfig>({});
const workspaceRouting = ref<RoutingConfig>({});
const providerSlide = ref(false);
const editingProvider = ref<ProviderConfig | null>(null);
const loadError = ref<string | null>(null);

async function load() {
  try {
    providers.value = await execute<ProviderConfig[]>('list_providers', {});
    const routing = await execute<{ system: RoutingConfig; workspace: RoutingConfig }>('get_routing', {});
    systemRouting.value = routing.system ?? {};
    workspaceRouting.value = routing.workspace ?? {};
    loadError.value = null;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(load);

function openProvider(p: ProviderConfig | null) {
  editingProvider.value = p;
  providerSlide.value = true;
}

const typeBadge: Record<string, string> = {
  'openai-compatible': 'bg-green-400/10 text-green-400 border-green-400/20',
  anthropic: 'bg-amber-400/10 text-amber-400 border-amber-400/20',
  copilot: 'bg-cyan-400/10 text-cyan-400 border-cyan-400/20',
  codex: 'bg-violet-400/10 text-violet-400 border-violet-400/20',
};

async function deleteProvider(name: string) {
  await execute('delete_provider', { name });
  await load();
}
</script>

<template>
  <AppLayout>
    <div class="bg-navy-900 border-b border-navy-600">
      <div class="px-5 pt-4 pb-0">
        <h1 class="text-sm font-semibold text-slate-100 mb-3">Configuration</h1>
        <div class="flex gap-0">
          <button
            v-for="tab in ['providers', 'routing'] as const"
            :key="tab"
            @click="activeTab = tab"
            :class="[
              'px-4 py-2 text-xs font-medium border-b-2 capitalize transition-colors',
              activeTab === tab
                ? 'text-slate-100 border-cyan-400'
                : 'text-navy-400 border-transparent',
            ]"
          >
            {{ tab }}
          </button>
        </div>
      </div>
    </div>

    <div class="p-5">
      <div v-if="loadError" class="mb-4 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded p-3">
        {{ loadError }}
      </div>

      <template v-if="activeTab === 'providers'">
        <div class="flex items-start justify-between mb-4">
          <p class="text-xs text-navy-400 max-w-lg leading-relaxed">
            System-level LLM providers. Stored in <code class="font-mono text-navy-300">~/.config/legion/providers/</code> and shared across all workspaces.
          </p>
          <button
            @click="openProvider(null)"
            class="shrink-0 ml-4 text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded"
          >
            + Add provider
          </button>
        </div>
        <table class="w-full border-collapse bg-navy-900 rounded-lg border border-navy-600 overflow-hidden text-xs">
          <thead class="bg-navy-950">
            <tr>
              <th v-for="h in ['Priority', 'Name', 'Type', 'Base URL', 'API Key', '']" :key="h" class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-3 py-2 font-semibold">
                {{ h }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in providers" :key="p.name" class="border-t border-navy-700 hover:bg-navy-800/40">
              <td class="px-3 py-2.5 text-navy-400 text-center">{{ p.priority }}</td>
              <td class="px-3 py-2.5 font-mono text-slate-100 font-medium">{{ p.name }}</td>
              <td class="px-3 py-2.5">
                <span :class="['text-[9px] font-bold px-1.5 py-0.5 rounded border', typeBadge[p.type] ?? 'bg-navy-700/50 text-navy-400 border-navy-600']">
                  {{ p.type }}
                </span>
              </td>
              <td class="px-3 py-2.5 font-mono text-navy-400 text-[10px]">{{ p.baseUrl ?? '—' }}</td>
              <td class="px-3 py-2.5 font-mono text-navy-500 text-[10px] tracking-wider">{{ p.apiKey ? '••••' + p.apiKey.slice(-4) : '—' }}</td>
              <td class="px-3 py-2.5 text-right space-x-3">
                <button @click="openProvider(p)" class="text-navy-400 hover:text-slate-200">Edit</button>
                <button @click="deleteProvider(p.name)" class="text-red-400 hover:text-red-300">Delete</button>
              </td>
            </tr>
            <tr v-if="providers.length === 0">
              <td colspan="6" class="px-3 py-6 text-center text-navy-600 text-xs italic">
                No providers configured. Add one to get started.
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-else>
        <div class="space-y-6">
          <div>
            <h2 class="text-xs font-semibold text-slate-100 mb-1">System routing</h2>
            <p class="text-[10px] text-navy-400 mb-3">
              Stored in <code class="font-mono text-navy-300">~/.config/legion/config.json</code>. Applies to all workspaces.
            </p>
            <RoutingEditor scope="system" :routing="systemRouting" :provider-names="providers.map((p) => p.name)" @saved="load" />
          </div>
          <div class="border-t border-navy-700 pt-6">
            <h2 class="text-xs font-semibold text-slate-100 mb-1">Workspace routing</h2>
            <p class="text-[10px] text-navy-400 mb-3">
              Stored in <code class="font-mono text-navy-300">.legion/config.local.json</code> — local only, not tracked by git.
            </p>
            <RoutingEditor scope="workspace" :routing="workspaceRouting" :provider-names="providers.map((p) => p.name)" @saved="load" />
          </div>
        </div>
      </template>
    </div>

    <ProviderSlideOver :open="providerSlide" :provider="editingProvider" @close="providerSlide = false" @saved="load" />
  </AppLayout>
</template>
