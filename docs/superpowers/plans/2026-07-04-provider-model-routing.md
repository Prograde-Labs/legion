# Provider & Model Routing Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace workspace-scoped provider/credential setup with system-level providers, inline API keys, and a `ModelRouter` that resolves model IDs to providers via priority-ordered routing config — removing the need to name a provider in agent configs.

**Architecture:** Five layered tasks: (1) update types, (2) add `SystemProviderStore` reading `~/.config/legion/providers/`, (3) extend `Provider` interface with optional `listModels()`, (4) add `ModelRouter` + wire into `AgentRuntime`, (5) update runtime tools and all UI. `ProviderRegistry` and the credential API-key system are deleted throughout.

**Tech Stack:** TypeScript, Vitest, Vue 3 (Composition API), Node.js `fs/promises`, native `fetch`.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `packages/types/src/config.ts` | New `ProviderConfig`, `ProviderModel`, `ModelConfig`, `RoutingConfig`, `LocalConfig`, `SystemConfig`; remove `defaultModel`, `providers` from `WorkspaceConfig` |
| Modify | `packages/types/src/participant.ts` | Remove `providerId` from `AgentConfig` |
| Modify | `packages/types/src/index.ts` | Export `SystemConfig`, `LocalConfig`, `RoutingConfig`, `ProviderModel` |
| Create | `packages/core/src/providers/SystemProviderStore.ts` | Reads `~/.config/legion/providers/`, constructs providers by type |
| Create | `packages/core/src/providers/SystemProviderStore.test.ts` | Unit tests using `MemoryStorage` |
| Delete | `packages/core/src/providers/ProviderRegistry.ts` | Dead code — removed |
| Delete | `packages/core/src/providers/ProviderStore.ts` | Replaced by `SystemProviderStore` |
| Delete | `packages/core/src/providers/ProviderStore.test.ts` | Tests for deleted file |
| Modify | `packages/core/src/providers/Provider.ts` | Add optional `listModels?()` and `ProviderModel` interface |
| Modify | `packages/core/src/providers/OpenAICompatibleProvider.ts` | Implement `listModels()`, change constructor to accept `apiKey` directly |
| Create | `packages/core/src/providers/ModelRouter.ts` | Resolves model ID → provider via routing config + `SystemProviderStore` |
| Create | `packages/core/src/providers/ModelRouter.test.ts` | Unit tests for routing resolution algorithm |
| Modify | `packages/core/src/runtime/AgentRuntime.ts` | Accept `ModelRouter`; call `router.resolve(agent.model.model)` |
| Modify | `packages/core/src/runtime/AgentRuntime.test.ts` | Replace `MockProviderStore` with `MockModelRouter` |
| Modify | `packages/core/src/index.ts` | Export `SystemProviderStore`, `ModelRouter`; remove `ProviderRegistry`, `ProviderStore` |
| Modify | `packages/runtime/src/LegionProcess.ts` | Load `SystemConfig` + `LocalConfig`; construct `SystemProviderStore` + `ModelRouter`; ensure `.gitignore` entry |
| Modify | `packages/runtime/src/server/runtime-tools.ts` | Replace all 4 tools with new 6 tools; remove credential tools |
| Modify | `packages/web/src/views/ConfigView.vue` | Remove Credentials tab; add Routing tab; update Providers tab |
| Delete | `packages/web/src/components/config/CredentialSlideOver.vue` | Removed — no separate credential concept |
| Modify | `packages/web/src/components/config/ProviderSlideOver.vue` | Add `apiKey` field; remove `credentialKey`/`defaultModel` |
| Create | `packages/web/src/components/config/RoutingEditor.vue` | Per-model routing config editor (system + workspace) |
| Modify | `packages/web/src/components/participants/ParticipantSlideOver.vue` | Replace provider dropdown + text model input with searchable model dropdown |

---

## Task 1: Update Type System

**Files:**
- Modify: `packages/types/src/config.ts`
- Modify: `packages/types/src/participant.ts`
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Replace `packages/types/src/config.ts` entirely**

```typescript
export interface ModelConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface RuntimeConfig {
  maxIterations: number;
  communicationDepthLimit: number;
}

export interface MCPServerConfig {
  /** Unique name for this MCP server; used in tool namespace: `mcp__<name>__<tool>`. */
  name: string;
  /** Stdio transport: path or name of the executable to spawn. Mutually exclusive with `url`. */
  command?: string;
  /** Stdio transport: arguments passed to the spawned process. */
  args?: string[];
  /**
   * Stdio transport: additional environment variables for the child process.
   * Values may contain `${VAR}` placeholders that are expanded from `process.env` at load time.
   */
  env?: Record<string, string>;
  /** HTTP/SSE transport: base URL of the MCP server (e.g. `http://localhost:3000/mcp`). */
  url?: string;
  /** HTTP/SSE transport: additional HTTP headers (e.g. for auth). */
  headers?: Record<string, string>;
}

export interface ServerConfig {
  port?: number;
  host?: string;
}

export interface ConnectorConfig {
  name: string;
  enabled?: boolean;
  defaultParticipantId?: string;
  options?: Record<string, unknown>;
}

export interface StorageConfig {
  backend?: 'file' | 'memory';
}

export interface ProviderConfig {
  name: string;
  type: 'openai-compatible' | 'anthropic' | 'copilot' | 'codex';
  baseUrl?: string;
  apiKey?: string;
  priority: number;
}

export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  inputCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  capabilities?: ('vision' | 'tools' | 'json_mode')[];
}

export interface RoutingConfig {
  models?: Record<string, string[]>;
  // key: model id, value: ordered provider names (highest priority first)
  // e.g. { "claude-sonnet-4-5": ["Copilot", "My Anthropic"] }
}

export interface LoggingConfig {
  level?: 'debug' | 'info' | 'warn' | 'error';
}

export interface WorkspaceConfig {
  version: '2';
  workspaceRoot?: string;
  storage?: StorageConfig;
  server?: ServerConfig;
  connectors?: ConnectorConfig[];
  mcpServers?: MCPServerConfig[];
  logging?: LoggingConfig;
}

/** Shape of .legion/config.local.json — gitignored, overrides WorkspaceConfig + adds routing. */
export interface LocalConfig extends Partial<WorkspaceConfig> {
  routing?: RoutingConfig;
}

/** Shape of ~/.config/legion/config.json — system-level defaults. */
export interface SystemConfig {
  routing?: RoutingConfig;
}
```

- [ ] **Step 2: Update `packages/types/src/participant.ts` — remove `providerId`**

Remove the `providerId: string` field from `AgentConfig`. The full updated `AgentConfig` interface:

```typescript
export interface AgentConfig extends BaseParticipant {
  type: 'agent';
  model: ModelConfig;
  systemPrompt: string;
  maxIterations: number;
  runtimeConfig?: Record<string, unknown>;
}
```

Leave all other interfaces (`BaseParticipant`, `ServiceConfig`, `UserConfig`, `MockConfig`, `ParticipantConfig`) unchanged.

- [ ] **Step 3: Update `packages/types/src/index.ts` — confirm all new types are exported**

The file already does `export * from './config.js'` and `export * from './participant.js'` so all new types (`SystemConfig`, `LocalConfig`, `RoutingConfig`, `ProviderModel`) are exported automatically. No change needed — verify by inspection.

- [ ] **Step 4: Build types package to catch errors**

```bash
cd /home/chris/source/javascript/legion-v2
npx tsc --build packages/types 2>&1
```

Expected: zero errors. If errors appear in other packages (they will — `ModelConfig.provider` no longer exists), that's expected and will be fixed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/config.ts packages/types/src/participant.ts
git commit -m "feat(types): new ProviderConfig/ModelConfig/RoutingConfig shapes; remove providerId from AgentConfig"
```

---

## Task 2: `SystemProviderStore` + delete dead code

**Files:**
- Create: `packages/core/src/providers/SystemProviderStore.ts`
- Create: `packages/core/src/providers/SystemProviderStore.test.ts`
- Delete: `packages/core/src/providers/ProviderRegistry.ts`
- Delete: `packages/core/src/providers/ProviderStore.ts`
- Delete: `packages/core/src/providers/ProviderStore.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing tests for `SystemProviderStore`**

Create `packages/core/src/providers/SystemProviderStore.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { SystemProviderStore } from './SystemProviderStore.js';
import type { ProviderConfig } from '@legion/types';

describe('SystemProviderStore', () => {
  it('get() returns null when no provider file exists', async () => {
    const storage = new MemoryStorage();
    const store = new SystemProviderStore(storage);
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('get() returns a Provider with a complete function for openai-compatible type', async () => {
    const storage = new MemoryStorage();
    const config: ProviderConfig = {
      name: 'my-openai',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'sk-test',
      priority: 1,
    };
    await storage.writeJson('providers/my-openai.json', config);
    const store = new SystemProviderStore(storage);
    const provider = await store.get('my-openai');
    expect(provider).not.toBeNull();
    expect(typeof provider!.complete).toBe('function');
  });

  it('get() returns a Provider with listModels for openai-compatible type', async () => {
    const storage = new MemoryStorage();
    const config: ProviderConfig = {
      name: 'my-openai',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'sk-test',
      priority: 1,
    };
    await storage.writeJson('providers/my-openai.json', config);
    const store = new SystemProviderStore(storage);
    const provider = await store.get('my-openai');
    expect(typeof provider!.listModels).toBe('function');
  });

  it('get() throws NotImplementedError for copilot type', async () => {
    const storage = new MemoryStorage();
    const config: ProviderConfig = {
      name: 'my-copilot',
      type: 'copilot',
      priority: 1,
    };
    await storage.writeJson('providers/my-copilot.json', config);
    const store = new SystemProviderStore(storage);
    await expect(store.get('my-copilot')).rejects.toThrow(/not implemented/i);
  });

  it('get() throws NotImplementedError for codex type', async () => {
    const storage = new MemoryStorage();
    const config: ProviderConfig = {
      name: 'my-codex',
      type: 'codex',
      priority: 1,
    };
    await storage.writeJson('providers/my-codex.json', config);
    const store = new SystemProviderStore(storage);
    await expect(store.get('my-codex')).rejects.toThrow(/not implemented/i);
  });

  it('list() returns empty array when no providers exist', async () => {
    const storage = new MemoryStorage();
    const store = new SystemProviderStore(storage);
    const result = await store.list();
    expect(result).toEqual([]);
  });

  it('list() returns all saved provider configs', async () => {
    const storage = new MemoryStorage();
    const configA: ProviderConfig = {
      name: 'provider-a',
      type: 'openai-compatible',
      baseUrl: 'http://a.example/v1',
      priority: 1,
    };
    const configB: ProviderConfig = {
      name: 'provider-b',
      type: 'anthropic',
      apiKey: 'sk-ant',
      priority: 2,
    };
    await storage.writeJson('providers/provider-a.json', configA);
    await storage.writeJson('providers/provider-b.json', configB);
    const store = new SystemProviderStore(storage);
    const result = await store.list();
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name).sort()).toEqual(['provider-a', 'provider-b']);
  });

  it('save() writes provider config so get() can find it', async () => {
    const storage = new MemoryStorage();
    const store = new SystemProviderStore(storage);
    const config: ProviderConfig = {
      name: 'saved-provider',
      type: 'openai-compatible',
      baseUrl: 'http://saved.example/v1',
      priority: 1,
    };
    await store.save(config);
    const provider = await store.get('saved-provider');
    expect(provider).not.toBeNull();
  });

  it('save() writes provider config so list() can find it', async () => {
    const storage = new MemoryStorage();
    const store = new SystemProviderStore(storage);
    const config: ProviderConfig = {
      name: 'listed-provider',
      type: 'openai-compatible',
      baseUrl: 'http://listed.example/v1',
      priority: 1,
    };
    await store.save(config);
    const result = await store.list();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('listed-provider');
  });

  it('delete() removes a provider so get() returns null', async () => {
    const storage = new MemoryStorage();
    const store = new SystemProviderStore(storage);
    const config: ProviderConfig = {
      name: 'to-delete',
      type: 'openai-compatible',
      priority: 1,
    };
    await store.save(config);
    await store.delete('to-delete');
    const result = await store.get('to-delete');
    expect(result).toBeNull();
  });

  it('delete() removes provider so list() does not include it', async () => {
    const storage = new MemoryStorage();
    const store = new SystemProviderStore(storage);
    const config: ProviderConfig = {
      name: 'to-delete',
      type: 'openai-compatible',
      priority: 1,
    };
    await store.save(config);
    await store.delete('to-delete');
    const result = await store.list();
    expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/chris/source/javascript/legion-v2
npx vitest run packages/core/src/providers/SystemProviderStore.test.ts 2>&1 | tail -20
```

Expected: FAIL with "Cannot find module './SystemProviderStore.js'"

- [ ] **Step 3: Implement `SystemProviderStore`**

Create `packages/core/src/providers/SystemProviderStore.ts`:

```typescript
import type { Storage } from '../storage/Storage.js';
import type { ProviderConfig } from '@legion/types';
import type { Provider } from './Provider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { NotImplementedError } from '../errors/LegionError.js';

export class SystemProviderStore {
  constructor(private storage: Storage) {}

  /**
   * Read provider config for `name` from storage and construct a Provider.
   * Returns null if no config file exists.
   * Throws NotImplementedError for provider types not yet implemented (copilot, codex).
   */
  async get(name: string): Promise<Provider | null> {
    const config = await this.storage.readJson<ProviderConfig>(`providers/${name}.json`);
    if (!config) return null;
    return this.construct(config);
  }

  /** List all saved provider configs, sorted by priority ascending. */
  async list(): Promise<ProviderConfig[]> {
    const keys = await this.storage.list('providers/');
    const configs = await Promise.all(
      keys.map((k) => this.storage.readJson<ProviderConfig>(`providers/${k}`)),
    );
    const valid = configs.filter((c): c is ProviderConfig => c !== null);
    return valid.sort((a, b) => a.priority - b.priority);
  }

  /** Persist a provider config. */
  async save(config: ProviderConfig): Promise<void> {
    await this.storage.writeJson(`providers/${config.name}.json`, config);
  }

  /** Remove a provider config. */
  async delete(name: string): Promise<void> {
    await this.storage.delete(`providers/${name}.json`);
  }

  private construct(config: ProviderConfig): Provider {
    switch (config.type) {
      case 'openai-compatible':
      case 'anthropic':
        return new OpenAICompatibleProvider(config.baseUrl, config.apiKey);
      case 'copilot':
      case 'codex':
        throw new NotImplementedError(
          `Provider type '${config.type}' is not yet implemented. OAuth support coming soon.`,
        );
    }
  }
}
```

- [ ] **Step 4: Check if `NotImplementedError` exists — add it if not**

```bash
grep -r 'NotImplementedError' /home/chris/source/javascript/legion-v2/packages/core/src/errors/ 2>&1
```

If it does not exist, add it to `packages/core/src/errors/LegionError.ts`. Read that file first:

```bash
cat /home/chris/source/javascript/legion-v2/packages/core/src/errors/LegionError.ts
```

Then add at the end of the file:

```typescript
export class NotImplementedError extends LegionError {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}
```

(Only add this if `NotImplementedError` does not already exist in the file.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run packages/core/src/providers/SystemProviderStore.test.ts 2>&1 | tail -20
```

Expected: all tests PASS

- [ ] **Step 6: Delete dead files**

```bash
rm packages/core/src/providers/ProviderRegistry.ts
rm packages/core/src/providers/ProviderStore.ts
rm packages/core/src/providers/ProviderStore.test.ts
```

- [ ] **Step 7: Update `packages/core/src/index.ts` — remove deleted exports, add new**

Replace these lines:
```typescript
export * from './providers/ProviderRegistry.js';
export * from './providers/ProviderStore.js';
```

With:
```typescript
export * from './providers/SystemProviderStore.js';
export * from './providers/ModelRouter.js';
```

(Note: `ModelRouter` doesn't exist yet — it will be created in Task 4. The export line will cause a build error until then, which is fine — just add it now so we don't forget.)

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/providers/SystemProviderStore.ts \
        packages/core/src/providers/SystemProviderStore.test.ts \
        packages/core/src/errors/LegionError.ts \
        packages/core/src/index.ts
git rm packages/core/src/providers/ProviderRegistry.ts \
       packages/core/src/providers/ProviderStore.ts \
       packages/core/src/providers/ProviderStore.test.ts
git commit -m "feat(providers): add SystemProviderStore; delete ProviderRegistry and workspace ProviderStore"
```

---

## Task 3: Extend `Provider` interface + update `OpenAICompatibleProvider`

**Files:**
- Modify: `packages/core/src/providers/Provider.ts`
- Modify: `packages/core/src/providers/OpenAICompatibleProvider.ts`

- [ ] **Step 1: Update `Provider.ts` — add `ProviderModel` and optional `listModels()`**

Replace the entire file content of `packages/core/src/providers/Provider.ts`:

```typescript
import type { JSONSchema, ModelConfig, ProviderModel } from '@legion/types';

/**
 * A message in the LLM conversation thread.
 * `role: 'tool'` carries the result of a function call; use `toolCallId` to match it.
 */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Set on role:'assistant' messages that contain function calls. */
  toolCalls?: ProviderToolCall[];
  /** Set on role:'tool' messages — matches the originating ProviderToolCall.id. */
  toolCallId?: string;
  /** Set on role:'tool' messages — the tool name (convenience for logging). */
  name?: string;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool definition sent to the LLM so it can choose to call it. */
export interface ProviderTool {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export type ProviderStopReason = 'stop' | 'tool_calls' | 'max_tokens';

export interface ProviderResponse {
  /** Final assistant text, or null if the LLM only produced tool calls. */
  content: string | null;
  /** Non-empty when stopReason === 'tool_calls'. */
  toolCalls: ProviderToolCall[];
  stopReason: ProviderStopReason;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * LLM provider interface. Implementations are constructed by SystemProviderStore
 * and resolved by ModelRouter.
 */
export interface Provider {
  complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Promise<ProviderResponse>;

  /**
   * Optional: return all models this provider can serve.
   * Providers that do not implement this cannot be auto-resolved by ModelRouter —
   * they must be referenced explicitly via RoutingConfig.
   */
  listModels?(): Promise<ProviderModel[]>;
}
```

- [ ] **Step 2: Update `OpenAICompatibleProvider.ts` — accept `apiKey` directly, implement `listModels()`**

Replace the entire file content of `packages/core/src/providers/OpenAICompatibleProvider.ts`:

```typescript
import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig, ProviderModel } from '@legion/types';
import type {
  Provider,
  ProviderMessage,
  ProviderResponse,
  ProviderStopReason,
  ProviderTool,
  ProviderToolCall,
} from './Provider.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// ── Internal OpenAI Chat Completions wire types ──────────────────────────────

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIChatResponse {
  choices: Array<{
    message: OAIMessage;
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OAIModelsResponse {
  data: Array<{ id: string }>;
}

// ── Static cost/capability data for known models ─────────────────────────────
// Used to enrich /models responses with pricing and capability info.
// Source: https://openai.com/pricing and https://www.anthropic.com/pricing
// Update periodically as pricing changes.

interface StaticModelData {
  name?: string;
  contextWindow?: number;
  inputCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  capabilities?: ('vision' | 'tools' | 'json_mode')[];
}

const STATIC_MODEL_DATA: Record<string, StaticModelData> = {
  // OpenAI
  'gpt-4o': { name: 'GPT-4o', contextWindow: 128000, inputCostPer1kTokens: 0.0025, outputCostPer1kTokens: 0.01, capabilities: ['vision', 'tools', 'json_mode'] },
  'gpt-4o-mini': { name: 'GPT-4o mini', contextWindow: 128000, inputCostPer1kTokens: 0.00015, outputCostPer1kTokens: 0.0006, capabilities: ['vision', 'tools', 'json_mode'] },
  'gpt-4-turbo': { name: 'GPT-4 Turbo', contextWindow: 128000, inputCostPer1kTokens: 0.01, outputCostPer1kTokens: 0.03, capabilities: ['vision', 'tools', 'json_mode'] },
  'gpt-3.5-turbo': { name: 'GPT-3.5 Turbo', contextWindow: 16385, inputCostPer1kTokens: 0.0005, outputCostPer1kTokens: 0.0015, capabilities: ['tools', 'json_mode'] },
  'o1': { name: 'o1', contextWindow: 200000, inputCostPer1kTokens: 0.015, outputCostPer1kTokens: 0.06, capabilities: ['tools'] },
  'o1-mini': { name: 'o1 mini', contextWindow: 128000, inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.012, capabilities: ['tools'] },
  // Anthropic (via OpenAI-compatible proxy e.g. OpenRouter)
  'claude-opus-4-5': { name: 'Claude Opus 4.5', contextWindow: 200000, inputCostPer1kTokens: 0.015, outputCostPer1kTokens: 0.075, capabilities: ['vision', 'tools'] },
  'claude-sonnet-4-5': { name: 'Claude Sonnet 4.5', contextWindow: 200000, inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015, capabilities: ['vision', 'tools'] },
  'claude-haiku-4-5': { name: 'Claude Haiku 4.5', contextWindow: 200000, inputCostPer1kTokens: 0.0008, outputCostPer1kTokens: 0.004, capabilities: ['vision', 'tools'] },
};

// ────────────────────────────────────────────────────────────────────────────

function toOAIMessage(msg: ProviderMessage): OAIMessage {
  const out: OAIMessage = { role: msg.role, content: msg.content };
  if (msg.toolCalls?.length) {
    out.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  if (msg.toolCallId) out.tool_call_id = msg.toolCallId;
  if (msg.name) out.name = msg.name;
  return out;
}

export class OpenAICompatibleProvider implements Provider {
  constructor(
    private baseUrl = DEFAULT_BASE_URL,
    private apiKey?: string,
  ) {
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  async complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: model.model,
      messages: messages.map(toOAIMessage),
    };
    if (model.temperature !== undefined) body['temperature'] = model.temperature;
    if (model.maxTokens !== undefined) body['max_tokens'] = model.maxTokens;
    if (tools.length > 0) {
      body['tools'] = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`OpenAI-compatible API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as OAIChatResponse;
    const choice = data.choices[0];
    if (!choice) {
      throw new ProviderError('No choices returned from OpenAI-compatible API');
    }

    const msg = choice.message;
    const toolCalls: ProviderToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const stopReason: ProviderStopReason =
      choice.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'stop';

    return {
      content: msg.content,
      toolCalls,
      stopReason,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }

  /**
   * Fetch available models from the provider's /models endpoint.
   * Merges live results with embedded static cost/capability data.
   * Returns [] on network error or non-200 response — never throws.
   */
  async listModels(): Promise<ProviderModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as OAIModelsResponse;
      return (data.data ?? []).map((m) => {
        const staticData = STATIC_MODEL_DATA[m.id] ?? {};
        return {
          id: m.id,
          ...staticData,
        };
      });
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 3: Build core package to check for type errors**

```bash
cd /home/chris/source/javascript/legion-v2
npx tsc --build packages/core 2>&1 | head -40
```

Expected: errors in `AgentRuntime.ts` (references `agent.model.provider` which no longer exists) and `AgentRuntime.test.ts`. These will be fixed in Task 4. All other errors should be zero.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/providers/Provider.ts \
        packages/core/src/providers/OpenAICompatibleProvider.ts
git commit -m "feat(providers): add listModels() to Provider interface; OpenAICompatibleProvider accepts apiKey directly"
```

---

## Task 4: `ModelRouter` + wire into `AgentRuntime`

**Files:**
- Create: `packages/core/src/providers/ModelRouter.ts`
- Create: `packages/core/src/providers/ModelRouter.test.ts`
- Modify: `packages/core/src/runtime/AgentRuntime.ts`
- Modify: `packages/core/src/runtime/AgentRuntime.test.ts`

- [ ] **Step 1: Write failing tests for `ModelRouter`**

Create `packages/core/src/providers/ModelRouter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ModelRouter } from './ModelRouter.js';
import type { Provider, ProviderModel } from '../providers/Provider.js';
import type { ProviderConfig, RoutingConfig } from '@legion/types';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeProvider(modelIds: string[]): Provider {
  return {
    async complete() {
      throw new Error('not called in routing tests');
    },
    async listModels(): Promise<ProviderModel[]> {
      return modelIds.map((id) => ({ id }));
    },
  };
}

function makeProviderNoList(): Provider {
  return {
    async complete() {
      throw new Error('not called in routing tests');
    },
    // no listModels — cannot be auto-resolved
  };
}

// Stub for SystemProviderStore
interface StubStore {
  list(): Promise<ProviderConfig[]>;
  get(name: string): Promise<Provider | null>;
}

function makeStore(entries: Array<{ config: ProviderConfig; provider: Provider | null }>): StubStore {
  return {
    async list() { return entries.map((e) => e.config); },
    async get(name: string) {
      return entries.find((e) => e.config.name === name)?.provider ?? null;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ModelRouter', () => {
  it('returns null when no providers exist', async () => {
    const store = makeStore([]);
    const router = new ModelRouter(store as any, {}, {});
    const result = await router.resolve('gpt-4o');
    expect(result).toBeNull();
  });

  it('auto-resolves via listModels() when provider lists the model', async () => {
    const provider = makeProvider(['gpt-4o', 'gpt-3.5-turbo']);
    const store = makeStore([
      { config: { name: 'OpenAI', type: 'openai-compatible', priority: 1 }, provider },
    ]);
    const router = new ModelRouter(store as any, {}, {});
    const result = await router.resolve('gpt-4o');
    expect(result).toBe(provider);
  });

  it('does not auto-resolve providers without listModels()', async () => {
    const provider = makeProviderNoList();
    const store = makeStore([
      { config: { name: 'Local', type: 'openai-compatible', priority: 1 }, provider },
    ]);
    const router = new ModelRouter(store as any, {}, {});
    const result = await router.resolve('any-model');
    expect(result).toBeNull();
  });

  it('system routing takes priority over auto-resolution', async () => {
    const providerA = makeProvider(['gpt-4o']);
    const providerB = makeProvider(['gpt-4o']);
    const store = makeStore([
      { config: { name: 'ProviderA', type: 'openai-compatible', priority: 2 }, provider: providerA },
      { config: { name: 'ProviderB', type: 'openai-compatible', priority: 1 }, provider: providerB },
    ]);
    // System routing specifies ProviderA despite lower priority
    const systemRouting: RoutingConfig = { models: { 'gpt-4o': ['ProviderA'] } };
    const router = new ModelRouter(store as any, systemRouting, {});
    const result = await router.resolve('gpt-4o');
    expect(result).toBe(providerA);
  });

  it('workspace routing takes priority over system routing', async () => {
    const providerA = makeProvider(['gpt-4o']);
    const providerB = makeProvider(['gpt-4o']);
    const store = makeStore([
      { config: { name: 'ProviderA', type: 'openai-compatible', priority: 1 }, provider: providerA },
      { config: { name: 'ProviderB', type: 'openai-compatible', priority: 2 }, provider: providerB },
    ]);
    const systemRouting: RoutingConfig = { models: { 'gpt-4o': ['ProviderA'] } };
    const workspaceRouting: RoutingConfig = { models: { 'gpt-4o': ['ProviderB'] } };
    const router = new ModelRouter(store as any, systemRouting, workspaceRouting);
    const result = await router.resolve('gpt-4o');
    expect(result).toBe(providerB);
  });

  it('falls back to second provider in routing list if first is not found', async () => {
    const providerB = makeProvider(['gpt-4o']);
    const store = makeStore([
      // ProviderA not in store
      { config: { name: 'ProviderB', type: 'openai-compatible', priority: 2 }, provider: providerB },
    ]);
    const systemRouting: RoutingConfig = { models: { 'gpt-4o': ['ProviderA', 'ProviderB'] } };
    const router = new ModelRouter(store as any, systemRouting, {});
    const result = await router.resolve('gpt-4o');
    expect(result).toBe(providerB);
  });

  it('auto-resolves by priority order when multiple providers list the model', async () => {
    const providerHigh = makeProvider(['gpt-4o']);
    const providerLow = makeProvider(['gpt-4o']);
    const store = makeStore([
      { config: { name: 'HighPriority', type: 'openai-compatible', priority: 1 }, provider: providerHigh },
      { config: { name: 'LowPriority', type: 'openai-compatible', priority: 2 }, provider: providerLow },
    ]);
    const router = new ModelRouter(store as any, {}, {});
    const result = await router.resolve('gpt-4o');
    expect(result).toBe(providerHigh);
  });

  it('provider routing via explicit config can reach provider without listModels()', async () => {
    const provider = makeProviderNoList();
    const store = makeStore([
      { config: { name: 'Local', type: 'openai-compatible', priority: 1 }, provider },
    ]);
    const systemRouting: RoutingConfig = { models: { 'my-local-model': ['Local'] } };
    const router = new ModelRouter(store as any, systemRouting, {});
    const result = await router.resolve('my-local-model');
    expect(result).toBe(provider);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/core/src/providers/ModelRouter.test.ts 2>&1 | tail -20
```

Expected: FAIL with "Cannot find module './ModelRouter.js'"

- [ ] **Step 3: Implement `ModelRouter`**

Create `packages/core/src/providers/ModelRouter.ts`:

```typescript
import type { RoutingConfig } from '@legion/types';
import type { Provider } from './Provider.js';
import type { SystemProviderStore } from './SystemProviderStore.js';

export class ModelRouter {
  constructor(
    private store: SystemProviderStore,
    private systemRouting: RoutingConfig,
    private workspaceRouting: RoutingConfig,
  ) {}

  /**
   * Resolve a model ID to a Provider using the following priority:
   * 1. Workspace routing config (config.local.json)
   * 2. System routing config (~/.config/legion/config.json)
   * 3. Auto-resolve: providers that list the model via listModels(), sorted by priority
   *
   * Returns null if no provider can serve the model.
   */
  async resolve(modelId: string): Promise<Provider | null> {
    // 1. Check workspace routing
    const workspaceProviders = this.workspaceRouting.models?.[modelId];
    if (workspaceProviders?.length) {
      const provider = await this.resolveFromList(workspaceProviders);
      if (provider) return provider;
    }

    // 2. Check system routing
    const systemProviders = this.systemRouting.models?.[modelId];
    if (systemProviders?.length) {
      const provider = await this.resolveFromList(systemProviders);
      if (provider) return provider;
    }

    // 3. Auto-resolve via listModels()
    return this.autoResolve(modelId);
  }

  private async resolveFromList(providerNames: string[]): Promise<Provider | null> {
    for (const name of providerNames) {
      try {
        const provider = await this.store.get(name);
        if (provider) return provider;
      } catch {
        // NotImplementedError or other — skip this provider
      }
    }
    return null;
  }

  private async autoResolve(modelId: string): Promise<Provider | null> {
    // list() returns configs sorted by priority ascending (lower = higher priority)
    const configs = await this.store.list();
    for (const config of configs) {
      let provider: Provider | null;
      try {
        provider = await this.store.get(config.name);
      } catch {
        continue; // NotImplementedError — skip
      }
      if (!provider || !provider.listModels) continue;
      try {
        const models = await provider.listModels();
        if (models.some((m) => m.id === modelId)) return provider;
      } catch {
        continue; // listModels() failed — skip
      }
    }
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/core/src/providers/ModelRouter.test.ts 2>&1 | tail -20
```

Expected: all tests PASS

- [ ] **Step 5: Update `AgentRuntime.ts` — accept `ModelRouter`, remove `agent.model.provider` reference**

Replace the import at line 3 and the constructor/provider-resolution section:

Replace:
```typescript
import type { ProviderStore } from '../providers/ProviderStore.js';
```
With:
```typescript
import type { ModelRouter } from '../providers/ModelRouter.js';
```

Replace the class constructor and provider lookup lines (lines 45–62):
```typescript
export class AgentRuntime implements Runtime {
  constructor(
    private participantId: string,
    private router: ModelRouter,
  ) {}

  async handle(_incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    const participant = context.collective.getOrThrow(this.participantId);
    if (participant.type !== 'agent') return { kind: 'void' };
    const agent = participant as AgentConfig;

    const provider = await this.router.resolve(agent.model.model);
    if (!provider) {
      return {
        kind: 'response',
        content: `[AgentRuntime error: no provider available for model '${agent.model.model}']`,
      };
    }
```

Leave all remaining code in the file (the rest of `handle()` and `processResumedApprovals()`) exactly as-is.

- [ ] **Step 6: Update `AgentRuntime.test.ts` — replace `MockProviderStore` with `MockModelRouter`**

Replace the `MockProviderStore` class (lines 24–32) and update all usages. Find and replace:

Old helper class:
```typescript
class MockProviderStore extends ProviderStore {
  constructor(private mockProviders: Map<string, Provider>) {
    super(new MemoryStorage());
  }

  override async get(name: string): Promise<Provider | null> {
    return this.mockProviders.get(name) ?? null;
  }
}
```

New helper class — replace the above with:
```typescript
class MockModelRouter {
  constructor(private mockProviders: Map<string, Provider>) {}

  async resolve(modelId: string): Promise<Provider | null> {
    return this.mockProviders.get(modelId) ?? null;
  }
}
```

Update the import — remove `ProviderStore` import, it's no longer needed:
```typescript
// Remove this line entirely:
import { ProviderStore } from '../providers/ProviderStore.js';
```

Add `ModelRouter` import (for typing only — not strictly needed since MockModelRouter is structural):
```typescript
import type { ModelRouter } from '../providers/ModelRouter.js';
```

Update `makeSetup` — change provider map key from provider name to model ID, and change constructor call:

In `makeSetup`, the agent config has `model: { provider: 'test', model: 'test-model' }`. With the new type, it becomes `model: { model: 'test-model' }`. Update the stored agent config:

```typescript
const agentConfig: AgentConfig = {
  id: 'agent-1',
  name: 'Test Agent',
  type: 'agent',
  systemPrompt: 'You are a helpful assistant.',
  model: { model: 'test-model' },
  tools: { echo: 'auto' },
  status: 'active',
};
```

Change the mock provider creation in `makeSetup`:
```typescript
// Old:
const providerStore = new MockProviderStore(new Map([['test', mockProvider]]));
// New (key is model ID):
const router = new MockModelRouter(new Map([['test-model', mockProvider]])) as unknown as ModelRouter;
```

Change the return value:
```typescript
return { context, thread, eventBus, inbound, router };
```

Update all destructuring sites in tests from `providerStore` to `router`, and all `new AgentRuntime('agent-1', providerStore)` to `new AgentRuntime('agent-1', router)`.

For the inline describe blocks (`maxIterations`, `deny`, `requires_approval`), find all occurrences of:
- `model: { provider: 'scripted', model: 'test' }` → change to `model: { model: 'test' }`
- `new MockProviderStore(new Map([['scripted', provider]]))` → `new MockModelRouter(new Map([['test', provider]])) as unknown as ModelRouter`
- `new MockProviderStore(new Map([['scripted', loopingProvider]]))` → `new MockModelRouter(new Map([['m', loopingProvider]])) as unknown as ModelRouter`
  (match the model field: `model: { model: 'm' }` in the maxIterations test)
- `new AgentRuntime('agent-1', providerStore)` → `new AgentRuntime('agent-1', providerStore as unknown as ModelRouter)` — actually, rename the variable: `const router = new MockModelRouter(...)` and use `new AgentRuntime('agent-1', router as unknown as ModelRouter)`

The "no provider registered" test — update the error message expectation to match the new text:
```typescript
it('returns an error message when no provider is registered for the agent model', async () => {
  const emptyRouter = new MockModelRouter(new Map()) as unknown as ModelRouter;
  const { context, inbound } = await makeSetup([]);
  const runtime = new AgentRuntime('agent-1', emptyRouter);
  const result = await runtime.handle(inbound, context);
  expect((result as { kind: string; content: string }).content).toMatch(/no provider/i);
  expect((result as { kind: string; content: string }).content).toMatch(/test-model/);
});
```

- [ ] **Step 7: Run the core test suite**

```bash
npx vitest run packages/core 2>&1 | tail -30
```

Expected: all tests PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/providers/ModelRouter.ts \
        packages/core/src/providers/ModelRouter.test.ts \
        packages/core/src/runtime/AgentRuntime.ts \
        packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "feat(routing): add ModelRouter; AgentRuntime resolves providers by model ID"
```

---

## Task 5: Update `LegionProcess` + runtime tools

**Files:**
- Modify: `packages/runtime/src/LegionProcess.ts`
- Modify: `packages/runtime/src/server/runtime-tools.ts`

- [ ] **Step 1: Update `runtime-tools.ts` — new 6-tool set**

Replace the entire file:

```typescript
import type { ProviderConfig, ProviderModel, RoutingConfig, ToolResult } from '@legion/types';
import type { Tool, SystemProviderStore } from '@legion/core';

interface RuntimeToolDeps {
  systemStore: SystemProviderStore;
  systemRouting: RoutingConfig;
  workspaceRouting: RoutingConfig;
  saveSystemRouting: (routing: RoutingConfig) => Promise<void>;
  saveWorkspaceRouting: (routing: RoutingConfig) => Promise<void>;
}

export function createRuntimeTools(deps: RuntimeToolDeps): Tool[] {
  const { systemStore, systemRouting, workspaceRouting, saveSystemRouting, saveWorkspaceRouting } = deps;

  return [
    {
      name: 'list_providers',
      description: 'List all configured system-level LLM providers.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          const configs = await systemStore.list();
          return { status: 'success', data: configs };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'save_provider',
      description: 'Create or update a system-level provider. Includes API key stored inline.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['openai-compatible', 'anthropic', 'copilot', 'codex'] },
          baseUrl: { type: 'string' },
          apiKey: { type: 'string' },
          priority: { type: 'number' },
        },
        required: ['name', 'type', 'priority'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as ProviderConfig;
          await systemStore.save(args);
          return { status: 'success', data: args };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'delete_provider',
      description: 'Remove a system-level provider by name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const { name } = rawArgs as { name: string };
          await systemStore.delete(name);
          return { status: 'success', data: { name } };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'list_models',
      description: 'List all models across all providers that support model discovery. Optionally filter to a single provider.',
      parameters: {
        type: 'object',
        properties: {
          providerName: { type: 'string' },
        },
        required: [],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as { providerName?: string };
          const configs = await systemStore.list();
          const targets = args.providerName
            ? configs.filter((c) => c.name === args.providerName)
            : configs;

          const results: Array<{ provider: string; model: ProviderModel }> = [];
          for (const config of targets) {
            let provider;
            try {
              provider = await systemStore.get(config.name);
            } catch {
              continue;
            }
            if (!provider?.listModels) continue;
            const models = await provider.listModels();
            for (const model of models) {
              results.push({ provider: config.name, model });
            }
          }
          return { status: 'success', data: results };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'get_routing',
      description: 'Return system and workspace routing configuration.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        return {
          status: 'success',
          data: { system: systemRouting, workspace: workspaceRouting },
        };
      },
    },

    {
      name: 'save_routing',
      description: 'Save routing configuration to system (~/.config/legion/config.json) or workspace (config.local.json). scope must be "system" or "workspace".',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['system', 'workspace'] },
          routing: {
            type: 'object',
            properties: {
              models: { type: 'object' },
            },
          },
        },
        required: ['scope', 'routing'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as { scope: 'system' | 'workspace'; routing: RoutingConfig };
          if (args.scope === 'system') {
            await saveSystemRouting(args.routing);
          } else {
            await saveWorkspaceRouting(args.routing);
          }
          return { status: 'success', data: { scope: args.scope } };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ] satisfies Tool[];
}
```

- [ ] **Step 2: Update `LegionProcess.ts` — load system config, local config, construct `SystemProviderStore` + `ModelRouter`, wire `.gitignore`**

Update the imports at the top of `LegionProcess.ts`. Replace the `@legion/core` import block:

```typescript
import {
  // Core engine
  Collective,
  ConversationThread,
  EventBus,
  FileConversationStore,
  FileCredentialStore,
  FileStorage,
  RuntimeRegistry,
  MessageRouter,
  ToolRegistry,
  AuthEngine,
  PendingApprovalRegistry,
  ConnectorRegistry,
  UserDeliveryRuntime,
  AgentRuntime,
  MockRuntime,
  ServiceManager,
  SystemProviderStore,
  ModelRouter,
  // Global tools
  communicateTool,
  approvalResponseTool,
  managementTools,
  // MCP
  loadMCPSources,
  type ToolSource,
  // Types
  type WorkspaceConfig,
  type ToolContext,
  type ConnectorContext,
  BOOTSTRAP_OPERATOR_ID,
} from '@legion/core';
import type { ConversationData, RoutingConfig, SystemConfig, LocalConfig, ToolResult } from '@legion/types';
```

Add two new imports at the top of the file after the existing node imports:
```typescript
import { homedir } from 'node:os';
```

Replace the `LegionProcess` class's private constructor to update the `ConnectorContextDeps` interface's `config` field type and remove the stale `credentials` reference (it stays for auth, just not for providers):

The constructor stays the same — no changes needed to the constructor itself.

Replace the `static async start()` method body. The key changes are in steps 1, 5b, 5c, and 6. Replace the entire `start()` method:

```typescript
static async start(workspaceRoot: string, options: StartOptions = {}): Promise<LegionProcess> {
  // ── Step 1: Load configs ────────────────────────────────────────────────
  const systemConfig = await loadSystemConfig();
  const workspaceConfig = await loadWorkspaceConfig(workspaceRoot);
  const localConfig = await loadLocalConfig(workspaceRoot);
  const legionRoot = join(workspaceRoot, '.legion');

  // Deep-merge localConfig over workspaceConfig (local wins on conflict)
  const mergedConfig: WorkspaceConfig = deepMerge(workspaceConfig, localConfig);

  // ── Step 2: Load collective; seed bootstrap operator if empty ────────────
  const storage = new FileStorage(legionRoot);
  const collective = await Collective.load(storage);
  const credentials = new FileCredentialStore(storage);
  const seeded = await collective.seedDefaultsIfEmpty();
  if (seeded.length > 0) {
    const password = process.env.LEGION_BOOTSTRAP_PASSWORD ?? randomUUID();
    await credentials.setCredential(BOOTSTRAP_OPERATOR_ID, password);
    console.log(
      '\n  ┌─ Legion bootstrap ──────────────────────────────────────────────┐' +
        '\n  │  Username: ' +
        BOOTSTRAP_OPERATOR_ID +
        '                                          │' +
        '\n  │  Password: ' +
        password +
        '                                         │' +
        '\n  │  Store this password — it will not be shown again.              │' +
        '\n  └─────────────────────────────────────────────────────────────────┘\n',
    );
  }

  // ── Step 3: Initialise ConversationStore ─────────────────────────────────
  const store = new FileConversationStore(storage);

  // ── Step 4: Register runtime factories ───────────────────────────────────
  const connectorRegistry = new ConnectorRegistry();
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.registerFactory('user', (id) => new UserDeliveryRuntime(id, connectorRegistry));
  runtimeRegistry.registerFactory('mock', (id) => new MockRuntime(id));

  // ── Step 5: Create core engine components ────────────────────────────────
  const eventBus = new EventBus();
  collective.eventBus = eventBus;
  const toolRegistry = new ToolRegistry();
  const authEngine = new AuthEngine();
  const pendingApprovalRegistry = await PendingApprovalRegistry.load(storage);

  const router = new MessageRouter(store, runtimeRegistry, collective, eventBus);

  // ── Step 5b: Ensure .legion/config.local.json is gitignored ─────────────
  await ensureGitignored(legionRoot, 'config.local.json');

  // ── Step 5c: Create SystemProviderStore + ModelRouter ───────────────────
  const systemConfigDir = join(homedir(), '.config', 'legion');
  const systemStorage = new FileStorage(systemConfigDir);
  const systemStore = new SystemProviderStore(systemStorage);

  const workspaceRouting: RoutingConfig = localConfig.routing ?? {};
  const systemRouting: RoutingConfig = systemConfig.routing ?? {};
  const modelRouter = new ModelRouter(systemStore, systemRouting, workspaceRouting);

  // ── Step 6: Register global tools ────────────────────────────────────────
  toolRegistry.register(communicateTool);
  toolRegistry.register(approvalResponseTool);
  for (const tool of managementTools) {
    toolRegistry.register(tool);
  }

  const systemConfigPath = join(systemConfigDir, 'config.json');
  const localConfigPath = join(legionRoot, 'config.local.json');

  const runtimeTools = createRuntimeTools({
    systemStore,
    systemRouting,
    workspaceRouting,
    saveSystemRouting: async (routing) => {
      const current = await loadSystemConfig();
      await writeJsonFile(systemConfigPath, { ...current, routing });
    },
    saveWorkspaceRouting: async (routing) => {
      const current = await loadLocalConfig(workspaceRoot);
      await writeJsonFile(localConfigPath, { ...current, routing });
    },
  });
  for (const tool of runtimeTools) {
    toolRegistry.register(tool);
  }

  // ── Step 7: Load MCP tool sources ────────────────────────────────────────
  const mcpSources = await loadMCPSources(mergedConfig.mcpServers ?? [], toolRegistry);

  // ── Step 8: Create ServiceManager + register service runtime factory ─────
  const serviceManager = new ServiceManager({
    collective,
    store,
    toolRegistry,
    authEngine,
    pendingApprovalRegistry,
    messageRouter: router,
    eventBus,
    storage,
    workspaceConfig: mergedConfig,
    workspaceRoot,
  });

  for (const participant of collective.listActive()) {
    if (participant.type === 'service') {
      await serviceManager.loadService(participant);
    }
  }

  runtimeRegistry.registerFactory('service', (id) => serviceManager.getRuntime(id));

  runtimeRegistry.registerFactory('agent', (id) => {
    return new AgentRuntime(id, modelRouter);
  });

  // ── Step 9: Initialise web connector ─────────────────────────────────────
  const port = process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : (mergedConfig.server?.port ?? 3000);
  if (isNaN(port)) {
    throw new Error(`Invalid PORT env var: "${process.env.PORT}" — must be a number`);
  }
  const webConnectorConfig = { ...(mergedConfig.server ?? {}), port };
  const _dirname = fileURLToPath(new URL('.', import.meta.url));

  const dev = options.dev ?? false;
  const webSrcPath = dev
    ? join(_dirname, '..', '..', 'web')
    : undefined;
  const webDistPath = dev
    ? undefined
    : join(_dirname, '..', '..', 'web', 'dist');

  const webConnector = new WebConnector({
    collective,
    credentials,
    eventBus,
    serverConfig: webConnectorConfig,
    webDistPath,
    webSrcPath,
    dev,
  });

  connectorRegistry.register(webConnector);

  const connectorContext: ConnectorContext = buildConnectorContext({
    router,
    toolRegistry,
    authEngine,
    connectorRegistry,
    collective,
    store,
    pendingApprovalRegistry,
    eventBus,
    storage,
    config: mergedConfig,
    workspaceRoot,
    serviceManager,
  });

  await webConnector.start(connectorContext);

  // ── Step 10: Auto-start services ─────────────────────────────────────────
  await serviceManager.autoStart();

  // ── Step 11: Emit process:ready ───────────────────────────────────────────
  eventBus.emit('process:ready', { workspaceRoot });

  return new LegionProcess(
    router,
    collective,
    store,
    credentials,
    serviceManager,
    connectorRegistry,
    eventBus,
    mcpSources,
  );
}
```

- [ ] **Step 3: Add helper functions to the bottom of `LegionProcess.ts`**

Replace the existing `loadWorkspaceConfig` helper and add new ones. Remove `loadWorkspaceConfig` and add all these at the bottom of the file (after the `buildConnectorContext` function):

```typescript
/** Read and parse `~/.config/legion/config.json`. Returns empty config if absent. */
async function loadSystemConfig(): Promise<SystemConfig> {
  const configPath = join(homedir(), '.config', 'legion', 'config.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as SystemConfig;
  } catch {
    return {};
  }
}

/** Read and parse `.legion/config.json`. Returns a default config if the file is absent. */
async function loadWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig> {
  const configPath = join(workspaceRoot, '.legion', 'config.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as WorkspaceConfig;
  } catch {
    return { version: '2' };
  }
}

/** Read and parse `.legion/config.local.json`. Returns empty object if absent. */
async function loadLocalConfig(workspaceRoot: string): Promise<LocalConfig> {
  const configPath = join(workspaceRoot, '.legion', 'config.local.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as LocalConfig;
  } catch {
    return {};
  }
}

/** Write JSON to an absolute file path, creating parent directories as needed. */
async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdirFs(dirname(filePath), { recursive: true });
  await writeFileFs(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Deep-merge `override` into `base`. Override wins on conflicting scalar values.
 * Arrays are replaced, not merged.
 */
function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const overrideVal = override[key];
    if (overrideVal === undefined) continue;
    const baseVal = base[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as object, overrideVal as object) as T[keyof T];
    } else {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}

/** Ensure a filename is listed in .legion/.gitignore, adding it if not present. */
async function ensureGitignored(legionRoot: string, filename: string): Promise<void> {
  const { readFile: rf, writeFile: wf, mkdir: mkdirFs } = await import('node:fs/promises');
  await mkdirFs(legionRoot, { recursive: true });
  const gitignorePath = join(legionRoot, '.gitignore');
  let existing = '';
  try {
    existing = await rf(gitignorePath, 'utf-8');
  } catch {
    // File doesn't exist yet — start empty
  }
  const lines = existing.split('\n').map((l) => l.trim());
  if (!lines.includes(filename)) {
    const updated = existing.trimEnd() + (existing ? '\n' : '') + filename + '\n';
    await wf(gitignorePath, updated, 'utf-8');
  }
}
```

- [ ] **Step 4: Build the runtime package**

```bash
cd /home/chris/source/javascript/legion-v2
npx tsc --build packages/runtime 2>&1 | head -40
```

Expected: zero type errors. If there are import errors for `SystemConfig`, `LocalConfig` etc., verify they are exported from `@legion/types`.

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts \
        packages/runtime/src/server/runtime-tools.ts
git commit -m "feat(runtime): SystemProviderStore + ModelRouter wired; system/local config loading; gitignore local config"
```

---

## Task 6: Update UI

**Files:**
- Modify: `packages/web/src/views/ConfigView.vue`
- Delete: `packages/web/src/components/config/CredentialSlideOver.vue`
- Modify: `packages/web/src/components/config/ProviderSlideOver.vue`
- Create: `packages/web/src/components/config/RoutingEditor.vue`
- Modify: `packages/web/src/components/participants/ParticipantSlideOver.vue`
- Modify: `packages/web/src/router/index.ts`

- [ ] **Step 1: Delete `CredentialSlideOver.vue`**

```bash
git rm packages/web/src/components/config/CredentialSlideOver.vue
```

- [ ] **Step 2: Rewrite `ProviderSlideOver.vue` — add `apiKey`, remove `credentialKey`/`defaultModel`**

Replace the entire file:

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ProviderConfig } from '@legion/types';
import SlideOver from '../common/SlideOver.vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  open: boolean;
  provider: ProviderConfig | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const name = ref('');
const type = ref<ProviderConfig['type']>('openai-compatible');
const baseUrl = ref('');
const apiKey = ref('');
const priority = ref(10);
const saving = ref(false);
const apiKeyPlaceholder = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    name.value = props.provider?.name ?? '';
    type.value = props.provider?.type ?? 'openai-compatible';
    baseUrl.value = props.provider?.baseUrl ?? '';
    priority.value = props.provider?.priority ?? 10;
    apiKey.value = '';
    apiKeyPlaceholder.value = props.provider?.apiKey ? '••••••••' : '';
  },
);

async function save() {
  saving.value = true;
  try {
    const payload: ProviderConfig = {
      name: name.value,
      type: type.value,
      priority: priority.value,
    };
    if (baseUrl.value) payload.baseUrl = baseUrl.value;
    // Only include apiKey if user typed a new value; preserve existing if left blank
    if (apiKey.value) {
      payload.apiKey = apiKey.value;
    } else if (props.provider?.apiKey) {
      payload.apiKey = props.provider.apiKey;
    }
    await execute('save_provider', payload);
    emit('saved');
    emit('close');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <SlideOver
    :open="open"
    :title="provider ? 'Edit provider' : 'Add provider'"
    @close="emit('close')"
  >
    <div class="p-5 space-y-4">
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Name</label
        >
        <input
          v-model="name"
          :readonly="!!provider"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none"
        />
        <p class="text-[10px] text-navy-500 mt-1">Cannot change after creation.</p>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Type</label
        >
        <select
          v-model="type"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100"
        >
          <option>openai-compatible</option>
          <option>anthropic</option>
          <option>copilot</option>
          <option>codex</option>
        </select>
      </div>
      <div v-if="type === 'openai-compatible'">
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Base URL</label
        >
        <input
          v-model="baseUrl"
          placeholder="https://api.openai.com/v1"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none"
        />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >API Key</label
        >
        <input
          v-model="apiKey"
          type="password"
          :placeholder="apiKeyPlaceholder || 'sk-...'"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none"
        />
        <p v-if="provider?.apiKey" class="text-[10px] text-navy-500 mt-1">
          Leave blank to keep existing key.
        </p>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
          >Priority</label
        >
        <input
          v-model.number="priority"
          type="number"
          min="1"
          class="w-20 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none"
        />
        <p class="text-[10px] text-navy-500 mt-1">Lower number = higher priority (used for auto-routing).</p>
      </div>
    </div>
    <template #footer>
      <div class="flex justify-end gap-2 px-5 py-3">
        <button
          @click="emit('close')"
          class="text-xs px-3 py-1.5 border border-navy-600 text-navy-400 rounded"
        >
          Cancel
        </button>
        <button
          @click="save"
          :disabled="saving"
          class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </template>
  </SlideOver>
</template>
```

- [ ] **Step 3: Create `RoutingEditor.vue`**

Create `packages/web/src/components/config/RoutingEditor.vue`:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import type { RoutingConfig } from '@legion/types';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  scope: 'system' | 'workspace';
  routing: RoutingConfig;
  providerNames: string[];
}>();
const emit = defineEmits<{ saved: [] }>();
const { execute } = useExecute();

// Local editable copy as array of {model, providers[]}
const rows = ref<Array<{ model: string; providers: string[] }>>(
  Object.entries(props.routing.models ?? {}).map(([model, providers]) => ({ model, providers })),
);

const newModelId = ref('');
const saving = ref(false);

function addRow() {
  const id = newModelId.value.trim();
  if (!id || rows.value.some((r) => r.model === id)) return;
  rows.value.push({ model: id, providers: [] });
  newModelId.value = '';
}

function removeRow(index: number) {
  rows.value.splice(index, 1);
}

function moveProviderUp(rowIndex: number, provIndex: number) {
  if (provIndex === 0) return;
  const providers = rows.value[rowIndex].providers;
  [providers[provIndex - 1], providers[provIndex]] = [providers[provIndex], providers[provIndex - 1]];
}

function moveProviderDown(rowIndex: number, provIndex: number) {
  const providers = rows.value[rowIndex].providers;
  if (provIndex === providers.length - 1) return;
  [providers[provIndex], providers[provIndex + 1]] = [providers[provIndex + 1], providers[provIndex]];
}

function addProvider(rowIndex: number, providerName: string) {
  const providers = rows.value[rowIndex].providers;
  if (!providers.includes(providerName)) {
    providers.push(providerName);
  }
}

function removeProvider(rowIndex: number, provIndex: number) {
  rows.value[rowIndex].providers.splice(provIndex, 1);
}

const availableForRow = computed(() => (rowIndex: number) => {
  const used = rows.value[rowIndex].providers;
  return props.providerNames.filter((p) => !used.includes(p));
});

async function save() {
  saving.value = true;
  try {
    const models: Record<string, string[]> = {};
    for (const row of rows.value) {
      if (row.model && row.providers.length > 0) {
        models[row.model] = row.providers;
      }
    }
    await execute('save_routing', { scope: props.scope, routing: { models } });
    emit('saved');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-3">
    <!-- Per-model rows -->
    <div
      v-for="(row, rowIndex) in rows"
      :key="row.model"
      class="border border-navy-700 rounded p-3 space-y-2"
    >
      <div class="flex items-center justify-between">
        <span class="font-mono text-xs text-slate-100">{{ row.model }}</span>
        <button @click="removeRow(rowIndex)" class="text-[10px] text-red-400 hover:text-red-300">
          Remove
        </button>
      </div>
      <!-- Provider priority list -->
      <div class="space-y-1">
        <div
          v-for="(prov, provIndex) in row.providers"
          :key="prov"
          class="flex items-center gap-1"
        >
          <span class="text-[10px] text-navy-400 w-4">{{ provIndex + 1 }}.</span>
          <span
            class="flex-1 text-[10px] font-mono bg-cyan-400/10 border border-cyan-400/20 text-cyan-400 px-2 py-0.5 rounded"
          >
            {{ prov }}
          </span>
          <button
            @click="moveProviderUp(rowIndex, provIndex)"
            :disabled="provIndex === 0"
            class="text-[10px] text-navy-400 hover:text-slate-200 disabled:opacity-30 px-1"
          >
            ↑
          </button>
          <button
            @click="moveProviderDown(rowIndex, provIndex)"
            :disabled="provIndex === row.providers.length - 1"
            class="text-[10px] text-navy-400 hover:text-slate-200 disabled:opacity-30 px-1"
          >
            ↓
          </button>
          <button
            @click="removeProvider(rowIndex, provIndex)"
            class="text-[10px] text-red-400 hover:text-red-300 px-1"
          >
            ×
          </button>
        </div>
        <p v-if="row.providers.length === 0" class="text-[10px] text-navy-600 italic">
          No providers — add one below.
        </p>
      </div>
      <!-- Add provider to row -->
      <select
        v-if="availableForRow(rowIndex).length > 0"
        @change="(e) => { addProvider(rowIndex, (e.target as HTMLSelectElement).value); (e.target as HTMLSelectElement).value = ''; }"
        class="w-full bg-navy-900 border border-navy-600 rounded px-2 py-1 text-[10px] text-navy-400"
      >
        <option value="">+ Add provider…</option>
        <option v-for="p in availableForRow(rowIndex)" :key="p" :value="p">{{ p }}</option>
      </select>
    </div>

    <!-- Add model row -->
    <div class="flex gap-2">
      <input
        v-model="newModelId"
        placeholder="model-id (e.g. claude-sonnet-4-5)"
        @keyup.enter="addRow"
        class="flex-1 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-xs text-slate-100 font-mono outline-none"
      />
      <button
        @click="addRow"
        class="text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded"
      >
        + Add model
      </button>
    </div>

    <!-- Save -->
    <div class="flex justify-end pt-2">
      <button
        @click="save"
        :disabled="saving"
        class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50"
      >
        {{ saving ? 'Saving…' : `Save ${scope} routing` }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Rewrite `ConfigView.vue` — remove Credentials tab, add Routing tab**

Replace the entire file:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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

      <!-- Providers tab -->
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
        <table
          class="w-full border-collapse bg-navy-900 rounded-lg border border-navy-600 overflow-hidden text-xs"
        >
          <thead class="bg-navy-950">
            <tr>
              <th
                v-for="h in ['Priority', 'Name', 'Type', 'Base URL', 'API Key', '']"
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
              <td class="px-3 py-2.5 text-navy-400 text-center">{{ p.priority }}</td>
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
              <td class="px-3 py-2.5 font-mono text-navy-500 text-[10px] tracking-wider">
                {{ p.apiKey ? '••••' + p.apiKey.slice(-4) : '—' }}
              </td>
              <td class="px-3 py-2.5 text-right space-x-3">
                <button @click="openProvider(p)" class="text-navy-400 hover:text-slate-200">
                  Edit
                </button>
                <button @click="deleteProvider(p.name)" class="text-red-400 hover:text-red-300">
                  Delete
                </button>
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

      <!-- Routing tab -->
      <template v-else>
        <div class="space-y-6">
          <div>
            <h2 class="text-xs font-semibold text-slate-100 mb-1">System routing</h2>
            <p class="text-[10px] text-navy-400 mb-3">
              Stored in <code class="font-mono text-navy-300">~/.config/legion/config.json</code>. Applies to all workspaces.
            </p>
            <RoutingEditor
              scope="system"
              :routing="systemRouting"
              :provider-names="providers.map((p) => p.name)"
              @saved="load"
            />
          </div>
          <div class="border-t border-navy-700 pt-6">
            <h2 class="text-xs font-semibold text-slate-100 mb-1">Workspace routing</h2>
            <p class="text-[10px] text-navy-400 mb-3">
              Stored in <code class="font-mono text-navy-300">.legion/config.local.json</code> — local only, not tracked by git.
            </p>
            <RoutingEditor
              scope="workspace"
              :routing="workspaceRouting"
              :provider-names="providers.map((p) => p.name)"
              @saved="load"
            />
          </div>
        </div>
      </template>
    </div>

    <ProviderSlideOver
      :open="providerSlide"
      :provider="editingProvider"
      @close="providerSlide = false"
      @saved="load"
    />
  </AppLayout>
</template>
```

- [ ] **Step 5: Update `ParticipantSlideOver.vue` — remove provider dropdown, add model dropdown**

In `packages/web/src/components/participants/ParticipantSlideOver.vue`:

Update the props definition — remove `providers` prop, add `availableModels`:

```typescript
const props = defineProps<{
  open: boolean;
  participantId: string | null;
  availableTools: string[];
  availableModels: Array<{ id: string; name?: string; provider: string }>;
}>();
```

Remove the `providerId` ref and the `modelFilter` logic. Replace with:

```typescript
const modelSearch = ref('');
const selectedModel = ref('');
const showModelDropdown = ref(false);

const filteredModels = computed(() =>
  props.availableModels.filter(
    (m) =>
      !modelSearch.value ||
      m.id.toLowerCase().includes(modelSearch.value.toLowerCase()) ||
      (m.name ?? '').toLowerCase().includes(modelSearch.value.toLowerCase()) ||
      m.provider.toLowerCase().includes(modelSearch.value.toLowerCase()),
  ),
);
```

In the `watch` for `props.open`, update the edit-mode loading:
```typescript
// Replace:
const modelCfg = p.model as { provider: string; model: string } | undefined;
providerId.value = modelCfg?.provider ?? '';
model.value = modelCfg?.model ?? '';
// With:
const modelCfg = p.model as { model: string } | undefined;
selectedModel.value = modelCfg?.model ?? '';
model.value = modelCfg?.model ?? '';
```

In the new-mode reset block:
```typescript
// Remove: providerId.value = props.providers[0]?.name ?? '';
// Add:
selectedModel.value = '';
model.value = '';
```

Update the `save()` function — remove `providerId` from model payload:
```typescript
// Replace:
model: { provider: providerId.value, model: model.value },
// With:
model: { model: selectedModel.value || model.value },
```

In the template, replace the Provider `<select>` block and Model `<input>` block with a combined searchable model picker:

```html
<div>
  <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1"
    >Model</label
  >
  <!-- Selected model display -->
  <div v-if="selectedModel && !showModelDropdown" class="flex items-center gap-2">
    <span class="flex-1 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono">
      {{ selectedModel }}
    </span>
    <button
      @click="showModelDropdown = true; modelSearch = ''"
      class="text-[10px] text-navy-400 hover:text-slate-200 border border-navy-600 rounded px-2 py-1.5"
    >
      Change
    </button>
  </div>
  <!-- Search input -->
  <div v-else class="space-y-1">
    <input
      v-model="modelSearch"
      placeholder="Search models… or type model ID"
      @focus="showModelDropdown = true"
      class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none focus:border-cyan-400/40"
    />
    <div
      v-if="showModelDropdown"
      class="border border-navy-600 rounded bg-navy-950 max-h-48 overflow-y-auto"
    >
      <!-- Free-text option -->
      <button
        v-if="modelSearch && !filteredModels.some((m) => m.id === modelSearch)"
        @click="selectedModel = modelSearch; model = modelSearch; showModelDropdown = false"
        class="w-full text-left px-3 py-2 text-xs text-navy-400 hover:bg-navy-800 font-mono border-b border-navy-700"
      >
        Use "{{ modelSearch }}" (not in discovery list)
      </button>
      <button
        v-for="m in filteredModels"
        :key="m.id"
        @click="selectedModel = m.id; model = m.id; modelSearch = ''; showModelDropdown = false"
        class="w-full text-left px-3 py-2 hover:bg-navy-800"
      >
        <span class="text-xs font-mono text-slate-100">{{ m.id }}</span>
        <span class="text-[10px] text-navy-500 ml-2">{{ m.provider }}</span>
      </button>
      <p
        v-if="filteredModels.length === 0 && !modelSearch"
        class="px-3 py-2 text-[10px] text-navy-600 italic"
      >
        No models discovered. Configure providers first.
      </p>
    </div>
  </div>
</div>
```

- [ ] **Step 6: Update the parent view that passes `providers` to `ParticipantSlideOver` — switch to `availableModels`**

Find where `ParticipantSlideOver` is used:

```bash
grep -r 'ParticipantSlideOver' /home/chris/source/javascript/legion-v2/packages/web/src/ --include="*.vue" -l
```

Open that file and:
1. Add a `list_models` call alongside existing data loading
2. Replace `:providers="providers"` with `:available-models="availableModels"`

The `availableModels` array shape: `Array<{ id: string; name?: string; provider: string }>`, built from the `list_models` tool response which returns `Array<{ provider: string; model: ProviderModel }>`.

- [ ] **Step 7: Update router — remove `/config/credentials` route**

In `packages/web/src/router/index.ts`, remove the `/config/credentials` route entry:

```typescript
// Remove this block:
{
  path: '/config/credentials',
  component: () => import('../views/ConfigView.vue'),
  meta: { requiresAuth: true },
},
```

- [ ] **Step 8: Build the web package**

```bash
cd /home/chris/source/javascript/legion-v2
npx tsc --build packages/web 2>&1 | head -40
```

Fix any remaining type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/views/ConfigView.vue \
        packages/web/src/components/config/ProviderSlideOver.vue \
        packages/web/src/components/config/RoutingEditor.vue \
        packages/web/src/components/participants/ParticipantSlideOver.vue \
        packages/web/src/router/index.ts
git rm packages/web/src/components/config/CredentialSlideOver.vue
git commit -m "feat(ui): unified provider form, routing editor, searchable model picker; remove credential UI"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full typecheck**

```bash
cd /home/chris/source/javascript/legion-v2
npx tsc --build --force 2>&1
```

Expected: zero errors

- [ ] **Step 2: Full test suite**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: all tests pass, 0 failures

- [ ] **Step 3: Prettier check**

```bash
npx prettier --check \
  packages/types/src/config.ts \
  packages/types/src/participant.ts \
  packages/core/src/providers/SystemProviderStore.ts \
  packages/core/src/providers/SystemProviderStore.test.ts \
  packages/core/src/providers/ModelRouter.ts \
  packages/core/src/providers/ModelRouter.test.ts \
  packages/core/src/providers/Provider.ts \
  packages/core/src/providers/OpenAICompatibleProvider.ts \
  packages/core/src/runtime/AgentRuntime.ts \
  packages/core/src/runtime/AgentRuntime.test.ts \
  packages/core/src/index.ts \
  packages/runtime/src/LegionProcess.ts \
  packages/runtime/src/server/runtime-tools.ts \
  packages/web/src/views/ConfigView.vue \
  packages/web/src/components/config/ProviderSlideOver.vue \
  packages/web/src/components/config/RoutingEditor.vue \
  packages/web/src/components/participants/ParticipantSlideOver.vue 2>&1
```

If any fail, run with `--write` instead of `--check`, then:

```bash
git add -u
git commit -m "style: prettier formatting for provider/routing overhaul"
```

- [ ] **Step 4: Delete stale `~/.config/legion/config.json` (old POC config)**

```bash
rm ~/.config/legion/config.json 2>/dev/null || true
```

- [ ] **Step 5: Smoke test — start the dev server and verify providers page loads**

```bash
cd /home/chris/source/javascript/legion-v2
npm run dev 2>&1 &
sleep 5
# Open http://localhost:3000 in browser — verify /config shows Providers + Routing tabs, no Credentials tab
# Verify Add Provider form has Name, Type, Base URL (conditional), API Key, Priority fields
# Kill the dev server
kill %1
```
