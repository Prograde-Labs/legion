<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';

interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
}

const { execute } = useLegionApi();

const servers = ref<McpServer[]>([]);
const loaded = ref(false);
const error = ref<string | null>(null);
const saved = ref<string | null>(null);
const busy = ref(false);

async function load(): Promise<void> {
  try {
    servers.value = await execute<McpServer[]>('list_mcp_sources', {});
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loaded.value = true;
  }
}

onMounted(() => void load());

function addServer(): void {
  servers.value = [...servers.value, { name: '' }];
}

function transport(card: McpServer): 'stdio' | 'http' {
  return card.url !== undefined ? 'http' : 'stdio';
}

function setTransport(card: McpServer, mode: 'stdio' | 'http'): void {
  if (mode === 'http') {
    card.url = card.url ?? '';
    delete card.command;
    delete card.args;
  } else {
    card.command = card.command ?? '';
    delete card.url;
  }
}

function parseArgs(card: McpServer, raw: string): void {
  card.args = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function argsText(card: McpServer): string {
  return (card.args ?? []).join('\n');
}

function validate(list: McpServer[]): string | null {
  const seen = new Set<string>();
  for (const [index, server] of list.entries()) {
    if (typeof server.name !== 'string' || server.name.trim().length === 0) {
      return `servers[${index}].name must be a non-empty string`;
    }
    if (seen.has(server.name)) return `duplicate MCP server name: ${server.name}`;
    seen.add(server.name);
    if (server.command !== undefined && server.url !== undefined) {
      return `servers[${index}] (${server.name}): command and url are mutually exclusive`;
    }
    if (server.command === undefined && server.url === undefined) {
      return `servers[${index}] (${server.name}): needs either command (stdio) or url (HTTP)`;
    }
  }
  return null;
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  saved.value = null;
  const problem = validate(servers.value);
  if (problem) {
    error.value = problem;
    busy.value = false;
    return;
  }
  try {
    const result = await execute<{ saved: number }>('save_mcp_sources', {
      servers: servers.value,
    });
    saved.value = `Saved ${result.saved} server(s). Changes take effect after process restart.`;
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 text-sm">
    <template v-if="loaded">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-medium text-ink">MCP sources</h3>
        <button
          type="button"
          data-test="add-server"
          class="ml-auto rounded bg-accent-soft px-2 py-1 text-xs text-accent"
          @click="addServer"
        >
          ＋ Add server
        </button>
      </div>
      <div
        v-if="saved"
        data-test="mcp-saved"
        class="rounded border border-line bg-surface px-2 py-1 text-xs text-success"
      >
        {{ saved }}
      </div>
      <div
        v-if="error"
        data-test="mcp-error"
        class="rounded border border-line px-2 py-1 text-xs text-danger"
      >
        {{ error }}
      </div>
      <div
        v-for="(card, index) in servers"
        :key="index"
        data-test="mcp-card"
        class="flex flex-col gap-2 rounded-md border border-line bg-surface p-3"
      >
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-ink">{{ card.name }}</span>
          <input
            v-model="card.name"
            name="name"
            placeholder="name"
            class="w-40 rounded border border-line bg-surface-raised px-2 py-1 font-mono text-xs"
          />
          <span class="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">{{
            transport(card)
          }}</span>
          <label class="ml-auto flex items-center gap-1 text-xs text-muted">
            <input
              type="checkbox"
              :checked="transport(card) === 'http'"
              @change="
                setTransport(card, ($event.target as HTMLInputElement).checked ? 'http' : 'stdio')
              "
            />
            HTTP
          </label>
          <button
            type="button"
            class="text-xs text-faint hover:text-danger"
            @click="servers.splice(index, 1)"
          >
            ×
          </button>
        </div>
        <template v-if="card.url === undefined">
          <input
            v-model="card.command"
            name="command"
            placeholder="command"
            class="rounded border border-line bg-surface-raised px-2 py-1 font-mono text-xs"
          />
          <textarea
            :value="argsText(card)"
            name="args"
            rows="2"
            placeholder="args (one per line)"
            class="rounded border border-line bg-surface-raised px-2 py-1 font-mono text-xs"
            @change="parseArgs(card, ($event.target as HTMLTextAreaElement).value)"
          />
        </template>
        <template v-if="card.command === undefined">
          <input
            v-model="card.url"
            name="url"
            placeholder="url"
            class="rounded border border-line bg-surface-raised px-2 py-1 font-mono text-xs"
          />
        </template>
      </div>
      <button
        type="button"
        data-test="mcp-save"
        :disabled="busy"
        class="self-start rounded bg-accent-soft px-3 py-1 text-xs font-medium text-accent"
        @click="save"
      >
        Save MCP sources
      </button>
      <p class="text-xs text-faint">Changes take effect after process restart.</p>
    </template>
    <p v-else class="text-xs text-faint">Loading MCP sources…</p>
  </div>
</template>
