# Connector-Provided Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let connectors contribute tools to Legion's global `ToolRegistry`, and add Teams card, reaction, and conversation-list tools on top of that seam.

**Architecture:** Core gains an optional `Connector.tools()` method and a leak-proof register/unregister lifecycle owned by `LegionProcess`. The Teams connector builds three tools after `start()`, records inbound/outbound Teams activity IDs in state v3, and resolves the caller's live `teams-bot` before acting.

**Tech Stack:** TypeScript (NodeNext, strict), Vitest, `@microsoft/teams.apps`/`teams.api` 2.2.1, Adaptive Cards via `@microsoft/teams.cards`.

**Spec:** `docs/superpowers/specs/2026-11-24-connector-tools-design.md`

## Global Constraints

- Work happens in two worktrees on branch `feat/connector-tools`:
  - `threads/2026-11-24-connector-tools/legion` (core seam + `communicate`)
  - `threads/2026-11-24-connector-tools/legion-connector-teams` (Teams tools)
- Tool names must be `<connectorName>__<tool>`. Teams tools are `teams__send_card`, `teams__post_reaction`, `teams__list_conversations`.
- Tool visibility stays fail-closed: only a participant's `tools` map grants a tool. No automatic policy edits.
- The acting bot is always the caller's own live `teams-bot`; verify with `BotPool.ownerOf` and `BotPool.getByAppId`.
- State migrates to schema v3; `maxMessageRecords` defaults to 2000 and `maxCardBytes` to 28000.
- Tool failures return `{ status: 'error', error }`; never throw, never include secrets.
- Build order: build `legion` core/types before typechecking the connector, because the connector's `file:` dependency resolves to the thread worktree's `packages/core`.
- Verification commands: `npm run format:check`, `npm run typecheck`, `npm test` in `legion`; `npm run typecheck`, `npm run test` in `legion-connector-teams`.

---

## Setup: install dependencies and establish a baseline

**Files:** none (environment only)

- [ ] **Step 1: Install the legion workspace**

Run in `threads/2026-11-24-connector-tools/legion`:

```bash
npm install
npm run build
```

Expected: workspace packages build; `packages/core/dist` and `packages/types/dist` exist.

- [ ] **Step 2: Install the connector**

Run in `threads/2026-11-24-connector-tools/legion-connector-teams`:

```bash
npm install
```

Expected: `node_modules/@legion-collective/core` is a symlink to the sibling `../legion/packages/core`.

- [ ] **Step 3: Run the existing suites to confirm a clean baseline**

Run in each worktree:

```bash
npm test
```

Expected: all existing tests pass before any changes.

---

## Task 1: Add the `Connector.tools()` seam and registration helpers

**Files:**

- Modify: `packages/core/src/connectors/Connector.ts`
- Modify: `packages/runtime/src/LegionProcess.ts`
- Test: `packages/runtime/src/connector-tools.test.ts` (create)

**Interfaces:**

- Produces:
  - `Connector.tools?(): AnyTool[]`
  - `registerConnectorTools(connector: Connector, toolRegistry: ToolRegistry): string[]`
  - `unregisterConnectorTools(toolRegistry: ToolRegistry, names: readonly string[]): void`

- [ ] **Step 1: Write the failing test**

Create `packages/runtime/src/connector-tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ConnectorRegistry,
  ToolRegistry,
  type AnyTool,
  type Connector,
} from '@legion-collective/core';
import { registerConnectorTools, unregisterConnectorTools } from './LegionProcess.js';

function fakeTool(name: string): AnyTool {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ status: 'success' }),
  };
}

function fakeConnector(name: string, tools?: AnyTool[]): Connector {
  return {
    name,
    start: async () => undefined,
    deliver: async () => ({ status: 'delivered' }),
    stop: async () => undefined,
    ...(tools === undefined ? {} : { tools: () => tools }),
  };
}

describe('registerConnectorTools', () => {
  it('returns an empty list when the connector has no tools()', () => {
    const registry = new ToolRegistry();
    expect(registerConnectorTools(fakeConnector('teams'), registry)).toEqual([]);
    expect(registry.listAll()).toEqual([]);
  });

  it('registers tools that carry the connector prefix', () => {
    const registry = new ToolRegistry();
    const connector = fakeConnector('teams', [
      fakeTool('teams__send_card'),
      fakeTool('teams__post_reaction'),
    ]);
    expect(registerConnectorTools(connector, registry)).toEqual([
      'teams__send_card',
      'teams__post_reaction',
    ]);
    expect(registry.listAll()).toEqual(['teams__send_card', 'teams__post_reaction']);
  });

  it('rejects a tool whose name lacks the connector prefix and registers nothing', () => {
    const registry = new ToolRegistry();
    const connector = fakeConnector('teams', [fakeTool('teams__ok'), fakeTool('send_card')]);
    expect(() => registerConnectorTools(connector, registry)).toThrow(/teams__/);
    expect(registry.listAll()).toEqual([]);
  });

  it('rejects duplicate tool names within one connector', () => {
    const registry = new ToolRegistry();
    const connector = fakeConnector('teams', [fakeTool('teams__x'), fakeTool('teams__x')]);
    expect(() => registerConnectorTools(connector, registry)).toThrow(/duplicate/i);
    expect(registry.listAll()).toEqual([]);
  });

  it('rolls back already-registered tools when a later registration collides', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('teams__taken'));
    const connector = fakeConnector('teams', [fakeTool('teams__first'), fakeTool('teams__taken')]);
    expect(() => registerConnectorTools(connector, registry)).toThrow(/already registered/i);
    expect(registry.listAll()).toEqual(['teams__taken']);
  });
});

describe('unregisterConnectorTools', () => {
  it('removes every name and tolerates missing names', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('teams__a'));
    registry.register(fakeTool('teams__b'));
    unregisterConnectorTools(registry, ['teams__a', 'teams__b', 'teams__missing']);
    expect(registry.listAll()).toEqual([]);
  });
});

describe('ConnectorRegistry parity', () => {
  it('accepts a connector that implements tools()', () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('teams', [fakeTool('teams__x')]));
    expect(registry.get('teams')?.tools?.()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/runtime/src/connector-tools.test.ts
```

Expected: FAIL — `tools` is not a property of `Connector`, and `registerConnectorTools`/`unregisterConnectorTools` are not exported.

- [ ] **Step 3: Extend the `Connector` interface**

In `packages/core/src/connectors/Connector.ts`, add the import and method:

```ts
import type { AnyTool } from '../tools/Tool.js';
```

```ts
export interface Connector {
  readonly name: string;

  canDeliver?(participantId: string): boolean;

  start(ctx: ConnectorContext): Promise<void>;

  deliver(message: {
    id: string;
    conversationId: string;
    senderId: string;
    recipientId: string;
    replyTo?: string;
    content: string;
    timestamp: string;
  }): Promise<DeliveryOutcome>;

  stop(): Promise<void>;

  /**
   * Tools this connector contributes to the global registry.
   * Called by core after a successful `start()`; unregistered on `stop()`.
   * Every tool name must start with `<connector.name>__`.
   */
  tools?(): AnyTool[];
}
```

- [ ] **Step 4: Add the helpers**

In `packages/runtime/src/LegionProcess.ts`, add `type Connector` to the core import list, then add these functions after `startExternalConnectors`:

```ts
export function registerConnectorTools(connector: Connector, toolRegistry: ToolRegistry): string[] {
  const provider = connector.tools;
  if (!provider) return [];

  const tools = provider.call(connector);
  if (!Array.isArray(tools)) {
    throw new Error(`connector '${connector.name}' tools() did not return an array`);
  }

  const prefix = `${connector.name}__`;
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new Error(`connector '${connector.name}' returned a tool without a name`);
    }
    if (!tool.name.startsWith(prefix)) {
      throw new Error(
        `tool '${tool.name}' from connector '${connector.name}' must start with '${prefix}'`,
      );
    }
    if (names.includes(tool.name)) {
      throw new Error(`duplicate tool '${tool.name}' from connector '${connector.name}'`);
    }
    names.push(tool.name);
  }

  const registered: string[] = [];
  try {
    for (const tool of tools) {
      toolRegistry.register(tool);
      registered.push(tool.name);
    }
  } catch (error) {
    unregisterConnectorTools(toolRegistry, registered);
    throw error;
  }
  return registered;
}

export function unregisterConnectorTools(
  toolRegistry: ToolRegistry,
  names: readonly string[],
): void {
  for (const name of [...names].reverse()) {
    toolRegistry.unregister(name);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run packages/runtime/src/connector-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/connectors/Connector.ts packages/runtime/src/LegionProcess.ts packages/runtime/src/connector-tools.test.ts
git commit -m "feat(core): add Connector.tools() seam and registration helpers"
```

---

## Task 2: Register external connector tools during boot

**Files:**

- Modify: `packages/runtime/src/LegionProcess.ts`
- Modify: `packages/runtime/src/LegionProcess.loader.test.ts`

**Interfaces:**

- Consumes: `registerConnectorTools`, `unregisterConnectorTools` from Task 1.
- Produces:
  - `StartExternalConnectorsDeps.toolRegistry: ToolRegistry`
  - `StartExternalConnectorsResult { connectors: string[]; toolsByConnector: Map<string, string[]> }`
  - `startExternalConnectors(deps): Promise<StartExternalConnectorsResult>`

- [ ] **Step 1: Update the existing loader tests for the new return shape**

In `packages/runtime/src/LegionProcess.loader.test.ts`, import `ToolRegistry`:

```ts
import { ConnectorRegistry, ToolRegistry } from '@legion-collective/core';
```

For each existing `startExternalConnectors({...})` call, add `toolRegistry: new ToolRegistry()` and change the result assertion. Example for the first test:

```ts
const toolRegistry = new ToolRegistry();
const result = await startExternalConnectors({
  entries,
  workspaceRoot: ws,
  connectorRegistry: registry,
  toolRegistry,
  runtimeDeps: runtimeDeps(),
  context: stubContext,
});

expect(result.connectors).toEqual(['ext']);
```

Apply the same `result.connectors` change to the other two existing tests.

- [ ] **Step 2: Add failing tests for tool registration and rollback**

Add these fixtures near the other fixtures in the same file:

```ts
const WITH_TOOLS = `
export function connector() {
  return {
    name: 'ext',
    start: async () => {},
    deliver: async () => ({ status: 'delivered' }),
    stop: async () => {},
    tools: () => [{
      name: 'ext__ping',
      description: 'ping',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ status: 'success' }),
    }],
  };
}
export default connector;
`;

const BAD_TOOLS = `
let stopped = 0;
export function connector() {
  return {
    name: 'ext',
    start: async () => {},
    deliver: async () => ({ status: 'delivered' }),
    stop: () => { stopped += 1; },
    tools: () => [{
      name: 'wrong',
      description: 'wrong prefix',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ status: 'success' }),
    }],
  };
}
export function stopCount() { return stopped; }
export default connector;
`;
```

Add the tests:

```ts
it('registers tools returned by connector.tools()', async () => {
  const ws = tmpWorkspace();
  const file = writeModule(ws, 'tools', WITH_TOOLS);
  const connectorRegistry = new ConnectorRegistry();
  const toolRegistry = new ToolRegistry();

  const result = await startExternalConnectors({
    entries: [{ name: 'ext', module: file }],
    workspaceRoot: ws,
    connectorRegistry,
    toolRegistry,
    runtimeDeps: runtimeDeps(),
    context: stubContext,
  });

  expect(result.connectors).toEqual(['ext']);
  expect(result.toolsByConnector.get('ext')).toEqual(['ext__ping']);
  expect(toolRegistry.has('ext__ping')).toBe(true);
});

it('deregisters and stops a connector whose tools fail validation', async () => {
  const ws = tmpWorkspace();
  const file = writeModule(ws, 'bad-tools', BAD_TOOLS);
  const connectorRegistry = new ConnectorRegistry();
  const toolRegistry = new ToolRegistry();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  const result = await startExternalConnectors({
    entries: [{ name: 'ext', module: file }],
    workspaceRoot: ws,
    connectorRegistry,
    toolRegistry,
    runtimeDeps: runtimeDeps(),
    context: stubContext,
  });

  expect(result.connectors).toEqual([]);
  expect(result.toolsByConnector.size).toBe(0);
  expect(connectorRegistry.get('ext')).toBeUndefined();
  expect(toolRegistry.listAll()).toEqual([]);

  const mod = (await import(pathToFileURL(file).href)) as { stopCount: () => number };
  expect(mod.stopCount()).toBe(1);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run packages/runtime/src/LegionProcess.loader.test.ts
```

Expected: FAIL — the result is still a `string[]`, and no tools are registered.

- [ ] **Step 4: Update `startExternalConnectors`**

Replace the deps interface and function in `packages/runtime/src/LegionProcess.ts`:

```ts
export interface StartExternalConnectorsDeps {
  entries: ConnectorConfig[];
  workspaceRoot: string;
  connectorRegistry: ConnectorRegistry;
  toolRegistry: ToolRegistry;
  runtimeDeps: ConnectorRuntimeDeps;
  context: ConnectorContext;
}

export interface StartExternalConnectorsResult {
  connectors: string[];
  toolsByConnector: Map<string, string[]>;
}

/**
 * Load, start, register, and contribute tools for every configured external
 * connector. Never throws: per-entry failures are reported by the loader and
 * logged here so the process boots without them (spec §4.3 log-and-skip).
 */
export async function startExternalConnectors(
  deps: StartExternalConnectorsDeps,
): Promise<StartExternalConnectorsResult> {
  const { loaded, failures } = await loadExternalConnectors(
    deps.entries,
    deps.workspaceRoot,
    deps.runtimeDeps,
    deps.context,
  );
  const registered: string[] = [];
  const toolsByConnector = new Map<string, string[]>();

  for (const { connector } of loaded) {
    try {
      deps.connectorRegistry.register(connector);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[legion] external connector '${connector.name}' could not register: ${msg} — skipped`,
      );
      try {
        await connector.stop();
      } catch {
        // A broken stop() must not turn a registration skip into a boot failure.
      }
      continue;
    }

    let names: string[] = [];
    try {
      names = registerConnectorTools(connector, deps.toolRegistry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[legion] external connector '${connector.name}' tools failed: ${msg} — skipped`,
      );
      unregisterConnectorTools(deps.toolRegistry, names);
      deps.connectorRegistry.deregister(connector.name);
      try {
        await connector.stop();
      } catch {
        // Best-effort.
      }
      continue;
    }

    toolsByConnector.set(connector.name, names);
    console.log(`[legion] external connector '${connector.name}' started`);
    registered.push(connector.name);
  }

  if (failures.length > 0) {
    console.warn(`[legion] ${failures.length} external connector(s) failed to load`);
  }
  return { connectors: registered, toolsByConnector };
}
```

Note: `registerConnectorTools` already rolls back its partial registrations before throwing, so the extra `unregisterConnectorTools` is defensive and harmless.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run packages/runtime/src/LegionProcess.loader.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts packages/runtime/src/LegionProcess.loader.test.ts
git commit -m "feat(runtime): register external connector tools"
```

---

## Task 3: Wire connector tool lifecycle into `LegionProcess`

**Files:**

- Modify: `packages/runtime/src/LegionProcess.ts`
- Test: `packages/runtime/src/connector-tools.test.ts`

**Interfaces:**

- Consumes: Task 1 helpers, Task 2 result.
- Produces: `shutdownConnectors(deps): Promise<void>`.

- [ ] **Step 1: Write the failing shutdown-order test**

Append to `packages/runtime/src/connector-tools.test.ts`:

```ts
import { vi } from 'vitest';
import { shutdownConnectors } from './LegionProcess.js';

describe('shutdownConnectors', () => {
  it("unregisters a connector's tools before stopping it", async () => {
    const toolRegistry = new ToolRegistry();
    const connectors = new ConnectorRegistry();
    const stop = vi.fn(async () => {
      expect(toolRegistry.has('teams__a')).toBe(false);
    });
    const connector: Connector = {
      name: 'teams',
      start: async () => undefined,
      deliver: async () => ({ status: 'delivered' }),
      stop,
    };
    connectors.register(connector);
    toolRegistry.register(fakeTool('teams__a'));

    const connectorTools = new Map<string, string[]>([['teams', ['teams__a']]]);
    await shutdownConnectors({ connectors, toolRegistry, connectorTools });

    expect(stop).toHaveBeenCalledOnce();
    expect(connectorTools.size).toBe(0);
    expect(toolRegistry.has('teams__a')).toBe(false);
  });

  it('stops connectors even when their tool names are already gone', async () => {
    const toolRegistry = new ToolRegistry();
    const connectors = new ConnectorRegistry();
    const stop = vi.fn(async () => undefined);
    connectors.register({
      name: 'teams',
      start: async () => undefined,
      deliver: async () => ({ status: 'delivered' }),
      stop,
    });
    await shutdownConnectors({
      connectors,
      toolRegistry,
      connectorTools: new Map([['teams', ['teams__missing']]]),
    });
    expect(stop).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/runtime/src/connector-tools.test.ts
```

Expected: FAIL — `shutdownConnectors` is not exported.

- [ ] **Step 3: Add `shutdownConnectors`**

Add after `startExternalConnectors` in `packages/runtime/src/LegionProcess.ts`:

```ts
export async function shutdownConnectors(deps: {
  connectors: ConnectorRegistry;
  toolRegistry: ToolRegistry;
  connectorTools: Map<string, string[]>;
}): Promise<void> {
  for (const connector of deps.connectors.getAll()) {
    const names = deps.connectorTools.get(connector.name);
    if (names) {
      unregisterConnectorTools(deps.toolRegistry, names);
      deps.connectorTools.delete(connector.name);
    }
    try {
      await connector.stop();
    } catch {
      // Best-effort.
    }
  }
}
```

- [ ] **Step 4: Add the connector-tools map to boot**

In `LegionProcess.start()`, immediately before `await webConnector.start(connectorContext);`, add:

```ts
const connectorTools = new Map<string, string[]>();
```

After `await webConnector.start(connectorContext);`, add:

```ts
try {
  const webTools = registerConnectorTools(webConnector, toolRegistry);
  if (webTools.length > 0) connectorTools.set(webConnector.name, webTools);
} catch (error) {
  console.warn(
    `[legion] web connector tools failed to register: ${error instanceof Error ? error.message : String(error)}`,
  );
}
```

Replace the external-connector block with:

```ts
if ((mergedConfig.connectors?.length ?? 0) > 0) {
  const { toolsByConnector } = await startExternalConnectors({
    entries: mergedConfig.connectors ?? [],
    workspaceRoot,
    connectorRegistry,
    toolRegistry,
    runtimeDeps: { collective, secrets },
    context: connectorContext,
  });
  for (const [name, names] of toolsByConnector) connectorTools.set(name, names);
}
```

- [ ] **Step 5: Pass the map into the process and unregister on stop**

Add a constructor parameter after `readonly connectorContext: ConnectorContext`:

```ts
private readonly connectorTools: Map<string, string[]>,
```

Add `connectorTools` as the final argument to the `new LegionProcess(...)` call.

Replace the connector-stop block in `stop()` with:

```ts
await shutdownConnectors({
  connectors: this.connectors,
  toolRegistry: this.toolRegistry,
  connectorTools: this.connectorTools,
});
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run packages/runtime/src/connector-tools.test.ts
npx vitest run packages/runtime/src/LegionProcess.loader.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts packages/runtime/src/connector-tools.test.ts
git commit -m "feat(runtime): wire connector tool lifecycle into LegionProcess"
```

---

## Task 4: Expose `storedMessageId` in `communicate` results

**Files:**

- Modify: `packages/core/src/tools/communicate-tool.ts`
- Modify: `packages/core/src/tools/communicate-tool.test.ts`

**Interfaces:**

- Produces: `communicate` result `data.storedMessageId?: string` on success, error, pending-approval, and timeout paths.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/tools/communicate-tool.test.ts`:

```ts
import type { ToolResult } from '@legion-collective/types';
import type { MessageRouterPort, MessageRouterResult, ToolContext } from './Tool.js';

function contextWith(result: MessageRouterResult): ToolContext {
  return {
    participant: { id: 'agent-a', name: 'A', type: 'mock', tools: {} },
    communicationDepth: 0,
    messageRouter: {
      sendStream: async function* () {
        return result;
      },
    } as unknown as MessageRouterPort,
  } as unknown as ToolContext;
}

async function runTool(result: MessageRouterResult): Promise<ToolResult> {
  const gen = communicateTool.stream({ to: 'agent-b', message: 'hi' }, contextWith(result));
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

describe('communicate storedMessageId', () => {
  it.each([
    ['success', { conversationId: 'conv-1', status: 'success', response: 'ok' }],
    ['error', { conversationId: 'conv-1', status: 'error', error: 'boom' }],
    [
      'pending_approval',
      { conversationId: 'conv-1', status: 'pending_approval', approvalRequests: [] },
    ],
    ['timeout', { conversationId: 'conv-1', status: 'timeout', response: 'partial' }],
  ] as const)('exposes storedMessageId on %s', async (_label, base) => {
    const result = await runTool({ ...base, storedMessageId: 'msg-1' } as MessageRouterResult);
    expect((result.data as { storedMessageId?: string }).storedMessageId).toBe('msg-1');
  });

  it('omits storedMessageId when the router has none', async () => {
    const result = await runTool({ conversationId: 'conv-1', status: 'success' });
    expect(result.data).not.toHaveProperty('storedMessageId');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run packages/core/src/tools/communicate-tool.test.ts
```

Expected: FAIL — `storedMessageId` is absent from `data`.

- [ ] **Step 3: Add the helper and wire all four paths**

In `packages/core/src/tools/communicate-tool.ts`, add above `communicateTool`:

```ts
function withStoredMessageId(
  data: Record<string, unknown>,
  result: MessageRouterResult,
): Record<string, unknown> {
  if (result.storedMessageId !== undefined) data.storedMessageId = result.storedMessageId;
  return data;
}
```

Replace the four result returns:

```ts
if (result.status === 'error') {
  return {
    status: 'error',
    error: result.error,
    data: withStoredMessageId({ conversationId: result.conversationId }, result),
  };
}
if (result.status === 'pending_approval') {
  return {
    status: 'pending_approval',
    data: withStoredMessageId(
      { conversationId: result.conversationId, approvalRequests: result.approvalRequests },
      result,
    ),
  };
}
if (result.status === 'timeout') {
  return {
    status: 'error',
    error: 'deadline exceeded',
    data: withStoredMessageId(
      {
        conversationId: result.conversationId,
        response: result.response,
        partial: true,
      },
      result,
    ),
  };
}
const data: Record<string, unknown> = {
  conversationId: result.conversationId,
  response: result.response,
  status: result.status,
};
if (detail.value === 'full' && result.meta !== undefined) data.meta = result.meta;
return { status: 'success', data: withStoredMessageId(data, result) };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/core/src/tools/communicate-tool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/communicate-tool.ts packages/core/src/tools/communicate-tool.test.ts
git commit -m "feat(core): expose storedMessageId in communicate results"
```

---

## Task 5: Migrate Teams state to v3 with message records

**Files:**

- Modify: `src/state.ts`
- Modify: `src/state.test.ts`

**Interfaces:**

- Produces:
  - `MessageRecord`
  - `TeamsState` with `version: 3`, `messages`, `legionMessages`
  - `emptyState()` returning v3
  - v1→v3 and v2→v3 migrations

- [ ] **Step 1: Write the failing migration tests**

In `src/state.test.ts`, add:

```ts
it('migrates v2 state to v3 with empty message maps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teams-state-'));
  await writeFile(
    join(dir, 'state.json'),
    JSON.stringify({
      version: 2,
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          externalId: 'aad-1',
          updatedAt: '2026-11-21T00:00:00.000Z',
        },
      },
      pendingPairs: {},
      legionConversations: { 'app:alice': 'thread-1' },
      legionConversationTargets: { 'thread-1': 'app:alice' },
    }),
  );

  await expect(new StateStore(dir).load()).resolves.toEqual({
    version: 3,
    conversations: {
      'app:alice': {
        conversationId: 'conv-1',
        conversationType: 'personal',
        externalId: 'aad-1',
        updatedAt: '2026-11-21T00:00:00.000Z',
      },
    },
    pendingPairs: {},
    legionConversations: { 'app:alice': 'thread-1' },
    legionConversationTargets: { 'thread-1': 'app:alice' },
    messages: {},
    legionMessages: {},
  });
});

it('round-trips v3 message records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teams-state-'));
  const store = new StateStore(dir);
  const state = emptyState();
  state.messages['app:act-1'] = {
    appId: 'app',
    conversationId: 'conv-1',
    activityId: 'act-1',
    direction: 'inbound',
    legionMessageId: 'msg-1',
    createdAt: '2026-11-24T00:00:00.000Z',
  };
  state.legionMessages['msg-1'] = 'app:act-1';

  await store.save(state);
  await expect(store.load()).resolves.toEqual(state);
});
```

Update the existing expectations:

- Rename `returns empty v2 state` to `returns empty v3 state`.
- In `migrates v1 conversations and pending pairs`, change `version: 2` to `version: 3` and add `messages: {}, legionMessages: {}`.
- In `skips null and non-object entries during v1 migration`, do the same.
- In `round-trips v2 state`, rename to `round-trips v3 state` (the body already uses `emptyState()`).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/state.test.ts
```

Expected: FAIL — loaded state still reports `version: 2` and has no `messages`/`legionMessages`.

- [ ] **Step 3: Add v3 types and migration**

In `src/state.ts`, add the record type and update `TeamsState`:

```ts
export interface MessageRecord {
  appId: string;
  conversationId: string;
  activityId: string;
  direction: 'inbound' | 'outbound';
  legionMessageId?: string;
  legionConversationId?: string;
  createdAt: string;
}
```

```ts
export interface TeamsState {
  version: 3;
  conversations: Record<string, ConversationRecord>;
  pendingPairs: Record<string, PendingPair>;
  legionConversations: Record<string, string>;
  legionConversationTargets: Record<string, string>;
  messages: Record<string, MessageRecord>;
  legionMessages: Record<string, string>;
}
```

```ts
export function emptyState(): TeamsState {
  return {
    version: 3,
    conversations: {},
    pendingPairs: {},
    legionConversations: {},
    legionConversationTargets: {},
    messages: {},
    legionMessages: {},
  };
}
```

Add a v2 shape type and validators:

```ts
interface V2State {
  version: 2;
  conversations: Record<string, ConversationRecord>;
  pendingPairs: Record<string, PendingPair>;
  legionConversations: Record<string, string>;
  legionConversationTargets?: Record<string, string>;
}

function isV2(value: unknown): value is V2State {
  return (
    isPlainObject(value) &&
    value.version === 2 &&
    isPlainObject(value.conversations) &&
    isPlainObject(value.pendingPairs) &&
    isPlainObject(value.legionConversations) &&
    (value.legionConversationTargets === undefined ||
      isPlainObject(value.legionConversationTargets))
  );
}

function isV3(value: unknown): value is TeamsState {
  return (
    isPlainObject(value) &&
    value.version === 3 &&
    isPlainObject(value.conversations) &&
    isPlainObject(value.pendingPairs) &&
    isPlainObject(value.legionConversations) &&
    isPlainObject(value.legionConversationTargets) &&
    isPlainObject(value.messages) &&
    isPlainObject(value.legionMessages)
  );
}
```

Replace `migrateV1`'s return with v3:

```ts
return {
  version: 3,
  conversations,
  pendingPairs,
  legionConversations: v1.legionConversations,
  legionConversationTargets: {},
  messages: {},
  legionMessages: {},
};
```

Replace `normalizeV2` with `migrateV2` and add `normalizeV3`:

```ts
function migrateV2(v2: V2State): TeamsState {
  return {
    version: 3,
    conversations: v2.conversations ?? {},
    pendingPairs: v2.pendingPairs ?? {},
    legionConversations: v2.legionConversations ?? {},
    legionConversationTargets: v2.legionConversationTargets ?? {},
    messages: {},
    legionMessages: {},
  };
}

function normalizeV3(parsed: TeamsState): TeamsState {
  return {
    version: 3,
    conversations: parsed.conversations ?? {},
    pendingPairs: parsed.pendingPairs ?? {},
    legionConversations: parsed.legionConversations ?? {},
    legionConversationTargets: parsed.legionConversationTargets ?? {},
    messages: parsed.messages ?? {},
    legionMessages: parsed.legionMessages ?? {},
  };
}
```

Update `load()`:

```ts
if (isV3(parsed)) return normalizeV3(parsed);
if (isV2(parsed)) return migrateV2(parsed);
if (isV1(parsed)) return migrateV1(parsed);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/state.test.ts
git commit -m "feat(teams): add v3 state with message records"
```

---

## Task 6: Add message record helpers

**Files:**

- Create: `src/tool-state.ts`
- Test: `src/tool-state.test.ts`

**Interfaces:**

- Consumes: `MessageRecord`, `TeamsState` from Task 5.
- Produces:
  - `recordMessage(state, input, maxRecords): string`
  - `lookupMessageByLegionId(state, id): MessageRecord | undefined`
  - `lookupMessageByActivityId(state, activityId, appId?, conversationId?): MessageRecord | undefined`
  - `pruneMessages(state, maxRecords): void`

- [ ] **Step 1: Write the failing tests**

Create `src/tool-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState } from './state.js';
import {
  lookupMessageByActivityId,
  lookupMessageByLegionId,
  pruneMessages,
  recordMessage,
} from './tool-state.js';

describe('recordMessage', () => {
  it('records an inbound message and indexes the Legion id', () => {
    const state = emptyState();
    const key = recordMessage(
      state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'act-1',
        direction: 'inbound',
        legionMessageId: 'msg-1',
        legionConversationId: 'thread-1',
      },
      10,
    );

    expect(key).toBe('app:act-1');
    expect(state.messages['app:act-1']).toMatchObject({
      appId: 'app',
      conversationId: 'conv-1',
      activityId: 'act-1',
      direction: 'inbound',
      legionMessageId: 'msg-1',
      legionConversationId: 'thread-1',
    });
    expect(state.legionMessages['msg-1']).toBe('app:act-1');
  });

  it('overwrites an existing record with the same key', () => {
    const state = emptyState();
    recordMessage(
      state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'act-1',
        direction: 'inbound',
        legionMessageId: 'msg-1',
      },
      10,
    );
    recordMessage(
      state,
      {
        appId: 'app',
        conversationId: 'conv-2',
        activityId: 'act-1',
        direction: 'outbound',
      },
      10,
    );
    expect(state.messages['app:act-1']).toMatchObject({
      conversationId: 'conv-2',
      direction: 'outbound',
    });
    expect(state.messages['app:act-1']?.legionMessageId).toBeUndefined();
  });
});

describe('message lookups', () => {
  it('looks up by Legion id and by activity id', () => {
    const state = emptyState();
    recordMessage(
      state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'act-1',
        direction: 'inbound',
        legionMessageId: 'msg-1',
      },
      10,
    );

    expect(lookupMessageByLegionId(state, 'msg-1')?.activityId).toBe('act-1');
    expect(lookupMessageByActivityId(state, 'act-1', 'app')?.conversationId).toBe('conv-1');
    expect(lookupMessageByActivityId(state, 'act-1', 'other')).toBeUndefined();
    expect(lookupMessageByActivityId(state, 'act-1', 'app', 'conv-2')).toBeUndefined();
  });
});

describe('pruneMessages', () => {
  it('removes the oldest records and their Legion index entries', () => {
    const state = emptyState();
    recordMessage(
      state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'a',
        direction: 'outbound',
        legionMessageId: 'm-a',
        now: '2026-01-01T00:00:00.000Z',
      },
      2,
    );
    recordMessage(
      state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'b',
        direction: 'outbound',
        legionMessageId: 'm-b',
        now: '2026-01-02T00:00:00.000Z',
      },
      2,
    );
    recordMessage(
      state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'c',
        direction: 'outbound',
        legionMessageId: 'm-c',
        now: '2026-01-03T00:00:00.000Z',
      },
      2,
    );

    expect(Object.keys(state.messages).sort()).toEqual(['app:b', 'app:c']);
    expect(state.legionMessages).toEqual({ 'm-b': 'app:b', 'm-c': 'app:c' });
  });

  it('keeps the map unchanged when under the limit', () => {
    const state = emptyState();
    recordMessage(
      state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'a',
        direction: 'outbound',
      },
      5,
    );
    pruneMessages(state, 5);
    expect(Object.keys(state.messages)).toEqual(['app:a']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/tool-state.test.ts
```

Expected: FAIL — `./tool-state.js` does not exist.

- [ ] **Step 3: Implement the helpers**

Create `src/tool-state.ts`:

```ts
import type { MessageRecord, TeamsState } from './state.js';

export interface RecordMessageInput {
  appId: string;
  conversationId: string;
  activityId: string;
  direction: 'inbound' | 'outbound';
  legionMessageId?: string;
  legionConversationId?: string;
  now?: string;
}

export function messageKey(appId: string, activityId: string): string {
  return `${appId}:${activityId}`;
}

export function recordMessage(
  state: TeamsState,
  input: RecordMessageInput,
  maxRecords: number,
): string {
  const key = messageKey(input.appId, input.activityId);
  state.messages[key] = {
    appId: input.appId,
    conversationId: input.conversationId,
    activityId: input.activityId,
    direction: input.direction,
    ...(input.legionMessageId === undefined ? {} : { legionMessageId: input.legionMessageId }),
    ...(input.legionConversationId === undefined
      ? {}
      : { legionConversationId: input.legionConversationId }),
    createdAt: input.now ?? new Date().toISOString(),
  };
  if (input.legionMessageId !== undefined) {
    state.legionMessages[input.legionMessageId] = key;
  }
  pruneMessages(state, maxRecords);
  return key;
}

export function lookupMessageByLegionId(
  state: TeamsState,
  legionMessageId: string,
): MessageRecord | undefined {
  const key = state.legionMessages[legionMessageId];
  return key === undefined ? undefined : state.messages[key];
}

export function lookupMessageByActivityId(
  state: TeamsState,
  activityId: string,
  appId?: string,
  conversationId?: string,
): MessageRecord | undefined {
  for (const record of Object.values(state.messages)) {
    if (record.activityId !== activityId) continue;
    if (appId !== undefined && record.appId !== appId) continue;
    if (conversationId !== undefined && record.conversationId !== conversationId) continue;
    return record;
  }
  return undefined;
}

export function pruneMessages(state: TeamsState, maxRecords: number): void {
  const keys = Object.keys(state.messages);
  if (keys.length <= maxRecords) return;

  const ordered = keys.sort((a, b) => {
    const left = state.messages[a]?.createdAt ?? '';
    const right = state.messages[b]?.createdAt ?? '';
    return left === right ? a.localeCompare(b) : left.localeCompare(right);
  });

  for (const key of ordered.slice(0, keys.length - maxRecords)) {
    const record = state.messages[key];
    delete state.messages[key];
    if (
      record?.legionMessageId !== undefined &&
      state.legionMessages[record.legionMessageId] === key
    ) {
      delete state.legionMessages[record.legionMessageId];
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/tool-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-state.ts src/tool-state.test.ts
git commit -m "feat(teams): add message record helpers"
```

---

## Task 7: Add tool and message-record options

**Files:**

- Modify: `src/options.ts`
- Modify: `src/options.test.ts`

**Interfaces:**

- Produces:
  - `TeamsToolName = 'cards' | 'reactions' | 'list'`
  - `TeamsConnectorOptions.tools?: TeamsToolName[] | false`
  - `TeamsConnectorOptions.maxMessageRecords?: number`
  - `TeamsConnectorOptions.maxCardBytes?: number`
  - `ResolvedOptions.tools: Set<TeamsToolName>`
  - `ResolvedOptions.maxMessageRecords: number`
  - `ResolvedOptions.maxCardBytes: number`

- [ ] **Step 1: Write the failing tests**

Append to `src/options.test.ts`:

```ts
describe('resolveOptions tools', () => {
  it('enables all tools by default', () => {
    const options = resolveOptions({ stateDir: '/tmp/x' });
    expect([...options.tools].sort()).toEqual(['cards', 'list', 'reactions']);
    expect(options.maxMessageRecords).toBe(2000);
    expect(options.maxCardBytes).toBe(28000);
  });

  it('accepts a subset', () => {
    expect([...resolveOptions({ stateDir: '/tmp/x', tools: ['cards'] }).tools]).toEqual(['cards']);
  });

  it('accepts false to disable every tool', () => {
    expect(resolveOptions({ stateDir: '/tmp/x', tools: false }).tools.size).toBe(0);
  });

  it('rejects an unknown tool name', () => {
    expect(() => resolveOptions({ stateDir: '/tmp/x', tools: ['nope' as never] })).toThrow(
      /unknown Teams tool/,
    );
  });

  it('rejects non-positive message and card limits', () => {
    expect(() => resolveOptions({ stateDir: '/tmp/x', maxMessageRecords: 0 })).toThrow(
      /maxMessageRecords/,
    );
    expect(() => resolveOptions({ stateDir: '/tmp/x', maxCardBytes: 0 })).toThrow(/maxCardBytes/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/options.test.ts
```

Expected: FAIL — the new fields are `undefined`.

- [ ] **Step 3: Add the option types and resolution**

In `src/options.ts`, add:

```ts
export type TeamsToolName = 'cards' | 'reactions' | 'list';
const TEAM_TOOL_NAMES: readonly TeamsToolName[] = ['cards', 'reactions', 'list'];
```

Add to `TeamsConnectorOptions`:

```ts
  tools?: TeamsToolName[] | false;
  maxMessageRecords?: number;
  maxCardBytes?: number;
```

Add to `ResolvedOptions`:

```ts
tools: Set<TeamsToolName>;
maxMessageRecords: number;
maxCardBytes: number;
```

Add helpers above `resolveOptions`:

```ts
function resolveTools(value: TeamsConnectorOptions['tools']): Set<TeamsToolName> {
  if (value === false) return new Set();
  if (value === undefined) return new Set(TEAM_TOOL_NAMES);
  const tools = new Set<TeamsToolName>();
  for (const name of value) {
    if (!TEAM_TOOL_NAMES.includes(name)) {
      throw new Error(`unknown Teams tool '${String(name)}' (expected cards, reactions, list)`);
    }
    tools.add(name);
  }
  return tools;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
```

Add to the returned object in `resolveOptions`:

```ts
    tools: resolveTools(options.tools),
    maxMessageRecords: positiveInteger(options.maxMessageRecords, 2000, 'maxMessageRecords'),
    maxCardBytes: positiveInteger(options.maxCardBytes, 28000, 'maxCardBytes'),
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/options.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options.ts src/options.test.ts
git commit -m "feat(teams): add tool and message-record options"
```

---

## Task 8: Track Teams activity IDs for inbound and outbound messages

**Files:**

- Modify: `src/bot-pool.ts`
- Modify: `src/bot-pool.test.ts`
- Modify: `src/connector.test.ts`
- Modify: `src/outbound.ts`
- Modify: `src/outbound.test.ts`
- Modify: `src/communicate.ts`
- Modify: `src/communicate.test.ts`
- Modify: `src/inbound.ts`
- Modify: `src/inbound.test.ts`

**Interfaces:**

- Consumes: Task 5 `MessageRecord`, Task 6 `recordMessage`, Task 7 `maxMessageRecords`.
- Produces:
  - `TeamsAppLike.send(...): Promise<{ id?: string }>`
  - `TeamsAppLike.api.reactions.add/delete`
  - `TeamsActivity.id?: string`
  - `runCommunicate(...): Promise<{ result; conversationId; storedMessageId?; outboundActivityId? }>`

- [ ] **Step 1: Update the SDK-facing types**

In `src/bot-pool.ts`, replace `TeamsAppLike`:

```ts
export interface TeamsAppLike {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(conversationId: string, activity: unknown): Promise<{ id?: string }>;
  api: {
    conversations: { create(params: Record<string, unknown>): Promise<{ id: string }> };
    reactions: {
      add(conversationId: string, activityId: string, type: string): Promise<void>;
      delete(conversationId: string, activityId: string, type: string): Promise<void>;
    };
  };
  on(event: string, handler: (ctx: unknown) => Promise<void> | void): void;
}
```

In `src/inbound.ts`, add `id?: string;` to `TeamsActivity`:

```ts
export interface TeamsActivity {
  id?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  // existing fields unchanged
}
```

Update the fake apps:

- `src/bot-pool.test.ts` `fakeApp()`: `send` returns `{ id: 'act-1' }`, and `api` gains `reactions: { add: async () => undefined, delete: async () => undefined }`.
- `src/connector.test.ts` `setup()` app: `send` returns `{ id: 'activity-1' }`, and `api` gains the same `reactions` stubs.

- [ ] **Step 2: Write the failing outbound test**

Append to `src/outbound.test.ts`:

```ts
it('records outbound activity ids and maps the first chunk to the Legion message', async () => {
  const s = setup(
    [
      { id: 'assistant', identities: [{ connector: 'teams-bot', externalId: 'app' }] },
      { id: 'alice', identities: [{ connector: 'teams', externalId: 'aad-1' }] },
    ],
    { 'app:alice': { conversationId: 'conv-1', updatedAt: 'now' } },
  );
  const send = vi.fn(async () => ({ id: 'teams-act-1' }));
  s.apps.getByAppId = () => ({ send, api: { conversations: { create: s.create } } }) as never;

  await deliverMessage(
    {
      collective: s.collective,
      state: s.state as never,
      stateStore: { save: s.save } as never,
      apps: s.apps as never,
      options: resolveOptions({ stateDir: '/tmp/x', maxMessageRecords: 10 }),
    },
    {
      id: 'legion-msg-1',
      senderId: 'assistant',
      recipientId: 'alice',
      conversationId: 'legion-1',
      content: 'hello',
    },
  );

  expect(s.state.messages['app:teams-act-1']).toMatchObject({
    direction: 'outbound',
    conversationId: 'conv-1',
    legionMessageId: 'legion-msg-1',
    legionConversationId: 'legion-1',
  });
  expect(s.state.legionMessages['legion-msg-1']).toBe('app:teams-act-1');
});
```

- [ ] **Step 3: Write the failing communicate test**

Append to `src/communicate.test.ts`:

```ts
it('returns the stored Legion message id and the streamed activity id', async () => {
  const stream = fakeStream();
  const ctx = fakeCtx([
    {
      type: 'stream:done',
      result: {
        status: 'success',
        data: { conversationId: 'thread-1', storedMessageId: 'msg-1' },
      },
    },
  ]);
  const result = await runCommunicate({
    ctx,
    userId: 'alice',
    botOwnerId: 'assistant',
    text: 'hi',
    options: options(),
    stream,
    send: async () => undefined,
  });
  expect(result.storedMessageId).toBe('msg-1');
  expect(result.outboundActivityId).toBe('m1');
});
```

- [ ] **Step 4: Write the failing inbound test**

Append to `src/inbound.test.ts`:

```ts
it('records inbound and outbound message ids after a turn', async () => {
  const s = setup([
    alice,
    { id: 'assistant', identities: [{ connector: 'teams-bot', externalId: 'app' }] },
  ]);
  s.streamTool = vi.fn(async () => ({
    conversationId: 'conv-1',
    gen: (async function* (): AsyncGenerator<StreamChunk> {
      yield {
        type: 'stream:done',
        result: {
          status: 'success',
          data: { conversationId: 'thread-1', storedMessageId: 'msg-1' },
        },
      };
    })(),
  }));
  const ctx = { ...s.ctx, streamTool: s.streamTool } as unknown as ConnectorContext;
  const stream = {
    emit() {},
    update() {},
    async close() {
      return { id: 'act-out-1' };
    },
  };

  await handleInbound(
    { ...inboundDeps(s), ctx },
    { activity: { ...activity('hello'), id: 'act-in-1' }, send: captureReply(), stream },
  );

  expect(s.state.messages['app:act-in-1']).toMatchObject({
    direction: 'inbound',
    legionMessageId: 'msg-1',
    conversationId: 'conv-1',
  });
  expect(s.state.messages['app:act-out-1']).toMatchObject({
    direction: 'outbound',
    conversationId: 'conv-1',
  });
  expect(s.save).toHaveBeenCalled();
});
```

- [ ] **Step 5: Run the tests to verify they fail**

```bash
npx vitest run src/outbound.test.ts src/communicate.test.ts src/inbound.test.ts
```

Expected: FAIL — no message records are written and `runCommunicate` returns only `result`/`conversationId`.

- [ ] **Step 6: Record outbound IDs in `deliverMessage`**

In `src/outbound.ts`, import `recordMessage`:

```ts
import { recordMessage } from './tool-state.js';
```

Change `OutboundApp.send` and the `deliverMessage` message argument:

```ts
export interface OutboundApp {
  send(conversationId: string, activity: MessageActivityInput): Promise<{ id?: string }>;
  api: {
    conversations: {
      create(params: Record<string, unknown>): Promise<{ id: string }>;
    };
  };
}
```

```ts
export async function deliverMessage(
  deps: OutboundDeps,
  message: {
    id?: string;
    senderId: string;
    recipientId: string;
    conversationId: string;
    content: string;
  },
): Promise<DeliveryOutcome> {
```

Inside the chunk loop, replace the send call:

```ts
let firstChunk = true;
for (const chunk of chunkMarkdown(message.content, deps.options.maxMessageChars)) {
  const activity = new MessageActivityInput(chunk);
  if (deps.options.aiLabel) activity.addAiGenerated();
  try {
    const sent = await app.send(record.conversationId, activity);
    const activityId = sent?.id;
    if (activityId) {
      recordMessage(
        deps.state,
        {
          appId,
          conversationId: record.conversationId,
          activityId,
          direction: 'outbound',
          ...(firstChunk && message.id !== undefined ? { legionMessageId: message.id } : {}),
          legionConversationId: message.conversationId,
        },
        deps.options.maxMessageRecords,
      );
    }
    firstChunk = false;
  } catch (error) {
    const reason = describeError(error);
    console.error('Teams message delivery failed', reason);
    return { status: 'failed', reason: `Teams message delivery failed: ${reason}` };
  }
}
```

- [ ] **Step 7: Capture IDs in `runCommunicate`**

In `src/communicate.ts`, change the return type:

```ts
export async function runCommunicate(deps: CommunicateDeps): Promise<{
  result: ToolResult;
  conversationId: string | undefined;
  storedMessageId?: string;
  outboundActivityId?: string;
}> {
```

Add state near the top of the function:

```ts
let outboundActivityId: string | undefined;
const closeStream = async (): Promise<void> => {
  if (!deps.stream) return;
  const sent = await deps.stream.close();
  outboundActivityId = sent?.id ?? outboundActivityId;
};
```

Replace both `await deps.stream.close();` calls with `await closeStream();`.

Extend the `data` cast:

```ts
const data = final?.data as
  | {
      conversationId?: unknown;
      response?: unknown;
      approvalRequests?: ApprovalRequest[];
      storedMessageId?: unknown;
    }
  | undefined;
```

Add before the return:

```ts
const storedMessageId =
  typeof data?.storedMessageId === 'string' ? data.storedMessageId : undefined;
```

Return:

```ts
return {
  result: final ?? { status: 'success' },
  conversationId:
    typeof data?.conversationId === 'string'
      ? data.conversationId
      : final?.status === 'error'
        ? undefined
        : conversationId,
  ...(storedMessageId === undefined ? {} : { storedMessageId }),
  ...(outboundActivityId === undefined ? {} : { outboundActivityId }),
};
```

- [ ] **Step 8: Record inbound and streamed IDs in `runTurn`**

In `src/inbound.ts`, import `recordMessage`:

```ts
import { recordMessage } from './tool-state.js';
```

Replace the `runCommunicate` call and save block in `runTurn`:

```ts
const turn = await runCommunicate({
  ctx: deps.ctx,
  userId: participantId,
  botOwnerId: deps.bot.participantId,
  text,
  conversationId: deps.state.legionConversations[key],
  options: deps.options,
  stream: context.stream,
  send: (activity) => context.send(activity),
  stopTyping,
});

const { conversationId, storedMessageId, outboundActivityId } = turn;
let changed = false;
if (conversationId !== undefined) {
  deps.state.legionConversations[key] = conversationId;
  deps.state.legionConversationTargets[conversationId] = key;
  changed = true;
}

const teamsConversationId = context.activity.conversation?.id;
const inboundActivityId = context.activity.id;
if (teamsConversationId && inboundActivityId && storedMessageId) {
  recordMessage(
    deps.state,
    {
      appId: deps.bot.appId,
      conversationId: teamsConversationId,
      activityId: inboundActivityId,
      direction: 'inbound',
      legionMessageId: storedMessageId,
      ...(conversationId === undefined ? {} : { legionConversationId: conversationId }),
    },
    deps.options.maxMessageRecords,
  );
  changed = true;
}
if (teamsConversationId && outboundActivityId) {
  recordMessage(
    deps.state,
    {
      appId: deps.bot.appId,
      conversationId: teamsConversationId,
      activityId: outboundActivityId,
      direction: 'outbound',
      ...(conversationId === undefined ? {} : { legionConversationId: conversationId }),
    },
    deps.options.maxMessageRecords,
  );
  changed = true;
}
if (changed) await deps.stateStore.save(deps.state);
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
npx vitest run src/outbound.test.ts src/communicate.test.ts src/inbound.test.ts src/bot-pool.test.ts src/connector.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/bot-pool.ts src/bot-pool.test.ts src/connector.test.ts \
  src/outbound.ts src/outbound.test.ts src/communicate.ts src/communicate.test.ts \
  src/inbound.ts src/inbound.test.ts
git commit -m "feat(teams): track Teams activity ids for inbound and outbound messages"
```

---

## Task 9: Add conversation and message target resolution

**Files:**

- Create: `src/tool-targets.ts`
- Test: `src/tool-targets.test.ts`

**Interfaces:**

- Consumes: `BotPool`, `TeamsAppLike`, `CollectiveLike`, `ResolvedOptions`, `StateStore`, `TeamsState`, `recordMessage`, `lookupMessageBy*`.
- Produces:
  - `TeamsToolDeps`
  - `resolveCallerBot(deps, participantId): Resolved<CallerBot>`
  - `resolveConversationTarget(deps, appId, app, args): Promise<Resolved<{ conversationId; key? }>>`
  - `resolveMessageTarget(deps, appId, args): Resolved<{ conversationId; activityId }>`

- [ ] **Step 1: Write the failing tests**

Create `src/tool-targets.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { BotPool, TeamsAppLike } from './bot-pool.js';
import type { CollectiveLike } from './directory.js';
import { resolveOptions } from './options.js';
import { emptyState, type StateStore, type TeamsState } from './state.js';
import { recordMessage } from './tool-state.js';
import {
  resolveCallerBot,
  resolveConversationTarget,
  resolveMessageTarget,
} from './tool-targets.js';

function setup(
  args: {
    participants?: Array<Record<string, unknown>>;
    conversations?: TeamsState['conversations'];
  } = {},
) {
  const participants = args.participants ?? [
    { id: 'assistant', identities: [{ connector: 'teams-bot', externalId: 'app' }] },
    { id: 'alice', identities: [{ connector: 'teams', externalId: 'aad-1' }] },
    { id: 'team-eng', identities: [{ connector: 'teams-group', externalId: '19:g@thread.v2' }] },
  ];
  const create = vi.fn(async () => ({ id: 'conv-new' }));
  const app: TeamsAppLike = {
    initialize: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    send: async () => ({ id: 'act-1' }),
    api: {
      conversations: { create },
      reactions: { add: async () => undefined, delete: async () => undefined },
    },
    on: () => undefined,
  };
  const collective = {
    list: () => participants,
    get: (id: string) => participants.find((p) => p.id === id),
  } as unknown as CollectiveLike;
  const pool = {
    getByAppId: (appId: string) => (appId === 'app' ? app : undefined),
    ownerOf: (appId: string) => (appId === 'app' ? 'assistant' : undefined),
  } as unknown as BotPool;
  const state: TeamsState = { ...emptyState(), conversations: args.conversations ?? {} };
  const deps = {
    collective,
    pool,
    state,
    store: { save: vi.fn(async () => undefined) } as unknown as StateStore,
    options: resolveOptions({ stateDir: '/tmp/x', tenantId: 'tenant-1' }),
  };
  return { deps, app, create };
}

describe('resolveCallerBot', () => {
  it("resolves the caller's live bot", () => {
    const { deps, app } = setup();
    expect(resolveCallerBot(deps, 'assistant')).toEqual({
      ok: true,
      value: { appId: 'app', app },
    });
  });

  it('rejects a caller without a teams-bot identity', () => {
    const { deps } = setup();
    const result = resolveCallerBot(deps, 'alice');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no Teams bot');
  });

  it('rejects a bot owned by another participant', () => {
    const { deps } = setup();
    deps.pool = {
      getByAppId: () => undefined,
      ownerOf: () => 'someone-else',
    } as unknown as BotPool;
    const result = resolveCallerBot(deps, 'assistant');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no live Teams bot');
  });
});

describe('resolveConversationTarget', () => {
  it('uses a stored personal conversation', async () => {
    const { deps, app } = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    expect(await resolveConversationTarget(deps, 'app', app, { participantId: 'alice' })).toEqual({
      ok: true,
      value: { conversationId: 'conv-1', key: 'app:alice' },
    });
  });

  it('creates a personal conversation when none exists', async () => {
    const { deps, app, create } = setup();
    const result = await resolveConversationTarget(deps, 'app', app, { participantId: 'alice' });
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      members: [{ id: 'aad-1' }],
      tenantId: 'tenant-1',
      channelData: { tenant: { id: 'tenant-1' } },
    });
    expect(deps.state.conversations['app:alice']?.conversationId).toBe('conv-new');
  });

  it('uses the group identity conversation id', async () => {
    const { deps, app } = setup();
    expect(
      await resolveConversationTarget(deps, 'app', app, { participantId: 'team-eng' }),
    ).toEqual({
      ok: true,
      value: { conversationId: '19:g@thread.v2', key: 'app:team-eng:19:g@thread.v2' },
    });
  });

  it('resolves a raw conversation that belongs to the bot', async () => {
    const { deps, app } = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    expect(await resolveConversationTarget(deps, 'app', app, { conversationId: 'conv-1' })).toEqual(
      {
        ok: true,
        value: { conversationId: 'conv-1', key: 'app:alice' },
      },
    );
  });

  it('rejects an unknown raw conversation', async () => {
    const { deps, app } = setup();
    const result = await resolveConversationTarget(deps, 'app', app, { conversationId: 'conv-x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('does not belong');
  });

  it('rejects an unknown participant', async () => {
    const { deps, app } = setup();
    const result = await resolveConversationTarget(deps, 'app', app, { participantId: 'ghost' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not found');
  });
});

describe('resolveMessageTarget', () => {
  it('resolves a message by Legion id', () => {
    const { deps } = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    recordMessage(
      deps.state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'act-1',
        direction: 'inbound',
        legionMessageId: 'msg-1',
      },
      10,
    );
    expect(resolveMessageTarget(deps, 'app', { messageId: 'msg-1' })).toEqual({
      ok: true,
      value: { conversationId: 'conv-1', activityId: 'act-1' },
    });
  });

  it('resolves a message by recorded activity id', () => {
    const { deps } = setup();
    recordMessage(
      deps.state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'act-1',
        direction: 'outbound',
      },
      10,
    );
    expect(resolveMessageTarget(deps, 'app', { messageId: 'act-1' })).toEqual({
      ok: true,
      value: { conversationId: 'conv-1', activityId: 'act-1' },
    });
  });

  it('accepts a raw activity id with a bot conversation', () => {
    const { deps } = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    expect(
      resolveMessageTarget(deps, 'app', { messageId: 'act-raw', conversationId: 'conv-1' }),
    ).toEqual({ ok: true, value: { conversationId: 'conv-1', activityId: 'act-raw' } });
  });

  it('rejects a raw activity id with an unknown conversation', () => {
    const { deps } = setup();
    const result = resolveMessageTarget(deps, 'app', {
      messageId: 'act-raw',
      conversationId: 'conv-x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('does not belong');
  });

  it('rejects a message recorded for another bot', () => {
    const { deps } = setup();
    recordMessage(
      deps.state,
      {
        appId: 'other',
        conversationId: 'conv-1',
        activityId: 'act-1',
        direction: 'inbound',
        legionMessageId: 'msg-1',
      },
      10,
    );
    const result = resolveMessageTarget(deps, 'app', { messageId: 'msg-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('another bot');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/tool-targets.test.ts
```

Expected: FAIL — `./tool-targets.js` does not exist.

- [ ] **Step 3: Implement `src/tool-targets.ts`**

```ts
import type { BotPool, TeamsAppLike } from './bot-pool.js';
import type { CollectiveLike } from './directory.js';
import { describeError } from './errors.js';
import type { ResolvedOptions } from './options.js';
import type { StateStore, TeamsState } from './state.js';
import { lookupMessageByActivityId, lookupMessageByLegionId } from './tool-state.js';

export interface TeamsToolDeps {
  collective: CollectiveLike;
  pool: BotPool;
  state: TeamsState;
  store: StateStore;
  options: ResolvedOptions;
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CallerBot {
  appId: string;
  app: TeamsAppLike;
}

function fail<T>(error: string): Resolved<T> {
  return { ok: false, error };
}

function succeed<T>(value: T): Resolved<T> {
  return { ok: true, value };
}

export function resolveCallerBot(deps: TeamsToolDeps, participantId: string): Resolved<CallerBot> {
  const participant = deps.collective.get(participantId);
  const identity = participant?.identities?.find((item) => item.connector === 'teams-bot');
  if (!identity) {
    return fail(`caller '${participantId}' has no Teams bot identity`);
  }

  const appId = identity.externalId;
  if (deps.pool.ownerOf(appId) !== participantId) {
    return fail(`caller '${participantId}' has no live Teams bot`);
  }
  const app = deps.pool.getByAppId(appId);
  if (!app) {
    return fail(`Teams app '${appId}' is not running`);
  }
  return succeed({ appId, app });
}

function conversationForApp(
  state: TeamsState,
  appId: string,
  conversationId: string,
): string | undefined {
  for (const [key, record] of Object.entries(state.conversations)) {
    if (key.startsWith(`${appId}:`) && record.conversationId === conversationId) return key;
  }
  return undefined;
}

export async function resolveConversationTarget(
  deps: TeamsToolDeps,
  appId: string,
  app: TeamsAppLike,
  args: { participantId?: string; conversationId?: string },
): Promise<Resolved<{ conversationId: string; key?: string }>> {
  if (args.conversationId !== undefined) {
    const key = conversationForApp(deps.state, appId, args.conversationId);
    if (!key) {
      return fail(`conversation '${args.conversationId}' does not belong to the caller's bot`);
    }
    return succeed({ conversationId: args.conversationId, key });
  }

  const participantId = args.participantId;
  if (participantId === undefined) {
    return fail('a participantId or conversationId is required');
  }
  const participant = deps.collective.get(participantId);
  if (!participant) {
    return fail(`participant '${participantId}' not found`);
  }

  const group = participant.identities?.find((item) => item.connector === 'teams-group');
  if (group) {
    const key = `${appId}:${participantId}:${group.externalId}`;
    const record = deps.state.conversations[key];
    return succeed({ conversationId: record?.conversationId ?? group.externalId, key });
  }

  const user = participant.identities?.find((item) => item.connector === 'teams');
  if (!user) {
    return fail(`participant '${participantId}' has no Teams identity`);
  }

  const key = `${appId}:${participantId}`;
  const existing = deps.state.conversations[key];
  if (existing) {
    return succeed({ conversationId: existing.conversationId, key });
  }

  try {
    const conversation = await app.api.conversations.create({
      members: [{ id: user.externalId }],
      tenantId: deps.options.tenantId,
      channelData: { tenant: { id: deps.options.tenantId } },
    });
    deps.state.conversations[key] = {
      conversationId: conversation.id,
      conversationType: 'personal',
      externalId: user.externalId,
      tenantId: deps.options.tenantId,
      updatedAt: new Date().toISOString(),
    };
    return succeed({ conversationId: conversation.id, key });
  } catch (error) {
    return fail(`Teams conversation creation failed: ${describeError(error)}`);
  }
}

export function resolveMessageTarget(
  deps: TeamsToolDeps,
  appId: string,
  args: { messageId: string; conversationId?: string },
): Resolved<{ conversationId: string; activityId: string }> {
  const legionRecord = lookupMessageByLegionId(deps.state, args.messageId);
  if (legionRecord) {
    if (legionRecord.appId !== appId) {
      return fail(`message '${args.messageId}' belongs to another bot`);
    }
    return succeed({
      conversationId: legionRecord.conversationId,
      activityId: legionRecord.activityId,
    });
  }

  const record = lookupMessageByActivityId(deps.state, args.messageId, appId, args.conversationId);
  if (record) {
    return succeed({ conversationId: record.conversationId, activityId: record.activityId });
  }

  if (args.conversationId !== undefined) {
    const key = conversationForApp(deps.state, appId, args.conversationId);
    if (!key) {
      return fail(`conversation '${args.conversationId}' does not belong to the caller's bot`);
    }
    return succeed({ conversationId: args.conversationId, activityId: args.messageId });
  }

  return fail(`message '${args.messageId}' not found`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/tool-targets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-targets.ts src/tool-targets.test.ts
git commit -m "feat(teams): add conversation and message target resolution"
```

---

## Task 10: Add `teams__send_card`

**Files:**

- Create: `src/tools.ts`
- Test: `src/tools.test.ts`

**Interfaces:**

- Consumes: `TeamsToolDeps`, `resolveCallerBot`, `resolveConversationTarget`, `recordMessage`.
- Produces: `sendCardTool(deps): Tool` with name `teams__send_card`.

- [ ] **Step 1: Write the failing tests**

Create `src/tools.test.ts` with a shared setup and the `send_card` tests:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolResult } from '@legion-collective/core';
import type { BotPool, TeamsAppLike } from './bot-pool.js';
import type { CollectiveLike } from './directory.js';
import { resolveOptions } from './options.js';
import { emptyState, type StateStore, type TeamsState } from './state.js';
import { sendCardTool } from './tools.js';

function setup(
  args: {
    participants?: Array<Record<string, unknown>>;
    conversations?: TeamsState['conversations'];
    options?: Record<string, unknown>;
  } = {},
) {
  const participants = args.participants ?? [
    { id: 'assistant', identities: [{ connector: 'teams-bot', externalId: 'app' }] },
    { id: 'alice', identities: [{ connector: 'teams', externalId: 'aad-1' }] },
    { id: 'team-eng', identities: [{ connector: 'teams-group', externalId: '19:g@thread.v2' }] },
  ];
  const sent: Array<{ conversationId: string; activity: unknown }> = [];
  const reactions = {
    add: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const create = vi.fn(async () => ({ id: 'conv-new' }));
  const app: TeamsAppLike = {
    initialize: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    send: async (conversationId, activity) => {
      sent.push({ conversationId, activity });
      return { id: `act-${sent.length}` };
    },
    api: { conversations: { create }, reactions },
    on: () => undefined,
  };
  const collective = {
    list: () => participants,
    get: (id: string) => participants.find((p) => p.id === id),
  } as unknown as CollectiveLike;
  const pool = {
    getByAppId: (appId: string) => (appId === 'app' ? app : undefined),
    ownerOf: (appId: string) => (appId === 'app' ? 'assistant' : undefined),
  } as unknown as BotPool;
  const state: TeamsState = { ...emptyState(), conversations: args.conversations ?? {} };
  const deps = {
    collective,
    pool,
    state,
    store: { save: vi.fn(async () => undefined) } as unknown as StateStore,
    options: resolveOptions({ stateDir: '/tmp/x', tenantId: 'tenant-1', ...args.options }),
  };
  const context = { participant: { id: 'assistant' } } as unknown as ToolContext;
  return { deps, context, app, sent, reactions, create };
}

async function run(tool: ReturnType<typeof sendCardTool>, context: ToolContext, args: unknown) {
  return (await tool.execute(args, context)) as ToolResult;
}

describe('teams__send_card', () => {
  it('sends an Adaptive Card to a participant and records the activity id', async () => {
    const s = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    const result = await run(sendCardTool(s.deps), s.context, {
      participantId: 'alice',
      card: { type: 'AdaptiveCard', version: '1.4', body: [] },
    });

    expect(result.status).toBe('success');
    expect(s.sent[0]?.conversationId).toBe('conv-1');
    const activity = s.sent[0]?.activity as {
      attachments?: Array<{ contentType: string }>;
    };
    expect(activity.attachments?.[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(s.deps.state.messages['app:act-1']).toMatchObject({
      direction: 'outbound',
      conversationId: 'conv-1',
    });
    expect(result.data).toMatchObject({ conversationId: 'conv-1', activityId: 'act-1' });
  });

  it('sends to a raw Teams conversation that belongs to the caller', async () => {
    const s = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    const result = await run(sendCardTool(s.deps), s.context, {
      conversationId: 'conv-1',
      card: { type: 'AdaptiveCard', version: '1.4', body: [] },
    });
    expect(result.status).toBe('success');
    expect(s.sent[0]?.conversationId).toBe('conv-1');
  });

  it('rejects a caller without a live bot', async () => {
    const s = setup({
      participants: [{ id: 'alice', identities: [{ connector: 'teams', externalId: 'aad-1' }] }],
    });
    const result = await run(sendCardTool(s.deps), s.context, {
      participantId: 'alice',
      card: { type: 'AdaptiveCard', version: '1.4', body: [] },
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('no Teams bot');
  });

  it('rejects an unknown recipient', async () => {
    const s = setup();
    const result = await run(sendCardTool(s.deps), s.context, {
      participantId: 'ghost',
      card: { type: 'AdaptiveCard', version: '1.4', body: [] },
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
  });

  it('rejects a card larger than maxCardBytes', async () => {
    const s = setup({ options: { maxCardBytes: 10 } });
    const result = await run(sendCardTool(s.deps), s.context, {
      participantId: 'alice',
      card: { type: 'AdaptiveCard', version: '1.4', body: [] },
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('max');
  });

  it('reports SDK send failures as tool errors', async () => {
    const s = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    s.app.send = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await run(sendCardTool(s.deps), s.context, {
      participantId: 'alice',
      card: { type: 'AdaptiveCard', version: '1.4', body: [] },
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('boom');
  });

  it('requires exactly one target', async () => {
    const s = setup();
    const result = await run(sendCardTool(s.deps), s.context, {
      card: { type: 'AdaptiveCard', version: '1.4', body: [] },
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('exactly one');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/tools.test.ts
```

Expected: FAIL — `./tools.js` does not exist.

- [ ] **Step 3: Implement the module and `sendCardTool`**

Create `src/tools.ts`:

```ts
import type { AnyTool, Tool, ToolContext, ToolResult } from '@legion-collective/core';
import type { IAdaptiveCard } from '@microsoft/teams.cards';
import { MessageActivityInput } from '@microsoft/teams.api';
import { describeError } from './errors.js';
import { resolveCallerBot, resolveConversationTarget, type TeamsToolDeps } from './tool-targets.js';
import { recordMessage } from './tool-state.js';

const ok = (data: unknown): ToolResult => ({ status: 'success', data });
const fail = (error: string): ToolResult => ({ status: 'error', error });

async function saveQuietly(deps: TeamsToolDeps): Promise<void> {
  try {
    await deps.store.save(deps.state);
  } catch (error) {
    console.error('Teams state save failed', describeError(error));
  }
}

export function sendCardTool(deps: TeamsToolDeps): Tool {
  return {
    name: 'teams__send_card',
    description: "Send an Adaptive Card to a Teams conversation through the caller's Teams bot.",
    parameters: {
      type: 'object',
      properties: {
        participantId: {
          type: 'string',
          description: 'Legion user or group participant to send to',
        },
        conversationId: {
          type: 'string',
          description: "Raw Teams conversation id; must belong to the caller's bot",
        },
        card: {
          type: 'object',
          description: 'Adaptive Card JSON (schema version 1.4 or later)',
        },
        fallbackText: {
          type: 'string',
          description: 'Plain-text summary shown when the card cannot render',
        },
        aiLabel: {
          type: 'boolean',
          description: 'Mark the message as AI-generated',
        },
      },
      required: ['card'],
    },
    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const raw = (args ?? {}) as Record<string, unknown>;
      const card = raw.card;
      if (typeof card !== 'object' || card === null || Array.isArray(card)) {
        return fail('teams__send_card: card must be an object');
      }

      const participantId =
        typeof raw.participantId === 'string' && raw.participantId.trim()
          ? raw.participantId.trim()
          : undefined;
      const conversationId =
        typeof raw.conversationId === 'string' && raw.conversationId.trim()
          ? raw.conversationId.trim()
          : undefined;
      if ((participantId === undefined) === (conversationId === undefined)) {
        return fail('teams__send_card: exactly one of participantId or conversationId is required');
      }

      const caller = resolveCallerBot(deps, context.participant.id);
      if (!caller.ok) return fail(caller.error);

      const target = await resolveConversationTarget(deps, caller.value.appId, caller.value.app, {
        participantId,
        conversationId,
      });
      if (!target.ok) return fail(target.error);

      const serialized = JSON.stringify(card);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > deps.options.maxCardBytes) {
        return fail(`teams__send_card: card is ${bytes} bytes (max ${deps.options.maxCardBytes})`);
      }

      const activity =
        typeof raw.fallbackText === 'string' && raw.fallbackText.trim()
          ? new MessageActivityInput('', { summary: raw.fallbackText })
          : new MessageActivityInput();
      activity.addCard('adaptive', card as IAdaptiveCard);

      const aiLabel = typeof raw.aiLabel === 'boolean' ? raw.aiLabel : deps.options.aiLabel;
      if (aiLabel) activity.addAiGenerated();

      let sent: { id?: string };
      try {
        sent = await caller.value.app.send(target.value.conversationId, activity);
      } catch (error) {
        return fail(`teams__send_card: ${describeError(error)}`);
      }

      const activityId = sent?.id;
      if (activityId) {
        recordMessage(
          deps.state,
          {
            appId: caller.value.appId,
            conversationId: target.value.conversationId,
            activityId,
            direction: 'outbound',
          },
          deps.options.maxMessageRecords,
        );
      }
      await saveQuietly(deps);

      return ok({
        conversationId: target.value.conversationId,
        ...(activityId === undefined ? {} : { activityId }),
      });
    },
  };
}

export function buildTeamsTools(deps: TeamsToolDeps): AnyTool[] {
  const tools: AnyTool[] = [];
  if (deps.options.tools.has('cards')) tools.push(sendCardTool(deps));
  return tools;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/tools.test.ts
git commit -m "feat(teams): add teams__send_card tool"
```

---

## Task 11: Add `teams__post_reaction`

**Files:**

- Modify: `src/tools.ts`
- Modify: `src/tools.test.ts`

**Interfaces:**

- Consumes: `resolveMessageTarget`.
- Produces: `postReactionTool(deps): Tool` with name `teams__post_reaction`; `buildTeamsTools` includes it when enabled.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools.test.ts`:

```ts
describe('teams__post_reaction', () => {
  it('adds a reaction by Legion message id', async () => {
    const s = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    recordMessage(
      s.deps.state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'act-msg',
        direction: 'inbound',
        legionMessageId: 'msg-1',
      },
      10,
    );

    const result = await run(postReactionTool(s.deps), s.context, {
      messageId: 'msg-1',
      reaction: 'like',
    });

    expect(result.status).toBe('success');
    expect(s.reactions.add).toHaveBeenCalledWith('conv-1', 'act-msg', 'like');
  });

  it('removes a reaction when remove is true', async () => {
    const s = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    recordMessage(
      s.deps.state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'act-msg',
        direction: 'inbound',
        legionMessageId: 'msg-1',
      },
      10,
    );

    const result = await run(postReactionTool(s.deps), s.context, {
      messageId: 'msg-1',
      reaction: 'heart',
      remove: true,
    });

    expect(result.status).toBe('success');
    expect(s.reactions.delete).toHaveBeenCalledWith('conv-1', 'act-msg', 'heart');
  });

  it('accepts a raw activity id with a conversation', async () => {
    const s = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    const result = await run(postReactionTool(s.deps), s.context, {
      messageId: 'act-raw',
      reaction: 'launch',
      conversationId: 'conv-1',
    });

    expect(result.status).toBe('success');
    expect(s.reactions.add).toHaveBeenCalledWith('conv-1', 'act-raw', 'launch');
  });

  it('rejects an unknown message', async () => {
    const s = setup();
    const result = await run(postReactionTool(s.deps), s.context, {
      messageId: 'nope',
      reaction: 'like',
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
  });

  it('rejects a message recorded for another bot', async () => {
    const s = setup();
    recordMessage(
      s.deps.state,
      {
        appId: 'other',
        conversationId: 'conv-1',
        activityId: 'act-msg',
        direction: 'inbound',
        legionMessageId: 'msg-1',
      },
      10,
    );
    const result = await run(postReactionTool(s.deps), s.context, {
      messageId: 'msg-1',
      reaction: 'like',
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('another bot');
  });

  it('reports SDK reaction failures as tool errors', async () => {
    const s = setup({
      conversations: {
        'app:alice': {
          conversationId: 'conv-1',
          conversationType: 'personal',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    recordMessage(
      s.deps.state,
      {
        appId: 'app',
        conversationId: 'conv-1',
        activityId: 'act-msg',
        direction: 'inbound',
        legionMessageId: 'msg-1',
      },
      10,
    );
    s.reactions.add.mockRejectedValue(new Error('reaction failed'));

    const result = await run(postReactionTool(s.deps), s.context, {
      messageId: 'msg-1',
      reaction: 'like',
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('reaction failed');
  });
});
```

Update the import at the top of `src/tools.test.ts`:

```ts
import { sendCardTool, postReactionTool } from './tools.js';
import { recordMessage } from './tool-state.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/tools.test.ts
```

Expected: FAIL — `postReactionTool` is not exported.

- [ ] **Step 3: Implement `postReactionTool`**

Add to `src/tools.ts` after `sendCardTool`:

```ts
export function postReactionTool(deps: TeamsToolDeps): Tool {
  return {
    name: 'teams__post_reaction',
    description:
      "Add or remove an emoji reaction on a Teams message through the caller's Teams bot.",
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'Legion message id or Teams activity id',
        },
        reaction: {
          type: 'string',
          description: 'Emoji reaction type, e.g. like, heart, 1f440_eyes, launch',
        },
        conversationId: {
          type: 'string',
          description:
            'Teams conversation id; required when messageId is a raw activity id that is not recorded',
        },
        remove: {
          type: 'boolean',
          description: 'Remove instead of add',
        },
      },
      required: ['messageId', 'reaction'],
    },
    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const raw = (args ?? {}) as Record<string, unknown>;
      const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : '';
      const reaction = typeof raw.reaction === 'string' ? raw.reaction.trim() : '';
      if (!messageId) return fail('teams__post_reaction: messageId is required');
      if (!reaction) return fail('teams__post_reaction: reaction is required');

      const conversationId =
        typeof raw.conversationId === 'string' && raw.conversationId.trim()
          ? raw.conversationId.trim()
          : undefined;

      const caller = resolveCallerBot(deps, context.participant.id);
      if (!caller.ok) return fail(caller.error);

      const target = resolveMessageTarget(deps, caller.value.appId, {
        messageId,
        conversationId,
      });
      if (!target.ok) return fail(target.error);

      const remove = raw.remove === true;
      try {
        if (remove) {
          await caller.value.app.api.reactions.delete(
            target.value.conversationId,
            target.value.activityId,
            reaction,
          );
        } else {
          await caller.value.app.api.reactions.add(
            target.value.conversationId,
            target.value.activityId,
            reaction,
          );
        }
      } catch (error) {
        return fail(`teams__post_reaction: ${describeError(error)}`);
      }

      return ok({
        conversationId: target.value.conversationId,
        activityId: target.value.activityId,
        reaction,
        removed: remove,
      });
    },
  };
}
```

Add `resolveMessageTarget` to the imports:

```ts
import {
  resolveCallerBot,
  resolveConversationTarget,
  resolveMessageTarget,
  type TeamsToolDeps,
} from './tool-targets.js';
```

Update `buildTeamsTools`:

```ts
export function buildTeamsTools(deps: TeamsToolDeps): AnyTool[] {
  const tools: AnyTool[] = [];
  if (deps.options.tools.has('cards')) tools.push(sendCardTool(deps));
  if (deps.options.tools.has('reactions')) tools.push(postReactionTool(deps));
  return tools;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/tools.test.ts
git commit -m "feat(teams): add teams__post_reaction tool"
```

---

## Task 12: Add `teams__list_conversations`

**Files:**

- Modify: `src/tools.ts`
- Modify: `src/tools.test.ts`

**Interfaces:**

- Produces: `listConversationsTool(deps): Tool` with name `teams__list_conversations`; `buildTeamsTools` includes it when enabled.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools.test.ts`:

```ts
describe('teams__list_conversations', () => {
  const conversations: TeamsState['conversations'] = {
    'app:alice': {
      conversationId: 'conv-1',
      conversationType: 'personal',
      externalId: 'aad-1',
      displayName: 'Alice',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    'app:team-eng': {
      conversationId: '19:g@thread.v2',
      conversationType: 'groupChat',
      externalId: '19:g@thread.v2',
      name: 'Engineering',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    'other:alice': {
      conversationId: 'conv-3',
      conversationType: 'personal',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
  };

  it("lists only the caller bot's conversations, newest first", async () => {
    const s = setup({ conversations });
    const result = await run(listConversationsTool(s.deps), s.context, {});
    expect(result.status).toBe('success');
    const listed = (result.data as { conversations: Array<{ key: string }> }).conversations;
    expect(listed.map((entry) => entry.key)).toEqual(['app:alice', 'app:team-eng']);
  });

  it('filters by conversation type', async () => {
    const s = setup({ conversations });
    const result = await run(listConversationsTool(s.deps), s.context, {
      conversationType: 'groupChat',
    });
    const listed = (result.data as { conversations: Array<{ key: string }> }).conversations;
    expect(listed.map((entry) => entry.key)).toEqual(['app:team-eng']);
  });

  it('caps the limit at 200 and applies a smaller limit', async () => {
    const s = setup({ conversations });
    const limited = await run(listConversationsTool(s.deps), s.context, { limit: 1 });
    expect((limited.data as { conversations: unknown[] }).conversations).toHaveLength(1);

    const capped = await run(listConversationsTool(s.deps), s.context, { limit: 500 });
    expect((capped.data as { conversations: unknown[] }).conversations).toHaveLength(2);
  });

  it('returns an empty list when the bot has no conversations', async () => {
    const s = setup();
    const result = await run(listConversationsTool(s.deps), s.context, {});
    expect(result.data).toEqual({ conversations: [] });
  });

  it('rejects an invalid conversation type', async () => {
    const s = setup();
    const result = await run(listConversationsTool(s.deps), s.context, {
      conversationType: 'channel',
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('conversationType');
  });
});
```

Update the import:

```ts
import { sendCardTool, postReactionTool, listConversationsTool } from './tools.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/tools.test.ts
```

Expected: FAIL — `listConversationsTool` is not exported.

- [ ] **Step 3: Implement `listConversationsTool`**

Add to `src/tools.ts` after `postReactionTool`:

```ts
export function listConversationsTool(deps: TeamsToolDeps): Tool {
  return {
    name: 'teams__list_conversations',
    description: "List Teams conversations known to the caller's Teams bot.",
    parameters: {
      type: 'object',
      properties: {
        conversationType: {
          type: 'string',
          enum: ['personal', 'groupChat'],
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
        },
      },
    },
    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const raw = (args ?? {}) as Record<string, unknown>;
      const type = raw.conversationType;
      if (type !== undefined && type !== 'personal' && type !== 'groupChat') {
        return fail(`teams__list_conversations: invalid conversationType '${String(type)}'`);
      }
      const limit =
        typeof raw.limit === 'number' && Number.isInteger(raw.limit)
          ? Math.min(200, Math.max(1, raw.limit))
          : 50;

      const caller = resolveCallerBot(deps, context.participant.id);
      if (!caller.ok) return fail(caller.error);

      const prefix = `${caller.value.appId}:`;
      const conversations = Object.entries(deps.state.conversations)
        .filter(
          ([key, record]) =>
            key.startsWith(prefix) && (type === undefined || record.conversationType === type),
        )
        .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit)
        .map(([key, record]) => ({
          key,
          conversationId: record.conversationId,
          conversationType: record.conversationType,
          ...(record.externalId === undefined ? {} : { externalId: record.externalId }),
          ...(record.name === undefined ? {} : { name: record.name }),
          ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
          updatedAt: record.updatedAt,
        }));

      return ok({ conversations });
    },
  };
}
```

Update `buildTeamsTools`:

```ts
export function buildTeamsTools(deps: TeamsToolDeps): AnyTool[] {
  const tools: AnyTool[] = [];
  if (deps.options.tools.has('cards')) tools.push(sendCardTool(deps));
  if (deps.options.tools.has('reactions')) tools.push(postReactionTool(deps));
  if (deps.options.tools.has('list')) tools.push(listConversationsTool(deps));
  return tools;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/tools.test.ts
git commit -m "feat(teams): add teams__list_conversations tool"
```

---

## Task 13: Expose Teams tools from the connector

**Files:**

- Modify: `src/connector.ts`
- Modify: `src/connector.test.ts`
- Modify: `src/tools.test.ts`

**Interfaces:**

- Consumes: `buildTeamsTools`, `TeamsToolDeps`.
- Produces: `TeamsConnector.tools(): AnyTool[]`, filtered by `options.tools`.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools.test.ts`:

```ts
describe('buildTeamsTools selection', () => {
  it('returns all three tools by default', () => {
    const s = setup();
    expect(buildTeamsTools(s.deps).map((tool) => tool.name)).toEqual([
      'teams__send_card',
      'teams__post_reaction',
      'teams__list_conversations',
    ]);
  });

  it('returns only the enabled tools', () => {
    const s = setup({ options: { tools: ['reactions'] } });
    expect(buildTeamsTools(s.deps).map((tool) => tool.name)).toEqual(['teams__post_reaction']);
  });

  it('returns no tools when disabled', () => {
    const s = setup({ options: { tools: false } });
    expect(buildTeamsTools(s.deps)).toEqual([]);
  });
});
```

Update the import:

```ts
import { buildTeamsTools, sendCardTool, postReactionTool, listConversationsTool } from './tools.js';
```

Append to `src/connector.test.ts`:

```ts
it('exposes only the configured Teams tools after start', async () => {
  const { app, deps } = setup();
  const dir = await mkdtemp(join(tmpdir(), 'teams-tools-'));
  const connector = new TeamsConnector(
    { stateDir: dir, port: 0, tools: ['cards'] },
    deps,
    () => app,
  );
  await connector.start({} as never);
  try {
    expect(connector.tools().map((tool) => tool.name)).toEqual(['teams__send_card']);
  } finally {
    await connector.stop();
  }
});

it('exposes all Teams tools by default after start', async () => {
  const { app, deps } = setup();
  const dir = await mkdtemp(join(tmpdir(), 'teams-tools-default-'));
  const connector = new TeamsConnector({ stateDir: dir, port: 0 }, deps, () => app);
  await connector.start({} as never);
  try {
    expect(connector.tools().map((tool) => tool.name)).toEqual([
      'teams__send_card',
      'teams__post_reaction',
      'teams__list_conversations',
    ]);
  } finally {
    await connector.stop();
  }
});

it('exposes no tools before start', () => {
  const { app, deps } = setup();
  const connector = new TeamsConnector({ stateDir: '/tmp/x' }, deps, () => app);
  expect(connector.tools()).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/tools.test.ts src/connector.test.ts
```

Expected: FAIL — `buildTeamsTools` selection is incomplete and `TeamsConnector.tools` does not exist.

- [ ] **Step 3: Implement `TeamsConnector.tools()`**

In `src/connector.ts`, import:

```ts
import type { AnyTool } from '@legion-collective/core';
import { buildTeamsTools } from './tools.js';
```

Add the method after `deliver`:

```ts
  tools(): AnyTool[] {
    if (!this.pool || !this.state || !this.store) return [];
    return buildTeamsTools({
      collective: this.deps.collective,
      pool: this.pool,
      state: this.state,
      store: this.store,
      options: this.options,
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/tools.test.ts src/connector.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connector.ts src/connector.test.ts src/tools.test.ts
git commit -m "feat(teams): expose Teams tools from the connector"
```

---

## Task 14: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build legion and run its checks**

Run in `threads/2026-11-24-connector-tools/legion`:

```bash
npm run build
npm run format:check
npm run typecheck
npm test
```

Expected: all pass. If `format:check` fails, run `npm run format` and commit the formatting change.

- [ ] **Step 2: Rebuild core for the connector and run its checks**

Run in `threads/2026-11-24-connector-tools/legion-connector-teams`:

```bash
npm run typecheck
npm run test
npm run build
```

Expected: all pass.

- [ ] **Step 3: Confirm the seam end-to-end**

Run a focused assertion that the connector's tools carry the `teams__` prefix and are selected by options:

```bash
npx vitest run src/tools.test.ts src/connector.test.ts src/tool-targets.test.ts src/tool-state.test.ts src/state.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit any verification fixes**

```bash
git add -A
git commit -m "chore: verify connector tools"
```

Only commit if Step 1–3 produced changes (e.g. formatting). Otherwise skip.

---

## Self-Review Checklist

- **Spec coverage**
  - `Connector.tools()` and lifecycle: Tasks 1–3.
  - `communicate` `storedMessageId`: Task 4.
  - State v3 and message records: Tasks 5–6.
  - Config defaults: Task 7.
  - Inbound/outbound ID tracking: Task 8.
  - Target resolution and caller-bot ownership: Task 9.
  - Three Teams tools: Tasks 10–12.
  - Connector wiring and option filtering: Task 13.
  - Verification: Task 14.
- **Placeholders:** none; every step has concrete code or a concrete command.
- **Type consistency:** `TeamsToolDeps` is defined once in `tool-targets.ts`; `Resolved<T>` is shared; `recordMessage` and lookup names match across tasks; `TeamsAppLike` is extended in Task 8 before tools consume it.
