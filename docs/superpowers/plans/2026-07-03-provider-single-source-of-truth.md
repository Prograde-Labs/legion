# Provider Single Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify provider configuration so `.legion/providers/<name>.json` is the single source of truth, with hot-reload: agents pick up newly configured providers immediately without a server restart.

**Architecture:** Replace the startup-populated `ProviderRegistry` in `AgentRuntime` with a new `ProviderStore` class that reads provider config from `FileStorage` on each call. `LegionProcess` migrates any providers from `config.json` into `.legion/providers/` on startup. `runtime-tools.ts` delegates `list_providers` and `configure_provider` to `ProviderStore`.

**Tech Stack:** TypeScript, Vitest, Node.js `fs/promises` (via `Storage` abstraction), `MemoryStorage` for tests.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `packages/core/src/providers/ProviderStore.ts` | Reads/writes provider configs via `Storage`; constructs `OpenAICompatibleProvider` instances |
| Create | `packages/core/src/providers/ProviderStore.test.ts` | Unit tests for `ProviderStore` |
| Modify | `packages/core/src/runtime/AgentRuntime.ts` | Accept `ProviderStore` instead of `ProviderRegistry` |
| Modify | `packages/core/src/runtime/AgentRuntime.test.ts` | Update test setup: replace `ProviderRegistry` with stub `ProviderStore` |
| Modify | `packages/core/src/index.ts` | Export `ProviderStore` |
| Modify | `packages/runtime/src/LegionProcess.ts` | Migrate `config.json` providers; construct `ProviderStore`; wire to `AgentRuntime` factory and `createRuntimeTools` |
| Modify | `packages/runtime/src/server/runtime-tools.ts` | Accept `providerStore` dep; delegate list/configure to it |

---

## Task 1: Create `ProviderStore`

**Files:**
- Create: `packages/core/src/providers/ProviderStore.ts`
- Create: `packages/core/src/providers/ProviderStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/providers/ProviderStore.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { ProviderStore } from './ProviderStore.js';
import type { ProviderConfig } from '@legion/types';

describe('ProviderStore', () => {
  it('get() returns null when no provider file exists', async () => {
    const storage = new MemoryStorage();
    const store = new ProviderStore(storage);
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('get() returns an OpenAICompatibleProvider when the file exists', async () => {
    const storage = new MemoryStorage();
    const config: ProviderConfig = {
      name: 'my-provider',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      defaultModel: 'llama',
    };
    await storage.writeJson('providers/my-provider.json', config);
    const store = new ProviderStore(storage);
    const provider = await store.get('my-provider');
    expect(provider).not.toBeNull();
    expect(typeof provider!.complete).toBe('function');
  });

  it('list() returns empty array when no providers exist', async () => {
    const storage = new MemoryStorage();
    const store = new ProviderStore(storage);
    const result = await store.list();
    expect(result).toEqual([]);
  });

  it('list() returns all saved provider configs', async () => {
    const storage = new MemoryStorage();
    const configA: ProviderConfig = {
      name: 'provider-a',
      type: 'openai-compatible',
      baseUrl: 'http://a.example/v1',
      defaultModel: 'model-a',
    };
    const configB: ProviderConfig = {
      name: 'provider-b',
      type: 'openai-compatible',
      baseUrl: 'http://b.example/v1',
      defaultModel: 'model-b',
    };
    await storage.writeJson('providers/provider-a.json', configA);
    await storage.writeJson('providers/provider-b.json', configB);
    const store = new ProviderStore(storage);
    const result = await store.list();
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name).sort()).toEqual(['provider-a', 'provider-b']);
  });

  it('save() writes provider config so get() can find it', async () => {
    const storage = new MemoryStorage();
    const store = new ProviderStore(storage);
    const config: ProviderConfig = {
      name: 'saved-provider',
      type: 'openai-compatible',
      baseUrl: 'http://saved.example/v1',
      defaultModel: 'saved-model',
    };
    await store.save(config);
    const provider = await store.get('saved-provider');
    expect(provider).not.toBeNull();
  });

  it('save() writes provider config so list() can find it', async () => {
    const storage = new MemoryStorage();
    const store = new ProviderStore(storage);
    const config: ProviderConfig = {
      name: 'listed-provider',
      type: 'openai-compatible',
      baseUrl: 'http://listed.example/v1',
      defaultModel: 'listed-model',
    };
    await store.save(config);
    const result = await store.list();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('listed-provider');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/chris/source/javascript/legion-v2
npx vitest run packages/core/src/providers/ProviderStore.test.ts
```

Expected: FAIL with "Cannot find module './ProviderStore.js'"

- [ ] **Step 3: Implement `ProviderStore`**

Create `packages/core/src/providers/ProviderStore.ts`:

```typescript
import type { Storage } from '../storage/Storage.js';
import type { ProviderConfig } from '@legion/types';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';

export class ProviderStore {
  constructor(private storage: Storage) {}

  /**
   * Read provider config for `name` from storage and construct an
   * OpenAICompatibleProvider. Returns null if no config file exists.
   */
  async get(name: string): Promise<OpenAICompatibleProvider | null> {
    const config = await this.storage.readJson<ProviderConfig>(`providers/${name}.json`);
    if (!config) return null;
    return new OpenAICompatibleProvider(config.baseUrl, config.apiKeyEnv ?? config.credentialKey);
  }

  /** List all saved provider configs. */
  async list(): Promise<ProviderConfig[]> {
    const keys = await this.storage.list('providers/');
    const configs = await Promise.all(
      keys.map((k) => this.storage.readJson<ProviderConfig>(`providers/${k}`)),
    );
    return configs.filter((c): c is ProviderConfig => c !== null);
  }

  /** Persist a provider config so it can be resolved by `get()` and `list()`. */
  async save(config: ProviderConfig): Promise<void> {
    await this.storage.writeJson(`providers/${config.name}.json`, config);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/core/src/providers/ProviderStore.test.ts
```

Expected: 6 tests PASS

- [ ] **Step 5: Export `ProviderStore` from `packages/core/src/index.ts`**

Add after the `ProviderRegistry` export line (line 30):

```typescript
export * from './providers/ProviderStore.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers/ProviderStore.ts \
        packages/core/src/providers/ProviderStore.test.ts \
        packages/core/src/index.ts
git commit -m "feat(providers): add ProviderStore — reads provider config from storage on demand"
```

---

## Task 2: Wire `AgentRuntime` to use `ProviderStore`

**Files:**
- Modify: `packages/core/src/runtime/AgentRuntime.ts`
- Modify: `packages/core/src/runtime/AgentRuntime.test.ts`

- [ ] **Step 1: Update `AgentRuntime` to accept `ProviderStore`**

In `packages/core/src/runtime/AgentRuntime.ts`:

Replace the import of `ProviderRegistry`:
```typescript
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
```
With:
```typescript
import type { ProviderStore } from '../providers/ProviderStore.js';
```

Replace the constructor and provider-lookup:
```typescript
export class AgentRuntime implements Runtime {
  constructor(
    private participantId: string,
    private providerStore: ProviderStore,
  ) {}

  async handle(_incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    const participant = context.collective.getOrThrow(this.participantId);
    if (participant.type !== 'agent') return { kind: 'void' };
    const agent = participant as AgentConfig;

    const provider = await this.providerStore.get(agent.model.provider);
    if (!provider) {
      return {
        kind: 'response',
        content: `[AgentRuntime error: no provider registered for '${agent.model.provider}']`,
      };
    }
    // ... rest of handle() unchanged
```

- [ ] **Step 2: Run the full test suite to check for breakage**

```bash
npx vitest run packages/core
```

Expected: `AgentRuntime.test.ts` fails because `makeSetup` still passes a `ProviderRegistry`.

- [ ] **Step 3: Update `AgentRuntime.test.ts` to use `ProviderStore`**

In `packages/core/src/runtime/AgentRuntime.test.ts`:

Remove the `ProviderRegistry` import and add `ProviderStore`:
```typescript
// Remove:
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
// Add:
import { ProviderStore } from '../providers/ProviderStore.js';
```

Replace `makeSetup` to use a `ProviderStore` backed by a `MemoryStorage` that has the mock provider's config pre-written. Because `ProviderStore.get()` constructs a real `OpenAICompatibleProvider` from stored config, we need a different approach for injecting a mock provider. Create a `MockProviderStore` inline in the test file:

```typescript
// Add above makeSetup:
class MockProviderStore extends ProviderStore {
  constructor(private mockProviders: Map<string, import('../providers/Provider.js').Provider>) {
    super(new MemoryStorage());
  }

  override async get(name: string): Promise<import('../providers/OpenAICompatibleProvider.js').OpenAICompatibleProvider | null> {
    return (this.mockProviders.get(name) as any) ?? null;
  }
}
```

Update `makeSetup` to build a `MockProviderStore`:
```typescript
async function makeSetup(providerResponses: ProviderResponse[]) {
  const storage = new MemoryStorage();
  const conversationStore = new FileConversationStore(storage);

  const agentConfig: AgentConfig = {
    id: 'agent-1',
    name: 'Test Agent',
    type: 'agent',
    systemPrompt: 'You are a helpful assistant.',
    model: { provider: 'test', model: 'test-model' },
    tools: { echo: 'auto' },
    status: 'active',
  };
  await storage.writeJson('collective/participants/agent-1.json', agentConfig);
  const collective = await Collective.load(storage);

  const conv = await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  const thread = new ConversationThread(conv, conversationStore);
  const inbound = await thread.append({
    senderId: 'user-1',
    recipientId: 'agent-1',
    role: 'user',
    content: 'Hello, agent!',
  });

  const eventBus = new EventBus();

  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: 'echo',
    description: 'Echoes the input text',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(args) {
      const { text } = args as { text: string };
      return { status: 'success', data: text };
    },
  });

  let responseIndex = 0;
  const mockProvider: Provider = {
    async complete() {
      const resp = providerResponses[responseIndex++];
      return resp ?? { content: '[no more responses]', toolCalls: [], stopReason: 'stop' };
    },
  };
  const providerStore = new MockProviderStore(new Map([['test', mockProvider]]));

  const context = {
    participant: collective.getOrThrow('agent-1'),
    conversationId: conv.id,
    conversation: thread,
    collective,
    config: { version: '2' },
    eventBus,
    storage,
    workspaceRoot: '/tmp/test',
    communicationDepth: 0,
    toolRegistry,
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
  } as unknown as RuntimeContext;

  return { context, thread, eventBus, inbound, providerStore };
}
```

Update all test sites that destructure `providerRegistry` from `makeSetup` to use `providerStore` instead, and update `new AgentRuntime('agent-1', providerRegistry)` to `new AgentRuntime('agent-1', providerStore)`.

Also update the inline tests (`maxIterations`, `deny`, `requires_approval` describe blocks) that build their own `ProviderRegistry` to use `MockProviderStore` the same way. For each:

```typescript
// Before:
const providerRegistry = new ProviderRegistry();
providerRegistry.register('scripted', provider);
// ...
const runtime = new AgentRuntime('agent-1', providerRegistry);

// After:
const providerStore = new MockProviderStore(new Map([['scripted', provider]]));
// ...
const runtime = new AgentRuntime('agent-1', providerStore);
```

The "no provider registered" test becomes:
```typescript
it('returns an error message when no provider is registered for the agent model', async () => {
  const emptyStore = new MockProviderStore(new Map());
  const { context, inbound } = await makeSetup([]);
  const runtime = new AgentRuntime('agent-1', emptyStore);
  const result = await runtime.handle(inbound, context);
  expect((result as { kind: string; content: string }).content).toMatch(/no provider/i);
  expect((result as { kind: string; content: string }).content).toMatch(/test/);
});
```

The "provider throws" test becomes:
```typescript
it('returns a graceful error response when the provider throws', async () => {
  const throwingProvider: Provider = {
    async complete() {
      throw new TypeError('fetch failed');
    },
  };
  const providerStore = new MockProviderStore(new Map([['test', throwingProvider]]));
  const { context, inbound } = await makeSetup([]);
  const runtime = new AgentRuntime('agent-1', providerStore);
  const result = await runtime.handle(inbound, context);
  expect(result).toEqual({ kind: 'response', content: '[AgentRuntime error: fetch failed]' });
});
```

- [ ] **Step 4: Run core tests to verify they all pass**

```bash
npx vitest run packages/core
```

Expected: all tests PASS (same count as before)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/AgentRuntime.ts \
        packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "feat(runtime): AgentRuntime now resolves providers from ProviderStore instead of ProviderRegistry"
```

---

## Task 3: Update `runtime-tools.ts` to accept `ProviderStore`

**Files:**
- Modify: `packages/runtime/src/server/runtime-tools.ts`

- [ ] **Step 1: Update `RuntimeToolDeps` and the tool implementations**

Replace the contents of `packages/runtime/src/server/runtime-tools.ts`:

```typescript
import type { CredentialInfo, ToolResult } from '@legion/types';
import type { Tool, ProviderStore } from '@legion/core';

interface RuntimeToolDeps {
  providerStore: ProviderStore;
  credStore: { set(key: string, value: string): Promise<void>; list(): Promise<string[]> };
}

export function createRuntimeTools(deps: RuntimeToolDeps): Tool[] {
  const { providerStore, credStore } = deps;

  return [
    {
      name: 'list_providers',
      description: 'List all configured LLM provider instances.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          const configs = await providerStore.list();
          return { status: 'success', data: configs };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'configure_provider',
      description: 'Create or update a provider instance.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['openai-compatible', 'anthropic', 'copilot', 'codex'] },
          baseUrl: { type: 'string' },
          defaultModel: { type: 'string' },
          credentialKey: { type: 'string' },
        },
        required: ['name', 'type', 'defaultModel'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as import('@legion/types').ProviderConfig;
          await providerStore.save(args);
          return { status: 'success', data: args };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'list_credentials',
      description: 'List credential key names and metadata. Values are never returned.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          // Re-use the storage from providerStore is not possible; credentials use a
          // separate credStore. This tool is unchanged in behaviour.
          // credStore.list() is not available — list via the injected storage directly.
          // NOTE: list_credentials is unchanged; it still needs `storage` access.
          // See implementation note below — we keep storage in deps for credentials only.
          throw new Error('list_credentials requires storage dep — see implementation note');
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'set_credential_with_meta',
      description: 'Set a named credential and update its metadata record.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          usedBy: { type: 'array', items: { type: 'string' } },
        },
        required: ['key', 'value'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as { key: string; value: string; usedBy?: string[] };
          await credStore.set(args.key, args.value);
          throw new Error('set_credential_with_meta requires storage dep — see implementation note');
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ] satisfies Tool[];
}
```

**Implementation note:** `list_credentials` and `set_credential_with_meta` still need access to raw `Storage` for the `credential-meta/` prefix. Keep `storage` in the deps alongside `providerStore`. The correct updated `RuntimeToolDeps` and full implementation is:

```typescript
import type { CredentialInfo, ProviderConfig, ToolResult } from '@legion/types';
import type { Storage, Tool, ProviderStore } from '@legion/core';

interface RuntimeToolDeps {
  storage: Storage;
  providerStore: ProviderStore;
  credStore: { set(key: string, value: string): Promise<void>; list(): Promise<string[]> };
}

export function createRuntimeTools(deps: RuntimeToolDeps): Tool[] {
  const { storage, providerStore, credStore } = deps;

  return [
    {
      name: 'list_providers',
      description: 'List all configured LLM provider instances.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          const configs = await providerStore.list();
          return { status: 'success', data: configs };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'configure_provider',
      description: 'Create or update a provider instance.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['openai-compatible', 'anthropic', 'copilot', 'codex'] },
          baseUrl: { type: 'string' },
          defaultModel: { type: 'string' },
          credentialKey: { type: 'string' },
        },
        required: ['name', 'type', 'defaultModel'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as ProviderConfig;
          await providerStore.save(args);
          return { status: 'success', data: args };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'list_credentials',
      description: 'List credential key names and metadata. Values are never returned.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          const keys = await storage.list('credential-meta/');
          const infos = await Promise.all(
            keys.map((k) => storage.readJson<CredentialInfo>(`credential-meta/${k}`)),
          );
          return { status: 'success', data: infos.filter(Boolean) };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'set_credential_with_meta',
      description: 'Set a named credential and update its metadata record.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          usedBy: { type: 'array', items: { type: 'string' } },
        },
        required: ['key', 'value'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as { key: string; value: string; usedBy?: string[] };
          await credStore.set(args.key, args.value);
          const masked = '••••' + args.value.slice(-4);
          await storage.writeJson(`credential-meta/${args.key}.json`, {
            key: args.key,
            maskedValue: masked,
            usedBy: args.usedBy ?? [],
            updatedAt: Date.now(),
          } satisfies CredentialInfo);
          return { status: 'success', data: { key: args.key } };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ] satisfies Tool[];
}
```

- [ ] **Step 2: Build to check for type errors**

```bash
cd /home/chris/source/javascript/legion-v2
npx tsc --build --force 2>&1 | head -40
```

Expected: errors in `LegionProcess.ts` because `createRuntimeTools` call still passes old deps — that's fine, fixed in Task 4.

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/src/server/runtime-tools.ts
git commit -m "feat(runtime-tools): delegate list_providers/configure_provider to ProviderStore"
```

---

## Task 4: Update `LegionProcess` — migrate config, wire `ProviderStore`

**Files:**
- Modify: `packages/runtime/src/LegionProcess.ts`

- [ ] **Step 1: Update imports**

In `packages/runtime/src/LegionProcess.ts`, update the `@legion/core` import block.

Remove `ProviderRegistry` and `OpenAICompatibleProvider` from the import, add `ProviderStore`:

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
  ProviderStore,
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
```

- [ ] **Step 2: Replace provider wiring in `LegionProcess.start()`**

Replace lines 142–154 (the `ProviderRegistry` build block and the agent factory) with:

```typescript
    // ── Step 8b: Migrate providers from config.json → .legion/providers/ ──────
    if (workspaceConfig.providers) {
      for (const [name, config] of Object.entries(workspaceConfig.providers)) {
        const fileKey = `providers/${name}.json`;
        const alreadyExists = await storage.exists(fileKey);
        if (!alreadyExists) {
          await storage.writeJson(fileKey, { ...config, name });
        }
      }
    }

    // ── Step 8c: Create ProviderStore ─────────────────────────────────────────
    const providerStore = new ProviderStore(storage);

    // Register agent factory
    runtimeRegistry.registerFactory('agent', (id) => {
      return new AgentRuntime(id, providerStore);
    });
```

- [ ] **Step 3: Update `createRuntimeTools` call to pass `providerStore`**

Line 110 currently reads:
```typescript
    const runtimeTools = createRuntimeTools({ storage, credStore: credentials });
```

Replace with:
```typescript
    const runtimeTools = createRuntimeTools({ storage, providerStore, credStore: credentials });
```

- [ ] **Step 4: Build cleanly**

```bash
cd /home/chris/source/javascript/legion-v2
npx tsc --build --force 2>&1
```

Expected: zero errors

- [ ] **Step 5: Run the full test suite**

```bash
npx vitest run
```

Expected: all tests pass (326+6 new ProviderStore tests)

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts
git commit -m "feat(process): migrate config.json providers on startup; wire ProviderStore to AgentRuntime and runtime-tools"
```

---

## Task 5: Verify end-to-end and clean up

- [ ] **Step 1: Run typecheck one more time**

```bash
cd /home/chris/source/javascript/legion-v2
npx tsc --build --force
```

Expected: zero errors

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass, 0 failures

- [ ] **Step 3: Check prettier**

```bash
npx prettier --check packages/core/src/providers/ProviderStore.ts \
                      packages/core/src/providers/ProviderStore.test.ts \
                      packages/core/src/runtime/AgentRuntime.ts \
                      packages/core/src/runtime/AgentRuntime.test.ts \
                      packages/runtime/src/server/runtime-tools.ts \
                      packages/runtime/src/LegionProcess.ts
```

If any files fail, run:

```bash
npx prettier --write packages/core/src/providers/ProviderStore.ts \
                     packages/core/src/providers/ProviderStore.test.ts \
                     packages/core/src/runtime/AgentRuntime.ts \
                     packages/core/src/runtime/AgentRuntime.test.ts \
                     packages/runtime/src/server/runtime-tools.ts \
                     packages/runtime/src/LegionProcess.ts
git add -u
git commit -m "style: prettier formatting for provider unification changes"
```

- [ ] **Step 4: Verify `.legion/providers/LM Studio.json` exists and `.legion/config.json` providers block is now inert**

```bash
cat /home/chris/source/javascript/legion-v2/.legion/providers/LM\ Studio.json
```

Expected: the existing provider file is present (the startup migration will skip writing it since the file already exists).

The `providers` block in `.legion/config.json` can be removed manually at any time — it is now ignored by the runtime.
