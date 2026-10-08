<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ProviderConfig, RoutingConfig } from '@legion-collective/types';
import ProviderSlideOver from '../components/config/ProviderSlideOver.vue';
import RoutingEditor from '../components/config/RoutingEditor.vue';
import McpSourcesEditor from './McpSourcesEditor.vue';
import { useLegionApi } from '../composables/useLegionApi.js';

const { execute } = useLegionApi();

const providers = ref<ProviderConfig[]>([]);
const systemRouting = ref<RoutingConfig>({});
const workspaceRouting = ref<RoutingConfig>({});
const providerSlide = ref(false);
const editingProvider = ref<ProviderConfig | null>(null);
const loadError = ref<string | null>(null);

async function load() {
  try {
    providers.value = await execute<ProviderConfig[]>('list_providers', {});
    const routing = await execute<{ system: RoutingConfig; workspace: RoutingConfig }>(
      'get_routing',
      {},
    );
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
  'openai-compatible': 'bg-success/10 text-success border-success/20',
  anthropic: 'bg-warning/10 text-warning border-warning/20',
  copilot: 'bg-accent-soft text-accent border-accent/20',
  codex: 'bg-accent-soft text-accent-strong border-accent/20',
};

async function deleteProvider(name: string) {
  await execute('delete_provider', { name });
  await load();
}
</script>

<template>
  <div class="bg-bg min-h-0 flex-1 overflow-y-auto">
    <div class="px-5 pt-4 pb-0">
      <h1 class="text-sm font-semibold text-ink mb-3">Configuration</h1>
    </div>

    <div class="p-5 pt-2 space-y-8">
      <div
        v-if="loadError"
        class="text-xs text-danger bg-danger/10 border border-danger/20 rounded p-3"
      >
        {{ loadError }}
      </div>

      <!-- Providers section -->
      <section>
        <h2 class="text-xs font-semibold text-ink mb-1">Providers</h2>
        <div class="flex items-start justify-between mb-4">
          <p class="text-xs text-muted max-w-lg leading-relaxed">
            System-level LLM providers. Stored in
            <code class="font-mono text-ink">~/.config/legion/providers/</code> and shared across
            all workspaces.
          </p>
          <button
            @click="openProvider(null)"
            class="shrink-0 ml-4 text-xs px-3 py-1.5 border border-line text-accent rounded"
          >
            + Add provider
          </button>
        </div>
        <table
          class="w-full border-collapse bg-surface rounded-lg border border-line overflow-hidden text-xs"
        >
          <thead class="bg-surface-raised">
            <tr>
              <th
                v-for="h in ['Priority', 'Name', 'Type', 'Base URL', 'API Key', '']"
                :key="h"
                class="text-left text-[9px] uppercase tracking-wider text-faint px-3 py-2 font-semibold"
              >
                {{ h }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in providers"
              :key="p.name"
              class="border-t border-line hover:bg-surface-raised"
            >
              <td class="px-3 py-2.5 text-muted text-center">{{ p.priority }}</td>
              <td class="px-3 py-2.5 font-mono text-ink font-medium">{{ p.name }}</td>
              <td class="px-3 py-2.5">
                <span
                  :class="[
                    'text-[9px] font-bold px-1.5 py-0.5 rounded border',
                    typeBadge[p.type] ?? 'bg-surface-raised text-muted border-line',
                  ]"
                >
                  {{ p.type }}
                </span>
              </td>
              <td class="px-3 py-2.5 font-mono text-muted text-[10px]">
                {{ p.baseUrl ?? '—' }}
              </td>
              <td class="px-3 py-2.5 font-mono text-faint text-[10px] tracking-wider">
                {{ p.apiKey ? '••••' + p.apiKey.slice(-4) : '—' }}
              </td>
              <td class="px-3 py-2.5 text-right space-x-3">
                <button @click="openProvider(p)" class="text-muted hover:text-ink">Edit</button>
                <button @click="deleteProvider(p.name)" class="text-danger hover:brightness-110">
                  Delete
                </button>
              </td>
            </tr>
            <tr v-if="providers.length === 0">
              <td colspan="6" class="px-3 py-6 text-center text-faint text-xs italic">
                No providers configured. Add one to get started.
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Model routing section -->
      <section>
        <h2 class="text-xs font-semibold text-ink mb-1">Model routing</h2>
        <div class="space-y-6">
          <div>
            <p class="text-[10px] text-muted mb-3">
              System routing — stored in
              <code class="font-mono text-ink">~/.config/legion/config.json</code>. Applies to all
              workspaces.
            </p>
            <RoutingEditor
              scope="system"
              :routing="systemRouting"
              :provider-names="providers.map((p) => p.name)"
              @saved="load"
            />
          </div>
          <div class="border-t border-line pt-6">
            <p class="text-[10px] text-muted mb-3">
              Workspace routing — stored in
              <code class="font-mono text-ink">.legion/config.local.json</code> — local only, not
              tracked by git.
            </p>
            <RoutingEditor
              scope="workspace"
              :routing="workspaceRouting"
              :provider-names="providers.map((p) => p.name)"
              @saved="load"
            />
          </div>
        </div>
      </section>

      <!-- MCP sources: coming with Task 19 (spec §6.3 part 2) -->
      <section>
        <h2 class="text-xs font-semibold text-ink mb-1">MCP sources</h2>
        <McpSourcesEditor />
      </section>
    </div>
  </div>

  <ProviderSlideOver
    :open="providerSlide"
    :provider="editingProvider"
    @close="providerSlide = false"
    @saved="load"
  />
</template>
