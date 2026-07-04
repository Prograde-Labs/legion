# Provider & Model Routing Overhaul

**Date:** 2026-07-03
**Status:** Approved

## Problem

The current provider/credential system has several compounding issues:

1. **Split setup flow** — configuring a provider requires two separate actions: create a credential, then create a provider and link it by credential key name. Not atomic, not intuitive.
2. **Workspace-scoped providers** — providers live in `.legion/providers/<name>.json`, tied to a specific workspace. Can't be shared across projects.
3. **Provider-locked agents** — `ModelConfig.provider` is a required string name. Agent configs are not portable between users or systems with different provider names.
4. **No model routing** — if you have Anthropic and Copilot both able to serve `claude-sonnet-4-5`, there is no way to express a preference or fallback. The agent is hardcoded to one provider.
5. **Dead abstractions** — `ProviderRegistry` is never used at runtime. `defaultModel` on `ProviderConfig` has no routing purpose.
6. **Credential/provider split in UI** — two tabs, two forms, manual linking. Poor UX.

## Goal

- Single atomic provider setup: name, type, base URL, API key — one form, one save
- Providers stored at system level (`~/.config/legion/`), shared across all workspaces
- Agents reference models by ID only — no provider name in agent config
- Priority-ordered model routing at system and workspace level
- Workspace local overrides via gitignored `config.local.json`
- Provider interface extended to support live model discovery
- UI: unified provider management, model routing config, agent model picker as searchable dropdown

## Approach: Layered

1. Type system — new shapes, remove dead fields
2. Storage — system-level `SystemProviderStore`, local config loading
3. Provider interface — add optional `listModels()`
4. Model routing — `ModelRouter` resolving model ID → provider
5. UI — unified provider form, routing config, agent model picker

---

## Section 1: Type System

### `ProviderConfig`

Stored at `~/.config/legion/providers/<name>.json`. One file per provider.

```ts
interface ProviderConfig {
  name: string;           // user-defined display name, used in routing config
  type: 'openai-compatible' | 'anthropic' | 'copilot' | 'codex';
  baseUrl?: string;       // required for openai-compatible; optional for others
  apiKey?: string;        // plaintext inline — no separate credential store
  auth?: OAuthToken;      // copilot/codex — future; OAuthToken type defined when OAuth is implemented
  priority: number;       // system-level ranking; lower number = higher priority
}
```

**Removed from `ProviderConfig`:** `defaultModel`, `credentialKey`, `apiKeyEnv`.

### `ProviderModel`

Returned by `Provider.listModels()`. Not persisted — always fetched live.

```ts
interface ProviderModel {
  id: string;                         // "claude-sonnet-4-5"
  name?: string;                      // display name if different from id
  contextWindow?: number;
  inputCostPer1kTokens?: number;      // USD, informational only
  outputCostPer1kTokens?: number;     // USD, informational only
  capabilities?: ('vision' | 'tools' | 'json_mode')[];
}
```

### `ModelConfig`

Used in `AgentConfig`. Provider reference removed entirely.

```ts
interface ModelConfig {
  model: string;          // "claude-sonnet-4-5"
  temperature?: number;
  maxTokens?: number;
  // baseUrl and apiKeyEnv removed — provider owns these
}
```

**Removed from `ModelConfig`:** `provider`, `baseUrl`, `apiKeyEnv`.

### `RoutingConfig`

Per-model ordered provider priority lists. Present at both system and workspace level.

```ts
interface RoutingConfig {
  models?: Record<string, string[]>;
  // key: model id, value: ordered provider names (highest priority first)
  // e.g. { "claude-sonnet-4-5": ["Copilot", "My Anthropic"] }
}
```

### `WorkspaceConfig` changes

- `providers` field removed (no longer valid — compile error if present)
- `defaultModel` field removed
- `routing` field **not** added — routing is local-only, never tracked

### `LocalConfig`

Shape of `.legion/config.local.json`. Full override layer over `WorkspaceConfig`, plus routing.

```ts
interface LocalConfig extends Partial<WorkspaceConfig> {
  routing?: RoutingConfig;
}
```

`routing` is only valid in `LocalConfig`, not `WorkspaceConfig`. Type system enforces this.

### System config

`~/.config/legion/config.json` — new file, system-level defaults.

```ts
interface SystemConfig {
  routing?: RoutingConfig;  // system-level routing defaults
  // extensible for future system-level settings
}
```

---

## Section 2: Storage

### Directory layout

```
~/.config/legion/
  config.json                    # SystemConfig — routing defaults
  providers/
    <name>.json                  # ProviderConfig per provider

<workspace>/.legion/
  config.json                    # WorkspaceConfig — tracked, no provider/routing fields
  config.local.json              # LocalConfig — gitignored, full override + routing
  collective/participants/*.json  # AgentConfig — no provider field
```

### `SystemProviderStore`

Replaces current `ProviderStore` as the runtime source of truth.

```ts
class SystemProviderStore {
  get(name: string): Promise<Provider | null>;
  list(): Promise<ProviderConfig[]>;
  save(config: ProviderConfig): Promise<void>;
  delete(name: string): Promise<void>;
}
```

Reads/writes `~/.config/legion/providers/<name>.json`. Constructs provider instances by type:
- `openai-compatible` / `anthropic` → `OpenAICompatibleProvider(config.baseUrl, config.apiKey)`
- `copilot` / `codex` → throws `NotImplementedError` (placeholder for future OAuth implementations)

### Workspace `ProviderStore`

The existing workspace-level `ProviderStore` is **deleted**. No migration — workspace `.legion/providers/` directory is abandoned. Users reconfigure providers at system level.

### `.gitignore`

`LegionProcess` ensures `.legion/config.local.json` is present in `.legion/.gitignore` on startup (creates the gitignore entry if missing).

### Config loading in `LegionProcess`

```
1. Load ~/.config/legion/config.json → SystemConfig
2. Load <workspace>/.legion/config.json → WorkspaceConfig
3. Load <workspace>/.legion/config.local.json → LocalConfig (missing = empty)
4. Deep-merge: WorkspaceConfig ← LocalConfig (local wins on conflict)
5. Extract workspace routing: LocalConfig.routing (may be undefined — treated as empty)
6. Pass SystemConfig.routing + LocalConfig.routing to ModelRouter constructor
```

---

## Section 3: Provider Interface

```ts
interface Provider {
  complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Promise<ProviderResponse>;

  listModels?(): Promise<ProviderModel[]>;
}
```

`listModels()` is optional. Providers that do not implement it cannot be auto-resolved by the router — they are only reachable via explicit routing config.

### `OpenAICompatibleProvider`

Implements `listModels()` by calling `GET <baseUrl>/models`. Merges live results with embedded static data for known providers (OpenAI, Anthropic) to populate cost and capability fields not returned by the API.

Static data is embedded in the provider implementation as a lookup table keyed by model ID. Live `/models` response is the source of truth for which models exist; static data fills in pricing/capabilities where available.

Constructor updated: `new OpenAICompatibleProvider(baseUrl, apiKey)` — no more `apiKeyEnv`. API key is passed directly, not read from `process.env`.

### `ProviderRegistry`

Deleted. No longer referenced anywhere.

---

## Section 4: Model Routing

### `ModelRouter`

```ts
class ModelRouter {
  constructor(
    private systemStore: SystemProviderStore,
    private systemRouting: RoutingConfig,
    private workspaceRouting: RoutingConfig,
  ) {}

  async resolve(modelId: string): Promise<Provider | null>;
}
```

### Resolution algorithm

For a given `modelId`:

1. Check `workspaceRouting.models[modelId]` — if present, use that ordered provider name list
2. Otherwise check `systemRouting.models[modelId]` — if present, use that ordered provider name list
3. Otherwise: get all providers from `systemStore.list()`, filter to those where `listModels()` returns a list containing `modelId`, sort by `priority` ascending
4. Providers without `listModels()` are **never** auto-resolved — only reachable via step 1 or 2
5. Return the first resolvable provider, or `null` if none found

### `AgentRuntime` change

Receives `ModelRouter` instead of `ProviderStore`.

```ts
// Before
const provider = await this.providerStore.get(agent.model.provider);

// After
const provider = await this.router.resolve(agent.model.model);
```

Error message when no provider found: `[AgentRuntime error: no provider available for model '<modelId>']`

---

## Section 5: UI

### Provider management (replaces current two-tab Providers + Credentials)

**Provider list:**
- Single "Providers" tab — no separate Credentials tab
- Columns: name, type badge, priority, model count (from `listModels()` if available), edit/delete
- Drag-to-reorder rows updates `priority` field
- "Add Provider" button opens slideout

**Provider slideout (add/edit):**
- Fields: name, type (dropdown), base URL (shown only for `openai-compatible`), API key (password input, masked after save)
- On save: calls `save_provider` tool
- After save: calls `list_models` for that provider in background, updates model count in list

### Model routing (new tab)

Two sections, clearly labeled:

**System routing** — reads/writes `~/.config/legion/config.json` via `get_routing` / `save_routing` tools
**Workspace routing** — reads/writes `.legion/config.local.json`, labeled "Local only — not tracked by git"

Each section: per-model rows showing model ID and ordered provider list. Drag to reorder providers within a model row. Add model row button. Remove button per row.

### Agent config UI

**Model field:**
- Replaced with searchable dropdown
- Populated from `list_models` (all models across all providers that have `listModels()`)
- Grouped by provider or sorted alphabetically — implementation detail
- "Filter by provider" control narrows the dropdown list (not saved to config — UI-only)
- Free-text entry still allowed for models not in discovery results

**Provider field:** removed entirely from agent config form.

### New runtime tools

| Tool | Description |
|------|-------------|
| `list_providers` | List all system-level providers (reads `SystemProviderStore`) |
| `save_provider` | Create or update a provider (writes to system store, includes `apiKey`) |
| `delete_provider` | Remove a provider by name |
| `list_models` | Call `listModels()` on one or all providers, return merged results |
| `get_routing` | Return system routing + workspace routing (merged, labeled by source) |
| `save_routing` | Write routing config to system (`~/.config/legion/config.json`) or workspace (`config.local.json`) |

**Removed tools:** `configure_provider`, `list_credentials`, `set_credential_with_meta`.

---

## Error Handling

- `ModelRouter.resolve()` returns `null` — never throws. Caller (`AgentRuntime`) surfaces as a `kind: 'response'` error message to the conversation.
- `SystemProviderStore.get()` returns `null` when provider file missing.
- `OpenAICompatibleProvider.listModels()` returns `[]` on network error or non-200 response — does not throw. Provider is effectively invisible to auto-routing if models can't be fetched.
- `save_provider` / `delete_provider` tools return `{ status: 'error', error: string }` on failure — consistent with existing tool error shape.

---

## Testing

**`SystemProviderStore.test.ts`** (new):
- `get()` returns constructed provider when file exists
- `get()` returns `null` when file missing
- `save()` writes correct JSON
- `delete()` removes file
- `list()` returns all configs

**`ModelRouter.test.ts`** (new):
- Workspace routing takes precedence over system routing
- System routing used when no workspace routing for model
- Auto-resolution uses `listModels()` + priority sort
- Provider without `listModels()` not auto-resolved
- Returns `null` when no provider can serve model

**`OpenAICompatibleProvider.test.ts`** (update):
- `listModels()` merges live response with static data
- `listModels()` returns `[]` on network error
- `complete()` uses `apiKey` directly (not env var)

**`AgentRuntime.test.ts`** (update):
- Replace `ProviderStore` stub with `ModelRouter` stub
- Error message when router returns `null`

---

## Migration Notes

- Existing `.legion/providers/*.json` files: abandoned, not read. Users reconfigure at system level.
- Existing `.legion/config.json` `providers` block: ignored (field removed from type, deep-merge skips unknown fields).
- `ProviderRegistry` class: deleted.
- `FileCredentialStore` API key storage (`scheme: 'raw'`): removed from use. User-auth password hashing (argon2id) remains — `FileCredentialStore` kept for auth only.
- Agent participant files with `model.provider` or `model.apiKeyEnv`: `provider` field silently ignored at runtime (removed from `ModelConfig` type); agents will route via `ModelRouter` instead.
