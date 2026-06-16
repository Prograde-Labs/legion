<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { CredentialInfo, ProviderConfig } from '@legion/types';
import AppLayout from '../components/layout/AppLayout.vue';
import ProviderSlideOver from '../components/config/ProviderSlideOver.vue';
import CredentialSlideOver from '../components/config/CredentialSlideOver.vue';
import { useExecute } from '../composables/useExecute.js';

const { execute } = useExecute();
const route = useRoute();
const activeTab = ref(route.path.includes('credentials') ? 'credentials' : 'providers');

const providers = ref<ProviderConfig[]>([]);
const credentials = ref<CredentialInfo[]>([]);
const providerSlide = ref(false);
const credSlide = ref(false);
const editingProvider = ref<ProviderConfig | null>(null);
const editingCredential = ref<CredentialInfo | null>(null);

async function load() {
  providers.value = await execute<ProviderConfig[]>('list_providers', {});
  credentials.value = await execute<CredentialInfo[]>('list_credentials', {});
}

onMounted(load);

function openProvider(p: ProviderConfig | null) {
  editingProvider.value = p;
  providerSlide.value = true;
}
function openCredential(c: CredentialInfo | null) {
  editingCredential.value = c;
  credSlide.value = true;
}

const typeBadge: Record<string, string> = {
  'openai-compatible': 'bg-green-400/10 text-green-400 border-green-400/20',
  anthropic: 'bg-amber-400/10 text-amber-400 border-amber-400/20',
};
</script>

<template>
  <AppLayout>
    <div class="bg-navy-900 border-b border-navy-600">
      <div class="px-5 pt-4 pb-0">
        <h1 class="text-sm font-semibold text-slate-100 mb-3">Configuration</h1>
        <div class="flex gap-0">
          <button
            v-for="tab in ['providers', 'credentials']"
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
      <!-- Providers tab -->
      <template v-if="activeTab === 'providers'">
        <div class="flex items-start justify-between mb-4">
          <p class="text-xs text-navy-400 max-w-lg leading-relaxed">
            Provider instances available to agents. Each references a credential for authentication.
          </p>
          <button
            @click="openProvider(null)"
            class="shrink-0 ml-4 text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded"
          >
            + Add provider
          </button>
        </div>
        <table
          class="w-full border-collapse bg-navy-900 rounded-lg border border-navy-600 overflow-hidden text-xs"
        >
          <thead class="bg-navy-950">
            <tr>
              <th
                v-for="h in ['Name', 'Type', 'Base URL', 'Default model', 'Credential', '']"
                :key="h"
                class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-3 py-2 font-semibold"
              >
                {{ h }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in providers"
              :key="p.name"
              class="border-t border-navy-700 hover:bg-navy-800/40"
            >
              <td class="px-3 py-2.5 font-mono text-slate-100 font-medium">{{ p.name }}</td>
              <td class="px-3 py-2.5">
                <span
                  :class="[
                    'text-[9px] font-bold px-1.5 py-0.5 rounded border',
                    typeBadge[p.type] ?? 'bg-navy-700/50 text-navy-400 border-navy-600',
                  ]"
                >
                  {{ p.type }}
                </span>
              </td>
              <td class="px-3 py-2.5 font-mono text-navy-400 text-[10px]">
                {{ p.baseUrl ?? '—' }}
              </td>
              <td class="px-3 py-2.5 font-mono text-navy-400 text-[10px]">{{ p.defaultModel }}</td>
              <td class="px-3 py-2.5">
                <span
                  v-if="p.credentialKey"
                  class="text-[10px] font-mono bg-cyan-400/10 border border-cyan-400/20 text-cyan-400 px-2 py-0.5 rounded"
                >
                  {{ p.credentialKey }}
                </span>
                <span v-else class="text-navy-600 text-[10px] italic">none</span>
              </td>
              <td class="px-3 py-2.5 text-right">
                <button @click="openProvider(p)" class="text-navy-400 hover:text-slate-200 mr-2">
                  Edit
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- Credentials tab -->
      <template v-else>
        <div class="flex items-start justify-between mb-4">
          <p class="text-xs text-navy-400 max-w-lg leading-relaxed">
            Named secrets stored encrypted at rest. Values are write-only after saving.
          </p>
          <button
            @click="openCredential(null)"
            class="shrink-0 ml-4 text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded"
          >
            + Add credential
          </button>
        </div>
        <table
          class="w-full border-collapse bg-navy-900 rounded-lg border border-navy-600 overflow-hidden text-xs"
        >
          <thead class="bg-navy-950">
            <tr>
              <th
                v-for="h in ['Key name', 'Value', 'Used by', 'Last updated', '']"
                :key="h"
                class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-3 py-2 font-semibold"
              >
                {{ h }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in credentials"
              :key="c.key"
              class="border-t border-navy-700 hover:bg-navy-800/40"
            >
              <td class="px-3 py-2.5 font-mono text-slate-100 font-medium">{{ c.key }}</td>
              <td class="px-3 py-2.5 font-mono text-navy-500 text-[10px] tracking-wider">
                {{ c.maskedValue }}
              </td>
              <td class="px-3 py-2.5">
                <span
                  v-for="p in c.usedBy"
                  :key="p"
                  class="text-[9px] font-mono bg-cyan-400/10 border border-cyan-400/20 text-cyan-400 px-1.5 py-0.5 rounded mr-1"
                  >{{ p }}</span
                >
                <span v-if="!c.usedBy.length" class="text-navy-600 text-[10px] italic">unused</span>
              </td>
              <td class="px-3 py-2.5 text-navy-500 text-[10px]">
                {{ new Date(c.updatedAt).toLocaleDateString() }}
              </td>
              <td class="px-3 py-2.5 text-right">
                <button @click="openCredential(c)" class="text-navy-400 hover:text-slate-200">
                  Rotate
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>

    <ProviderSlideOver
      :open="providerSlide"
      :provider="editingProvider"
      :credential-keys="credentials.map((c) => c.key)"
      @close="providerSlide = false"
      @saved="load"
    />
    <CredentialSlideOver
      :open="credSlide"
      :credential="editingCredential"
      @close="credSlide = false"
      @saved="load"
    />
  </AppLayout>
</template>
