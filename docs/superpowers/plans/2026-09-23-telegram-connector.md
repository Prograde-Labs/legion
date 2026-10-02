# Telegram Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human talk to a Legion collective from Telegram — identity-mapped participants, general tool calls (kwargs / form-fill, no hand-written JSON), outbound delivery, inline-button approvals.

**Architecture:** Two deliverables: (1) a generic config-driven connector loader in `packages/runtime` (built-in `web` + external modules via the same resolve-and-import convention services use), and (2) a standalone `legion-connector-telegram` package implementing the §6 `Connector` interface with grammY long polling. The connector adds one small core tool (`list_tools`) for discovery.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, grammY ^1.46.0 (long polling + `handleUpdate()` for tests).

**Spec:** `docs/superpowers/specs/2026-09-23-telegram-connector-design.md` (read it first — this plan argues from it).

## Global Constraints

- Legion repo: `/workspace/legion` (npm workspaces, pure ESM, `"type": "module"`, Node ≥ 20, TS ^5.5 strict + `noUnusedLocals` + `noUnusedParameters` + `verbatimModuleSyntax`).
- All relative imports in `.ts` source use `.js` extensions (NodeNext). Type-only imports use `import type`.
- Prettier: single quotes, semicolons, trailing commas, 100 cols, 2-space. Run `npm run format` before committing in the Legion repo.
- Required gate before claiming done in the Legion repo: `npm run format:check` → `npm run typecheck` → `npm test`.
- Vitest: root config has `globals: true`; test files live next to source as `*.test.ts`; `packages/web` excluded (not touched here).
- Connector package: own repo `/workspace/legion-connector-telegram`; grammY is the **only runtime dependency**; Legion packages are devDependencies (type conformance only) — verified via `tsc --emitDeclarationOnly`.
- Bot token resolution: `options.botToken ?? process.env[options.botTokenEnv ?? 'TELEGRAM_BOT_TOKEN']`; missing → throw at construction. Tokens never in committed config.
- Identity key is the **chat id** (`String(update.message.chat.id)`), resolved via `Collective.findByIdentity('telegram', chatId)`. Unknown sender + no `defaultParticipantId` → polite rejection, no state change.
- Tool policies: `ToolPolicy = 'auto' | 'requires_approval'`; a tool is visible iff `participant.tools[name] !== undefined` (AuthEngine returns `{authorized: false, reason: 'hidden'}` otherwise).
- Event payloads (from `@legion-collective/types` `LegionEventMap`): `approval:requested → {conversationId, participantId, tool, approvalId}`; `approval:resolved → {conversationId, approvalId, approved, decidedByParticipantId}`.
- `ConnectorContext.callTool(participantId, toolName, args, opts?) → {result: ToolResult, conversationId: string}`; `ToolResult = {status: 'success'|'error'|'pending_approval'|'rejected', data?, error?, approvalId?, message?}`.
- `Tool.execute(args, context): Promise<unknown>` — successful tools return `{status: 'success', data: ...}` like `list-middleware-tool.ts` does.
- Commit as Chris's git identity (already configured globally). Branch: `feat/telegram-connector` off `main` in the Legion repo; the connector repo starts its own git history on `main`.

---

### Task 1: ConnectorRuntimeDeps + generic connector loader (unit-tested, not yet wired)

**Files:**

- Create: `packages/core/src/connectors/ConnectorRuntimeDeps.ts`
- Modify: `packages/core/src/connectors/index.ts`
- Create: `packages/runtime/src/server/loadConnectors.ts`
- Test: `packages/runtime/src/server/loadConnectors.test.ts`

**Interfaces:**

- Consumes: `Connector`, `ConnectorRegistry` (core, existing); `ConnectorConfig` (types, existing — `module` field added in Task 2).
- Produces: `ConnectorRuntimeDeps {collective: Collective; eventBus: EventBus}` (exported from `@legion-collective/core`); `ConnectorFactory = (options: Record<string, unknown>, deps: ConnectorRuntimeDeps) => Connector`; `loadAndStartConnectors(deps: LoadConnectorsDeps): Promise<void>` where `LoadConnectorsDeps = {configs: ConnectorConfig[]; connectorRegistry: ConnectorRegistry; workspaceRoot: string; runtimeDeps: ConnectorRuntimeDeps; createWebConnector: () => Connector; buildContext: () => ConnectorContext}`.

- [ ] **Step 1: Create the feature branch**

```bash
cd /workspace/legion
git checkout -b feat/telegram-connector
```

- [ ] **Step 2: Write the ConnectorRuntimeDeps type (no test — pure type)**

Create `packages/core/src/connectors/ConnectorRuntimeDeps.ts`:

```typescript
import type { Collective } from '../collective/Collective.js';
import type { EventBus } from '../events/EventBus.js';

/**
 * Runtime internals handed to external connector factories at construction time.
 * Everything else a connector needs arrives through `ConnectorContext` at `start()`.
 */
export interface ConnectorRuntimeDeps {
  /** Read access for identity mapping (`findByIdentity`). */
  collective: Collective;
  /** Subscribe to runtime events (e.g. `approval:requested`). */
  eventBus: EventBus;
}

export type ConnectorFactory = (
  options: Record<string, unknown>,
  deps: ConnectorRuntimeDeps,
) => Connector;
```

Add the `Connector` import at the top of that file — it needs `import type { Connector } from './Connector.js';` (include it in the import block above; `verbatimModuleSyntax` requires `import type`).

Modify `packages/core/src/connectors/index.ts` — add:

```typescript
export type { ConnectorRuntimeDeps, ConnectorFactory } from './ConnectorRuntimeDeps.js';
```

- [ ] **Step 3: Write the failing loader tests**

Create `packages/runtime/src/server/loadConnectors.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector, ConnectorContext } from '@legion-collective/core';
import { ConnectorRegistry } from '@legion-collective/core';
import type { ConnectorConfig } from '@legion-collective/types';
import { loadAndStartConnectors } from './loadConnectors.js';

function fakeConnector(name: string): Connector {
  return {
    name,
    start: async () => undefined,
    deliver: async () => undefined,
    stop: async () => undefined,
  };
}

const noopContext = {} as ConnectorContext;

function baseDeps(overrides: Partial<Parameters<typeof loadAndStartConnectors>[0]> = {}) {
  return {
    configs: [] as ConnectorConfig[],
    connectorRegistry: new ConnectorRegistry(),
    workspaceRoot: '/tmp/does-not-matter',
    runtimeDeps: {} as never,
    createWebConnector: () => fakeConnector('web'),
    buildContext: () => noopContext,
    ...overrides,
  };
}

// -- built-in web -----------------------------------------------------------

it('registers and starts the built-in web connector by default', async () => {
  const registry = new ConnectorRegistry();
  const created: string[] = [];
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'web' }],
      connectorRegistry: registry,
      createWebConnector: () => {
        created.push('web');
        return fakeConnector('web');
      },
    }),
  );
  expect(created).toEqual(['web']);
  expect(registry.get('web')).toBeDefined();
});

it('defaults to a single web connector entry when configs is empty', async () => {
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(baseDeps({ connectorRegistry: registry }));
  expect(registry.get('web')).toBeDefined();
});

it('skips disabled entries', async () => {
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({ configs: [{ name: 'web', enabled: false }], connectorRegistry: registry }),
  );
  expect(registry.get('web')).toBeUndefined();
});

it('propagates web connector construction failure (fail-fast)', async () => {
  await expect(
    loadAndStartConnectors(
      baseDeps({
        createWebConnector: () => {
          throw new Error('spa missing');
        },
      }),
    ),
  ).rejects.toThrow('spa missing');
});

// -- external modules -------------------------------------------------------

it('loads an external connector from an absolute module path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'my-connector.mjs');
  writeFileSync(
    modPath,
    'export function connector() { return { name: "ext", start: async () => {}, deliver: async () => {}, stop: async () => {} }; }',
  );
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'ext', module: modPath }],
      connectorRegistry: registry,
    }),
  );
  expect(registry.get('ext')).toBeDefined();
});

it('loads an external connector from a workspace-relative module path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  writeFileSync(
    join(dir, 'rel-connector.mjs'),
    'export function connector() { return { name: "rel", start: async () => {}, deliver: async () => {}, stop: async () => {} }; }',
  );
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'rel', module: './rel-connector.mjs' }],
      connectorRegistry: registry,
      workspaceRoot: dir,
    }),
  );
  expect(registry.get('rel')).toBeDefined();
});

it('resolves a bare specifier from the workspace root node_modules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const pkgDir = join(dir, 'node_modules', 'fake-connector');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'fake-connector', version: '1.0.0', type: 'module', main: 'index.js' }),
  );
  writeFileSync(
    join(pkgDir, 'index.js'),
    'export function connector() { return { name: "bare", start: async () => {}, deliver: async () => {}, stop: async () => {} }; }',
  );
  // require.resolve needs a real package entry; also symlink layout sanity
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'bare', module: 'fake-connector' }],
      connectorRegistry: registry,
      workspaceRoot: dir,
    }),
  );
  expect(registry.get('bare')).toBeDefined();
});

it('skips a broken external module and still boots the web connector', async () => {
  const errSpy: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errSpy.push(args.join(' '));
  });
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({
      configs: [
        { name: 'broken', module: '/definitely/not/anywhere/connector.mjs' },
        { name: 'web' },
      ],
      connectorRegistry: registry,
    }),
  );
  spy.mockRestore();
  expect(registry.get('broken')).toBeUndefined();
  expect(registry.get('web')).toBeDefined();
  expect(errSpy.some((line) => line.includes('broken'))).toBe(true);
});

it('skips an external module that exports no connector factory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'nofactory.mjs');
  writeFileSync(modPath, 'export const notAFactory = 1;');
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({ configs: [{ name: 'nof', module: modPath }], connectorRegistry: registry }),
  );
  spy.mockRestore();
  expect(registry.get('nof')).toBeUndefined();
});

it('passes options and runtimeDeps to the external factory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'opted.mjs');
  writeFileSync(
    modPath,
    `export function connector(options, deps) {
      globalThis.__lastFactoryArgs = { options, deps };
      return { name: 'opted', start: async () => {}, deliver: async () => {}, stop: async () => {} };
    }`,
  );
  const runtimeDeps = { collective: { marker: true }, eventBus: { marker: true } } as never;
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'opted', module: modPath, options: { botTokenEnv: 'X' } }],
      runtimeDeps,
    }),
  );
  const args = (globalThis as Record<string, unknown>).__lastFactoryArgs as {
    options: Record<string, unknown>;
    deps: unknown;
  };
  expect(args.options).toEqual({ botTokenEnv: 'X' });
  expect(args.deps).toBe(runtimeDeps);
});

it('deregisters an external connector whose start() throws and keeps the process alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'badstart.mjs');
  writeFileSync(
    modPath,
    `export function connector() {
      return { name: 'badstart', start: async () => { throw new Error('bad token'); }, deliver: async () => {}, stop: async () => {} };
    }`,
  );
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const registry = new ConnectorRegistry();
  const web = fakeConnector('web');
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'badstart', module: modPath }, { name: 'web' }],
      connectorRegistry: registry,
      createWebConnector: () => web,
    }),
  );
  spy.mockRestore();
  expect(registry.get('badstart')).toBeUndefined();
  expect(registry.get('web')).toBeDefined();
});

it('rejects duplicate connector names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'dupe.mjs');
  writeFileSync(
    modPath,
    'export function connector() { return { name: "web", start: async () => {}, deliver: async () => {}, stop: async () => {} }; }',
  );
  await expect(
    loadAndStartConnectors(
      baseDeps({ configs: [{ name: 'web' }, { name: 'web', module: modPath }] }),
    ),
  ).rejects.toThrow(/already registered/);
});
```

Note: `symlinkSync` import is unused in this draft — remove it from the import list to satisfy `noUnusedLocals`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run packages/runtime/src/server/loadConnectors.test.ts`
Expected: FAIL — `Cannot find module './loadConnectors.js'`

- [ ] **Step 5: Implement the loader**

Create `packages/runtime/src/server/loadConnectors.ts`:

```typescript
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Connector,
  ConnectorContext,
  ConnectorRegistry,
  ConnectorRuntimeDeps,
} from '@legion-collective/core';
import type { ConnectorConfig } from '@legion-collective/types';

export interface LoadConnectorsDeps {
  configs: ConnectorConfig[];
  connectorRegistry: ConnectorRegistry;
  workspaceRoot: string;
  runtimeDeps: ConnectorRuntimeDeps;
  /** Builds the built-in web connector with its runtime-internal dependencies. */
  createWebConnector: () => Connector;
  /** Builds the shared ConnectorContext once all connectors are registered. */
  buildContext: () => ConnectorContext;
}

function resolveConnectorModule(spec: string, workspaceRoot: string): string {
  if (isAbsolute(spec)) return pathToFileURL(spec).href;
  const require = createRequire(join(workspaceRoot, 'package.json'));
  try {
    return pathToFileURL(require.resolve(spec)).href;
  } catch {
    const direct = resolve(workspaceRoot, spec);
    if (existsSync(direct)) return pathToFileURL(direct).href;
    throw new Error(
      `Connector module '${spec}' not found (tried Node resolution from ${workspaceRoot} and path ${direct})`,
    );
  }
}

async function loadExternalConnector(
  entry: ConnectorConfig,
  workspaceRoot: string,
  runtimeDeps: ConnectorRuntimeDeps,
): Promise<Connector> {
  if (!entry.module) {
    throw new Error(`Connector '${entry.name}' requires a 'module' (built-in names: web)`);
  }
  const resolved = resolveConnectorModule(entry.module, workspaceRoot);
  const mod = (await import(resolved)) as Record<string, unknown>;
  const factory = mod.connector;
  if (typeof factory !== 'function') {
    throw new Error(
      `Connector module '${entry.module}' must export a named 'connector' factory ` +
        `(options, deps) => Connector`,
    );
  }
  return (factory as (options: Record<string, unknown>, deps: ConnectorRuntimeDeps) => Connector)(
    entry.options ?? {},
    runtimeDeps,
  );
}

/**
 * Register all configured connectors, build the shared ConnectorContext, then start
 * every connector. The web connector fails fast on construction/start errors; external
 * connectors log-and-skip so a broken plugin cannot take the process down.
 */
export async function loadAndStartConnectors(deps: LoadConnectorsDeps): Promise<void> {
  const registered: Array<{ connector: Connector; external: boolean }> = [];

  for (const entry of deps.configs) {
    if (entry.enabled === false) continue;
    const external = entry.name !== 'web';
    try {
      const connector = external
        ? await loadExternalConnector(entry, deps.workspaceRoot, deps.runtimeDeps)
        : deps.createWebConnector();
      deps.connectorRegistry.register(connector);
      registered.push({ connector, external });
    } catch (err) {
      if (!external) throw err;
      console.error(`  [connectors] failed to load connector '${entry.name}':`, err);
    }
  }

  const context = deps.buildContext();
  for (const { connector, external } of registered) {
    if (!external) {
      await connector.start(context);
      continue;
    }
    try {
      await connector.start(context);
    } catch (err) {
      deps.connectorRegistry.deregister(connector.name);
      console.error(`  [connectors] failed to start connector '${connector.name}':`, err);
    }
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/runtime/src/server/loadConnectors.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 7: Commit**

```bash
cd /workspace/legion
git add packages/core/src/connectors/ConnectorRuntimeDeps.ts packages/core/src/connectors/index.ts packages/runtime/src/server/loadConnectors.ts packages/runtime/src/server/loadConnectors.test.ts
git commit -m "feat(core,runtime): ConnectorRuntimeDeps + generic connector loader"
```

---

### Task 2: `ConnectorConfig.module` + wire the loader into LegionProcess

**Files:**

- Modify: `packages/types/src/config.ts` (add `module?: string` to `ConnectorConfig`)
- Modify: `packages/runtime/src/LegionProcess.ts` (step 9, ~lines 296–344: replace direct web construction with `loadAndStartConnectors`)

**Interfaces:**

- Consumes: `loadAndStartConnectors`, `ConnectorRuntimeDeps` (Task 1); `Collective`/`EventBus` instances already assembled in `start()`.
- Produces: config behavior — `connectors` defaults to `[{name: 'web'}]`; external entries load from `module`. No exported API change beyond `ConnectorConfig.module`.

- [ ] **Step 1: Add the `module` field to `ConnectorConfig`**

In `packages/types/src/config.ts`, extend the interface:

```typescript
export interface ConnectorConfig {
  name: string;
  enabled?: boolean;
  /**
   * For external connectors: npm package name OR absolute/workspace-relative path to
   * built JS. Built-in name 'web' needs no module.
   */
  module?: string;
  defaultParticipantId?: string;
  options?: Record<string, unknown>;
}
```

- [ ] **Step 2: Wire the loader into LegionProcess step 9**

In `packages/runtime/src/LegionProcess.ts`, replace the block from `const webConnector = new WebConnector({` through `await webConnector.start(connectorContext);` with:

```typescript
const dev = options.dev ?? false;
// In dev mode, point Vite at the web package source root (contains index.html + src/).
// In production, serve the pre-built static files from web/dist/.
const webSrcPath = dev
  ? join(_dirname, '..', '..', 'web') // packages/runtime/src/ → packages/web/
  : undefined;
const webDistPath = dev ? undefined : join(_dirname, '..', '..', 'web', 'dist');

await loadAndStartConnectors({
  configs: mergedConfig.connectors ?? [{ name: 'web' }],
  connectorRegistry,
  workspaceRoot,
  runtimeDeps: { collective, eventBus },
  createWebConnector: () =>
    new WebConnector({
      collective,
      credentials,
      eventBus,
      processManager,
      serverConfig: webConnectorConfig,
      webDistPath,
      webSrcPath,
      dev,
    }),
  buildContext: () =>
    buildConnectorContext({
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
      processManager,
      middlewareRegistry,
    }),
});
```

Preserve everything above this block that computes `port`, `webConnectorConfig`, and `_dirname` (the dev/dist path computation moves inside the replacement as shown). Add imports at the top of `LegionProcess.ts`:

```typescript
import { loadAndStartConnectors } from './server/loadConnectors.js';
```

(`ConnectorRuntimeDeps` is not needed as a named import — the object literal is structurally typed.)

- [ ] **Step 3: Run the full gate**

Run:

```bash
npm run format
npm run format:check
npm run typecheck
npm test
```

Expected: all green. If an existing test asserted on web-connector construction order, fix the test to match the new loader flow (behavior preserved: default `[{name:'web'}]`, same register → context → start sequence).

- [ ] **Step 4: Verify the real process still boots (web default, no connectors config)**

Run:

```bash
LEGION_BOOTSTRAP_PASSWORD=smoke-test-$(date +%s) PORT=4199 timeout 12 node packages/runtime/bin/legion.js /tmp/legion-smoke-$(date +%s) 2>&1 | head -20
```

Expected: boot banner, `Web UI: http://127.0.0.1:4199`, no connector errors. (No UI curl check needed here — dist serving is unchanged and covered by existing behavior.)

- [ ] **Step 5: Commit**

```bash
cd /workspace/legion
git add packages/types/src/config.ts packages/runtime/src/LegionProcess.ts
git commit -m "feat(runtime): config-driven connector loading in LegionProcess step 9"
```

---

### Task 3: `list_tools` core tool + registration

**Files:**

- Create: `packages/core/src/tools/list-tools-tool.ts`
- Create: `packages/core/src/tools/list-tools-tool.test.ts`
- Modify: `packages/core/src/index.ts` (export)
- Modify: `packages/runtime/src/LegionProcess.ts` (register + operator policy)

**Interfaces:**

- Consumes: `Tool`, `ToolContext` (`context.participant`, `context.toolRegistry.list()`), `ToolResult`.
- Produces: exported `listToolsTool: Tool` with `name: 'list_tools'`, no parameters; result `{status: 'success', data: {tools: Array<{name, description, parameters}>}}` filtered to tools present in the caller's `tools` map.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/tools/list-tools-tool.test.ts`:

```typescript
import type { ParticipantConfig, ToolResult } from '@legion-collective/types';
import { listToolsTool } from './list-tools-tool.js';
import type { AnyTool, ToolContext, ToolRegistryLike } from './Tool.js';

function makeTool(name: string, description = `${name} description`): AnyTool {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
    execute: async () => ({ status: 'success' }),
  };
}

function makeContext(
  tools: Record<string, 'auto' | 'requires_approval'>,
  registryTools: AnyTool[],
): ToolContext {
  const registry: ToolRegistryLike = {
    get: (name) => registryTools.find((t) => t.name === name),
    has: (name) => registryTools.some((t) => t.name === name),
    list: () => registryTools,
    listAll: () => registryTools.map((t) => t.name),
  } as ToolRegistryLike;
  return {
    participant: { id: 'chris', name: 'Chris', type: 'user', tools } as ParticipantConfig,
    conversationId: 'c1',
    toolRegistry: registry,
  } as unknown as ToolContext;
}

it('lists only tools present in the participant policy', async () => {
  const registryTools = [
    makeTool('communicate'),
    makeTool('list_participants'),
    makeTool('read_file'),
  ];
  const context = makeContext(
    { communicate: 'auto', read_file: 'requires_approval' },
    registryTools,
  );
  const result = (await listToolsTool.execute({}, context)) as ToolResult;
  expect(result.status).toBe('success');
  const tools = (result.data as { tools: Array<{ name: string; description: string }> }).tools;
  expect(tools.map((t) => t.name).sort()).toEqual(['communicate', 'read_file']);
});

it('includes name, description, and parameters for each entry', async () => {
  const registryTools = [makeTool('communicate')];
  const context = makeContext({ communicate: 'auto' }, registryTools);
  const result = (await listToolsTool.execute({}, context)) as ToolResult;
  const entry = (result.data as { tools: Array<Record<string, unknown>> }).tools[0];
  expect(entry.name).toBe('communicate');
  expect(entry.description).toBe('communicate description');
  expect(entry.parameters).toEqual({
    type: 'object',
    properties: { pattern: { type: 'string' } },
  });
});

it('returns an empty list when the participant has no tools', async () => {
  const registryTools = [makeTool('communicate')];
  const context = makeContext({}, registryTools);
  const result = (await listToolsTool.execute({}, context)) as ToolResult;
  expect((result.data as { tools: unknown[] }).tools).toEqual([]);
});

it('list_tools itself is discoverable once registered', () => {
  expect(listToolsTool.name).toBe('list_tools');
  expect(listToolsTool.parameters).toEqual({
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/list-tools-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool**

Create `packages/core/src/tools/list-tools-tool.ts`:

```typescript
import type { ToolResult } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';

/**
 * Discovery tool: returns the name, description, and parameter schema of every
 * registry tool the calling participant's policy makes visible. Fine-grained
 * authorization (auto vs requires_approval) is still enforced per call by AuthEngine.
 */
export const listToolsTool: Tool = {
  name: 'list_tools',
  description:
    'List the tools this participant is authorized to call, with their parameter schemas.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args: unknown, context: ToolContext): Promise<unknown> {
    const policy = context.participant.tools ?? {};
    const tools = context.toolRegistry
      .list()
      .filter((tool) => policy[tool.name] !== undefined)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.parameters),
      }));
    const result: ToolResult = { status: 'success', data: { tools } };
    return result;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/tools/list-tools-tool.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Export from core and register in the runtime**

In `packages/core/src/index.ts`, next to the other tool exports (~line 50):

```typescript
export * from './tools/list-tools-tool.js';
```

In `packages/runtime/src/LegionProcess.ts`:

1. Add `listToolsTool` to the `@legion-collective/core` import list.
2. In step 6, after `toolRegistry.register(approvalResponseTool);` add:

```typescript
toolRegistry.register(listToolsTool);
```

3. In `ensureBootstrapRuntimeToolPolicies`, add `'list_tools'` to `RUNTIME_TOOL_NAMES` so the bootstrap operator gets it `auto`:

```typescript
const RUNTIME_TOOL_NAMES = [
  'list_tools',
  'list_providers',
  // ... rest unchanged
] as const;
```

- [ ] **Step 6: Full gate + commit**

Run: `npm run format && npm run format:check && npm run typecheck && npm test`
Expected: all green.

```bash
git add packages/core/src/tools/list-tools-tool.ts packages/core/src/tools/list-tools-tool.test.ts packages/core/src/index.ts packages/runtime/src/LegionProcess.ts
git commit -m "feat(core,runtime): list_tools discovery tool + registration"
```

---

### Task 4: Connector repo scaffold — package, factory, token resolution

**Files (new repo `/workspace/legion-connector-telegram`):**

- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/index.ts`, `src/telegram-connector.ts`
- Test: `src/telegram-connector.test.ts`

**Interfaces:**

- Consumes: `ConnectorRuntimeDeps` shape (structural import type from `@legion-collective/core` devDep).
- Produces: `connector(options: TelegramConnectorOptions, deps: ConnectorRuntimeDeps): Connector`; `TelegramConnectorOptions = {botToken?: string; botTokenEnv?: string}`. Class `TelegramConnector` (name `'telegram'`) with constructor `(options, deps, bot?)` — third param injects a grammY `Bot` for tests.

- [ ] **Step 1: Prerequisite — build the Legion repo so core/types dist exists**

```bash
cd /workspace/legion && npm run build
```

Expected: `dist/` populated in `packages/core`, `packages/types` (needed for the connector's devDep type imports).

- [ ] **Step 2: Scaffold the package**

```bash
mkdir -p /workspace/legion-connector-telegram/src && cd /workspace/legion-connector-telegram && git init
```

`package.json`:

```json
{
  "name": "legion-connector-telegram",
  "version": "0.1.0",
  "description": "Telegram boundary connector for Legion collectives",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "grammy": "^1.46.0"
  },
  "peerDependencies": {},
  "devDependencies": {
    "@legion-collective/core": "file:../legion/packages/core",
    "@legion-collective/types": "file:../legion/packages/types",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`.gitignore`: `node_modules/`, `dist/`.

```bash
npm install
```

Expected: installs grammy + links `file:` devDeps (requires the Legion build from step 1; `@legion-collective/core` resolves its own `@legion-collective/types` through the Legion workspace node_modules).

- [ ] **Step 3: Write the failing test**

Create `src/telegram-connector.test.ts`:

```typescript
import { Bot } from 'grammy';
import { describe, expect, it } from 'vitest';
import { connector } from './index.js';

const token = '123456:TEST-TOKEN';

it('throws a clear error when no token is available', () => {
  expect(() => connector({}, {} as never)).toThrow(/TELEGRAM_BOT_TOKEN/);
});

it('resolves the token from options.botToken', () => {
  const c = connector({ botToken: token }, {} as never);
  expect(c.name).toBe('telegram');
});

it('resolves the token from a custom env var', () => {
  process.env.MY_TG_TOKEN = token;
  const c = connector({ botTokenEnv: 'MY_TG_TOKEN' }, {} as never);
  expect(c.name).toBe('telegram');
  delete process.env.MY_TG_TOKEN;
});

it('exposes the injected Bot for tests', () => {
  const bot = new Bot(token);
  const c = connector({ botToken: token }, {} as never, bot);
  expect((c as unknown as { bot: Bot }).bot).toBe(bot);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `./index.js` not found.

- [ ] **Step 5: Implement the factory and connector shell**

Create `src/telegram-connector.ts`:

```typescript
import { Bot } from 'grammy';
import type { Connector, ConnectorContext, ConnectorRuntimeDeps } from '@legion-collective/core';

export interface TelegramConnectorOptions {
  /** Inline token (discouraged — prefer botTokenEnv). */
  botToken?: string;
  /** Env var holding the bot token. Default 'TELEGRAM_BOT_TOKEN'. */
  botTokenEnv?: string;
}

export class TelegramConnector implements Connector {
  readonly name = 'telegram';
  readonly bot: Bot;

  constructor(
    options: TelegramConnectorOptions,
    private readonly deps: ConnectorRuntimeDeps,
    bot?: Bot,
  ) {
    const token = options.botToken ?? process.env[options.botTokenEnv ?? 'TELEGRAM_BOT_TOKEN'];
    if (!token) {
      throw new Error(
        '[telegram-connector] no bot token: set options.botToken, options.botTokenEnv, or the TELEGRAM_BOT_TOKEN env var',
      );
    }
    this.bot = bot ?? new Bot(token);
  }

  async start(_ctx: ConnectorContext): Promise<void> {
    // Wiring lands in Tasks 5–9; long polling starts in Task 9.
  }

  async deliver(_message: {
    id: string;
    conversationId: string;
    senderId: string;
    recipientId: string;
    replyTo?: string;
    content: string;
    timestamp: string;
  }): Promise<void> {
    // Task 8.
  }

  async stop(): Promise<void> {
    // Task 9.
  }
}
```

Create `src/index.ts`:

```typescript
import type { ConnectorRuntimeDeps } from '@legion-collective/core';
import { TelegramConnector } from './telegram-connector.js';
import type { TelegramConnectorOptions } from './telegram-connector.js';

export type { TelegramConnectorOptions } from './telegram-connector.js';

/** Legion connector-package entry point: named `connector` export. */
export function connector(
  options: TelegramConnectorOptions,
  deps: ConnectorRuntimeDeps,
  bot?: ConstructorParameters<typeof TelegramConnector>[2],
): TelegramConnector {
  return new TelegramConnector(options, deps, bot);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: package scaffold, connector factory, token resolution"
```

---

### Task 5: Identity mapping (inbound gate)

**Files:**

- Create: `src/identity.ts`
- Modify: `src/telegram-connector.ts` (wire message handler)
- Test: `src/identity.test.ts`, extend `src/telegram-connector.test.ts`

**Interfaces:**

- Consumes: `deps.collective.findByIdentity(connector, externalId)`; `ctx.registry.setActive(participantId, 'telegram')`.
- Produces: `resolveIdentity(collective: CollectiveLike, chatId: string, fallbackParticipantId?: string): {participantId: string} | {error: string}` where `CollectiveLike = {findByIdentity(connector: string, externalId: string): {id: string} | undefined}`.

- [ ] **Step 1: Write the failing tests**

Create `src/identity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { resolveIdentity } from './identity.js';

const collective = {
  findByIdentity: (connector: string, externalId: string) =>
    connector === 'telegram' && externalId === '111'
      ? { id: 'chris', identities: [{ connector: 'telegram', externalId: '111' }] }
      : undefined,
};

describe('resolveIdentity', () => {
  it('maps a known chat id to its participant', () => {
    expect(resolveIdentity(collective, '111')).toEqual({ participantId: 'chris' });
  });

  it('uses the fallback participant for unknown chats when configured', () => {
    expect(resolveIdentity(collective, '999', 'guest')).toEqual({ participantId: 'guest' });
  });

  it('rejects unknown chats with an explanatory error otherwise', () => {
    const result = resolveIdentity(collective, '999');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/unknown sender/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/identity.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement identity.ts**

Create `src/identity.ts`:

```typescript
export interface CollectiveLike {
  findByIdentity(connector: string, externalId: string): { id: string } | undefined;
}

export type IdentityResolution = { participantId: string } | { error: string };

export function resolveIdentity(
  collective: CollectiveLike,
  chatId: string,
  fallbackParticipantId?: string,
): IdentityResolution {
  const participant = collective.findByIdentity('telegram', chatId);
  if (participant) return { participantId: participant.id };
  if (fallbackParticipantId) return { participantId: fallbackParticipantId };
  return {
    error:
      'Unknown sender — register your Telegram identity with an operator ' +
      '(identities: [{connector: "telegram", externalId: "<your chat id>"}]).',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/identity.test.ts` — Expected: PASS (3 tests)

- [ ] **Step 5: Wire into the connector with an instrumented Bot**

Extend `src/telegram-connector.test.ts`:

```typescript
import { Bot } from 'grammy';
import { connector } from './index.js';

// ... existing imports/tests ...

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

export function makeTestBot(): { bot: Bot; calls: RecordedCall[] } {
  const bot = new Bot('123456:TEST-TOKEN');
  const calls: RecordedCall[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  bot.botInfo = {
    id: 42,
    is_bot: true,
    first_name: 'Legion',
    username: 'legion_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  return { bot, calls };
}

it('sends the rejection text to unknown senders and does not register them', async () => {
  const { bot, calls } = makeTestBot();
  const collective = { findByIdentity: () => undefined };
  const registry = { setActive: (..._a: unknown[]) => {}, clearActive: () => {} };
  const c = connector({ botToken: 'x' }, { collective, eventBus: noopEventBus } as never, bot);
  // start() wires handlers without long polling in test mode
  await c.start({ registry } as never);
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      text: 'hello',
      chat: { id: 777, type: 'private' },
      from: { id: 5, is_bot: false, first_name: 'X' },
    },
  } as never);
  const sends = calls.filter((c) => c.method === 'sendMessage');
  expect(sends).toHaveLength(1);
  expect(String(sends[0].payload.chat_id)).toBe('777');
  expect(String(sends[0].payload.text)).toMatch(/unknown sender/i);
});

it('activates a mapped participant on first successful message', async () => {
  const { bot } = makeTestBot();
  const setActive = vi.fn();
  const collective = {
    findByIdentity: (_c: string, id: string) => (id === '777' ? { id: 'chris' } : undefined),
  };
  const c = connector({ botToken: 'x' }, { collective, eventBus: noopEventBus } as never, bot);
  await c.start({ registry: { setActive, clearActive: () => {} } } as never);
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      text: 'hello',
      chat: { id: 777, type: 'private' },
      from: { id: 5, is_bot: false, first_name: 'X' },
    },
  } as never);
  expect(setActive).toHaveBeenCalledWith('chris', 'telegram');
});
```

(Consolidate the two `makeTestBot`-style helpers into one shared `src/test-helpers.ts` exported for both test files — do not duplicate. Extend the test file's vitest import to include `vi` from this task onward (`import { describe, expect, it, vi } from 'vitest';`) — later snippets use `vi.fn()`/`vi.waitFor()`. `test-helpers.ts` also exports a stub event bus used by every connector test from Task 5 onward, because Task 9 adds an `approval:requested` subscription in `start()` that would crash on `undefined`:

```typescript
export const noopEventBus = {
  on: (_event: string, _handler: (payload: unknown) => void) => () => undefined,
  off: () => undefined,
};
```

Every test snippet below passes `{ collective, eventBus: noopEventBus }` (or a per-test mock bus) as `deps`.)

In `src/telegram-connector.ts` — add handler wiring. `start()` gains a `testMode` guard: when constructed with an injected Bot, do **not** call `bot.start()` (no long polling); production (no injected bot) starts polling. Implementation:

```typescript
  private mappedChats = new Set<string>(); // chat ids that resolved to a participant

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
    this.bot.on('message:text', (tgCtx) => {
      void this.handleTextMessage(tgCtx).catch(async (err) => {
        console.error('[telegram-connector] handler error:', err);
        const chatId = tgCtx.chat?.id;
        if (chatId !== undefined) {
          try { await tgCtx.reply('Internal error handling that message.'); } catch { /* best effort */ }
        }
      });
    });
    // Callback queries wired in Task 9.
    if (!this.injectedBot) {
      void this.bot.start({ onStart: () => console.log('  Telegram connector: polling started') });
    }
  }
```

with fields `private ctx?: ConnectorContext;` and `private readonly injectedBot: boolean` (set in the constructor when `bot` was passed). Add `handleTextMessage` (partial — identity gate only; translation lands in Task 6):

```typescript
  private async handleTextMessage(tgCtx: Context): Promise<void> {
    const msg = tgCtx.message;
    if (!msg) return;
    const chatId = String(msg.chat.id);
    const fallback = this.fallbackParticipantId; // from options via config entry (Task 6 wires config)
    const resolution = resolveIdentity(this.deps.collective, chatId, fallback);
    if ('error' in resolution) {
      await tgCtx.reply(resolution.error);
      return;
    }
    this.mappedChats.add(chatId);
    this.ctx!.registry.setActive(resolution.participantId, this.name);
    // Task 6: translate and execute.
  }
```

`resolveIdentity` import added; `fallbackParticipantId` is a public settable field (`fallbackParticipantId?: string`) — the LegionProcess config path sets it from `ConnectorConfig.defaultParticipantId` via options in Task 6. For now tests pass it through options: extend `TelegramConnectorOptions` with `defaultParticipantId?: string` and assign `this.fallbackParticipantId = options.defaultParticipantId;` in the constructor.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test` — Expected: all PASS (identity + connector tests).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: chat-id identity mapping with fallback and rejection"
```

---

### Task 6: Inbound translation — commands, kwargs, communicate default

**Files:**

- Create: `src/commands.ts` (pure parsing), `src/render.ts` (result → text + chunking)
- Modify: `src/telegram-connector.ts` (execute path, conversation map)
- Test: `src/commands.test.ts`, `src/render.test.ts`, extend connector tests

**Interfaces:**

- Consumes: `ctx.callTool(participantId, toolName, args, opts?) → {result: ToolResult, conversationId: string}`; `ctx.callTool(participantId, 'list_tools', {})` for schema lookup (cached per participant in a `Map<string, Map<string, JSONSchema>>`).
- Produces: `parseInbound(text: string): InboundAction` where

```typescript
type InboundAction =
  | { kind: 'help' } // /start
  | { kind: 'new' } // /new
  | { kind: 'cancel' } // /cancel
  | { kind: 'tools' } // /tools
  | { kind: 'form'; tool: string } // /tool name (no args)
  | { kind: 'kwargs'; tool: string; kwargs: string } // /tool name key=value ...
  | { kind: 'to'; participantId: string; message: string } // /to id text
  | { kind: 'communicate'; message: string }; // plain text / unknown command
```

and `parseKwargs(raw: string, schema: JSONSchema | undefined): {args: Record<string, unknown>; unresolved: string[]}` (unresolved = keys not in schema or needing nested objects → form fill).

- [ ] **Step 1: Write failing tests for parsing**

Create `src/commands.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseInbound, parseKwargs } from './commands.js';

describe('parseInbound', () => {
  it('recognizes connector-protocol commands', () => {
    expect(parseInbound('/start')).toEqual({ kind: 'help' });
    expect(parseInbound('/new')).toEqual({ kind: 'new' });
    expect(parseInbound('/cancel')).toEqual({ kind: 'cancel' });
    expect(parseInbound('/tools')).toEqual({ kind: 'tools' });
  });

  it('treats /tool with no args as form fill', () => {
    expect(parseInbound('/tool search_files')).toEqual({ kind: 'form', tool: 'search_files' });
  });

  it('treats /tool with args as kwargs', () => {
    const action = parseInbound('/tool search_files pattern="foo bar" limit=5');
    expect(action).toEqual({
      kind: 'kwargs',
      tool: 'search_files',
      kwargs: 'pattern="foo bar" limit=5',
    });
  });

  it('parses /to with participant and message', () => {
    expect(parseInbound('/to assistant hello there')).toEqual({
      kind: 'to',
      participantId: 'assistant',
      message: 'hello there',
    });
  });

  it('routes plain text and unknown commands to communicate', () => {
    expect(parseInbound('hi')).toEqual({ kind: 'communicate', message: 'hi' });
    expect(parseInbound('/deploy now')).toEqual({ kind: 'communicate', message: '/deploy now' });
  });

  it('parses /to without a message as communicate', () => {
    expect(parseInbound('/to assistant')).toEqual({
      kind: 'communicate',
      message: '/to assistant',
    });
  });
});

describe('parseKwargs', () => {
  const schema = {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      limit: { type: 'number' },
      recursive: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      nested: { type: 'object' },
    },
  };

  it('parses quoted string values', () => {
    const { args, unresolved } = parseKwargs('pattern="foo bar" x=1', schema);
    expect(args).toEqual({ pattern: 'foo bar' });
    expect(unresolved).toEqual([]);
  });

  it('coerces numbers and booleans from the schema', () => {
    const { args, unresolved } = parseKwargs('limit=5 recursive=true', schema);
    expect(args).toEqual({ limit: 5, recursive: true });
    expect(unresolved).toEqual([]);
  });

  it('comma-splits arrays of strings', () => {
    const { args } = parseKwargs('tags=a,b,c', schema);
    expect(args).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('marks unknown keys and nested-object values as unresolved', () => {
    const { args, unresolved } = parseKwargs('nope=1 nested={"a":1}', schema);
    expect(args).toEqual({});
    expect(unresolved.sort()).toEqual(['nested', 'nope']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement commands.ts**

Create `src/commands.ts`:

```typescript
import type { JSONSchema } from '@legion-collective/types';

export type InboundAction =
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'cancel' }
  | { kind: 'tools' }
  | { kind: 'form'; tool: string }
  | { kind: 'kwargs'; tool: string; kwargs: string }
  | { kind: 'to'; participantId: string; message: string }
  | { kind: 'communicate'; message: string };

export function parseInbound(text: string): InboundAction {
  const trimmed = text.trim();
  if (trimmed === '/start') return { kind: 'help' };
  if (trimmed === '/new') return { kind: 'new' };
  if (trimmed === '/cancel') return { kind: 'cancel' };
  if (trimmed === '/tools') return { kind: 'tools' };

  const toolMatch = /^\/tool\s+(\S+)(?:\s+(.*))?$/.exec(trimmed);
  if (toolMatch) {
    const [, tool, rest] = toolMatch;
    return rest ? { kind: 'kwargs', tool, kwargs: rest } : { kind: 'form', tool };
  }

  const toMatch = /^\/to\s+(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (toMatch) {
    const [, participantId, message] = toMatch;
    if (message) return { kind: 'to', participantId, message };
  }

  return { kind: 'communicate', message: trimmed };
}

/** shlex-style tokenizer: single/double-quoted values keep their spaces. */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ' ' || char === '\t') {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function coerce(raw: string, prop: Record<string, unknown> | undefined): unknown | undefined {
  const type = prop?.type;
  if (type === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  }
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  if (type === 'array') {
    const items = (prop?.items ?? {}) as Record<string, unknown>;
    return raw.split(',').map((piece) => coerce(piece.trim(), items));
  }
  return raw; // string and untyped scalars
}

export interface KwargsResult {
  args: Record<string, unknown>;
  /** Keys not in the schema or requiring nested objects → route through form fill. */
  unresolved: string[];
}

export function parseKwargs(raw: string, schema: JSONSchema | undefined): KwargsResult {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const args: Record<string, unknown> = {};
  const unresolved: string[] = [];
  for (const token of tokenize(raw)) {
    const eq = token.indexOf('=');
    if (eq <= 0) {
      continue; // bare token without key — ignore; form fill covers the tool run
    }
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    const prop = props[key];
    if (!prop || prop.type === 'object') {
      if (!unresolved.includes(key)) unresolved.push(key);
      continue;
    }
    const coerced = coerce(value, prop);
    if (coerced === undefined) {
      if (!unresolved.includes(key)) unresolved.push(key);
      continue;
    }
    args[key] = coerced;
  }
  return { args, unresolved };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/commands.test.ts` — Expected: PASS (10 tests).

- [ ] **Step 5: Write failing tests for render.ts**

Create `src/render.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { chunkMessage, formatToolResult } from './render.js';

describe('formatToolResult', () => {
  it('returns string data verbatim', () => {
    expect(formatToolResult({ status: 'success', data: 'plain text' })).toBe('plain text');
  });

  it('JSON-formats non-string data', () => {
    const out = formatToolResult({ status: 'success', data: { a: 1 } });
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it('renders pending_approval and dispatched-style statuses as status text', () => {
    expect(formatToolResult({ status: 'pending_approval', approvalId: 'a1' })).toMatch(
      /pending approval/i,
    );
    expect(formatToolResult({ status: 'rejected', message: 'nope' })).toMatch(/rejected.*nope/i);
  });

  it('renders errors verbatim', () => {
    expect(formatToolResult({ status: 'error', error: 'Not authorized' })).toBe('Not authorized');
  });
});

describe('chunkMessage', () => {
  it('returns a single chunk for short messages', () => {
    expect(chunkMessage('short')).toEqual(['short']);
  });

  it('splits long text on paragraph boundaries under the limit', () => {
    const paragraph = 'x'.repeat(900);
    const text = Array.from({ length: 6 }, () => paragraph).join('\n\n');
    const chunks = chunkMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(chunks.join('\n\n')).toBe(text);
  });

  it('hard-splits when a single paragraph exceeds the limit', () => {
    const text = 'y'.repeat(5000);
    const chunks = chunkMessage(text, 2000);
    expect(chunks.length).toBe(3);
    expect(chunks.join('')).toBe(text);
  });
});
```

- [ ] **Step 6: Run to verify fail, then implement render.ts**

Run: `npx vitest run src/render.test.ts` — Expected: FAIL.

Create `src/render.ts`:

```typescript
import type { ToolResult } from '@legion-collective/types';

/** Telegram hard message limit is 4096; stay under it with room for prefixes. */
export const MAX_CHUNK = 3800;

export function formatToolResult(result: ToolResult): string {
  if (result.status === 'error') return result.error ?? 'Unknown error';
  if (result.status === 'pending_approval') return '⏳ Tool call requires approval.';
  if (result.status === 'rejected') {
    return `❌ Rejected${result.message ? `: ${result.message}` : ''}`;
  }
  if (typeof result.data === 'string') return result.data;
  if (result.data === undefined) return '(no data)';
  return JSON.stringify(result.data, null, 2);
}

export function chunkMessage(text: string, limit = MAX_CHUNK): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
```

Run again: `npx vitest run src/render.test.ts` — Expected: PASS (7 tests).

- [ ] **Step 7: Wire the execute path into the connector**

Extend `src/telegram-connector.test.ts` with the execute-path tests (uses `makeTestBot` from `src/test-helpers.ts`):

```typescript
it('runs communicate for plain text with the default recipient and stores the conversation', async () => {
  const { bot, calls } = makeTestBot();
  const callTool = vi.fn().mockResolvedValue({
    result: {
      status: 'success',
      data: { response: 'hello from assistant', conversationId: 'conv-1' },
    },
    conversationId: 'conv-1',
  });
  const collective = {
    findByIdentity: (_c: string, id: string) => (id === '777' ? { id: 'chris' } : undefined),
  };
  const c = connector(
    { botToken: 'x', defaultRecipientId: 'assistant' },
    { collective, eventBus: noopEventBus } as never,
    bot,
  );
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} }, callTool } as never);
  await bot.handleUpdate({
    update_id: 1,
    message: { message_id: 10, date: 0, text: 'hello', chat: { id: 777, type: 'private' } },
  } as never);
  await vi.waitFor(() => expect(calls.some((x) => x.method === 'sendMessage')).toBe(true));
  expect(callTool).toHaveBeenCalledWith(
    'chris',
    'communicate',
    expect.objectContaining({ to: 'assistant', message: 'hello' }),
    expect.objectContaining({ conversationId: '' }),
  );
  const send = calls.find((x) => x.method === 'sendMessage')!;
  expect(send.payload.text).toBe('hello from assistant');
});

it('reuses the stored conversationId on the next message and /new resets it', async () => {
  const { bot } = makeTestBot();
  const callTool = vi.fn().mockResolvedValue({
    result: { status: 'success', data: { response: 'ok', conversationId: 'conv-1' } },
    conversationId: 'conv-1',
  });
  const collective = {
    findByIdentity: (_c: string, id: string) => (id === '777' ? { id: 'chris' } : undefined),
  };
  const c = connector(
    { botToken: 'x', defaultRecipientId: 'assistant' },
    { collective, eventBus: noopEventBus } as never,
    bot,
  );
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} }, callTool } as never);
  const update = (text: string, uid: number) => ({
    update_id: uid,
    message: { message_id: uid, date: 0, text, chat: { id: 777, type: 'private' } },
  });
  await bot.handleUpdate(update('first', 1) as never);
  await bot.handleUpdate(update('second', 2) as never);
  expect(callTool).toHaveBeenLastCalledWith(
    'chris',
    'communicate',
    expect.objectContaining({ conversationId: 'conv-1' }),
    expect.anything(),
  );
  await bot.handleUpdate(update('/new', 3) as never);
  await bot.handleUpdate(update('third', 4) as never);
  expect(callTool).toHaveBeenLastCalledWith(
    'chris',
    'communicate',
    expect.objectContaining({ conversationId: '' }),
    expect.anything(),
  );
});

it('runs /to as communicate to the named participant', async () => {
  const { bot } = makeTestBot();
  const callTool = vi.fn().mockResolvedValue({
    result: { status: 'success', data: { response: 'agent reply', conversationId: 'conv-2' } },
    conversationId: 'conv-2',
  });
  const collective = {
    findByIdentity: (_c: string, id: string) => (id === '777' ? { id: 'chris' } : undefined),
  };
  const c = connector({ botToken: 'x' }, { collective, eventBus: noopEventBus } as never, bot);
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} }, callTool } as never);
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      text: '/to watcher status?',
      chat: { id: 777, type: 'private' },
    },
  } as never);
  expect(callTool).toHaveBeenCalledWith(
    'chris',
    'communicate',
    expect.objectContaining({ to: 'watcher', message: 'status?' }),
    expect.anything(),
  );
});

it('sends help for /start without calling any tool', async () => {
  const { bot, calls } = makeTestBot();
  const callTool = vi.fn();
  const collective = {
    findByIdentity: (_c: string, id: string) => (id === '777' ? { id: 'chris' } : undefined),
  };
  const c = connector({ botToken: 'x' }, { collective, eventBus: noopEventBus } as never, bot);
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} }, callTool } as never);
  await bot.handleUpdate({
    update_id: 1,
    message: { message_id: 1, date: 0, text: '/start', chat: { id: 777, type: 'private' } },
  } as never);
  await vi.waitFor(() => expect(calls.some((x) => x.method === 'sendMessage')).toBe(true));
  expect(callTool).not.toHaveBeenCalled();
  const send = calls.find((x) => x.method === 'sendMessage')!;
  expect(String(send.payload.text)).toMatch(/\/tools|\/to|\/tool/);
});
```

In `src/telegram-connector.ts`, extend `TelegramConnectorOptions` with `defaultRecipientId?: string` and implement the execute path inside `handleTextMessage` after the identity gate:

```typescript
  private readonly chatConversations = new Map<string, string>();
  private readonly schemaCache = new Map<string, Map<string, JSONSchema>>();

  private async callToolAs(participantId: string, tool: string, args: Record<string, unknown>, chatId: string): Promise<void> {
    const typing = setInterval(() => {
      void this.bot.api.sendChatAction(chatId, 'typing').catch(() => undefined);
    }, 4000);
    void this.bot.api.sendChatAction(chatId, 'typing').catch(() => undefined);
    try {
      const conversationId = this.chatConversations.get(chatId) ?? '';
      const { result } = await this.ctx!.callTool(participantId, tool, args, { conversationId });
      if (tool === 'communicate') {
        const convId = (result.data as { conversationId?: string } | undefined)?.conversationId;
        if (convId) this.chatConversations.set(chatId, convId);
      }
      const text = formatToolResult(result);
      for (const chunk of chunkMessage(text)) {
        await this.bot.api.sendMessage(chatId, chunk);
      }
    } finally {
      clearInterval(typing);
    }
  }
```

and the translation switch (inside `handleTextMessage`, replacing the Task-5 placeholder comment):

```typescript
const action = parseInbound(msg.text ?? '');
switch (action.kind) {
  case 'help':
    await tgCtx.reply(HELP_TEXT);
    return;
  case 'new':
    this.chatConversations.delete(chatId);
    await tgCtx.reply('🆕 Next message starts a fresh conversation.');
    return;
  case 'cancel':
    // Task 7 wires form-fill cancel; until then treat as no-op.
    return;
  case 'tools': {
    const { result } = await this.ctx!.callTool(resolution.participantId, 'list_tools', {});
    for (const chunk of chunkMessage(formatToolResult(result))) {
      await this.bot.api.sendMessage(chatId, chunk);
    }
    return;
  }
  case 'form':
    // Task 7 wires the form-fill state machine.
    await tgCtx.reply('Form fill lands in the next update — use /tool <name> key=value for now.');
    return;
  case 'kwargs': {
    // Task 7 completes kwargs→form-fill fallback; until then pass parsed args.
    const schema = await this.toolSchema(resolution.participantId, action.tool);
    const { args } = parseKwargs(action.kwargs, schema);
    await this.callToolAs(resolution.participantId, action.tool, args, chatId);
    return;
  }
  case 'to':
    await this.callToolAs(
      resolution.participantId,
      'communicate',
      { to: action.participantId, message: action.message },
      chatId,
    );
    return;
  case 'communicate': {
    const to = this.defaultRecipientId;
    if (!to) {
      await tgCtx.reply('No default recipient configured — use /to <participant> <message>.');
      return;
    }
    await this.callToolAs(
      resolution.participantId,
      'communicate',
      { to, message: action.message },
      chatId,
    );
    return;
  }
}
```

Add module-level `HELP_TEXT` in `telegram-connector.ts` (concise: `/tools`, `/tool <name> [key=value …]`, `/to <participant> <message>`, `/new`, `/cancel`; plain text talks to the default agent). Add a `toolSchema(participantId, toolName)` helper that calls `list_tools` once per participant, caches into `this.schemaCache`, and returns the named tool's `parameters` or `undefined`. Also assign `this.defaultRecipientId = options.defaultRecipientId;` in the constructor.

- [ ] **Step 8: Run the full connector test suite**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: inbound translation — commands, kwargs, communicate default, rendering"
```

---

### Task 7: Schema-driven form fill state machine

**Files:**

- Create: `src/formfill.ts` (pure state machine)
- Modify: `src/telegram-connector.ts` (session map, `/cancel`, message interception during fill)
- Test: `src/formfill.test.ts`, extend connector tests

**Interfaces:**

- Consumes: `toolSchema(participantId, tool)` from Task 6; grammY `InlineKeyboard` for enum/boolean params.
- Produces: `FormFillSession` and pure helpers:

```typescript
interface FormFillSession {
  tool: string;
  participantId: string;
  requiredQueue: string[];
  optionalQueue: string[];
  values: Record<string, unknown>;
  currentKey: string | undefined;
  createdAt: number;          // Date.now() at start
  timeoutMs: number;          // default 600_000
}
startFormFill(tool: string, participantId: string, schema: JSONSchema, preset?: Record<string, unknown>): FormFillSession
currentPrompt(session: FormFillSession): { key: string; prop: Record<string, unknown>; required: boolean } | { done: true }
answerCurrent(session: FormFillSession, raw: string): void   // coerces; 'skip' on optional advances
```

- [ ] **Step 1: Write failing tests**

Create `src/formfill.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { answerCurrent, currentPrompt, isExpired, startFormFill } from './formfill.js';

const schema = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'text to search' },
    mode: { type: 'string', enum: ['fast', 'deep'] },
    recursive: { type: 'boolean' },
    limit: { type: 'number' },
    note: { type: 'string' },
  },
  required: ['pattern', 'mode', 'recursive'],
};

describe('form fill', () => {
  it('prompts required parameters first, in schema order', () => {
    const s = startFormFill('search', 'chris', schema);
    const p = currentPrompt(s);
    expect(p).toMatchObject({ key: 'pattern', required: true });
  });

  it('advances through required then optional', () => {
    const s = startFormFill('search', 'chris', schema);
    answerCurrent(s, 'foo');
    expect(currentPrompt(s)).toMatchObject({ key: 'mode', required: true });
    answerCurrent(s, 'deep');
    expect(currentPrompt(s)).toMatchObject({ key: 'recursive', required: true });
    answerCurrent(s, 'true');
    expect(currentPrompt(s)).toMatchObject({ key: 'limit', required: false });
    answerCurrent(s, 'skip');
    expect(currentPrompt(s)).toMatchObject({ key: 'note', required: false });
    answerCurrent(s, 'skip');
    expect(currentPrompt(s)).toEqual({ done: true });
    expect(s.values).toEqual({ pattern: 'foo', mode: 'deep', recursive: true });
  });

  it('coerces scalars by schema type', () => {
    const s = startFormFill('search', 'chris', schema);
    answerCurrent(s, 'foo');
    answerCurrent(s, 'fast');
    answerCurrent(s, 'false');
    answerCurrent(s, '10');
    answerCurrent(s, 'skip');
    answerCurrent(s, 'skip');
    expect(s.values).toEqual({ pattern: 'foo', mode: 'fast', recursive: false, limit: 10 });
  });

  it('supports preset values from kwargs fallback', () => {
    const s = startFormFill('search', 'chris', schema, { pattern: 'preset' });
    expect(currentPrompt(s)).toMatchObject({ key: 'mode' });
  });

  it('rejects invalid enum answers and reprompts', () => {
    const s = startFormFill('search', 'chris', schema);
    answerCurrent(s, 'foo');
    const before = currentPrompt(s);
    expect(() => answerCurrent(s, 'bogus')).toThrow(/mode/);
    expect(currentPrompt(s)).toEqual(before);
  });

  it('expires after the timeout', () => {
    const s = startFormFill('search', 'chris', schema);
    expect(isExpired(s, s.createdAt + 1000)).toBe(false);
    expect(isExpired(s, s.createdAt + s.timeoutMs + 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/formfill.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement formfill.ts**

Create `src/formfill.ts`:

```typescript
import type { JSONSchema } from '@legion-collective/types';

export interface FormFillSession {
  tool: string;
  participantId: string;
  requiredQueue: string[];
  optionalQueue: string[];
  values: Record<string, unknown>;
  currentKey: string | undefined;
  createdAt: number;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

function propsOf(schema: JSONSchema): Record<string, Record<string, unknown>> {
  return (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
}

export function startFormFill(
  tool: string,
  participantId: string,
  schema: JSONSchema,
  preset: Record<string, unknown> = {},
): FormFillSession {
  const props = propsOf(schema);
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const keys = Object.keys(props).filter((key) => !(key in preset));
  const session: FormFillSession = {
    tool,
    participantId,
    requiredQueue: keys.filter((key) => required.has(key)),
    optionalQueue: keys.filter((key) => !required.has(key)),
    values: { ...preset },
    currentKey: undefined,
    createdAt: Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  // The props map travels with the session, non-enumerable so Map values stay clean.
  Object.defineProperty(session, '__props', { value: props, enumerable: false });
  return session;
}

export type Prompt =
  | { key: string; prop: Record<string, unknown>; required: boolean }
  | { done: true };

function propOf(session: FormFillSession, key: string): Record<string, unknown> {
  const props = (session as unknown as { __props: Record<string, Record<string, unknown>> })
    .__props;
  return props[key] ?? {};
}

export function currentPrompt(session: FormFillSession): Prompt {
  const key = session.requiredQueue[0] ?? session.optionalQueue[0];
  if (!key) {
    session.currentKey = undefined;
    return { done: true };
  }
  session.currentKey = key;
  const required = session.requiredQueue[0] !== undefined;
  return { key, prop: propOf(session, key), required };
}

function coerceValue(raw: string, prop: Record<string, unknown>): unknown {
  const type = prop.type;
  if (type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`'${raw}' is not a number`);
    return n;
  }
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error("'true' or 'false' required");
  }
  return raw;
}

export function answerCurrent(session: FormFillSession, raw: string): void {
  if (!session.currentKey) throw new Error('No active prompt');
  const key = session.currentKey;
  const prop = propOf(session, key);
  const required = session.requiredQueue[0] === key;
  const optionalSkip = !required && raw.trim().toLowerCase() === 'skip';
  const value = optionalSkip ? undefined : coerceValue(raw.trim(), prop);
  if (value !== undefined && prop.enum && !(prop.enum as unknown[]).includes(value)) {
    throw new Error(`'${key}' must be one of: ${(prop.enum as unknown[]).join(', ')}`);
  }
  if (required) session.requiredQueue.shift();
  else session.optionalQueue.shift();
  if (value !== undefined) session.values[key] = value;
}

export function isExpired(session: FormFillSession, now: number): boolean {
  return now - session.createdAt > session.timeoutMs;
}
```

Note: `currentPrompt` must be called before each `answerCurrent` (the connector does this — it renders the prompt from the returned value, which also sets `currentKey`). The boolean coercion covers the inline true/false buttons: their `callback_data` (`fill:true` / `fill:false`) routes through the same `answerCurrent` path as typed text.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/formfill.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Wire the session into the connector + connector-level test**

Extend `src/telegram-connector.test.ts`:

```typescript
it('completes a form fill end-to-end with enum buttons', async () => {
  const { bot, calls } = makeTestBot();
  const listResult = {
    status: 'success',
    data: {
      tools: [
        {
          name: 'search',
          description: 'd',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              mode: { type: 'string', enum: ['fast', 'deep'] },
            },
            required: ['pattern', 'mode'],
          },
        },
      ],
    },
  };
  const callTool = vi
    .fn()
    .mockResolvedValueOnce({ result: listResult, conversationId: '' })
    .mockResolvedValueOnce({ result: { status: 'success', data: 'done' }, conversationId: 'c9' });
  const collective = {
    findByIdentity: (_c: string, id: string) => (id === '777' ? { id: 'chris' } : undefined),
  };
  const c = connector({ botToken: 'x' }, { collective, eventBus: noopEventBus } as never, bot);
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} }, callTool } as never);
  const update = (text: string, uid: number) => ({
    update_id: uid,
    message: { message_id: uid, date: 0, text, chat: { id: 777, type: 'private' } },
  });
  await bot.handleUpdate(update('/tool search', 1) as never); // starts fill, prompts pattern
  await bot.handleUpdate(update('foo', 2) as never); // pattern=foo, prompts mode with buttons
  await bot.handleUpdate(update('deep', 3) as never); // completes → executes
  await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
  expect(callTool).toHaveBeenLastCalledWith(
    'chris',
    'search',
    expect.objectContaining({ pattern: 'foo', mode: 'deep' }),
    expect.anything(),
  );
  const modePrompt = calls.find(
    (x) => x.method === 'sendMessage' && String(x.payload.text).includes('mode'),
  );
  expect(modePrompt).toBeDefined();
  const markup = modePrompt!.payload.reply_markup as { inline_keyboard: unknown };
  expect(markup).toBeDefined();
});

it('/cancel aborts an in-progress fill', async () => {
  const { bot, calls } = makeTestBot();
  const listResult = {
    status: 'success',
    data: {
      tools: [
        {
          name: 'search',
          description: 'd',
          parameters: {
            type: 'object',
            properties: { pattern: { type: 'string' } },
            required: ['pattern'],
          },
        },
      ],
    },
  };
  const callTool = vi.fn().mockResolvedValue({ result: listResult, conversationId: '' });
  const collective = {
    findByIdentity: (_c: string, id: string) => (id === '777' ? { id: 'chris' } : undefined),
  };
  const c = connector({ botToken: 'x' }, { collective, eventBus: noopEventBus } as never, bot);
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} }, callTool } as never);
  const update = (text: string, uid: number) => ({
    update_id: uid,
    message: { message_id: uid, date: 0, text, chat: { id: 777, type: 'private' } },
  });
  await bot.handleUpdate(update('/tool search', 1) as never);
  await bot.handleUpdate(update('/cancel', 2) as never);
  await bot.handleUpdate(update('foo', 3) as never); // plain text again → communicate, not fill
  await vi.waitFor(() =>
    expect(
      calls.some(
        (x) => x.method === 'sendMessage' && String(x.payload.text).includes('fresh conversation'),
      ),
    ).toBe(true),
  );
  expect(callTool).toHaveBeenCalledTimes(1); // only the list_tools lookup
});
```

In `src/telegram-connector.ts`: add `private readonly fills = new Map<string, FormFillSession>();`. In `handleTextMessage`, **before** `parseInbound`, check for an active fill:

```typescript
const activeFill = this.fills.get(chatId);
if (activeFill && isExpired(activeFill, Date.now())) {
  this.fills.delete(chatId);
  await tgCtx.reply('⌛ Form fill timed out.');
  return;
}
```

Then in the switch: `case 'form'` starts the fill (schema via `toolSchema`; unknown tool → error text), sends the first prompt (with `InlineKeyboard` when `prop.enum` or `type === 'boolean'` — buttons `true`/`false` for booleans, enum values otherwise); `case 'cancel'` deletes the fill and confirms; when `activeFill` exists and the action is plain-text `communicate`, instead answer the fill:

```typescript
if (activeFill && action.kind === 'communicate') {
  try {
    answerCurrent(activeFill, msg.text ?? '');
  } catch (err) {
    await tgCtx.reply(`⚠️ ${(err as Error).message} — try again.`);
    return;
  }
  await this.promptNextOrExecute(tgCtx, chatId, activeFill);
  return;
}
```

`promptNextOrExecute` sends the next prompt or executes via `callToolAs(activeFill.participantId, activeFill.tool, activeFill.values, chatId)` and deletes the fill. For enum/boolean prompts, attach `reply_markup` with `InlineKeyboard` buttons whose `callback_data` is `fill:<value>`; handle `callback_query:data` updates where data starts with `fill:` by treating the value as the answer (Task 9's callback wiring section covers registration order — the `fill:` prefix check happens before approval callbacks).

Also update `case 'kwargs'`: after `parseKwargs`, if `unresolved.length > 0`, start a form fill with `preset = args` and prompt instead of executing.

- [ ] **Step 6: Run the full suite**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: schema-driven form fill with enum buttons and kwargs fallback"
```

---

### Task 8: Outbound delivery + reply-thread learning

**Files:**

- Modify: `src/telegram-connector.ts` (`deliver()`, reverse identity lookup)
- Test: extend `src/telegram-connector.test.ts`

**Interfaces:**

- Consumes: `deps.collective.get(recipientId)` → participant with `identities?: [{connector, externalId}]`; `message.conversationId` for thread learning.
- Produces: delivery of `message.content` to the mapped chat, chunked; conversation-map learning.

- [ ] **Step 1: Write failing tests**

Extend `src/telegram-connector.test.ts`:

```typescript
it('delivers agent messages to the mapped chat and learns the thread', async () => {
  const { bot, calls } = makeTestBot();
  const collective = {
    findByIdentity: () => undefined,
    get: (id: string) =>
      id === 'chris'
        ? { id: 'chris', identities: [{ connector: 'telegram', externalId: '777' }] }
        : undefined,
  };
  const c = connector({ botToken: 'x' }, { collective, eventBus: noopEventBus } as never, bot);
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} } } as never);
  await c.deliver({
    id: 'm1',
    conversationId: 'conv-agent',
    senderId: 'watcher',
    recipientId: 'chris',
    content: 'proactively pinging you',
    timestamp: new Date().toISOString(),
  });
  await vi.waitFor(() => expect(calls.some((x) => x.method === 'sendMessage')).toBe(true));
  const send = calls.find((x) => x.method === 'sendMessage')!;
  expect(send.payload.text).toBe('proactively pinging you');
  // thread learning: subsequent plain text continues conv-agent
  const callTool = vi.fn().mockResolvedValue({
    result: { status: 'success', data: { response: 'ok', conversationId: 'conv-agent' } },
    conversationId: 'conv-agent',
  });
  (c as unknown as { ctx: Record<string, unknown> }).ctx.callTool = callTool;
  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: 0,
      text: 'and back to you',
      chat: { id: 777, type: 'private' },
    },
  } as never);
  await vi.waitFor(() => expect(callTool).toHaveBeenCalled());
  expect(callTool).toHaveBeenCalledWith(
    'chris',
    'communicate',
    expect.objectContaining({ conversationId: 'conv-agent' }),
    expect.anything(),
  );
});

it('splits deliveries over the telegram limit', async () => {
  const { bot, calls } = makeTestBot();
  const collective = {
    findByIdentity: () => undefined,
    get: (id: string) =>
      id === 'chris'
        ? { id: 'chris', identities: [{ connector: 'telegram', externalId: '777' }] }
        : undefined,
  };
  const c = connector({ botToken: 'x' }, { collective, eventBus: noopEventBus } as never, bot);
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} } } as never);
  const long = Array.from({ length: 6 }, () => 'x'.repeat(900)).join('\n\n');
  await c.deliver({
    id: 'm2',
    conversationId: 'c',
    senderId: 's',
    recipientId: 'chris',
    content: long,
    timestamp: new Date().toISOString(),
  });
  await vi.waitFor(() =>
    expect(calls.filter((x) => x.method === 'sendMessage').length).toBeGreaterThan(1),
  );
});

it('ignores recipients without a telegram identity and swallows send failures', async () => {
  const { bot, calls } = makeTestBot();
  const collective = {
    findByIdentity: () => undefined,
    get: (id: string) => (id === 'webmaster' ? { id: 'webmaster', identities: [] } : undefined),
  };
  bot.api.config.use(async (_prev, method) => {
    throw new Error('blocked');
  });
  const c = connector({ botToken: 'x' }, { collective, eventBus: noopEventBus } as never, bot);
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} } } as never);
  await expect(
    c.deliver({
      id: 'm3',
      conversationId: 'c',
      senderId: 's',
      recipientId: 'webmaster',
      content: 'hi',
      timestamp: new Date().toISOString(),
    }),
  ).resolves.toBeUndefined();
  await expect(
    c.deliver({
      id: 'm4',
      conversationId: 'c',
      senderId: 's',
      recipientId: 'ghost',
      content: 'hi',
      timestamp: new Date().toISOString(),
    }),
  ).resolves.toBeUndefined();
  expect(calls.filter((x) => x.method === 'sendMessage')).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test` — the three new tests FAIL (deliver is a no-op).

- [ ] **Step 3: Implement deliver**

Replace `deliver()` in `src/telegram-connector.ts`:

```typescript
  async deliver(message: {
    id: string;
    conversationId: string;
    senderId: string;
    recipientId: string;
    replyTo?: string;
    content: string;
    timestamp: string;
  }): Promise<void> {
    const participant = this.deps.collective.get(message.recipientId) as
      | { identities?: Array<{ connector: string; externalId: string }> }
      | undefined;
    const externalId = participant?.identities?.find((i) => i.connector === this.name)?.externalId;
    if (!externalId) return;
    // Reply-thread learning: route this chat's next inbound message into the sender's thread.
    this.chatConversations.set(externalId, message.conversationId);
    try {
      for (const chunk of chunkMessage(message.content)) {
        await this.bot.api.sendMessage(Number(externalId), chunk);
      }
    } catch (err) {
      console.error('[telegram-connector] delivery failed:', err);
    }
  }
```

Note: `collective.get()` is used here (not `findByIdentity`) because delivery goes participant → chat, the reverse direction.

- [ ] **Step 4: Run to verify pass**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: outbound delivery with chunking and reply-thread learning"
```

---

### Task 9: Approvals — event cards + inline-button decisions

**Files:**

- Modify: `src/telegram-connector.ts` (eventBus subscription, callback handler)
- Test: extend `src/telegram-connector.test.ts`

**Interfaces:**

- Consumes: `deps.eventBus.on('approval:requested', handler)` (returns unsubscribe fn); `ctx.callTool(participantId, 'approval_response', {decisions: [{approvalId, decision}]})`; grammY `InlineKeyboard`, `bot.on('callback_query:data', ...)`.
- Produces: approval card per mapped chat on `approval:requested`; button callback → `approval_response` → answer callback query + edit message buttons off with the recorded decision.

- [ ] **Step 1: Write failing tests**

Extend `src/telegram-connector.test.ts`:

```typescript
it('posts an approval card to mapped chats and records a decision via buttons', async () => {
  const { bot, calls } = makeTestBot();
  let requestedHandler: ((payload: unknown) => void) | undefined;
  const off = vi.fn();
  const eventBus = { on: vi.fn(() => off), off: vi.fn() };
  const callTool = vi.fn().mockResolvedValue({
    result: { status: 'success', data: { approved: true } },
    conversationId: 'c',
  });
  const collective = {
    findByIdentity: (_c: string, id: string) => (id === '777' ? { id: 'chris' } : undefined),
  };
  const c = connector({ botToken: 'x' }, { collective, eventBus } as never, bot);
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} }, callTool } as never);
  // become a mapped chat
  await bot.handleUpdate({
    update_id: 1,
    message: { message_id: 1, date: 0, text: 'hi', chat: { id: 777, type: 'private' } },
  } as never);
  expect(eventBus.on).toHaveBeenCalledWith('approval:requested', expect.any(Function));
  requestedHandler = eventBus.on.mock.calls[0][1];
  requestedHandler!({
    conversationId: 'conv-9',
    participantId: 'watcher',
    tool: 'read_file',
    approvalId: 'ap-1',
  });
  await vi.waitFor(() => {
    const card = calls.find(
      (x) => x.method === 'sendMessage' && String(x.payload.text).includes('read_file'),
    );
    expect(card).toBeDefined();
  });
  // press approve: callback_query update
  await bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: 'cbq-1',
      from: { id: 5, is_bot: false, first_name: 'X' },
      data: 'approve:ap-1',
      message: { message_id: 55, date: 0, text: 'approval', chat: { id: 777, type: 'private' } },
    },
  } as never);
  await vi.waitFor(() =>
    expect(callTool).toHaveBeenCalledWith(
      'chris',
      'approval_response',
      { decisions: [{ approvalId: 'ap-1', decision: 'approve' }] },
      expect.anything(),
    ),
  );
  expect(calls.some((x) => x.method === 'answerCallbackQuery')).toBe(true);
  const edit = calls.find((x) => x.method === 'editMessageText');
  expect(edit).toBeDefined();
});

it('unsubscribes from the event bus on stop', async () => {
  const { bot } = makeTestBot();
  const off = vi.fn();
  const eventBus = { on: vi.fn(() => off), off: vi.fn() };
  const c = connector(
    { botToken: 'x' },
    { collective: { findByIdentity: () => undefined }, eventBus } as never,
    bot,
  );
  await c.start({ registry: { setActive: () => {}, clearActive: () => {} } } as never);
  await c.stop();
  expect(off).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test` — new tests FAIL (no subscription, stop is a no-op).

- [ ] **Step 3: Implement**

In `src/telegram-connector.ts`:

Constructor additions — nothing (deps already held). Add fields:

```typescript
  private unsubscribeEvents: Array<() => void> = [];
```

In `start()`, before the `bot.on('message:text')` wiring:

```typescript
this.unsubscribeEvents.push(
  this.deps.eventBus.on('approval:requested', (payload) => {
    void this.postApprovalCard(payload).catch((err) =>
      console.error('[telegram-connector] approval card failed:', err),
    );
  }),
);

this.bot.on('callback_query:data', (tgCtx) => {
  void this.handleCallback(tgCtx).catch((err) =>
    console.error('[telegram-connector] callback error:', err),
  );
});
```

Methods:

```typescript
  private async postApprovalCard(payload: {
    conversationId: string;
    participantId: string;
    tool: string;
    approvalId: string;
  }): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${payload.approvalId}`)
      .text('❌ Reject', `reject:${payload.approvalId}`);
    const text =
      `🔔 Approval requested\n` +
      `Tool: ${payload.tool}\n` +
      `By: ${payload.participantId}\n` +
      `Conversation: ${payload.conversationId}`;
    for (const chatId of this.mappedChats) {
      try {
        await this.bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
      } catch (err) {
        console.error('[telegram-connector] approval card send failed:', err);
      }
    }
  }

  private async handleCallback(tgCtx: Context): Promise<void> {
    const data = tgCtx.callbackQuery?.data ?? '';
    const chatId = tgCtx.callbackQuery?.message?.chat.id;
    if (chatId === undefined) return;
    const chatKey = String(chatId);

    if (data.startsWith('fill:')) {
      const value = data.slice('fill:'.length);
      const fill = this.fills.get(chatKey);
      if (!fill) {
        await tgCtx.answerCallbackQuery({ text: 'No form fill in progress' });
        return;
      }
      try {
        answerCurrent(fill, value);
      } catch (err) {
        await tgCtx.answerCallbackQuery({ text: (err as Error).message });
        return;
      }
      await tgCtx.answerCallbackQuery();
      await this.promptNextOrExecute(tgCtx, chatKey, fill);
      return;
    }

    const match = /^(approve|reject):(.+)$/.exec(data);
    if (!match) return;
    const [, verb, approvalId] = match;
    const resolution = resolveIdentity(this.deps.collective, chatKey, this.fallbackParticipantId);
    if ('error' in resolution) {
      await tgCtx.answerCallbackQuery({ text: resolution.error });
      return;
    }
    const decision = verb === 'approve' ? 'approve' : 'reject';
    const { result } = await this.ctx!.callTool(resolution.participantId, 'approval_response', {
      decisions: [{ approvalId, decision }],
    });
    const outcome =
      result.status === 'error'
        ? `Error: ${result.error ?? 'unknown'}`
        : decision === 'approve'
          ? '✅ Approved'
          : '❌ Rejected';
    await tgCtx.answerCallbackQuery({ text: outcome });
    try {
      await tgCtx.editMessageText(
        `${tgCtx.callbackQuery?.message?.text ?? 'Approval'}\n\n→ ${outcome}`,
        { reply_markup: undefined },
      );
    } catch {
      // best-effort edit; decision is recorded regardless
    }
  }
```

Update `stop()`:

```typescript
  async stop(): Promise<void> {
    for (const off of this.unsubscribeEvents) off();
    this.unsubscribeEvents = [];
    this.mappedChats.clear();
    this.fills.clear();
    this.chatConversations.clear();
    await this.bot.stop().catch(() => undefined); // no-op in test mode (never started)
  }
```

Imports update: `import { Bot, Context, InlineKeyboard } from 'grammy';` and `answerCurrent` from `./formfill.js`. Note `bot.stop()` on a never-started bot rejects/throws in grammY — the `.catch(() => undefined)` covers it; verify in Task 10's live run.

- [ ] **Step 4: Run to verify pass**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: approval cards with inline-button decisions via approval_response"
```

---

### Task 10: Long polling lifecycle, typecheck/build, README, declaration-emit proof

**Files:**

- Modify: `src/telegram-connector.ts` (polling start/stop polish — final review only)
- Create: `README.md`
- Verify: `npm run build`, `npm run typecheck`

**Interfaces:**

- Consumes: everything above.
- Produces: `dist/` build with `.d.ts` (proves type-only Legion imports are erased); README with install + workspace-config example.

- [ ] **Step 1: Confirm the injected-bot guard covers all async paths**

Review `src/telegram-connector.ts`: `start()` must never begin long polling when `injectedBot` is true; `stop()` must tolerate a never-started bot (grammY `bot.stop()` before `bot.start()` resolves immediately or rejects — either is fine behind the catch). Adjust if needed; no behavior change otherwise.

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck && npm run build
```

Expected: clean compile, `dist/` emitted with `index.d.ts`, `telegram-connector.d.ts`.

- [ ] **Step 3: Prove Legion types are erased (no runtime dependency on @legion-collective/core)**

```bash
grep -rn "from '@legion" dist/ | grep -v "\.d\.ts" || echo "OK: no runtime imports of @legion-collective/*"
node -e "import('./dist/index.js').then(m => console.log(typeof m.connector))"
```

Expected: `OK: no runtime imports of @legion-collective/*` and `function`.

- [ ] **Step 4: Full test suite + format**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Write the README**

Create `README.md`:

```markdown
# legion-connector-telegram

Telegram boundary connector for [Legion](../legion) collectives. Maps Telegram chats to
participants via `identities: [{connector: "telegram", externalId: "<chat id>"}]`; the
mapped participant's tool policy is the entire permission surface.

## Install

From the workspace that runs Legion:

    npm install /path/to/legion-connector-telegram

## Configure

In `.legion/config.local.json` (or `config.json`) of your Legion workspace:

    {
      "connectors": [
        { "name": "web" },
        { "name": "telegram", "module": "legion-connector-telegram",
          "defaultParticipantId": "guest",
          "options": { "defaultRecipientId": "assistant" } }
      ]
    }

`defaultParticipantId` is the low-privilege _sender_ fallback for unknown chats (omit to
reject unknown senders). `options.defaultRecipientId` is the recipient for plain-text chat.

Set the bot token (create a bot with @BotFather):

    export TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

Restart Legion. Message the bot; `/start` shows help, `/tools` lists your tools,
`/tool <name> key=value ...` runs a tool directly, `/tool <name>` walks you through a
schema-driven form, `/to <participant> <message>` addresses a specific participant,
`/new` starts a fresh conversation, `/cancel` aborts a form fill.
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: README with install and workspace config"
```

---

### Task 11: Legion repo — final gate + live smoke (requires Chris's bot token)

**Files:**

- No new changes expected; verification only.

**Interfaces:**

- Consumes: Tasks 1–3 (Legion repo) and Tasks 4–10 (connector repo) complete.

- [ ] **Step 1: Legion repo gate**

```bash
cd /workspace/legion
npm run format:check && npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 2: Boot a real workspace with the telegram connector (needs TELEGRAM_BOT_TOKEN from @BotFather)**

```bash
mkdir -p /tmp/legion-tg-smoke/.legion/collective/participants
cat > /tmp/legion-tg-smoke/.legion/config.json <<'EOF'
{ "version": "2", "server": { "host": "0.0.0.0", "port": 4100 },
  "connectors": [
    { "name": "web" },
    { "name": "telegram", "module": "/workspace/legion-connector-telegram/dist/index.js" }
  ] }
EOF
# operator with telegram identity:
cat > /tmp/legion-tg-smoke/.legion/collective/participants/operator.json <<'EOF'
{ "id": "operator", "name": "Operator", "type": "user", "operator": true, "protected": true,
  "tools": { "list_tools": "auto", "communicate": "auto", "list_participants": "auto" },
  "identities": [{ "connector": "telegram", "externalId": "REPLACE_WITH_YOUR_CHAT_ID" }] }
EOF
cd /workspace/legion
LEGION_WORKSPACE=/tmp/legion-tg-smoke TELEGRAM_BOT_TOKEN=<token> \
  LEGION_BOOTSTRAP_PASSWORD=<pw> PORT=4100 node packages/runtime/bin/legion.js /tmp/legion-tg-smoke
```

Expected: `Telegram connector: polling started` in the log, web UI on 4100.

- [ ] **Step 3: Live round trip (Chris's phone)**

1. Text the bot any message → identity resolves → communicate → assistant reply arrives.
2. `/tools` → tool list rendered.
3. `/tool list_participants` → form fill prompts (none required → executes immediately) → participant list.
4. Trigger an agent with a requires-approval tool → approval card arrives → ✅ button → decision recorded.
5. `/new` then a plain message → fresh conversation.

Record results in the commit message of the merge commit.

- [ ] **Step 4: Merge**

```bash
cd /workspace/legion
git checkout main && git merge --no-ff feat/telegram-connector -m "Merge branch 'feat/telegram-connector'"
```

---

## Verification checklist (maps to spec §8)

- [ ] Loader: default web, enabled=false skip, absolute/relative/bare module resolution, broken module log-and-skip, no-factory skip, options+deps pass-through, start-throw deregister, duplicate names throw
- [ ] `list_tools`: policy filter, entry shape, empty policy
- [ ] Identity: known chat → participant, fallback, unknown rejection; `setActive` on first mapping
- [ ] Translation: plain text → communicate(default recipient), `/to`, `/tool` kwargs (quoted/coercion/arrays), `/tools`, `/start`, `/new`, `/cancel`; unknown commands → communicate
- [ ] Form fill: required-then-optional order, enum/boolean buttons, skip, cancel, timeout, kwargs preset fallback
- [ ] Delivery: chunking ≤ limit, thread learning from `deliver()`, no-identity no-op, swallowed send failures
- [ ] Approvals: card per mapped chat, callback → `approval_response`, callback answered, buttons disabled with outcome, unsubscribe on stop
- [ ] Packaging: declaration emit clean, no `@legion-collective/*` runtime imports, grammY-only runtime dep
- [ ] Live E2E (Task 11): reply, `/tools`, direct tool, approval flow, `/new`
