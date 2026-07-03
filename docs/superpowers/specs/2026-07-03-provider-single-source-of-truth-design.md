# Provider Single Source of Truth

**Date:** 2026-07-03  
**Status:** Approved

## Problem

There are two separate provider configuration stores that are completely disconnected:

1. **`.legion/config.json`** (`providers` key) — read once at process startup in `LegionProcess.ts` to populate the in-memory `ProviderRegistry` used by `AgentRuntime` to call LLMs. Never written to by the web UI.

2. **`.legion/providers/<name>.json`** — written by the web UI via `configure_provider` tool, read by `list_providers` tool. Never read at startup. Never seen by `AgentRuntime`.

The result: changes made through the web UI have no effect on running agents. The agent runtime and the UI are operating on different data.

## Goal

- Single source of truth: `.legion/providers/<name>.json`
- Provider changes made in the web UI take effect immediately (hot-reload, no server restart required)
- Migrate any providers defined in `config.json` to `.legion/providers/` on startup

## Approach: `ProviderStore` reads from disk per call

`AgentRuntime` stops receiving a `ProviderRegistry` and instead receives a `ProviderStore` that reads `.legion/providers/<name>.json` on each invocation. Because the file is read per-call, any change made through the web UI is immediately visible to the next agent invocation.

## Architecture

**Single source of truth:** `.legion/providers/<name>.json` — one JSON file per provider, already the format written by the web UI.

**`ProviderStore`** (new class, `packages/core/src/providers/ProviderStore.ts`): thin wrapper around `FileStorage` with three methods:
- `get(name): Promise<OpenAICompatibleProvider | null>` — reads `providers/<name>.json`, constructs and returns a provider instance; returns `null` if not found
- `list(): Promise<ProviderConfig[]>` — enumerates all provider files
- `save(config: ProviderConfig): Promise<void>` — writes the file

**`ProviderRegistry`**: retired from the production runtime path. Kept in the codebase for use as an in-memory stub in unit tests.

**`config.json` providers block**: deprecated. At startup, entries are migrated to `.legion/providers/<name>.json` if a file does not already exist. The block is then ignored; no automatic deletion.

## Component Changes

| File | Change |
|---|---|
| `packages/core/src/providers/ProviderStore.ts` | **New.** `get()`, `list()`, `save()` wrapping `FileStorage` |
| `packages/core/src/runtime/AgentRuntime.ts` | Constructor: `ProviderRegistry` → `ProviderStore`. `handle()`: calls `providerStore.get()` instead of `providerRegistry.get()` |
| `packages/runtime/src/LegionProcess.ts` | Startup: migrate `workspaceConfig.providers` to `.legion/providers/`. Construct `ProviderStore`, pass to `AgentRuntime` factory instead of `ProviderRegistry` |
| `packages/runtime/src/server/runtime-tools.ts` | `list_providers` and `configure_provider` delegate to `providerStore` instead of calling `FileStorage` directly. `providerStore` is passed in as a parameter to the `createRuntimeTools(storage, providerStore)` factory (or equivalent wiring from `LegionProcess`) |
| `packages/core/src/providers/ProviderRegistry.ts` | No deletion; kept for test use only |

## Data Flow

### Provider creation (web UI)

```
User submits ProviderSlideOver form
  → execute('configure_provider', { name, type, baseUrl, ... })
  → POST /api/execute
  → runtime-tools.ts configure_provider handler
  → providerStore.save(config)
  → FileStorage.writeJson('providers/<name>.json', config)
  → .legion/providers/<name>.json written to disk
```

### Provider resolution (agent call)

```
AgentRuntime.handle()
  → providerStore.get(agent.model.provider)
  → FileStorage.readJson('providers/<name>.json')
  → new OpenAICompatibleProvider(config.baseUrl, config.credentialKey)
  → provider.complete(messages, tools, model)
```

### Startup migration

```
LegionProcess starts
  → loadWorkspaceConfig() reads .legion/config.json
  → for each entry in workspaceConfig.providers:
      if FileStorage file 'providers/<name>.json' does not exist:
        FileStorage.writeJson('providers/<name>.json', config)
  → new ProviderStore(storage) constructed
  → AgentRuntime factory wired with providerStore
  → workspaceConfig.providers block ignored after this point
```

## Error Handling

No changes to error shapes. `ProviderStore.get()` returns `null` when a file is not found. `AgentRuntime.handle()` returns `{ kind: 'response', content: '[AgentRuntime error: no provider "<name>"]' }` — identical to the current registry-miss behavior. This follows the established pattern: all runtime errors are `kind: 'response'` with bracketed diagnostic text; there is no `kind: 'error'` variant in the codebase.

## Testing

**`ProviderStore.test.ts`** (new):
- `get()` returns a constructed `OpenAICompatibleProvider` when file exists
- `get()` returns `null` when file is missing
- `save()` writes correct JSON to storage
- `list()` returns all provider configs

**`AgentRuntime.test.ts`** (update):
- Replace `ProviderRegistry` with a mock/stub `ProviderStore` in test setup
- Existing behavior tests remain valid; only the injected dependency changes

## Migration Notes

- `.legion/providers/LM Studio.json` already exists on disk (the web UI has already written it)
- `.legion/config.json` still has a `providers` block — startup migration will detect the existing file and skip writing it again (no overwrite)
- The `providers` block in `config.json` can be removed manually at any time after the change ships; it will be silently ignored by the new code
