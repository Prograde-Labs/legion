<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ProviderConfig, ProviderUsageSummary, RoutingConfig } from '@legion-collective/types';
import ProviderSlideOver from '../components/config/ProviderSlideOver.vue';
import RoutingEditor from '../components/config/RoutingEditor.vue';
import McpSourcesEditor from './McpSourcesEditor.vue';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useToolAccess } from '../composables/useToolAccess.js';
import { friendlyToolError } from '../composables/friendlyToolError.js';

const { execute } = useLegionApi();
const toolAccess = useToolAccess();
const canSaveProvider = computed(() => toolAccess.can('save_provider') === 'auto');
const canDeleteProvider = computed(() => toolAccess.can('delete_provider') === 'auto');

const providers = ref<ProviderConfig[]>([]);
const systemRouting = ref<RoutingConfig>({});
const workspaceRouting = ref<RoutingConfig>({});
const providerSlide = ref(false);
const editingProvider = ref<ProviderConfig | null>(null);
const loadError = ref<string | null>(null);
const deleteError = ref<string | null>(null);

interface CodexStatus {
  signedIn: boolean;
  email?: string;
  plan?: string;
}

const codexStatus = ref<Record<string, CodexStatus>>({});
const codexUsage = ref<Record<string, ProviderUsageSummary | null>>({});
const hasCodex = computed(() => providers.value.some((p) => p.type === 'codex'));

async function loadCodexInfo(list: ProviderConfig[]) {
  const status: Record<string, CodexStatus> = {};
  const usage: Record<string, ProviderUsageSummary | null> = {};

  await Promise.all(
    list
      .filter((p) => p.type === 'codex')
      .map(async (p) => {
        try {
          status[p.name] = await execute<CodexStatus>('openai_auth_status', {
            providerName: p.name,
          });
        } catch {
          status[p.name] = { signedIn: false };
        }
        if (status[p.name]?.signedIn) {
          try {
            usage[p.name] = await execute<ProviderUsageSummary>('openai_usage', {
              providerName: p.name,
            });
          } catch {
            usage[p.name] = null;
          }
        }
      }),
  );

  codexStatus.value = status;
  codexUsage.value = usage;
}

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
    await loadCodexInfo(providers.value);
  } catch (err) {
    loadError.value = friendlyToolError(err);
  }
}

onMounted(load);

function shortLabel(label: string): string {
  if (label === '5-hour') return '5h';
  if (label === 'Weekly') return '7d';
  return label;
}

function usageSummary(name: string): string {
  if (!codexStatus.value[name]?.signedIn) return 'Sign in';
  const usage = codexUsage.value[name];
  if (!usage) return 'Unavailable';
  const parts = usage.windows.map(
    (w) => `${shortLabel(w.label)} ${w.remainingPercent === null ? '—' : `${w.remainingPercent}%`}`,
  );
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function openProvider(p: ProviderConfig | null) {
  editingProvider.value = p;
  providerSlide.value = true;
}

const typeBadge: Record<string, string> = {
  'openai-compatible': 'bg-success/10 text-success border-success/20',
  'openai-responses': 'bg-success/10 text-success border-success/20',
  anthropic: 'bg-warning/10 text-warning border-warning/20',
  copilot: 'bg-accent-soft text-accent border-accent/20',
  codex: 'bg-accent-soft text-accent-strong border-accent/20',
};

async function deleteProvider(name: string) {
  deleteError.value = null;
  if (!window.confirm(`Delete provider “${name}”?`)) return;
  try {
    await execute('delete_provider', { name });
    await load();
  } catch (err) {
    deleteError.value = friendlyToolError(err);
  }
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
          <div class="flex items-center gap-4 shrink-0 ml-4">
            <a
              v-if="hasCodex"
              href="https://chatgpt.com/settings/usage"
              target="_blank"
              rel="noreferrer"
              class="text-[10px] text-accent"
              >Manage usage</a
            >
            <button
              v-if="canSaveProvider"
              data-test="add-provider"
              @click="openProvider(null)"
              class="text-xs px-3 py-1.5 border border-line text-accent rounded"
            >
              + Add provider
            </button>
          </div>
        </div>
        <div
          v-if="deleteError"
          data-test="delete-error"
          role="alert"
          class="mb-3 text-xs text-danger bg-danger/10 border border-danger/20 rounded p-3"
        >
          {{ deleteError }}
        </div>
        <table
          class="w-full border-collapse bg-surface rounded-lg border border-line overflow-hidden text-xs"
        >
          <thead class="bg-surface-raised">
            <tr>
              <th
                v-for="h in ['Priority', 'Name', 'Type', 'Base URL', 'API Key', 'Usage', '']"
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
              data-test="provider-row"
              class="border-t border-line hover:bg-surface-raised"
            >
              <td class="px-3 py-2.5 text-muted text-center">{{ p.priority }}</td>
              <td class="px-3 py-2.5 font-mono text-ink font-medium">
                {{ p.name }}
                <div
                  v-if="p.type === 'codex' && codexStatus[p.name]?.email"
                  class="font-sans text-[10px] text-faint"
                >
                  {{ codexStatus[p.name]?.email }} · {{ codexStatus[p.name]?.plan ?? 'ChatGPT' }}
                </div>
              </td>
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
              <td class="px-3 py-2.5 text-muted text-[10px]" data-test="provider-usage">
                <template v-if="p.type === 'codex'">{{ usageSummary(p.name) }}</template>
                <template v-else>—</template>
              </td>
              <td class="px-3 py-2.5 text-right space-x-3">
                <button
                  v-if="canSaveProvider"
                  @click="openProvider(p)"
                  class="text-muted hover:text-ink"
                >
                  Edit
                </button>
                <button
                  v-if="canDeleteProvider"
                  data-test="provider-delete"
                  @click="deleteProvider(p.name)"
                  class="text-danger hover:brightness-110"
                >
                  Delete
                </button>
              </td>
            </tr>
            <tr v-if="providers.length === 0">
              <td colspan="7" class="px-3 py-6 text-center text-faint text-xs italic">
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

      <!-- MCP sources editor (spec §6.3 part 2; Task 19) -->
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
