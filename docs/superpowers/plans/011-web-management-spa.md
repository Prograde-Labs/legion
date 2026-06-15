# Vue Management SPA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@legion/web` Vue 3 + Vite + Tailwind management console SPA and the backend tools it requires. End state: a built `packages/web/dist/` served by `@legion/runtime`'s WebConnector; operators can manage participants, monitor conversations, stream live events, and configure providers and credentials.

**Architecture:** `@legion/web` depends on `@legion/types` only — no Node-coupled engine code in the browser bundle. All collective operations are tool calls via `POST /api/execute`. Live state arrives via the WebSocket event stream. State management uses singleton composables (no Pinia); auth token persisted in `localStorage` via VueUse. Six new backend management tools added to `@legion/core` and `@legion/runtime`. Agent config persisted to `Storage` at `agents/<id>.json` so `modify_agent` can reconstruct runtimes.

**Tech stack:** Vue 3 (`<script setup>`), Vite 5, Tailwind CSS v4 (`@tailwindcss/vite`), Vue Router 4, VueUse 11, `@vue/test-utils` 2, Vitest 2, happy-dom.

**Depends on:** Plans 1–10 complete.

**Design spec:** `docs/superpowers/specs/2026-06-14-plan11-web-spa-design.md`
**Mockups:** `docs/mockups/` (login, participants, conversations, event-stream, configuration)

---

## What is NOT new in this plan

| Item | Where | Plan |
|------|-------|------|
| `Storage.list(prefix)` | `@legion/core/src/storage/Storage.ts` | 1 |
| `LegionEventMap` base events | `@legion/types/src/events.ts` | 1 (amended 7, 10) |
| `Collective`, `BOOTSTRAP_OPERATOR_ID` | `@legion/core/src/collective/` | 3 |
| `ToolRegistry`, `AuthEngine` | `@legion/core/src/tools/` | 4 |
| `create_agent`, `retire_agent`, `list_participants`, `get_conversation`, `set_credential` | `@legion/core/src/tools/management-tools.ts` | 4 |
| `RuntimeRegistry` | `@legion/core/src/runtime/` | 5 |
| `AgentRuntime`, `ProviderRegistry` | `@legion/core/src/runtime/` | 6 |
| `WebConnector` `POST /api/execute`, `GET /ws` | `@legion/runtime/src/server/` | 10 |
| `packages/web/package.json` placeholder | `packages/web/package.json` | 1 |

---

## Decisions locked in

- **Auth token:** `useLocalStorage('legion-token', null)` — persists across page refresh. Acceptable for localhost management console.
- **Router mode:** `createWebHashHistory()` — avoids Fastify needing a catch-all route for SPA fallback.
- **State:** Singleton composables with module-level `reactive()`. `useAuth`, `useEventStream`, `useExecute` are shared singletons.
- **WS auth:** First message `{ type: 'auth', token }` per Plan 10 protocol. Reconnect with exponential back-off (1 s → 2 s → 4 s, max 30 s).
- **`modify_agent`:** Reads/writes agent config at `agents/<id>.json` in the workspace `Storage`. `create_agent` is amended to write this file on creation.
- **`configure_provider`:** Persists provider config at `providers/<name>.json`. `LegionProcess` loads these on startup in addition to any static config.
- **Tool renderer registry:** `Map<RegExp, Component>` checked in order; last entry is always `/.*/` → `JsonRenderer`.
- **`packages/web` excluded from root vitest:** Web tests run via `packages/web/vitest.config.ts` with `happy-dom`. Root vitest excludes `packages/web`.

---

## Amendments to prior plans

### Amendment A — Plan 1: `LegionEventMap` new events

Add to `packages/types/src/events.ts`:

```typescript
'participant:active':  { participantId: string };
'participant:retired': { participantId: string };
```

Emit `participant:active` in `Collective.seed()` after each participant is registered.
Emit `participant:retired` in `Collective.retire(id)` after marking retired.

### Amendment B — Plan 3: `Collective.modify()`

Add to `packages/core/src/collective/Collective.ts`:

```typescript
modify(id: string, updates: { name?: string }): Participant {
  const p = this.getOrThrow(id);
  if (updates.name !== undefined) p.name = updates.name;
  return p;
}
```

### Amendment C — Plan 4: `create_agent` persists config

After creating the participant and registering the runtime, `create_agent` must write:

```typescript
await storage.writeJson(`agents/${participant.id}.json`, {
  name: args.name,
  model: args.model,
  systemPrompt: args.systemPrompt ?? '',
  maxIterations: args.maxIterations ?? 20,
  providerId: args.providerId ?? 'default',
});
```

### Amendment D — Plan 1: root `tsconfig.json`

Add `packages/web` reference:

```json
{ "path": "packages/web" }
```

### Amendment E — Plan 1: root `vitest.config.ts`

Add exclude so web tests don't run in the node environment:

```typescript
exclude: ['packages/web/**', 'node_modules/**'],
```

---

## File structure

```
packages/web/
  index.html
  package.json                        — Vue + Vite + Tailwind deps (replaces placeholder)
  vite.config.ts
  vitest.config.ts
  tsconfig.json
  src/
    main.ts
    App.vue
    assets/style.css                  — @import "tailwindcss" + @theme custom colours
    router/index.ts                   — routes + auth guard
    composables/
      useAuth.ts                      — singleton: token, participantId, login, logout
      useExecute.ts                   — typed POST /api/execute wrapper
      useEventStream.ts               — singleton WebSocket, reconnect, subscribe
    views/
      LoginView.vue
      ParticipantsView.vue
      ConversationsView.vue
      EventStreamView.vue
      ConfigView.vue
    components/
      layout/
        AppSidebar.vue
        AppLayout.vue
      common/
        SlideOver.vue
        StatusDot.vue
        TypeBadge.vue
      participants/
        ParticipantTable.vue
        ParticipantSlideOver.vue
        ToolPolicyEditor.vue
      conversations/
        ConversationList.vue
        ConversationThread.vue
        MessageBlock.vue
        ToolCallBlock.vue
        SubThreadBlock.vue            — recursive: renders nested delegation threads
      events/
        EventTable.vue
        EventDetailPanel.vue
      config/
        ProviderTable.vue
        ProviderSlideOver.vue
        CredentialTable.vue
        CredentialSlideOver.vue
    renderers/
      index.ts                        — registry Map<RegExp, Component> + lookup()
      ToolResultRenderer.vue          — dispatcher
      JsonRenderer.vue
      SearchResultRenderer.vue
      FileTreeRenderer.vue
      FileContentsRenderer.vue
```

Also modified:
- `packages/core/src/tools/management-tools.ts` — add `modify_agent`, `list_tools`, `list_conversations`
- `packages/runtime/src/server/runtime-tools.ts` — new file: `list_providers`, `configure_provider`, `list_credentials`
- `packages/runtime/src/index.ts` — export new tools
- `packages/types/src/events.ts` — Amendment A
- `packages/core/src/collective/Collective.ts` — Amendment B
- Root `tsconfig.json` + `vitest.config.ts` — Amendments D, E

---

## Task 1: `@legion/web` package scaffold

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/vite.config.ts`
- Create: `packages/web/vitest.config.ts`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/index.html`
- Create: `packages/web/src/assets/style.css`
- Create: `packages/web/src/main.ts` (stub)
- Create: `packages/web/src/App.vue` (stub)
- Modify: `tsconfig.json` (root)
- Modify: `vitest.config.ts` (root)

- [ ] **Step 1: Replace `packages/web/package.json`**

```json
{
  "name": "@legion/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@legion/types": "*",
    "@vueuse/core": "^11.0.0",
    "vue": "^3.4.0",
    "vue-router": "^4.3.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@vitejs/plugin-vue": "^5.0.0",
    "@vue/test-utils": "^2.4.0",
    "happy-dom": "^14.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.0.0",
    "vitest": "^2.0.0",
    "vue-tsc": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/web/vite.config.ts`**

```typescript
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), vue()],
  build: { outDir: 'dist' },
});
```

- [ ] **Step 3: Create `packages/web/vitest.config.ts`**

```typescript
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'happy-dom',
  },
});
```

- [ ] **Step 4: Create `packages/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.vue"],
  "references": [{ "path": "../types" }]
}
```

- [ ] **Step 5: Create `packages/web/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Legion</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `packages/web/src/assets/style.css`**

```css
@import "tailwindcss";

@theme {
  --color-navy-950: #060d1a;
  --color-navy-900: #0a1220;
  --color-navy-800: #0d1a30;
  --color-navy-700: #162035;
  --color-navy-600: #1e3a5f;
  --color-navy-500: #2d4a6a;
  --color-navy-400: #4b6a8a;
}
```

- [ ] **Step 7: Create stub `packages/web/src/main.ts`**

```typescript
import './assets/style.css';
import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
```

- [ ] **Step 8: Create stub `packages/web/src/App.vue`**

```vue
<script setup lang="ts"></script>
<template><div class="bg-navy-950 min-h-screen text-slate-200">Legion</div></template>
```

- [ ] **Step 9: Apply Amendment D — add `packages/web` to root `tsconfig.json`**

```json
{
  "files": [],
  "references": [
    { "path": "packages/types" },
    { "path": "packages/core" },
    { "path": "packages/runtime" },
    { "path": "packages/web" }
  ]
}
```

- [ ] **Step 10: Apply Amendment E — update root `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/**/src/**/*.test.ts', 'packages/**/src/**/*.integration.test.ts'],
    exclude: ['packages/web/**', 'node_modules/**'],
    environment: 'node',
  },
});
```

- [ ] **Step 11: Install dependencies and verify build**

```bash
npm install
cd packages/web && npm run build
```

Expected: Vite builds `packages/web/dist/` with no errors. `index.html` present in dist.

- [ ] **Step 12: Commit**

```bash
git add packages/web package-lock.json tsconfig.json vitest.config.ts
git commit -m "feat(web): scaffold @legion/web package with Vite + Tailwind v4 + Vue Router"
```

---

## Task 2: Amendments to prior plans

**Files:**
- Modify: `packages/types/src/events.ts`
- Modify: `packages/core/src/collective/Collective.ts`
- Modify: `packages/core/src/tools/management-tools.ts` (create_agent config persistence only)

- [ ] **Step 1: Apply Amendment A — add participant events to `packages/types/src/events.ts`**

Add two entries inside the `LegionEventMap` interface:

```typescript
'participant:active':  { participantId: string };
'participant:retired': { participantId: string };
```

- [ ] **Step 2: Write failing test for `participant:active` emission**

Add to `packages/core/src/collective/Collective.test.ts`:

```typescript
it('emits participant:active when seed() registers a participant', async () => {
  const bus = new EventBus();
  const collective = new Collective(bus);
  const seen: string[] = [];
  bus.on('participant:active', (p) => seen.push(p.participantId));
  await collective.seed([{ id: 'p1', name: 'alpha', type: 'agent', status: 'active' }]);
  expect(seen).toEqual(['p1']);
});

it('emits participant:retired when retire() is called', async () => {
  const bus = new EventBus();
  const collective = new Collective(bus);
  await collective.seed([{ id: 'p1', name: 'alpha', type: 'agent', status: 'active' }]);
  const seen: string[] = [];
  bus.on('participant:retired', (p) => seen.push(p.participantId));
  await collective.retire('p1');
  expect(seen).toEqual(['p1']);
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
npx vitest run packages/core/src/collective/Collective.test.ts
```

Expected: FAIL — events not yet emitted.

- [ ] **Step 4: Apply Amendment B — add `modify()` and emit events in `Collective.ts`**

In `seed()`, after registering each participant:
```typescript
this.eventBus.emit('participant:active', { participantId: p.id });
```

In `retire(id)`:
```typescript
this.eventBus.emit('participant:retired', { participantId: id });
```

Add `modify()` method:
```typescript
modify(id: string, updates: { name?: string }): Participant {
  const p = this.getOrThrow(id);
  if (updates.name !== undefined) p.name = updates.name;
  return p;
}
```

- [ ] **Step 5: Run tests to verify passing**

```bash
npx vitest run packages/core/src/collective/Collective.test.ts
```

Expected: all tests PASS including the two new ones.

- [ ] **Step 6: Write failing test for `create_agent` config persistence**

Add to `packages/core/src/tools/management-tools.test.ts`:

```typescript
it('create_agent writes agent config to storage', async () => {
  const storage = new MemoryStorage();
  const deps = buildTestDeps({ storage });
  await invokeManagementTool('create_agent', {
    name: 'bot-1', model: 'gpt-4o', providerId: 'openai',
  }, deps);
  const ids = await storage.list('agents/');
  expect(ids.length).toBe(1);
  const config = await storage.readJson<{ model: string }>(ids[0]!);
  expect(config?.model).toBe('gpt-4o');
});
```

- [ ] **Step 7: Run to verify it fails**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "create_agent writes"
```

Expected: FAIL.

- [ ] **Step 8: Apply Amendment C — persist config in `create_agent`**

In `create_agent`'s execute function, after registering the runtime:

```typescript
await deps.storage.writeJson(`agents/${participant.id}.json`, {
  name: args.name as string,
  model: (args.model as string) ?? 'gpt-4o',
  systemPrompt: (args.systemPrompt as string) ?? '',
  maxIterations: (args.maxIterations as number) ?? 20,
  providerId: (args.providerId as string) ?? 'default',
});
```

- [ ] **Step 9: Run tests to verify passing**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/types/src/events.ts packages/core/src/collective/Collective.ts \
  packages/core/src/tools/management-tools.ts
git commit -m "feat(core): amend LegionEventMap participant events, Collective.modify(), create_agent config storage"
```

---

## Task 3: New core management tools

**Files:**
- Modify: `packages/core/src/tools/management-tools.ts`
- Test: `packages/core/src/tools/management-tools.test.ts`

The three new tools share access to the same `ManagementDeps` already used by the existing management tools.

- [ ] **Step 1: Write failing tests**

Add to `packages/core/src/tools/management-tools.test.ts`:

```typescript
describe('modify_agent', () => {
  it('updates model and systemPrompt in storage', async () => {
    const storage = new MemoryStorage();
    const deps = buildTestDeps({ storage });
    const { id } = await invokeManagementTool('create_agent', {
      name: 'bot-1', model: 'gpt-4o', providerId: 'openai',
    }, deps) as { id: string };
    await invokeManagementTool('modify_agent', {
      id, model: 'gpt-4o-mini', systemPrompt: 'Be concise.',
    }, deps);
    const config = await storage.readJson<{ model: string; systemPrompt: string }>(`agents/${id}.json`);
    expect(config?.model).toBe('gpt-4o-mini');
    expect(config?.systemPrompt).toBe('Be concise.');
  });

  it('updates name in Collective', async () => {
    const deps = buildTestDeps({});
    const { id } = await invokeManagementTool('create_agent', {
      name: 'bot-1', model: 'gpt-4o', providerId: 'openai',
    }, deps) as { id: string };
    const updated = await invokeManagementTool('modify_agent', { id, name: 'renamed' }, deps) as { name: string };
    expect(updated.name).toBe('renamed');
  });

  it('throws if participant id not found', async () => {
    const deps = buildTestDeps({});
    await expect(invokeManagementTool('modify_agent', { id: 'no-such' }, deps))
      .rejects.toThrow();
  });
});

describe('list_tools', () => {
  it('returns registered tool names', async () => {
    const deps = buildTestDeps({});
    const tools = await invokeManagementTool('list_tools', {}, deps) as string[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toContain('list_tools');
  });
});

describe('list_conversations', () => {
  it('returns empty array when no conversations exist', async () => {
    const storage = new MemoryStorage();
    const deps = buildTestDeps({ storage });
    const result = await invokeManagementTool('list_conversations', {}, deps) as unknown[];
    expect(result).toEqual([]);
  });

  it('returns summaries for stored conversations', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('conversations/conv-1.json', {
      id: 'conv-1', participantIds: ['a', 'b'], status: 'active',
      messageCount: 3, createdAt: 1000, updatedAt: 2000,
    });
    const deps = buildTestDeps({ storage });
    const result = await invokeManagementTool('list_conversations', {}, deps) as { id: string }[];
    expect(result[0]?.id).toBe('conv-1');
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "modify_agent|list_tools|list_conversations"
```

Expected: FAIL — tools not yet defined.

- [ ] **Step 3: Define `AgentConfig` type in `packages/types/src/participant.ts`**

```typescript
export interface AgentConfig {
  name: string;
  model: string;
  systemPrompt: string;
  maxIterations: number;
  providerId: string;
}
```

Export from `packages/types/src/index.ts`.

- [ ] **Step 4: Implement the three tools in `management-tools.ts`**

Add to the array returned by `createManagementTools(deps)`:

```typescript
{
  name: 'modify_agent',
  description: 'Update an existing agent — name, model, system prompt, max iterations.',
  parameters: {
    type: 'object',
    properties: {
      id:           { type: 'string', description: 'Participant ID' },
      name:         { type: 'string' },
      model:        { type: 'string' },
      systemPrompt: { type: 'string' },
      maxIterations:{ type: 'number' },
      providerId:   { type: 'string' },
    },
    required: ['id'],
  },
  execute: async (rawArgs) => {
    const args = rawArgs as Partial<AgentConfig> & { id: string };
    const participant = deps.collective.getOrThrow(args.id);
    const existing = await deps.storage.readJson<AgentConfig>(`agents/${args.id}.json`);
    if (!existing) throw new LegionError('NotFound', `Agent config not found for ${args.id}`);
    const updated: AgentConfig = {
      name:          args.name          ?? existing.name,
      model:         args.model         ?? existing.model,
      systemPrompt:  args.systemPrompt  ?? existing.systemPrompt,
      maxIterations: args.maxIterations ?? existing.maxIterations,
      providerId:    args.providerId    ?? existing.providerId,
    };
    if (args.name !== undefined) deps.collective.modify(args.id, { name: args.name });
    await deps.storage.writeJson(`agents/${args.id}.json`, updated);
    const provider = deps.providerRegistry.get(updated.providerId);
    if (provider) {
      const newRuntime = new AgentRuntime({
        participantId: args.id,
        model: updated.model,
        systemPrompt: updated.systemPrompt,
        maxIterations: updated.maxIterations,
        provider,
        eventBus: deps.eventBus,
        toolRegistry: deps.toolRegistry,
        authEngine: deps.authEngine,
      });
      deps.runtimeRegistry.register(args.id, newRuntime);
    }
    return deps.collective.getOrThrow(args.id);
  },
},

{
  name: 'list_tools',
  description: 'List all tool names registered in the ToolRegistry.',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => deps.toolRegistry.listAll(),
},

{
  name: 'list_conversations',
  description: 'List conversation summaries.',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => {
    const keys = await deps.storage.list('conversations/');
    const summaries = await Promise.all(
      keys.map((k) => deps.storage.readJson<ConversationSummary>(k)),
    );
    return summaries.filter(Boolean);
  },
},
```

Also add `listAll()` to `ToolRegistry`:
```typescript
listAll(): string[] {
  return [...this.tools.keys()];
}
```

Add `ConversationSummary` to `packages/types/src/conversation.ts`:
```typescript
export interface ConversationSummary {
  id: string;
  participantIds: string[];
  status: 'active' | 'completed';
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}
```
Export from `packages/types/src/index.ts`.

- [ ] **Step 5: Run tests to verify passing**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/ packages/core/src/tools/ packages/core/src/runtime/
git commit -m "feat(core): add modify_agent, list_tools, list_conversations management tools"
```

---

## Task 4: New runtime tools

**Files:**
- Create: `packages/runtime/src/server/runtime-tools.ts`
- Test: `packages/runtime/src/server/runtime-tools.test.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: Add `ProviderConfig` and `CredentialInfo` to `@legion/types`**

In `packages/types/src/config.ts`:
```typescript
export interface ProviderConfig {
  name: string;
  type: 'openai-compatible' | 'anthropic' | 'copilot' | 'codex';
  baseUrl?: string;
  defaultModel: string;
  credentialKey?: string;
}

export interface CredentialInfo {
  key: string;
  maskedValue: string;
  usedBy: string[];
  updatedAt: number;
}
```
Export both from `packages/types/src/index.ts`.

- [ ] **Step 2: Write failing tests**

`packages/runtime/src/server/runtime-tools.test.ts`:

```typescript
import { MemoryStorage } from '@legion/core';
import { describe, expect, it } from 'vitest';
import { createRuntimeTools } from './runtime-tools.js';

function makeDeps() {
  const storage = new MemoryStorage();
  const credStore = { set: async () => {}, list: async () => [] as string[] };
  return { storage, credStore };
}

describe('list_providers', () => {
  it('returns empty array when none configured', async () => {
    const tools = createRuntimeTools(makeDeps());
    const list = tools.find((t) => t.name === 'list_providers')!;
    expect(await list.execute({})).toEqual([]);
  });

  it('returns stored provider configs', async () => {
    const { storage, credStore } = makeDeps();
    await storage.writeJson('providers/openai.json', {
      name: 'openai', type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o',
    });
    const tools = createRuntimeTools({ storage, credStore });
    const list = tools.find((t) => t.name === 'list_providers')!;
    const result = await list.execute({}) as { name: string }[];
    expect(result[0]?.name).toBe('openai');
  });
});

describe('configure_provider', () => {
  it('writes provider config to storage', async () => {
    const { storage, credStore } = makeDeps();
    const tools = createRuntimeTools({ storage, credStore });
    const cfg = tools.find((t) => t.name === 'configure_provider')!;
    await cfg.execute({ name: 'local', type: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.2' });
    const stored = await storage.readJson<{ name: string }>('providers/local.json');
    expect(stored?.name).toBe('local');
  });
});

describe('list_credentials', () => {
  it('returns masked credential info', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('credential-meta/OPENAI_API_KEY.json', {
      key: 'OPENAI_API_KEY', maskedValue: 'sk-••••3f2a',
      usedBy: ['openai'], updatedAt: 1000,
    });
    const credStore = { set: async () => {}, list: async () => ['OPENAI_API_KEY'] };
    const tools = createRuntimeTools({ storage, credStore });
    const list = tools.find((t) => t.name === 'list_credentials')!;
    const result = await list.execute({}) as { key: string }[];
    expect(result[0]?.key).toBe('OPENAI_API_KEY');
  });
});
```

- [ ] **Step 3: Run to verify failures**

```bash
npx vitest run packages/runtime/src/server/runtime-tools.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `packages/runtime/src/server/runtime-tools.ts`**

```typescript
import type { CredentialInfo, ProviderConfig } from '@legion/types';
import type { Storage } from '@legion/core';
import type { Tool } from '@legion/core';

interface RuntimeToolDeps {
  storage: Storage;
  credStore: { set(key: string, value: string): Promise<void>; list(): Promise<string[]> };
}

export function createRuntimeTools(deps: RuntimeToolDeps): Tool[] {
  const { storage, credStore } = deps;

  return [
    {
      name: 'list_providers',
      description: 'List all configured LLM provider instances.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const keys = await storage.list('providers/');
        const configs = await Promise.all(keys.map((k) => storage.readJson<ProviderConfig>(k)));
        return configs.filter(Boolean);
      },
    },

    {
      name: 'configure_provider',
      description: 'Create or update a provider instance.',
      parameters: {
        type: 'object',
        properties: {
          name:          { type: 'string' },
          type:          { type: 'string', enum: ['openai-compatible', 'anthropic', 'copilot', 'codex'] },
          baseUrl:       { type: 'string' },
          defaultModel:  { type: 'string' },
          credentialKey: { type: 'string' },
        },
        required: ['name', 'type', 'defaultModel'],
      },
      execute: async (rawArgs) => {
        const args = rawArgs as ProviderConfig;
        await storage.writeJson(`providers/${args.name}.json`, args);
        return args;
      },
    },

    {
      name: 'list_credentials',
      description: 'List credential key names and metadata. Values are never returned.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const keys = await storage.list('credential-meta/');
        const infos = await Promise.all(keys.map((k) => storage.readJson<CredentialInfo>(k)));
        return infos.filter(Boolean);
      },
    },

    {
      name: 'set_credential_with_meta',
      description: 'Set a named credential and update its metadata record.',
      parameters: {
        type: 'object',
        properties: {
          key:       { type: 'string' },
          value:     { type: 'string' },
          usedBy:    { type: 'array', items: { type: 'string' } },
        },
        required: ['key', 'value'],
      },
      execute: async (rawArgs) => {
        const args = rawArgs as { key: string; value: string; usedBy?: string[] };
        await credStore.set(args.key, args.value);
        const masked = '••••' + args.value.slice(-4);
        await storage.writeJson(`credential-meta/${args.key}.json`, {
          key: args.key,
          maskedValue: masked,
          usedBy: args.usedBy ?? [],
          updatedAt: Date.now(),
        } satisfies CredentialInfo);
        return { key: args.key };
      },
    },
  ];
}
```

- [ ] **Step 5: Run tests to verify passing**

```bash
npx vitest run packages/runtime/src/server/runtime-tools.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Register runtime tools in `LegionProcess` startup**

In `packages/runtime/src/index.ts` (LegionProcess startup step 6 — global tools registration), after registering management tools:

```typescript
const runtimeTools = createRuntimeTools({ storage: this.storage, credStore: this.credentialStore });
for (const tool of runtimeTools) this.toolRegistry.register(tool);
```

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/ packages/runtime/src/server/runtime-tools.ts \
  packages/runtime/src/server/runtime-tools.test.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): add list_providers, configure_provider, list_credentials, set_credential_with_meta tools"
```

---

## Task 5: App shell, auth composable, router, LoginView

**Files:**
- Create: `packages/web/src/composables/useAuth.ts`
- Create: `packages/web/src/composables/useAuth.test.ts`
- Create: `packages/web/src/composables/useExecute.ts`
- Create: `packages/web/src/composables/useExecute.test.ts`
- Create: `packages/web/src/router/index.ts`
- Create: `packages/web/src/views/LoginView.vue`
- Modify: `packages/web/src/main.ts`
- Modify: `packages/web/src/App.vue`

- [ ] **Step 1: Write failing tests for `useAuth`**

`packages/web/src/composables/useAuth.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(async () => {
  // Reset singleton between tests
  const mod = await import('./useAuth.js');
  mod.useAuth().logout();
  vi.restoreAllMocks();
});

describe('useAuth', () => {
  it('starts unauthenticated', async () => {
    const { useAuth } = await import('./useAuth.js');
    expect(useAuth().isAuthenticated.value).toBe(false);
  });

  it('login sets token and participantId', async () => {
    const { useAuth } = await import('./useAuth.js');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'tok-1', participantId: 'p1', expiresAt: 9999999999 }),
    } as Response);
    await useAuth().login('admin', 'secret');
    expect(useAuth().isAuthenticated.value).toBe(true);
    expect(useAuth().participantId.value).toBe('p1');
  });

  it('logout clears token', async () => {
    const { useAuth } = await import('./useAuth.js');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'tok-1', participantId: 'p1', expiresAt: 9999999999 }),
    } as Response);
    await useAuth().login('admin', 'secret');
    useAuth().logout();
    expect(useAuth().isAuthenticated.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd packages/web && npx vitest run src/composables/useAuth.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useAuth.ts`**

```typescript
import { useLocalStorage } from '@vueuse/core';
import { computed, ref } from 'vue';

interface AuthState {
  token: string | null;
  participantId: string | null;
  expiresAt: number | null;
}

const token = useLocalStorage<string | null>('legion-token', null);
const participantId = ref<string | null>(null);
const expiresAt = ref<number | null>(null);

export function useAuth() {
  const isAuthenticated = computed(
    () => !!token.value && (expiresAt.value === null || Date.now() < expiresAt.value * 1000),
  );

  async function login(name: string, password: string): Promise<void> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    if (!res.ok) throw new Error('Invalid credentials');
    const data = (await res.json()) as AuthState;
    token.value = data.token;
    participantId.value = data.participantId;
    expiresAt.value = data.expiresAt;
  }

  function logout(): void {
    token.value = null;
    participantId.value = null;
    expiresAt.value = null;
  }

  function getToken(): string | null {
    return token.value;
  }

  return { isAuthenticated, participantId, login, logout, getToken };
}
```

- [ ] **Step 4: Run tests to verify passing**

```bash
cd packages/web && npx vitest run src/composables/useAuth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing tests for `useExecute`**

`packages/web/src/composables/useExecute.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => { vi.restoreAllMocks(); });

describe('useExecute', () => {
  it('POSTs to /api/execute with bearer token and returns result', async () => {
    const { useExecute } = await import('./useExecute.js');
    const { useAuth } = await import('./useAuth.js');
    useAuth().logout();
    // Patch token directly
    vi.spyOn(useAuth(), 'getToken').mockReturnValue('tok-1');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ['p1', 'p2'], conversationId: 'c1' }),
    } as Response);
    const { execute } = useExecute();
    const result = await execute<string[]>('list_participants', {});
    expect(result).toEqual(['p1', 'p2']);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers['Authorization'])
      .toBe('Bearer tok-1');
  });

  it('throws on non-ok response', async () => {
    const { useExecute } = await import('./useExecute.js');
    global.fetch = vi.fn().mockResolvedValue({ ok: false, text: async () => 'Forbidden' } as Response);
    const { execute } = useExecute();
    await expect(execute('list_participants', {})).rejects.toThrow('Forbidden');
  });
});
```

- [ ] **Step 6: Implement `useExecute.ts`**

```typescript
import { useAuth } from './useAuth.js';

export function useExecute() {
  const { getToken, logout } = useAuth();

  async function execute<T>(tool: string, args: unknown = {}): Promise<T> {
    const res = await fetch('/api/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken() ?? ''}`,
      },
      body: JSON.stringify({ tool, args }),
    });
    if (res.status === 401) {
      logout();
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { result: T };
    return data.result;
  }

  return { execute };
}
```

- [ ] **Step 7: Run execute tests**

```bash
cd packages/web && npx vitest run src/composables/useExecute.test.ts
```

Expected: PASS.

- [ ] **Step 8: Create `packages/web/src/router/index.ts`**

```typescript
import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuth } from '../composables/useAuth.js';

const routes = [
  { path: '/login', component: () => import('../views/LoginView.vue') },
  { path: '/', redirect: '/participants' },
  { path: '/participants', component: () => import('../views/ParticipantsView.vue'), meta: { requiresAuth: true } },
  { path: '/conversations', component: () => import('../views/ConversationsView.vue'), meta: { requiresAuth: true } },
  { path: '/conversations/:id', component: () => import('../views/ConversationsView.vue'), meta: { requiresAuth: true } },
  { path: '/events', component: () => import('../views/EventStreamView.vue'), meta: { requiresAuth: true } },
  { path: '/config', component: () => import('../views/ConfigView.vue'), meta: { requiresAuth: true } },
  { path: '/config/credentials', component: () => import('../views/ConfigView.vue'), meta: { requiresAuth: true } },
];

export const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  const { isAuthenticated } = useAuth();
  if (to.meta.requiresAuth && !isAuthenticated.value) return '/login';
});
```

- [ ] **Step 9: Create `packages/web/src/views/LoginView.vue`**

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../composables/useAuth.js';

const name = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const router = useRouter();
const { login } = useAuth();

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await login(name.value, password.value);
    await router.push('/participants');
  } catch {
    error.value = 'Incorrect name or password.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="bg-navy-950 min-h-screen flex items-center justify-center">
    <div class="w-80">
      <div class="text-center mb-8">
        <div class="w-10 h-10 bg-cyan-400 rounded-lg inline-flex items-center justify-center text-navy-950 font-black text-xl mb-3">L</div>
        <h1 class="text-slate-100 text-xl font-bold">Legion</h1>
        <p class="text-navy-400 text-xs mt-1">Management console</p>
      </div>
      <div class="bg-navy-800 border border-navy-600 rounded-xl p-7">
        <form @submit.prevent="submit" class="space-y-4">
          <div>
            <label class="text-navy-400 text-xs uppercase tracking-wider font-semibold block mb-1">Name</label>
            <input v-model="name" type="text" autocomplete="username"
              class="w-full bg-navy-900 border border-navy-600 rounded-md px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40" />
          </div>
          <div>
            <label class="text-navy-400 text-xs uppercase tracking-wider font-semibold block mb-1">Password</label>
            <input v-model="password" type="password" autocomplete="current-password"
              class="w-full bg-navy-900 border border-navy-600 rounded-md px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40" />
            <p v-if="error" class="text-red-400 text-xs mt-1">{{ error }}</p>
          </div>
          <button type="submit" :disabled="loading"
            class="w-full bg-cyan-400 text-navy-950 font-bold text-sm py-2.5 rounded-md mt-2 hover:opacity-90 disabled:opacity-50">
            {{ loading ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>
      </div>
      <p class="text-center text-navy-600 text-xs mt-4 leading-relaxed">
        First run? The bootstrap password was<br>printed to process stdout on startup.
      </p>
    </div>
  </div>
</template>
```

- [ ] **Step 10: Wire up `main.ts` and `App.vue`**

`src/main.ts`:
```typescript
import './assets/style.css';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router/index.js';

createApp(App).use(router).mount('#app');
```

`src/App.vue`:
```vue
<script setup lang="ts"></script>
<template><RouterView /></template>
```

- [ ] **Step 11: Verify dev server starts**

```bash
cd packages/web && npm run dev
```

Expected: Vite dev server starts, `http://localhost:5173` shows the login page (or redirects to it).

- [ ] **Step 12: Commit**

```bash
git add packages/web/src/
git commit -m "feat(web): auth composable, router, login view"
```

---

## Task 6: `useEventStream` composable

**Files:**
- Create: `packages/web/src/composables/useEventStream.ts`
- Test: `packages/web/src/composables/useEventStream.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/web/src/composables/useEventStream.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => vi.restoreAllMocks());

describe('useEventStream', () => {
  it('exports subscribe and unsubscribe', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const stream = useEventStream();
    expect(typeof stream.subscribe).toBe('function');
    expect(typeof stream.unsubscribe).toBe('function');
  });

  it('subscribe returns an unsubscribe function', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const stream = useEventStream();
    const off = stream.subscribe(() => {});
    expect(typeof off).toBe('function');
    off();
  });

  it('notifies subscribers when dispatchEvent is called', async () => {
    const { useEventStream, _testDispatch } = await import('./useEventStream.js');
    const stream = useEventStream();
    const received: unknown[] = [];
    stream.subscribe((evt) => received.push(evt));
    _testDispatch({ type: 'event', event: 'message:sent', data: { conversationId: 'c1' } });
    expect(received).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement `useEventStream.ts`**

```typescript
import { useAuth } from './useAuth.js';

interface StreamEvent {
  type: 'event';
  event: string;
  data: unknown;
}

type EventHandler = (evt: StreamEvent) => void;

// Singleton state
const subscribers = new Set<EventHandler>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;

function dispatch(evt: StreamEvent) {
  for (const handler of subscribers) {
    try { handler(evt); } catch { /* isolate */ }
  }
}

function connect() {
  const { getToken, isAuthenticated } = useAuth();
  if (!isAuthenticated.value) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    backoff = 1000;
    ws!.send(JSON.stringify({ type: 'auth', token: getToken() }));
  });

  ws.addEventListener('message', (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data as string) as StreamEvent;
      if (msg.type === 'event') dispatch(msg);
    } catch { /* ignore malformed */ }
  });

  ws.addEventListener('close', () => scheduleReconnect());
  ws.addEventListener('error', () => { ws?.close(); });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoff = Math.min(backoff * 2, 30_000);
    connect();
  }, backoff);
}

export function useEventStream() {
  function subscribe(handler: EventHandler): () => void {
    subscribers.add(handler);
    if (!ws || ws.readyState > WebSocket.OPEN) connect();
    return () => subscribers.delete(handler);
  }

  function unsubscribe(handler: EventHandler) {
    subscribers.delete(handler);
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    ws?.close();
    ws = null;
  }

  return { subscribe, unsubscribe, disconnect };
}

// Test escape hatch — not imported in production
export function _testDispatch(evt: StreamEvent) { dispatch(evt); }
```

- [ ] **Step 3: Run tests**

```bash
cd packages/web && npx vitest run src/composables/useEventStream.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/composables/
git commit -m "feat(web): useEventStream WebSocket composable with reconnect"
```

---

## Task 7: Common components + AppLayout

**Files:**
- Create: `packages/web/src/components/common/StatusDot.vue`
- Create: `packages/web/src/components/common/TypeBadge.vue`
- Create: `packages/web/src/components/common/SlideOver.vue`
- Create: `packages/web/src/components/layout/AppSidebar.vue`
- Create: `packages/web/src/components/layout/AppLayout.vue`
- Modify: stub views to use `AppLayout`

- [ ] **Step 1: Create `StatusDot.vue`**

```vue
<script setup lang="ts">
defineProps<{ status: 'active' | 'retired' | 'live' | 'complete' }>();
const colours: Record<string, string> = {
  active: 'bg-cyan-400', live: 'bg-cyan-400 animate-pulse',
  complete: 'bg-green-400', retired: 'bg-navy-500',
};
</script>
<template>
  <span :class="['inline-block w-2 h-2 rounded-full', colours[status] ?? 'bg-navy-500']" />
</template>
```

- [ ] **Step 2: Create `TypeBadge.vue`**

```vue
<script setup lang="ts">
defineProps<{ type: string }>();
const colours: Record<string, string> = {
  'message:sent':    'bg-cyan-400/10 text-cyan-400 border-cyan-400/20',
  'tool:call':       'bg-violet-400/10 text-violet-400 border-violet-400/20',
  'tool:result':     'bg-green-400/10 text-green-400 border-green-400/20',
  error:             'bg-red-400/10 text-red-400 border-red-400/20',
  delegation:        'bg-amber-400/10 text-amber-400 border-amber-400/20',
};
const cls = (t: string) => colours[t] ?? 'bg-navy-700/50 text-navy-400 border-navy-600';
</script>
<template>
  <span :class="['inline-block text-[9px] font-bold font-mono px-1.5 py-0.5 rounded border', cls(type)]">
    {{ type }}
  </span>
</template>
```

- [ ] **Step 3: Create `SlideOver.vue`**

```vue
<script setup lang="ts">
defineProps<{ title: string; open: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>
<template>
  <Teleport to="body">
    <Transition name="slide">
      <div v-if="open" class="fixed inset-0 z-40 flex justify-end">
        <div class="flex-1 bg-navy-950/60" @click="emit('close')" />
        <div class="w-96 bg-navy-800 border-l border-navy-600 flex flex-col shadow-2xl">
          <div class="flex items-center justify-between px-5 py-4 border-b border-navy-600">
            <span class="text-sm font-semibold text-slate-100">{{ title }}</span>
            <button @click="emit('close')" class="text-navy-400 hover:text-slate-200 text-lg leading-none">✕</button>
          </div>
          <div class="flex-1 overflow-y-auto"><slot /></div>
          <div v-if="$slots.footer" class="border-t border-navy-600 bg-navy-900"><slot name="footer" /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
<style scoped>
.slide-enter-from .w-96, .slide-leave-to .w-96 { transform: translateX(100%); }
.slide-enter-active .w-96, .slide-leave-active .w-96 { transition: transform .2s ease; }
</style>
```

- [ ] **Step 4: Create `AppSidebar.vue`**

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuth } from '../../composables/useAuth.js';

const { logout } = useAuth();
const router = useRouter();

const nav = [
  { label: 'Participants', icon: '👤', to: '/participants' },
  { label: 'Conversations', icon: '💬', to: '/conversations' },
  { label: 'Events', icon: '⚡', to: '/events' },
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
      <div class="w-[22px] h-[22px] bg-cyan-400 rounded flex items-center justify-center text-[11px] font-black text-navy-950">L</div>
      <span class="text-sm font-bold text-slate-100">Legion</span>
    </div>
    <nav class="flex-1 p-2 space-y-0.5">
      <RouterLink v-for="item in nav" :key="item.to" :to="item.to"
        class="flex items-center gap-2.5 px-3 py-1.5 rounded text-xs text-navy-400 hover:text-slate-200"
        active-class="bg-cyan-400/10 text-cyan-300 border-l-2 border-cyan-400 !pl-[10px]">
        <span>{{ item.icon }}</span>{{ item.label }}
      </RouterLink>
    </nav>
    <div class="p-2 border-t border-navy-600">
      <button @click="handleLogout"
        class="flex items-center gap-2 px-3 py-1.5 w-full text-xs text-navy-400 hover:text-slate-200">
        <span class="w-5 h-5 rounded-full bg-navy-600 flex items-center justify-center text-[10px]">A</span>
        admin <span class="ml-auto text-navy-600">logout</span>
      </button>
    </div>
  </aside>
</template>
```

- [ ] **Step 5: Create `AppLayout.vue`**

```vue
<script setup lang="ts"></script>
<template>
  <div class="flex h-screen bg-navy-950 text-slate-200 overflow-hidden">
    <AppSidebar />
    <main class="flex-1 min-w-0 overflow-y-auto"><slot /></main>
  </div>
</template>
<script>
import AppSidebar from './AppSidebar.vue';
</script>
```

- [ ] **Step 6: Write a basic render test**

`packages/web/src/components/common/StatusDot.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StatusDot from './StatusDot.vue';

describe('StatusDot', () => {
  it('renders active state with cyan class', () => {
    const w = mount(StatusDot, { props: { status: 'active' } });
    expect(w.classes()).toContain('bg-cyan-400');
  });

  it('renders retired state with navy class', () => {
    const w = mount(StatusDot, { props: { status: 'retired' } });
    expect(w.classes()).toContain('bg-navy-500');
  });
});
```

- [ ] **Step 7: Run component test**

```bash
cd packages/web && npx vitest run src/components/common/StatusDot.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/
git commit -m "feat(web): common components, AppSidebar, AppLayout"
```

---

## Task 8: Participants screen

**Files:**
- Create: `packages/web/src/components/participants/ToolPolicyEditor.vue`
- Create: `packages/web/src/components/participants/ToolPolicyEditor.test.ts`
- Create: `packages/web/src/components/participants/ParticipantSlideOver.vue`
- Create: `packages/web/src/components/participants/ParticipantTable.vue`
- Create: `packages/web/src/views/ParticipantsView.vue`

- [ ] **Step 1: Write failing tests for `ToolPolicyEditor`**

`packages/web/src/components/participants/ToolPolicyEditor.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ToolPolicyEditor from './ToolPolicyEditor.vue';

const overrides = [
  { tool: 'create_agent', source: 'built-in', enabled: true, requireApproval: false },
  { tool: 'retire_agent', source: 'built-in', enabled: true, requireApproval: true },
];

describe('ToolPolicyEditor', () => {
  it('renders override rows', () => {
    const w = mount(ToolPolicyEditor, {
      props: { defaultPolicy: 'allow', overrides, availableTools: [] },
    });
    expect(w.findAll('[data-tool-row]')).toHaveLength(2);
  });

  it('emits update:overrides when checkbox toggled', async () => {
    const w = mount(ToolPolicyEditor, {
      props: { defaultPolicy: 'allow', overrides, availableTools: [] },
    });
    await w.find('[data-tool-row]').find('input[type=checkbox]').setValue(false);
    expect(w.emitted('update:overrides')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement `ToolPolicyEditor.vue`**

```vue
<script setup lang="ts">
export interface ToolOverride {
  tool: string;
  source: string;
  enabled: boolean;
  requireApproval: boolean;
}

const props = defineProps<{
  defaultPolicy: 'allow' | 'require-approval' | 'deny';
  overrides: ToolOverride[];
  availableTools: string[];
}>();

const emit = defineEmits<{
  'update:defaultPolicy': [value: string];
  'update:overrides': [value: ToolOverride[]];
}>();

const policies = ['allow', 'require-approval', 'deny'] as const;

function toggleEnabled(index: number) {
  const next = props.overrides.map((o, i) =>
    i === index ? { ...o, enabled: !o.enabled } : o,
  );
  emit('update:overrides', next);
}

function toggleApproval(index: number) {
  const next = props.overrides.map((o, i) =>
    i === index ? { ...o, requireApproval: !o.requireApproval } : o,
  );
  emit('update:overrides', next);
}

function removeOverride(index: number) {
  emit('update:overrides', props.overrides.filter((_, i) => i !== index));
}

function addTool(toolName: string) {
  if (!toolName || props.overrides.find((o) => o.tool === toolName)) return;
  emit('update:overrides', [
    ...props.overrides,
    { tool: toolName, source: 'built-in', enabled: true, requireApproval: false },
  ]);
}

const grouped = computed(() => {
  const map = new Map<string, ToolOverride[]>();
  for (const o of props.overrides) {
    const src = o.source;
    if (!map.has(src)) map.set(src, []);
    map.get(src)!.push(o);
  }
  return map;
});

import { computed, ref } from 'vue';
const addingTool = ref('');
</script>

<template>
  <div class="space-y-4 p-5">
    <!-- Default policy -->
    <div>
      <p class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold mb-2">Default policy</p>
      <div class="flex gap-2">
        <button v-for="p in policies" :key="p"
          @click="emit('update:defaultPolicy', p)"
          :class="['text-xs px-3 py-1.5 rounded border transition-colors', defaultPolicy === p
            ? 'bg-cyan-400/10 border-cyan-400/30 text-cyan-400'
            : 'border-navy-600 text-navy-400 hover:text-slate-200']">
          {{ p }}
        </button>
      </div>
    </div>

    <!-- Per-tool overrides -->
    <div>
      <p class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold mb-2">Per-tool overrides</p>
      <template v-for="[source, items] in grouped" :key="source">
        <p class="text-[9px] uppercase tracking-wider text-navy-500 font-semibold py-1.5">{{ source }}</p>
        <div v-for="(override, idx) in items" :key="override.tool"
          data-tool-row
          class="flex items-center gap-2 py-1.5 border-b border-navy-900">
          <input type="checkbox" :checked="override.enabled"
            @change="toggleEnabled(props.overrides.indexOf(override))"
            class="accent-cyan-400" />
          <span :class="['flex-1 font-mono text-xs', override.enabled ? 'text-slate-100' : 'text-navy-500']">
            {{ override.tool }}
          </span>
          <button v-if="override.enabled"
            @click="toggleApproval(props.overrides.indexOf(override))"
            :class="['text-[9px] px-2 py-0.5 rounded border transition-colors', override.requireApproval
              ? 'bg-amber-400/10 border-amber-400/30 text-amber-400'
              : 'border-navy-600 text-navy-500']">
            require approval
          </button>
          <button @click="removeOverride(props.overrides.indexOf(override))"
            class="text-navy-600 hover:text-red-400 text-sm leading-none">×</button>
        </div>
      </template>

      <!-- Add tool -->
      <div class="flex gap-2 mt-3">
        <select v-model="addingTool"
          class="flex-1 bg-navy-900 border border-navy-600 rounded text-xs text-navy-400 px-2 py-1.5 font-mono">
          <option value="">— add tool override —</option>
          <option v-for="t in availableTools" :key="t" :value="t">{{ t }}</option>
        </select>
        <button @click="addTool(addingTool); addingTool = ''"
          class="text-xs px-3 py-1.5 bg-cyan-400/10 border border-cyan-400/30 text-cyan-400 rounded">
          Add
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Run ToolPolicyEditor tests**

```bash
cd packages/web && npx vitest run src/components/participants/ToolPolicyEditor.test.ts
```

Expected: PASS.

- [ ] **Step 4: Create `ParticipantSlideOver.vue`**

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import SlideOver from '../common/SlideOver.vue';
import ToolPolicyEditor, { type ToolOverride } from './ToolPolicyEditor.vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  open: boolean;
  participantId: string | null;
  availableTools: string[];
  providers: { name: string }[];
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const tab = ref<'basic' | 'tools'>('basic');
const name = ref('');
const model = ref('');
const providerId = ref('');
const systemPrompt = ref('');
const maxIterations = ref(20);
const defaultPolicy = ref<'allow' | 'require-approval' | 'deny'>('allow');
const overrides = ref<ToolOverride[]>([]);
const saving = ref(false);

watch(() => props.open, async (open) => {
  if (!open) return;
  tab.value = 'basic';
  if (props.participantId) {
    // Load existing — in a real app fetch participant details
  } else {
    name.value = ''; model.value = ''; providerId.value = '';
    systemPrompt.value = ''; maxIterations.value = 20;
    defaultPolicy.value = 'allow'; overrides.value = [];
  }
});

async function save() {
  saving.value = true;
  try {
    const toolPolicies = Object.fromEntries(
      overrides.value.map((o) => [o.tool, o.requireApproval ? 'require-approval' : o.enabled ? 'allow' : 'deny']),
    );
    if (props.participantId) {
      await execute('modify_agent', { id: props.participantId, name: name.value, model: model.value,
        systemPrompt: systemPrompt.value, maxIterations: maxIterations.value, toolPolicies });
    } else {
      await execute('create_agent', { name: name.value, model: model.value, providerId: providerId.value,
        systemPrompt: systemPrompt.value, maxIterations: maxIterations.value, toolPolicies });
    }
    emit('saved');
    emit('close');
  } finally {
    saving.value = false;
  }
}

async function retire() {
  if (!props.participantId) return;
  await execute('retire_agent', { id: props.participantId });
  emit('saved');
  emit('close');
}
</script>

<template>
  <SlideOver :open="open" :title="participantId ? 'Edit agent' : 'New agent'" @close="emit('close')">
    <!-- Tabs -->
    <div class="flex border-b border-navy-600 bg-navy-900">
      <button v-for="t in ['basic', 'tools'] as const" :key="t" @click="tab = t"
        :class="['px-4 py-2 text-xs font-medium border-b-2 transition-colors', tab === t
          ? 'text-cyan-400 border-cyan-400'
          : 'text-navy-400 border-transparent hover:text-slate-200']">
        {{ t === 'basic' ? 'Basic' : 'Tool policies' }}
      </button>
    </div>

    <!-- Basic tab -->
    <div v-if="tab === 'basic'" class="p-5 space-y-4">
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Name</label>
        <input v-model="name" :readonly="!!participantId"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40" />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Provider</label>
        <select v-model="providerId"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100">
          <option v-for="p in providers" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Model</label>
        <input v-model="model"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none focus:border-cyan-400/40" />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">System prompt</label>
        <textarea v-model="systemPrompt" rows="6"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-xs text-slate-200 font-mono resize-none outline-none focus:border-cyan-400/40" />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Max iterations</label>
        <input v-model.number="maxIterations" type="number" class="w-20 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none" />
      </div>
    </div>

    <!-- Tools tab -->
    <ToolPolicyEditor v-else
      :default-policy="defaultPolicy"
      :overrides="overrides"
      :available-tools="availableTools"
      @update:default-policy="(v) => (defaultPolicy = v as typeof defaultPolicy)"
      @update:overrides="(v) => (overrides = v)" />

    <template #footer>
      <div class="flex items-center justify-between px-5 py-3">
        <button v-if="participantId" @click="retire"
          class="text-xs px-3 py-1.5 border border-red-900 text-red-400 rounded hover:border-red-700">
          Retire agent
        </button>
        <div v-else />
        <div class="flex gap-2">
          <button @click="emit('close')" class="text-xs px-3 py-1.5 border border-navy-600 text-navy-400 rounded hover:text-slate-200">Cancel</button>
          <button @click="save" :disabled="saving"
            class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </template>
  </SlideOver>
</template>
```

- [ ] **Step 5: Create `ParticipantsView.vue`**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Participant } from '@legion/types';
import AppLayout from '../components/layout/AppLayout.vue';
import ParticipantSlideOver from '../components/participants/ParticipantSlideOver.vue';
import { useEventStream } from '../composables/useEventStream.js';
import { useExecute } from '../composables/useExecute.js';

const { execute } = useExecute();
const { subscribe } = useEventStream();

const participants = ref<Participant[]>([]);
const allTools = ref<string[]>([]);
const providers = ref<{ name: string }[]>([]);
const slideOpen = ref(false);
const editingId = ref<string | null>(null);

async function load() {
  participants.value = await execute<Participant[]>('list_participants', {});
  allTools.value = await execute<string[]>('list_tools', {});
  providers.value = await execute<{ name: string }[]>('list_providers', {});
}

onMounted(async () => {
  await load();
  subscribe((evt) => {
    if (evt.event === 'participant:active' || evt.event === 'participant:retired') load();
  });
});

function openCreate() { editingId.value = null; slideOpen.value = true; }
function openEdit(id: string) { editingId.value = id; slideOpen.value = true; }
</script>

<template>
  <AppLayout>
    <div class="flex items-center justify-between px-5 py-3.5 border-b border-navy-600">
      <h1 class="text-sm font-semibold text-slate-100">Participants</h1>
      <button @click="openCreate"
        class="text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded hover:border-cyan-400/40">
        + New agent
      </button>
    </div>

    <table class="w-full border-collapse text-xs">
      <thead>
        <tr class="border-b border-navy-700">
          <th class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold">Status</th>
          <th class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold">Name</th>
          <th class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold">Model</th>
          <th class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold">Provider</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in participants" :key="p.id"
          :class="['border-b border-navy-900 hover:bg-navy-800/40', p.status === 'retired' ? 'opacity-35' : '']">
          <td class="px-4 py-2.5">
            <div class="flex items-center gap-2">
              <StatusDot :status="p.status === 'active' ? 'active' : 'retired'" />
              <span :class="p.status === 'active' ? 'text-cyan-400' : 'text-navy-500'">
                {{ p.status === 'active' ? 'Active' : 'Retired' }}
              </span>
            </div>
          </td>
          <td class="px-4 py-2.5 text-slate-100 font-medium">{{ p.name }}</td>
          <td class="px-4 py-2.5 text-navy-400 font-mono">{{ (p as any).model ?? '—' }}</td>
          <td class="px-4 py-2.5 text-navy-400 font-mono">{{ (p as any).providerId ?? '—' }}</td>
          <td class="px-4 py-2.5 text-right">
            <button v-if="p.status === 'active'" @click="openEdit(p.id)"
              class="text-navy-400 hover:text-slate-200 mr-3">Edit</button>
          </td>
        </tr>
      </tbody>
    </table>

    <ParticipantSlideOver
      :open="slideOpen"
      :participant-id="editingId"
      :available-tools="allTools"
      :providers="providers"
      @close="slideOpen = false"
      @saved="load" />
  </AppLayout>
</template>

<script>
import StatusDot from '../components/common/StatusDot.vue';
</script>
```

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/participants/ packages/web/src/views/ParticipantsView.vue
git commit -m "feat(web): participants screen — table, slide-over, tool policy editor"

---

## Task 9: Renderer registry + Conversations screen

**Files:**
- Create: `packages/web/src/renderers/index.ts`
- Create: `packages/web/src/renderers/index.test.ts`
- Create: `packages/web/src/renderers/JsonRenderer.vue`
- Create: `packages/web/src/renderers/SearchResultRenderer.vue`
- Create: `packages/web/src/renderers/FileTreeRenderer.vue`
- Create: `packages/web/src/renderers/ToolResultRenderer.vue`
- Create: `packages/web/src/components/conversations/ToolCallBlock.vue`
- Create: `packages/web/src/components/conversations/SubThreadBlock.vue`
- Create: `packages/web/src/components/conversations/ConversationThread.vue`
- Create: `packages/web/src/components/conversations/ConversationList.vue`
- Create: `packages/web/src/views/ConversationsView.vue`

- [ ] **Step 1: Write failing tests for the renderer registry**

`packages/web/src/renderers/index.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { lookupRenderer, registerRenderer } from './index.js';

describe('renderer registry', () => {
  it('returns JsonRenderer for unknown tool', () => {
    const r = lookupRenderer('some_unknown_tool');
    expect(r.name).toBe('JsonRenderer');
  });

  it('returns registered renderer for matching pattern', () => {
    registerRenderer(/^mcp__web-search__/, { name: 'SearchResultRenderer' } as any);
    const r = lookupRenderer('mcp__web-search__search');
    expect(r.name).toBe('SearchResultRenderer');
  });

  it('matches more specific pattern over catch-all', () => {
    const r = lookupRenderer('mcp__filesystem__list_dir');
    expect(r.name).toBe('FileTreeRenderer');
  });
});
```

- [ ] **Step 2: Implement `packages/web/src/renderers/index.ts`**

```typescript
import type { Component } from 'vue';
import FileTreeRenderer from './FileTreeRenderer.vue';
import JsonRenderer from './JsonRenderer.vue';
import SearchResultRenderer from './SearchResultRenderer.vue';

export interface RendererEntry { pattern: RegExp; component: Component }

const registry: RendererEntry[] = [
  { pattern: /^mcp__web-search__/,        component: SearchResultRenderer },
  { pattern: /^mcp__filesystem__list_/,   component: FileTreeRenderer },
  { pattern: /^mcp__filesystem__read_/,   component: JsonRenderer }, // plain text/code
  { pattern: /.*/,                         component: JsonRenderer },
];

export function registerRenderer(pattern: RegExp, component: Component) {
  registry.unshift({ pattern, component });
}

export function lookupRenderer(toolName: string): Component {
  return registry.find((r) => r.pattern.test(toolName))?.component ?? JsonRenderer;
}
```

- [ ] **Step 3: Create renderer components**

`packages/web/src/renderers/JsonRenderer.vue`:
```vue
<script setup lang="ts">
defineProps<{ tool: string; args?: unknown; result?: unknown }>();
function fmt(v: unknown) { return JSON.stringify(v, null, 2); }
</script>
<template>
  <pre class="text-[10px] font-mono text-navy-400 p-3 overflow-x-auto leading-relaxed whitespace-pre-wrap">{{ fmt(result ?? args) }}</pre>
</template>
```

`packages/web/src/renderers/SearchResultRenderer.vue`:
```vue
<script setup lang="ts">
interface SearchResult { title: string; url: string; snippet: string }
defineProps<{ tool: string; args?: unknown; result?: unknown }>();
const results = (props: { result?: unknown }) =>
  (props.result as SearchResult[] | null) ?? [];
</script>
<template>
  <div class="p-3 space-y-2">
    <div v-for="r in results($props)" :key="r.url"
      class="bg-navy-950 border border-navy-600 rounded p-2.5">
      <p class="text-[11px] font-medium text-cyan-300 mb-0.5">{{ r.title }}</p>
      <p class="text-[9px] font-mono text-navy-500 mb-1">{{ r.url }}</p>
      <p class="text-[10px] text-slate-500 leading-relaxed">{{ r.snippet }}</p>
    </div>
  </div>
</template>
```

`packages/web/src/renderers/FileTreeRenderer.vue`:
```vue
<script setup lang="ts">
interface FileEntry { name: string; type: 'file' | 'dir'; size?: number }
defineProps<{ tool: string; args?: unknown; result?: unknown }>();
const entries = (r: unknown) => (r as FileEntry[] | null) ?? [];
</script>
<template>
  <div class="p-3 font-mono text-[10px] space-y-0.5">
    <div v-for="e in entries($props.result)" :key="e.name"
      class="flex items-center gap-2 text-slate-400 hover:text-slate-200">
      <span>{{ e.type === 'dir' ? '📁' : '📄' }}</span>
      <span :class="e.type === 'dir' ? 'text-cyan-400' : ''">{{ e.name }}</span>
      <span v-if="e.size" class="ml-auto text-navy-500">{{ e.size }}B</span>
    </div>
  </div>
</template>
```

`packages/web/src/renderers/ToolResultRenderer.vue`:
```vue
<script setup lang="ts">
import { computed } from 'vue';
import { lookupRenderer } from './index.js';

const props = defineProps<{ tool: string; args?: unknown; result?: unknown }>();
const renderer = computed(() => lookupRenderer(props.tool));
</script>
<template>
  <component :is="renderer" :tool="tool" :args="args" :result="result" />
</template>
```

- [ ] **Step 4: Run renderer tests**

```bash
cd packages/web && npx vitest run src/renderers/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Create `ToolCallBlock.vue`**

```vue
<script setup lang="ts">
import { ref } from 'vue';
import TypeBadge from '../common/TypeBadge.vue';
import ToolResultRenderer from '../../renderers/ToolResultRenderer.vue';

export interface ToolCallEntry {
  id: string;
  tool: string;
  type: 'tool:call' | 'tool:result' | 'delegation';
  args?: unknown;
  result?: unknown;
  timestamp: string;
  subThread?: MessageEntry[];
}

export interface MessageEntry {
  id: string;
  author: string;
  authorColour: string;
  content: string;
  timestamp: string;
  toolCalls?: ToolCallEntry[];
}

defineProps<{ entry: ToolCallEntry }>();
const open = ref(false);
</script>

<template>
  <div :class="['border rounded-md my-1.5 overflow-hidden',
    entry.type === 'delegation' ? 'border-amber-400/30' : 'border-navy-600']">
    <button @click="open = !open"
      class="flex items-center gap-2 px-3 py-1.5 w-full hover:bg-white/[.02] text-left">
      <span :class="['text-[9px] transition-transform', open ? 'rotate-90' : '']">▶</span>
      <TypeBadge :type="entry.type" />
      <span class="font-mono text-[11px] text-slate-100">{{ entry.tool }}</span>
      <span class="ml-auto text-[9px] text-navy-500">{{ entry.timestamp }}</span>
    </button>
    <div v-if="open" class="border-t border-navy-700">
      <!-- Delegation: show sub-thread -->
      <template v-if="entry.type === 'delegation' && entry.subThread">
        <div class="border-l-2 border-amber-400/30 ml-3 my-2">
          <SubThreadBlock :messages="entry.subThread" />
        </div>
      </template>
      <!-- Regular tool call/result -->
      <template v-else>
        <ToolResultRenderer :tool="entry.tool" :args="entry.args" :result="entry.result" />
      </template>
    </div>
  </div>
</template>

<script>
import SubThreadBlock from './SubThreadBlock.vue';
</script>
```

- [ ] **Step 6: Create `SubThreadBlock.vue`** (recursive)

```vue
<script setup lang="ts">
import type { MessageEntry } from './ToolCallBlock.vue';
import ToolCallBlock from './ToolCallBlock.vue';

defineProps<{ messages: MessageEntry[] }>();
</script>

<template>
  <div class="py-2 px-3 space-y-3">
    <div v-for="msg in messages" :key="msg.id">
      <div class="flex items-baseline gap-2 mb-1">
        <span :style="{ color: msg.authorColour }" class="text-xs font-bold">{{ msg.author }}</span>
        <span class="text-[10px] text-navy-500">{{ msg.timestamp }}</span>
      </div>
      <p class="text-[11px] text-slate-300 leading-relaxed">{{ msg.content }}</p>
      <ToolCallBlock v-for="tc in msg.toolCalls ?? []" :key="tc.id" :entry="tc" />
    </div>
  </div>
</template>
```

- [ ] **Step 7: Write recursion test for `SubThreadBlock`**

`packages/web/src/components/conversations/SubThreadBlock.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SubThreadBlock from './SubThreadBlock.vue';

describe('SubThreadBlock', () => {
  it('renders a flat message list', () => {
    const messages = [
      { id: 'm1', author: 'agent-1', authorColour: '#22d3ee',
        content: 'Hello', timestamp: '12:00', toolCalls: [] },
    ];
    const w = mount(SubThreadBlock, { props: { messages } });
    expect(w.text()).toContain('Hello');
    expect(w.text()).toContain('agent-1');
  });

  it('renders nested delegation tool call', () => {
    const messages = [
      { id: 'm1', author: 'orchestrator', authorColour: '#22d3ee',
        content: 'Delegating', timestamp: '12:00',
        toolCalls: [{
          id: 'tc1', tool: 'send_message', type: 'delegation' as const,
          timestamp: '12:00', subThread: [
            { id: 'm2', author: 'researcher', authorColour: '#f59e0b',
              content: 'Sub-response', timestamp: '12:01', toolCalls: [] },
          ],
        }],
      },
    ];
    const w = mount(SubThreadBlock, { props: { messages }, global: { stubs: { teleport: true } } });
    expect(w.text()).toContain('Delegating');
  });
});
```

- [ ] **Step 8: Run SubThreadBlock tests**

```bash
cd packages/web && npx vitest run src/components/conversations/SubThreadBlock.test.ts
```

Expected: PASS.

- [ ] **Step 9: Create `ConversationList.vue` and `ConversationThread.vue`**

`ConversationList.vue`:
```vue
<script setup lang="ts">
import type { ConversationSummary } from '@legion/types';
defineProps<{ conversations: ConversationSummary[]; activeId: string | null }>();
const emit = defineEmits<{ select: [id: string] }>();
function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
</script>
<template>
  <div class="w-60 shrink-0 border-r border-navy-600 bg-navy-900/50 flex flex-col">
    <div class="px-4 py-3 border-b border-navy-600 flex items-center justify-between">
      <span class="text-sm font-semibold text-slate-100">Conversations</span>
      <span class="text-[9px] text-navy-500">{{ conversations.length }} total</span>
    </div>
    <div class="flex-1 overflow-y-auto">
      <button v-for="c in conversations" :key="c.id" @click="emit('select', c.id)"
        :class="['w-full text-left px-4 py-3 border-b border-navy-900 hover:bg-navy-800/40',
          activeId === c.id ? 'bg-navy-800/60 border-l-2 border-cyan-400 !pl-[14px]' : '']">
        <div class="flex items-center gap-2 mb-1">
          <StatusDot :status="c.status === 'active' ? 'live' : 'complete'" />
          <span class="font-mono text-[11px] text-slate-100 truncate">{{ c.id }}</span>
          <span class="ml-auto text-[9px] text-navy-500 shrink-0">{{ ago(c.updatedAt) }}</span>
        </div>
        <p class="text-[10px] text-navy-400 pl-4 truncate">{{ c.participantIds.join(' · ') }}</p>
      </button>
    </div>
  </div>
</template>
<script>
import StatusDot from '../common/StatusDot.vue';
</script>
```

`ConversationThread.vue`:
```vue
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { MessageEntry } from './ToolCallBlock.vue';
import SubThreadBlock from './SubThreadBlock.vue';
import { useEventStream } from '../../composables/useEventStream.js';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{ conversationId: string | null }>();
const { execute } = useExecute();
const { subscribe } = useEventStream();

const messages = ref<MessageEntry[]>([]);
const isLive = ref(false);

const authorColours: Record<string, string> = {};
const palette = ['#22d3ee', '#f59e0b', '#a78bfa', '#4ade80', '#f87171'];
let colourIdx = 0;
function colourFor(author: string) {
  if (!authorColours[author]) authorColours[author] = palette[colourIdx++ % palette.length]!;
  return authorColours[author]!;
}

async function load(id: string) {
  const data = await execute<{ messages: any[] }>('get_conversation', { id });
  messages.value = (data.messages ?? []).map((m: any) => ({
    id: m.id, author: m.participantId, authorColour: colourFor(m.participantId),
    content: m.content ?? '', timestamp: new Date(m.createdAt).toLocaleTimeString(),
    toolCalls: (m.toolCalls ?? []).map((tc: any) => ({
      id: tc.callId, tool: tc.tool,
      type: tc.tool === 'send_message' ? 'delegation' : 'tool:call',
      args: tc.arguments, timestamp: '',
    })),
  }));
}

watch(() => props.conversationId, async (id) => {
  if (!id) return;
  await load(id);
  isLive.value = true;
});

const off = subscribe((evt) => {
  if (evt.event === 'message:sent' && (evt.data as any).conversationId === props.conversationId) {
    if (props.conversationId) load(props.conversationId);
  }
});
onUnmounted(() => off());
</script>

<template>
  <div v-if="conversationId" class="flex-1 flex flex-col min-h-0">
    <div class="px-5 py-3 border-b border-navy-600 bg-navy-900 flex items-center gap-3">
      <span class="font-mono text-xs font-semibold text-slate-100">{{ conversationId }}</span>
      <StatusDot v-if="isLive" status="live" />
      <span v-if="isLive" class="text-[10px] text-cyan-400">Live</span>
    </div>
    <div class="flex-1 overflow-y-auto px-5 py-4">
      <SubThreadBlock :messages="messages" />
    </div>
    <div class="px-5 py-2.5 border-t border-navy-600 bg-navy-900">
      <span class="text-[10px] text-navy-500 italic">Read-only monitoring view.</span>
    </div>
  </div>
  <div v-else class="flex-1 flex items-center justify-center">
    <p class="text-navy-500 text-sm">Select a conversation</p>
  </div>
</template>
<script>
import StatusDot from '../common/StatusDot.vue';
</script>
```

- [ ] **Step 10: Create `ConversationsView.vue`**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ConversationSummary } from '@legion/types';
import AppLayout from '../components/layout/AppLayout.vue';
import ConversationList from '../components/conversations/ConversationList.vue';
import ConversationThread from '../components/conversations/ConversationThread.vue';
import { useExecute } from '../composables/useExecute.js';

const { execute } = useExecute();
const route = useRoute();
const router = useRouter();

const conversations = ref<ConversationSummary[]>([]);
const activeId = ref<string | null>((route.params.id as string) ?? null);

onMounted(async () => {
  conversations.value = await execute<ConversationSummary[]>('list_conversations', {});
});

async function select(id: string) {
  activeId.value = id;
  await router.push(`/conversations/${id}`);
}
</script>

<template>
  <AppLayout>
    <div class="flex h-full">
      <ConversationList :conversations="conversations" :active-id="activeId" @select="select" />
      <ConversationThread :conversation-id="activeId" />
    </div>
  </AppLayout>
</template>
```

- [ ] **Step 11: Commit**

```bash
git add packages/web/src/renderers/ packages/web/src/components/conversations/ \
  packages/web/src/views/ConversationsView.vue
git commit -m "feat(web): conversations screen — two-pane, nested threads, tool renderer registry"
```

---

## Task 10: Event stream screen

**Files:**
- Create: `packages/web/src/components/events/EventDetailPanel.vue`
- Create: `packages/web/src/components/events/EventTable.vue`
- Create: `packages/web/src/views/EventStreamView.vue`

- [ ] **Step 1: Create `EventDetailPanel.vue`**

```vue
<script setup lang="ts">
defineProps<{ event: { type: string; event: string; data: unknown } | null }>();
function fmt(v: unknown) { return JSON.stringify(v, null, 2); }
</script>
<template>
  <div class="w-72 shrink-0 border-l border-navy-600 flex flex-col bg-navy-800/40">
    <div class="px-4 py-3 border-b border-navy-600 flex items-center justify-between">
      <span class="text-xs font-semibold text-slate-100">Event detail</span>
      <TypeBadge v-if="event" :type="event.event" />
    </div>
    <pre v-if="event" class="flex-1 text-[10px] font-mono text-navy-400 p-4 overflow-auto leading-relaxed whitespace-pre-wrap">{{ fmt(event.data) }}</pre>
    <div v-else class="flex-1 flex items-center justify-center text-navy-600 text-xs">Select an event</div>
  </div>
</template>
<script>
import TypeBadge from '../common/TypeBadge.vue';
</script>
```

- [ ] **Step 2: Create `EventStreamView.vue`**

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import AppLayout from '../components/layout/AppLayout.vue';
import EventDetailPanel from '../components/events/EventDetailPanel.vue';
import TypeBadge from '../components/common/TypeBadge.vue';
import { useEventStream } from '../composables/useEventStream.js';

interface LiveEvent { id: string; type: string; event: string; data: unknown; time: string }

const { subscribe } = useEventStream();
const events = ref<LiveEvent[]>([]);
const selected = ref<LiveEvent | null>(null);
const paused = ref(false);
const filters = ref(new Set(['message:sent', 'tool:call', 'tool:result', 'error']));
const search = ref('');

let idSeq = 0;
const off = subscribe((evt) => {
  if (paused.value) return;
  const le: LiveEvent = { id: String(idSeq++), type: 'event', event: evt.event,
    data: evt.data, time: new Date().toLocaleTimeString() };
  events.value.unshift(le);
  if (events.value.length > 500) events.value.splice(500);
});
onUnmounted(() => off());

const chips = [
  { label: 'message', events: ['message:sent', 'message:delivered'] },
  { label: 'tool',    events: ['tool:call', 'tool:result'] },
  { label: 'error',   events: ['error'] },
  { label: 'system',  events: ['conversation:created', 'participant:active', 'participant:retired', 'process:ready'] },
];

function toggleChip(chip: typeof chips[number]) {
  for (const e of chip.events) {
    if (filters.value.has(e)) filters.value.delete(e);
    else filters.value.add(e);
  }
}

function chipActive(chip: typeof chips[number]) {
  return chip.events.some((e) => filters.value.has(e));
}

const visible = ref<LiveEvent[]>([]);
// Simple computed won't work well with Set reactivity; use watch instead
import { watch } from 'vue';
watch([events, filters, search], () => {
  visible.value = events.value.filter((e) =>
    filters.value.has(e.event) &&
    (!search.value || JSON.stringify(e.data).includes(search.value)),
  );
}, { immediate: true });

function summary(e: LiveEvent): string {
  const d = e.data as Record<string, unknown>;
  if (d.participantId) return `${d.participantId as string}`;
  if (d.conversationId) return `conv ${d.conversationId as string}`;
  return '';
}
</script>

<template>
  <AppLayout>
    <div class="flex flex-col h-full">
      <!-- Toolbar -->
      <div class="flex items-center gap-3 px-4 py-2.5 border-b border-navy-600 bg-navy-900 flex-wrap">
        <div class="flex items-center gap-1.5">
          <StatusDot :status="paused ? 'retired' : 'live'" />
          <span :class="['text-xs font-semibold', paused ? 'text-navy-400' : 'text-cyan-400']">
            {{ paused ? 'Paused' : 'Live' }}
          </span>
        </div>
        <div class="w-px h-4 bg-navy-600" />
        <span class="text-[10px] text-navy-500">Filter:</span>
        <button v-for="chip in chips" :key="chip.label" @click="toggleChip(chip)"
          :class="['text-[10px] px-2.5 py-1 rounded-full border transition-colors',
            chipActive(chip) ? 'bg-cyan-400 text-navy-950 border-transparent font-semibold' : 'border-navy-600 text-navy-400']">
          {{ chip.label }}
        </button>
        <input v-model="search" placeholder="filter by participant or conv…"
          class="bg-navy-950 border border-navy-600 rounded px-2.5 py-1 text-xs text-slate-300 outline-none w-48" />
        <button @click="paused = !paused" class="ml-auto text-xs px-3 py-1.5 rounded border"
          :class="paused ? 'border-amber-400/30 text-amber-400' : 'border-cyan-400/30 text-cyan-400'">
          {{ paused ? '▶ Resume' : '⏸ Pause' }}
        </button>
      </div>

      <div class="flex flex-1 min-h-0">
        <!-- Event list -->
        <div class="flex-1 overflow-y-auto">
          <table class="w-full border-collapse text-xs">
            <thead class="sticky top-0 bg-navy-950">
              <tr>
                <th v-for="h in ['Time', 'Event', 'Detail', 'Conv']" :key="h"
                  class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-3 py-2 font-semibold border-b border-navy-700">
                  {{ h }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in visible" :key="e.id"
                @click="selected = e"
                :class="['border-b border-navy-900 cursor-pointer hover:bg-navy-800/40',
                  selected?.id === e.id ? 'bg-navy-800/60' : '']">
                <td class="px-3 py-1.5 font-mono text-[10px] text-navy-500 whitespace-nowrap">{{ e.time }}</td>
                <td class="px-3 py-1.5"><TypeBadge :type="e.event" /></td>
                <td class="px-3 py-1.5 text-slate-400 truncate max-w-xs">{{ summary(e) }}</td>
                <td class="px-3 py-1.5 font-mono text-[9px] text-navy-600 whitespace-nowrap">
                  {{ (e.data as any).conversationId ?? '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <EventDetailPanel :event="selected" />
      </div>
    </div>
  </AppLayout>
</template>
<script>
import StatusDot from '../components/common/StatusDot.vue';
</script>
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/events/ packages/web/src/views/EventStreamView.vue
git commit -m "feat(web): event stream screen — live feed, filter chips, detail panel, pause"
```

---

## Task 11: Configuration screen

**Files:**
- Create: `packages/web/src/components/config/ProviderSlideOver.vue`
- Create: `packages/web/src/components/config/CredentialSlideOver.vue`
- Create: `packages/web/src/views/ConfigView.vue`

- [ ] **Step 1: Create `ProviderSlideOver.vue`**

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ProviderConfig } from '@legion/types';
import SlideOver from '../common/SlideOver.vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{ open: boolean; provider: ProviderConfig | null; credentialKeys: string[] }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const name = ref('');
const type = ref<ProviderConfig['type']>('openai-compatible');
const baseUrl = ref('');
const defaultModel = ref('');
const credentialKey = ref('');
const saving = ref(false);

watch(() => props.open, (open) => {
  if (!open) return;
  name.value = props.provider?.name ?? '';
  type.value = props.provider?.type ?? 'openai-compatible';
  baseUrl.value = props.provider?.baseUrl ?? '';
  defaultModel.value = props.provider?.defaultModel ?? '';
  credentialKey.value = props.provider?.credentialKey ?? '';
});

async function save() {
  saving.value = true;
  try {
    await execute('configure_provider', { name: name.value, type: type.value,
      baseUrl: baseUrl.value || undefined, defaultModel: defaultModel.value,
      credentialKey: credentialKey.value || undefined });
    emit('saved'); emit('close');
  } finally { saving.value = false; }
}
</script>

<template>
  <SlideOver :open="open" :title="provider ? 'Edit provider' : 'Add provider'" @close="emit('close')">
    <div class="p-5 space-y-4">
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Name</label>
        <input v-model="name" :readonly="!!provider"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none" />
        <p class="text-[10px] text-navy-500 mt-1">Cannot change after creation.</p>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Type</label>
        <select v-model="type" class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100">
          <option>openai-compatible</option><option>anthropic</option><option>copilot</option><option>codex</option>
        </select>
      </div>
      <div v-if="type === 'openai-compatible'">
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Base URL</label>
        <input v-model="baseUrl" class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none" />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Default model</label>
        <input v-model="defaultModel" class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none" />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Credential key</label>
        <select v-model="credentialKey" class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono">
          <option value="">— none —</option>
          <option v-for="k in credentialKeys" :key="k" :value="k">{{ k }}</option>
        </select>
      </div>
    </div>
    <template #footer>
      <div class="flex justify-end gap-2 px-5 py-3">
        <button @click="emit('close')" class="text-xs px-3 py-1.5 border border-navy-600 text-navy-400 rounded">Cancel</button>
        <button @click="save" :disabled="saving" class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </template>
  </SlideOver>
</template>
```

- [ ] **Step 2: Create `CredentialSlideOver.vue`**

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import type { CredentialInfo } from '@legion/types';
import SlideOver from '../common/SlideOver.vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{ open: boolean; credential: CredentialInfo | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const key = ref('');
const value = ref('');
const saving = ref(false);
const isNew = ref(true);

watch(() => props.open, (open) => {
  if (!open) return;
  isNew.value = !props.credential;
  key.value = props.credential?.key ?? '';
  value.value = '';
});

async function save() {
  saving.value = true;
  try {
    await execute('set_credential_with_meta', { key: key.value, value: value.value,
      usedBy: props.credential?.usedBy ?? [] });
    emit('saved'); emit('close');
  } finally { saving.value = false; }
}
</script>

<template>
  <SlideOver :open="open" :title="isNew ? 'Add credential' : 'Rotate credential'" @close="emit('close')">
    <div class="p-5 space-y-4">
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Key name</label>
        <input v-model="key" :readonly="!isNew"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 outline-none" />
        <p v-if="!isNew" class="text-[10px] text-navy-500 mt-1">Delete and re-add to rename.</p>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">
          {{ isNew ? 'Value' : 'New value' }}
        </label>
        <input v-model="value" type="password"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 outline-none" />
        <p class="text-[10px] text-navy-500 mt-1">Write-only. Current value cannot be retrieved.</p>
      </div>
      <div v-if="credential" class="bg-navy-900 border border-navy-600 rounded p-3">
        <p class="text-[10px] text-navy-400 mb-2">Used by</p>
        <span v-for="p in credential.usedBy" :key="p"
          class="inline-block text-[10px] font-mono bg-cyan-400/10 border border-cyan-400/20 text-cyan-400 px-2 py-0.5 rounded mr-1">
          {{ p }}
        </span>
        <p class="text-[10px] text-navy-500 mt-2">Saving takes effect immediately — no restart required.</p>
      </div>
    </div>
    <template #footer>
      <div class="flex justify-end gap-2 px-5 py-3">
        <button @click="emit('close')" class="text-xs px-3 py-1.5 border border-navy-600 text-navy-400 rounded">Cancel</button>
        <button @click="save" :disabled="saving || !value"
          class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </template>
  </SlideOver>
</template>
```

- [ ] **Step 3: Create `ConfigView.vue`**

```vue
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

function openProvider(p: ProviderConfig | null) { editingProvider.value = p; providerSlide.value = true; }
function openCredential(c: CredentialInfo | null) { editingCredential.value = c; credSlide.value = true; }

const typeBadge: Record<string, string> = {
  'openai-compatible': 'bg-green-400/10 text-green-400 border-green-400/20',
  anthropic:           'bg-amber-400/10 text-amber-400 border-amber-400/20',
};
</script>

<template>
  <AppLayout>
    <div class="bg-navy-900 border-b border-navy-600">
      <div class="px-5 pt-4 pb-0">
        <h1 class="text-sm font-semibold text-slate-100 mb-3">Configuration</h1>
        <div class="flex gap-0">
          <button v-for="tab in ['providers', 'credentials']" :key="tab"
            @click="activeTab = tab"
            :class="['px-4 py-2 text-xs font-medium border-b-2 capitalize transition-colors',
              activeTab === tab ? 'text-slate-100 border-cyan-400' : 'text-navy-400 border-transparent']">
            {{ tab }}
          </button>
        </div>
      </div>
    </div>

    <div class="p-5">
      <!-- Providers tab -->
      <template v-if="activeTab === 'providers'">
        <div class="flex items-start justify-between mb-4">
          <p class="text-xs text-navy-400 max-w-lg leading-relaxed">Provider instances available to agents. Each references a credential for authentication.</p>
          <button @click="openProvider(null)" class="shrink-0 ml-4 text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded">+ Add provider</button>
        </div>
        <table class="w-full border-collapse bg-navy-900 rounded-lg border border-navy-600 overflow-hidden text-xs">
          <thead class="bg-navy-950">
            <tr>
              <th v-for="h in ['Name', 'Type', 'Base URL', 'Default model', 'Credential', '']" :key="h"
                class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-3 py-2 font-semibold">{{ h }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in providers" :key="p.name" class="border-t border-navy-700 hover:bg-navy-800/40">
              <td class="px-3 py-2.5 font-mono text-slate-100 font-medium">{{ p.name }}</td>
              <td class="px-3 py-2.5">
                <span :class="['text-[9px] font-bold px-1.5 py-0.5 rounded border', typeBadge[p.type] ?? 'bg-navy-700/50 text-navy-400 border-navy-600']">
                  {{ p.type }}
                </span>
              </td>
              <td class="px-3 py-2.5 font-mono text-navy-400 text-[10px]">{{ p.baseUrl ?? '—' }}</td>
              <td class="px-3 py-2.5 font-mono text-navy-400 text-[10px]">{{ p.defaultModel }}</td>
              <td class="px-3 py-2.5">
                <span v-if="p.credentialKey" class="text-[10px] font-mono bg-cyan-400/10 border border-cyan-400/20 text-cyan-400 px-2 py-0.5 rounded">
                  {{ p.credentialKey }}
                </span>
                <span v-else class="text-navy-600 text-[10px] italic">none</span>
              </td>
              <td class="px-3 py-2.5 text-right">
                <button @click="openProvider(p)" class="text-navy-400 hover:text-slate-200 mr-2">Edit</button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- Credentials tab -->
      <template v-else>
        <div class="flex items-start justify-between mb-4">
          <p class="text-xs text-navy-400 max-w-lg leading-relaxed">Named secrets stored encrypted at rest. Values are write-only after saving.</p>
          <button @click="openCredential(null)" class="shrink-0 ml-4 text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded">+ Add credential</button>
        </div>
        <table class="w-full border-collapse bg-navy-900 rounded-lg border border-navy-600 overflow-hidden text-xs">
          <thead class="bg-navy-950">
            <tr>
              <th v-for="h in ['Key name', 'Value', 'Used by', 'Last updated', '']" :key="h"
                class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-3 py-2 font-semibold">{{ h }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in credentials" :key="c.key" class="border-t border-navy-700 hover:bg-navy-800/40">
              <td class="px-3 py-2.5 font-mono text-slate-100 font-medium">{{ c.key }}</td>
              <td class="px-3 py-2.5 font-mono text-navy-500 text-[10px] tracking-wider">{{ c.maskedValue }}</td>
              <td class="px-3 py-2.5">
                <span v-for="p in c.usedBy" :key="p" class="text-[9px] font-mono bg-cyan-400/10 border border-cyan-400/20 text-cyan-400 px-1.5 py-0.5 rounded mr-1">{{ p }}</span>
                <span v-if="!c.usedBy.length" class="text-navy-600 text-[10px] italic">unused</span>
              </td>
              <td class="px-3 py-2.5 text-navy-500 text-[10px]">{{ new Date(c.updatedAt).toLocaleDateString() }}</td>
              <td class="px-3 py-2.5 text-right">
                <button @click="openCredential(c)" class="text-navy-400 hover:text-slate-200">Rotate</button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>

    <ProviderSlideOver :open="providerSlide" :provider="editingProvider"
      :credential-keys="credentials.map((c) => c.key)"
      @close="providerSlide = false" @saved="load" />
    <CredentialSlideOver :open="credSlide" :credential="editingCredential"
      @close="credSlide = false" @saved="load" />
  </AppLayout>
</template>
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/config/ packages/web/src/views/ConfigView.vue
git commit -m "feat(web): configuration screen — providers and credentials tabs with slide-overs"
```

---

## Task 12: Build integration + full verification

**Files:**
- Modify: `packages/runtime/src/server/WebConnector.ts` (verify static file path already wired)

- [ ] **Step 1: Build `@legion/web`**

```bash
cd packages/web && npm run build
```

Expected: `packages/web/dist/index.html` exists. No TypeScript errors. No Vite build errors.

- [ ] **Step 2: Verify static serving from `@legion/runtime`**

Plan 10 Decision: `@fastify/static` only registered when `packages/web/dist/` exists. Confirm in `packages/runtime/src/server/WebConnector.ts`:

```typescript
// Should already exist from Plan 10 — verify this block is present:
const webDistPath = new URL('../../../../web/dist', import.meta.url).pathname;
if (existsSync(webDistPath)) {
  await app.register(fastifyStatic, { root: webDistPath, wildcard: false });
  app.get('/*', (_req, reply) => reply.sendFile('index.html'));
}
```

If missing, add it.

- [ ] **Step 3: Run all server-side tests**

```bash
npm test
```

Expected: all `packages/{types,core,runtime}` tests PASS (packages/web excluded by root vitest config).

- [ ] **Step 4: Run web-specific tests**

```bash
cd packages/web && npm test
```

Expected: all composable and component tests PASS.

- [ ] **Step 5: Type-check the web package**

```bash
cd packages/web && npx vue-tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 6: Update the roadmap**

In `docs/superpowers/plans/000-roadmap.md`:
- Mark Plan 11 status as "Plan written"
- Check `[ ] Plan 11 written` → `[x] Plan 11 written`

- [ ] **Step 7: Final commit**

```bash
git add docs/superpowers/plans/000-roadmap.md
git commit -m "chore: mark Plan 11 written in roadmap"
```

---

## Self-review

**Spec coverage check:**

| Spec requirement | Covered by |
|-----------------|-----------|
| Vue 3 + Vite + Tailwind v4 | Task 1 |
| `@legion/web` depends on `@legion/types` only | Task 1 tsconfig, no core imports |
| Navy/cyan colour palette | Task 1 `style.css` `@theme` block |
| Login screen | Task 5 `LoginView.vue` |
| Persistent left sidebar | Task 7 `AppSidebar.vue` |
| Participants: table list | Task 8 `ParticipantsView.vue` |
| Participants: slide-over with Basic + Tool policies tabs | Task 8 `ParticipantSlideOver.vue` |
| Tool policies: checkbox whitelist + require approval toggle | Task 8 `ToolPolicyEditor.vue` |
| `modify_agent` tool (new) | Task 3 |
| `list_tools` tool (new) | Task 3 |
| Conversations: two-pane | Task 9 `ConversationsView.vue` |
| Recursive nested delegation threads | Task 9 `SubThreadBlock.vue` |
| Tool renderer registry + built-in renderers | Task 9 |
| Event stream: live feed + filter chips + pause | Task 10 `EventStreamView.vue` |
| Event detail panel | Task 10 `EventDetailPanel.vue` |
| Config: Providers tab | Task 11 `ConfigView.vue` |
| Config: Credentials tab (write-only, masked) | Task 11 |
| `list_providers`, `configure_provider`, `list_credentials` (new) | Task 4 |
| `useAuth` singleton with `useLocalStorage` | Task 5 |
| `useEventStream` with reconnect | Task 6 |
| Static serving from `@legion/runtime` | Task 12 |
| `participant:active` / `participant:retired` events | Task 2 |
| `Collective.modify()` | Task 2 |
| `create_agent` config persistence | Task 2 |

**Placeholder scan:** No TBD/TODO present. All code blocks are complete.

**Type consistency:**
- `ToolOverride` defined in `ToolPolicyEditor.vue` and imported in `ParticipantSlideOver.vue` ✓
- `MessageEntry` / `ToolCallEntry` defined in `ToolCallBlock.vue`, imported by `SubThreadBlock.vue` and `ConversationThread.vue` ✓
- `ConversationSummary`, `ProviderConfig`, `CredentialInfo`, `AgentConfig` all defined in `@legion/types` ✓
- `lookupRenderer` imported from `./index.js` in `ToolResultRenderer.vue` ✓
- `useAuth().getToken()` used in both `useAuth.ts` and `useExecute.ts` ✓
```
