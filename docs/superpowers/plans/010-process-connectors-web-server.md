# LegionProcess, Connectors & Web Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble and launch the complete Legion process. Introduce the `Connector`
abstraction, wire connector-aware delivery, and implement the `WebConnector` (Fastify HTTP
server + WebSocket event stream). End state: a running `LegionProcess` that responds to HTTP
requests, authenticates participants via JWT, executes tools on their behalf, and streams
`EventBus` events over WebSocket.

**Architecture overview:**

- `Connector` / `ConnectorContext` / `ConnectorRegistry` land in `@legion/core` (they are
  needed by `UserDeliveryRuntime` and `MessageRouter`, both already in core).
- `WebConnector` and `LegionProcess` live in `@legion/runtime`.
- `FileCredentialStore` **already exists** in `@legion/core` (Plan 3, argon2). Plan 10 uses
  it without re-implementing it.
- Three `@legion/core` amendments: `UserDeliveryRuntime` (real connector delivery),
  `EventBus` (wildcard `onAny`/`offAny` for WS bridging), `MessageRouter` (per-conversation
  locking).

**Tech stack:** Fastify v5, `@fastify/websocket` v10, `@fastify/static` v8, `jose` v5 (JWT).

**Depends on:** Plans 1–9 complete.

---

## What is NOT new in this plan

| Item                                                                      | Where it lives                                        | Plan       |
| ------------------------------------------------------------------------- | ----------------------------------------------------- | ---------- |
| `CredentialStore` interface + `FileCredentialStore` (argon2)              | `@legion/core/src/credentials/`                       | Plan 3     |
| `BOOTSTRAP_OPERATOR_ID` + `createDefaultParticipants()`                   | `@legion/core/src/collective/default-participants.ts` | Plan 3     |
| `Collective.seedDefaultsIfEmpty()`                                        | `@legion/core/src/collective/Collective.ts`           | Plan 3     |
| `ServiceManager` + `ServiceRuntime`                                       | `@legion/core/src/service/`                           | Plan 8     |
| `loadMCPSources()`                                                        | `@legion/core/src/tools/`                             | Plan 9     |
| `AgentRuntime`, `MockRuntime`                                             | `@legion/core/src/runtime/`                           | Plans 6, 5 |
| Global tools: `communicateTool`, `approvalResponseTool`, management tools | `@legion/core/src/tools/`                             | Plans 4–7  |

---

## Decisions locked in

- **`FileCredentialStore`:** Uses argon2 (Plan 3). The "bcrypt" preference expressed during
  plan design is superseded by the Plan 3 decision. Using argon2 as already implemented.
- **Session tokens:** Stateless JWT via `jose`. Secret: `crypto.getRandomValues(new Uint8Array(32))`
  at startup — never persisted. Sessions expire after 8 hours. Sessions are invalidated on
  process restart.
- **Per-conversation locking:** Hand-rolled lock-chain (`Map<conversationId, Promise<void>>`).
  Wraps `MessageRouter.send()` when `conversationId` is provided. New conversations bypass the
  lock (each gets a fresh unique ID).
- **`Connector` / `ConnectorContext` / `ConnectorRegistry`:** In `@legion/core`. External
  connector packages depend on `@legion/core`.
- **`UserDeliveryRuntime`:** Amended to accept an optional `ConnectorRegistry`. When present,
  calls `connector.deliver()` on all active connectors for the recipient. Falls back to
  `{ kind: 'void' }` if no registry or no active connectors.
- **Bootstrap operator password:** Generated with `crypto.randomUUID()` on first workspace
  init; printed to `stdout` once; stored as an argon2 hash. Never recoverable after init.
- **Login route:** Accepts `{ name: string; password: string }`. Looks up participant by
  display name (first case-insensitive match in `collective.listActive()`).
- **`POST /api/execute`:** Creates a new conversation per call when `conversationId` is not
  provided. Returns `{ result, conversationId }`. Uses `ConnectorContext.callTool()`.
- **WebSocket auth:** First-message protocol — client sends `{"type":"auth","token":"<jwt>"}`
  before receiving events. Connection is closed after 10 s if no auth message arrives.
- **EventBus bridge:** `onAny()` subscription per authenticated WS connection; all events
  forwarded as `{"type":"event","event":"<name>","data":{...}}`. `deliver()` pushes
  `{"type":"message","data":<IncomingMessage>}`.
- **SPA static files:** `@fastify/static` serves `packages/web/dist/`; wildcard route
  falls back to `index.html`. If `webDistPath` is absent (dev / no build), the static plugin
  is not registered and `GET /` returns 204.
- **`LEGION_INTEGRATION=1`:** Gate for `LegionProcess.integration.test.ts`. Starts a real
  server in a temp workspace; exercises login → token → execute tool → WebSocket connect.

---

## Amendments to prior plans

### Amendment A — Plan 1: `EventBus.onAny()` / `offAny()`

Add a wildcard subscription API alongside the typed `on`/`off`/`emit` in
`packages/core/src/events/EventBus.ts`.

**Shape to add:**

```typescript
type AnyEventHandler = (event: string, payload: unknown) => void;
```

Two new public methods:

```typescript
onAny(handler: AnyEventHandler): () => void {
  this.anyHandlers.add(handler);
  return () => this.offAny(handler);
}

offAny(handler: AnyEventHandler): void {
  this.anyHandlers.delete(handler);
}
```

Private field:

```typescript
private anyHandlers = new Set<AnyEventHandler>();
```

`emit()` must also invoke `anyHandlers` **after** typed handlers:

```typescript
emit<E extends LegionEventName>(event: E, payload: LegionEventMap[E]): void {
  const set = this.handlers.get(event);
  if (set) {
    for (const handler of [...set]) {
      try { handler(payload); } catch { /* isolate */ }
    }
  }
  for (const handler of [...this.anyHandlers]) {
    try { handler(event as string, payload); } catch { /* isolate */ }
  }
}
```

**3 new tests for `EventBus.test.ts`:**

```typescript
describe('EventBus: onAny', () => {
  it('receives every named event', () => {
    const bus = new EventBus();
    const calls: [string, unknown][] = [];
    bus.onAny((event, payload) => calls.push([event, payload]));
    bus.emit('process:ready', { workspaceRoot: '/w' });
    bus.emit('iteration', { conversationId: 'c', participantId: 'p', iteration: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('process:ready');
    expect(calls[1][0]).toBe('iteration');
  });

  it('offAny stops the handler from receiving further events', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.onAny(() => (count += 1));
    bus.emit('process:ready', { workspaceRoot: '/w' });
    off();
    bus.emit('process:ready', { workspaceRoot: '/w' });
    expect(count).toBe(1);
  });

  it('onAny does not interfere with typed on() listeners', () => {
    const bus = new EventBus();
    let typed = 0;
    let any = 0;
    bus.on('process:ready', () => (typed += 1));
    bus.onAny(() => (any += 1));
    bus.emit('process:ready', { workspaceRoot: '/w' });
    expect(typed).toBe(1);
    expect(any).toBe(1);
  });
});
```

---

### Amendment B — Plan 5: `MessageRouter.withLock()` (per-conversation mutex)

Add to `packages/core/src/runtime/MessageRouter.ts`:

**New private field:**

```typescript
private locks = new Map<string, Promise<void>>();
```

**New private method:**

```typescript
private withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = this.locks.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  this.locks.set(conversationId, prev.then(() => next));
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
      // Best-effort cleanup: remove if no one else queued after us.
      if (this.locks.get(conversationId) === prev.then(() => next)) {
        this.locks.delete(conversationId);
      }
    }
  });
}
```

**Refactor `send()`** to use the lock when `conversationId` is provided:

```typescript
async send(opts: SendOptions): Promise<MessageRouterResult> {
  if (opts.conversationId) {
    return this.withLock(opts.conversationId, () => this.sendInner(opts));
  }
  return this.sendInner(opts);
}

private async sendInner(opts: SendOptions): Promise<MessageRouterResult> {
  // ← exact body of the current send() implementation (unchanged)
}
```

**3 new tests for `MessageRouter.test.ts`:**

```typescript
describe('MessageRouter: per-conversation locking', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-lock-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serialises concurrent sends to the same conversation', async () => {
    const { router, baseContext } = await setup(dir);
    const first = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'one',
      context: baseContext,
    });
    const order: number[] = [];
    const p1 = router
      .send({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'a',
        conversationId: first.conversationId,
        context: baseContext,
      })
      .then(() => {
        order.push(1);
      });
    const p2 = router
      .send({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'b',
        conversationId: first.conversationId,
        context: baseContext,
      })
      .then(() => {
        order.push(2);
      });
    await Promise.all([p1, p2]);
    // Both complete; order is 1 then 2 (first in, first served).
    expect(order).toEqual([1, 2]);
  });

  it('does not block concurrent sends to different conversations', async () => {
    const { router, baseContext } = await setup(dir);
    // Two independent new conversations — no locking, should overlap freely.
    const [r1, r2] = await Promise.all([
      router.send({ senderId: 'op', recipientId: 'mock-1', message: 'a', context: baseContext }),
      router.send({ senderId: 'op', recipientId: 'mock-1', message: 'b', context: baseContext }),
    ]);
    expect(r1.conversationId).not.toBe(r2.conversationId);
    expect(r1.status).toBe('success');
    expect(r2.status).toBe('success');
  });

  it('new conversations (no conversationId) bypass the lock', async () => {
    // Verify that omitting conversationId creates independent threads without deadlock.
    const { router, baseContext } = await setup(dir);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        router.send({ senderId: 'op', recipientId: 'mock-1', message: 'x', context: baseContext }),
      ),
    );
    expect(new Set(results.map((r) => r.conversationId)).size).toBe(4);
  });
});
```

---

### Amendment C — Plan 5: `UserDeliveryRuntime` — connector-aware delivery

Replace `packages/core/src/runtime/UserDeliveryRuntime.ts` with:

```typescript
import type { MessageData } from '@legion/types';
import type { Runtime, RuntimeContext, RuntimeResult } from './Runtime.js';
import type { ConnectorRegistry } from '../connectors/ConnectorRegistry.js';

export class UserDeliveryRuntime implements Runtime {
  constructor(
    private participantId: string,
    private connectorRegistry?: ConnectorRegistry,
  ) {}

  async handle(incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    const connectors = this.connectorRegistry?.getActiveConnectors(this.participantId) ?? [];

    for (const connector of connectors) {
      try {
        await connector.deliver({
          id: incoming.id,
          conversationId: incoming.conversationId,
          senderId: incoming.senderId,
          recipientId: incoming.recipientId,
          replyTo: incoming.replyTo,
          content: incoming.content,
          timestamp: incoming.timestamp,
        });
      } catch {
        // Delivery failures are non-fatal: the message is already persisted.
        // The connector will deliver on next reconnect per its own policy.
      }
    }

    context.eventBus.emit('message:delivered', {
      conversationId: context.conversationId,
      recipientId: this.participantId,
      messageId: incoming.id,
    });

    return { kind: 'void' };
  }
}
```

**Add `UserDeliveryRuntime.test.ts`** (new file — Plan 5 had no test for this runtime):

```typescript
import { UserDeliveryRuntime } from './UserDeliveryRuntime.js';
import { ConnectorRegistry } from '../connectors/ConnectorRegistry.js';
import type { RuntimeContext } from './Runtime.js';
import type { MessageData } from '@legion/types';
import type { Connector } from '../connectors/Connector.js';

function makeConnector(name: string): Connector & { delivered: unknown[] } {
  return {
    name,
    delivered: [],
    async start() {},
    async deliver(msg) {
      this.delivered.push(msg);
    },
    async stop() {},
  };
}

const inbound: MessageData = {
  id: 'm1',
  parentId: null,
  conversationId: 'c1',
  senderId: 'op',
  recipientId: 'user-a',
  role: 'user',
  content: 'hello',
  status: 'active',
  timestamp: '2026-01-01T00:00:00.000Z',
};

function makeCtx(): RuntimeContext {
  const emitted: unknown[] = [];
  return {
    participant: { id: 'user-a', name: 'Alice', type: 'user', tools: {} },
    conversationId: 'c1',
    eventBus: { emit: (_e: string, p: unknown) => emitted.push(p), on: () => () => {} } as any,
    _emitted: emitted,
  } as any;
}

describe('UserDeliveryRuntime', () => {
  it('returns { kind: "void" }', async () => {
    const runtime = new UserDeliveryRuntime('user-a');
    const result = await runtime.handle(inbound, makeCtx());
    expect(result).toEqual({ kind: 'void' });
  });

  it('emits message:delivered regardless of connector presence', async () => {
    const ctx = makeCtx();
    const runtime = new UserDeliveryRuntime('user-a');
    await runtime.handle(inbound, ctx);
    expect((ctx as any)._emitted).toHaveLength(1);
  });

  it('calls deliver() on all active connectors for the participant', async () => {
    const registry = new ConnectorRegistry();
    const connA = makeConnector('web');
    registry.register(connA);
    registry.setActive('user-a', 'web');
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await runtime.handle(inbound, makeCtx());
    expect(connA.delivered).toHaveLength(1);
    expect((connA.delivered[0] as any).content).toBe('hello');
  });

  it('does not call deliver() on connectors for other participants', async () => {
    const registry = new ConnectorRegistry();
    const connA = makeConnector('web');
    registry.register(connA);
    registry.setActive('user-b', 'web'); // different participant
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await runtime.handle(inbound, makeCtx());
    expect(connA.delivered).toHaveLength(0);
  });

  it('swallows connector.deliver() errors and continues', async () => {
    const registry = new ConnectorRegistry();
    const failConnector: Connector = {
      name: 'broken',
      async start() {},
      async stop() {},
      async deliver() {
        throw new Error('network error');
      },
    };
    const goodConnector = makeConnector('good');
    registry.register(failConnector);
    registry.register(goodConnector);
    registry.setActive('user-a', 'broken');
    registry.setActive('user-a', 'good');
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({ kind: 'void' });
    expect(goodConnector.delivered).toHaveLength(1);
  });

  it('no-op deliver when no registry provided', async () => {
    const runtime = new UserDeliveryRuntime('user-a'); // no registry
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({ kind: 'void' });
  });

  it('no-op deliver when participant has no active connectors', async () => {
    const registry = new ConnectorRegistry();
    const conn = makeConnector('web');
    registry.register(conn);
    // no setActive call
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await runtime.handle(inbound, makeCtx());
    expect(conn.delivered).toHaveLength(0);
  });
});
```

---

## New types in `@legion/core`

### `packages/core/src/connectors/Connector.ts`

```typescript
import type { ToolResult, MessageRouterResult } from '@legion/types';
import type { ConnectorRegistry } from './ConnectorRegistry.js';

/** The shape an external entity sends as a message through a connector. */
export interface ConnectorSubmitOptions {
  senderId: string;
  recipientId: string;
  content: string;
  conversationId?: string;
  replyTo?: string;
}

/**
 * Context object given to a connector when it starts. Provides the inbound
 * submit path (message routing), tool execution, and the active-participant registry.
 */
export interface ConnectorContext {
  /** Route an inbound message from an external entity into the collective. */
  submit(msg: ConnectorSubmitOptions): Promise<MessageRouterResult>;

  /**
   * Execute a named tool as the given participant.
   * Authorization is checked before execution; the result includes the
   * conversation created for this call.
   */
  callTool(
    participantId: string,
    toolName: string,
    args: unknown,
    opts?: { conversationId?: string },
  ): Promise<{ result: ToolResult; conversationId: string }>;

  /** The active-participant registry: register/deregister who this connector fronts. */
  registry: ConnectorRegistry;
}

/**
 * A boundary channel through which external entities interact with the collective.
 * The `deliver` method is called by `UserDeliveryRuntime` to push outbound messages.
 */
export interface Connector {
  /** Unique connector name, e.g. `'web'`, `'teams'`, `'slack'`. */
  readonly name: string;

  /** Called once at process startup to hand over the `ConnectorContext`. */
  start(ctx: ConnectorContext): Promise<void>;

  /**
   * Push a message outbound to the external entity the connector fronts.
   * Called by `UserDeliveryRuntime` when a message is addressed to a
   * connector-bound participant.
   */
  deliver(message: {
    id: string;
    conversationId: string;
    senderId: string;
    recipientId: string;
    replyTo?: string;
    content: string;
    timestamp: string;
  }): Promise<void>;

  /** Called on process shutdown. Release all resources. */
  stop(): Promise<void>;
}
```

---

### `packages/core/src/connectors/ConnectorRegistry.ts`

```typescript
import type { Connector } from './Connector.js';

/**
 * Tracks registered connectors and which participants are actively connected
 * on each connector.
 *
 * - `register()` / `deregister()` — called at startup/shutdown for each connector.
 * - `setActive()` / `clearActive()` — called by connectors when clients connect/disconnect.
 * - `getActiveConnectors()` — called by `UserDeliveryRuntime` to find where to deliver.
 */
export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();
  /** connectorName → Set<participantId> */
  private active = new Map<string, Set<string>>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.name)) {
      throw new Error(`Connector '${connector.name}' already registered`);
    }
    this.connectors.set(connector.name, connector);
    this.active.set(connector.name, new Set());
  }

  deregister(name: string): void {
    this.connectors.delete(name);
    this.active.delete(name);
  }

  get(name: string): Connector | undefined {
    return this.connectors.get(name);
  }

  getAll(): Connector[] {
    return [...this.connectors.values()];
  }

  /**
   * Mark a participant as actively connected on the named connector.
   * No-op if the connector is not registered.
   */
  setActive(participantId: string, connectorName: string): void {
    this.active.get(connectorName)?.add(participantId);
  }

  /**
   * Mark a participant as no longer actively connected.
   * No-op if the connector is not registered or the participant was not active.
   */
  clearActive(participantId: string, connectorName: string): void {
    this.active.get(connectorName)?.delete(participantId);
  }

  /**
   * Returns every registered connector that currently has an active connection
   * for `participantId`. Used by `UserDeliveryRuntime`.
   */
  getActiveConnectors(participantId: string): Connector[] {
    const result: Connector[] = [];
    for (const [name, participants] of this.active) {
      if (participants.has(participantId)) {
        const connector = this.connectors.get(name);
        if (connector) result.push(connector);
      }
    }
    return result;
  }
}
```

---

## File Structure

### `@legion/runtime` (new package)

```
packages/runtime/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                          ← package barrel
    LegionProcess.ts                  ← static start() + stop()
    server/
      WebConnector.ts                 ← Connector impl (Fastify + WS)
      auth.ts                         ← JWT sign/verify helpers (jose)
      routes/
        auth.ts                       ← POST /api/auth/login, /logout, GET /api/auth/me
        execute.ts                    ← POST /api/execute
        health.ts                     ← GET /api/health
      WebConnector.test.ts            ← HTTP route tests (app.inject())
    LegionProcess.integration.test.ts ← env-gated, real server
```

### `@legion/core` amendments

```
packages/core/src/
  connectors/
    Connector.ts          ← (new) Connector, ConnectorContext interfaces
    ConnectorRegistry.ts  ← (new) ConnectorRegistry class
    ConnectorRegistry.test.ts  ← (new) 12 tests
    index.ts              ← (new) barrel
  events/
    EventBus.ts           ← AMEND: onAny / offAny
    EventBus.test.ts      ← AMEND: +3 tests
  runtime/
    UserDeliveryRuntime.ts     ← AMEND: connector-aware
    UserDeliveryRuntime.test.ts ← NEW: 7 tests
    MessageRouter.ts           ← AMEND: withLock() + sendInner()
    MessageRouter.test.ts      ← AMEND: +3 concurrency tests
  index.ts               ← AMEND: add connectors barrel
```

---

## Task 1: `@legion/runtime` package scaffold

**Files to create:**

1. `packages/runtime/package.json`
2. `packages/runtime/tsconfig.json`
3. `packages/runtime/vitest.config.ts`
4. `packages/runtime/src/index.ts` — placeholder barrel

**Root amendments:** 5. `package.json` — `packages/runtime` is already listed in `workspaces` (Plan 1 scaffold); verify only 6. `tsconfig.json` — add `{ "path": "packages/runtime" }` to `references`

> Note: Plan 1 created `packages/runtime/` as a minimal placeholder (`package.json` +
> empty `src/index.ts`). This task replaces that placeholder with the full build config.

- [ ] **Step 1: Create `packages/runtime/package.json`**

```json
{
  "name": "@legion/runtime",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@legion/core": "workspace:*",
    "@fastify/static": "^8.0.0",
    "@fastify/websocket": "^10.0.0",
    "fastify": "^5.0.0",
    "jose": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/ws": "^8.5.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "ws": "^8.17.0"
  }
}
```

- [ ] **Step 2: Create `packages/runtime/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "references": [{ "path": "../core" }],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/**/*.integration.test.ts", "node_modules"]
}
```

- [ ] **Step 3: Create `packages/runtime/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

- [ ] **Step 4: Update `packages/runtime/src/index.ts`** (replace the Plan 1 placeholder)

```typescript
export { LegionProcess } from './LegionProcess.js';
export { WebConnector } from './server/WebConnector.js';
```

> The exports will cause compile errors until the files exist; that is expected. The barrel
> is filled in as subsequent tasks add the files.

- [ ] **Step 5: Add `@legion/runtime` to root `tsconfig.json` references**

In `tsconfig.json`, add to the `references` array:

```json
{ "path": "packages/runtime" }
```

- [ ] **Step 6: Install dependencies**

```bash
npm install
```

Expected: `@legion/runtime` workspace resolved; fastify, jose, etc. installed.

- [ ] **Step 7: Verify build skeleton**

```bash
npm run build --workspace @legion/runtime 2>&1 | grep -E "error|warning" | head -20
```

Expected: Compile errors for missing `LegionProcess.js` and `WebConnector.js` imports —
these are normal and will resolve in later tasks. No structural errors.

- [ ] **Step 8: Commit**

```bash
git add packages/runtime/package.json packages/runtime/tsconfig.json \
        packages/runtime/vitest.config.ts packages/runtime/src/index.ts \
        tsconfig.json
git commit -m "feat(runtime): scaffold @legion/runtime package"
```

---

## Task 2: Connector interfaces + `ConnectorRegistry` in `@legion/core`

**Files:**

1. Create: `packages/core/src/connectors/Connector.ts` (see shape above)
2. Create: `packages/core/src/connectors/ConnectorRegistry.ts` (see shape above)
3. Create: `packages/core/src/connectors/ConnectorRegistry.test.ts`
4. Create: `packages/core/src/connectors/index.ts`
5. Modify: `packages/core/src/index.ts` — add connectors barrel

- [ ] **Step 1: Create `Connector.ts`** (exact content from "New types" section above)

- [ ] **Step 2: Create `ConnectorRegistry.ts`** (exact content from "New types" section above)

- [ ] **Step 3: Write the failing test**

`packages/core/src/connectors/ConnectorRegistry.test.ts`:

```typescript
import { ConnectorRegistry } from './ConnectorRegistry.js';
import type { Connector } from './Connector.js';

function makeConnector(name: string): Connector {
  return {
    name,
    async start() {},
    async deliver() {},
    async stop() {},
  };
}

describe('ConnectorRegistry', () => {
  it('registers a connector by name', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    expect(reg.get('web')).toBeDefined();
  });

  it('throws if the same name is registered twice', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    expect(() => reg.register(makeConnector('web'))).toThrow(/already registered/i);
  });

  it('deregisters a connector and its active-participant set', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.setActive('user-1', 'web');
    reg.deregister('web');
    expect(reg.get('web')).toBeUndefined();
    expect(reg.getActiveConnectors('user-1')).toHaveLength(0);
  });

  it('get() returns undefined for an unknown name', () => {
    expect(new ConnectorRegistry().get('nope')).toBeUndefined();
  });

  it('getAll() returns every registered connector', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.register(makeConnector('teams'));
    expect(reg.getAll()).toHaveLength(2);
  });

  it('setActive marks a participant as connected on a connector', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.setActive('user-1', 'web');
    expect(reg.getActiveConnectors('user-1')).toHaveLength(1);
    expect(reg.getActiveConnectors('user-1')[0].name).toBe('web');
  });

  it('setActive is a no-op for unregistered connectors', () => {
    const reg = new ConnectorRegistry();
    expect(() => reg.setActive('user-1', 'ghost')).not.toThrow();
  });

  it('clearActive removes a participant from the active set', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.setActive('user-1', 'web');
    reg.clearActive('user-1', 'web');
    expect(reg.getActiveConnectors('user-1')).toHaveLength(0);
  });

  it('clearActive is a no-op if participant was not active', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    expect(() => reg.clearActive('user-1', 'web')).not.toThrow();
  });

  it('getActiveConnectors returns connectors from multiple registrations', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.register(makeConnector('teams'));
    reg.setActive('user-1', 'web');
    reg.setActive('user-1', 'teams');
    expect(reg.getActiveConnectors('user-1')).toHaveLength(2);
  });

  it('getActiveConnectors returns empty array when participant has no active connectors', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    expect(reg.getActiveConnectors('user-1')).toHaveLength(0);
  });

  it('active sets are independent per connector', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.register(makeConnector('teams'));
    reg.setActive('user-1', 'web');
    expect(reg.getActiveConnectors('user-1')).toHaveLength(1);
    expect(reg.getActiveConnectors('user-1')[0].name).toBe('web');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
npx vitest run packages/core/src/connectors/ConnectorRegistry.test.ts
```

Expected: FAIL — `Cannot find module './ConnectorRegistry.js'`.

- [ ] **Step 5: Run test to verify it passes after creating files**

```bash
npx vitest run packages/core/src/connectors/ConnectorRegistry.test.ts
```

Expected: PASS (12 tests).

- [ ] **Step 6: Create the barrel `packages/core/src/connectors/index.ts`**

```typescript
export type { Connector, ConnectorContext, ConnectorSubmitOptions } from './Connector.js';
export { ConnectorRegistry } from './ConnectorRegistry.js';
```

- [ ] **Step 7: Add to `packages/core/src/index.ts`**

Append:

```typescript
export * from './connectors/index.js';
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/connectors packages/core/src/index.ts
git commit -m "feat(core): Connector interfaces and ConnectorRegistry"
```

---

## Task 3: `@legion/core` amendments — UserDeliveryRuntime, EventBus.onAny, MessageRouter.withLock

**Files:**

1. Replace: `packages/core/src/runtime/UserDeliveryRuntime.ts` (content above)
2. Create: `packages/core/src/runtime/UserDeliveryRuntime.test.ts` (content above)
3. Modify: `packages/core/src/events/EventBus.ts` (add `onAny`/`offAny` + update `emit()`)
4. Modify: `packages/core/src/events/EventBus.test.ts` (add 3 new tests)
5. Modify: `packages/core/src/runtime/MessageRouter.ts` (add `withLock`, rename `send` body to `sendInner`)
6. Modify: `packages/core/src/runtime/MessageRouter.test.ts` (add 3 concurrency tests)

- [ ] **Step 1: Replace `UserDeliveryRuntime.ts`**

Use the full implementation from "Amendment C" above.

- [ ] **Step 2: Create `UserDeliveryRuntime.test.ts`**

Use the full test file from "Amendment C" above (7 tests).

- [ ] **Step 3: Run `UserDeliveryRuntime` tests**

```bash
npx vitest run packages/core/src/runtime/UserDeliveryRuntime.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 4: Apply `EventBus` amendment**

In `packages/core/src/events/EventBus.ts`:

Add the private field after the existing `handlers` field:

```typescript
private anyHandlers = new Set<(event: string, payload: unknown) => void>();
```

Add the two new methods after `off()`:

```typescript
onAny(handler: (event: string, payload: unknown) => void): () => void {
  this.anyHandlers.add(handler);
  return () => this.offAny(handler);
}

offAny(handler: (event: string, payload: unknown) => void): void {
  this.anyHandlers.delete(handler);
}
```

Replace the `emit()` method with the updated version from "Amendment A" above (calls `anyHandlers` after typed handlers).

- [ ] **Step 5: Append `onAny` tests to `EventBus.test.ts`**

Add the three tests from "Amendment A" above.

- [ ] **Step 6: Run `EventBus` tests**

```bash
npx vitest run packages/core/src/events/EventBus.test.ts
```

Expected: PASS (7 tests — 4 original + 3 new).

- [ ] **Step 7: Apply `MessageRouter` amendment**

In `packages/core/src/runtime/MessageRouter.ts`:

1. Add the `locks` private field after `background`:

   ```typescript
   private locks = new Map<string, Promise<void>>();
   ```

2. Add the `withLock()` method from "Amendment B" above.

3. Rename the current `send()` body (from `const recipient = ...` to the closing `}`) to `sendInner()`.

4. Replace `send()` with:
   ```typescript
   async send(opts: SendOptions): Promise<MessageRouterResult> {
     if (opts.conversationId) {
       return this.withLock(opts.conversationId, () => this.sendInner(opts));
     }
     return this.sendInner(opts);
   }
   ```

- [ ] **Step 8: Append concurrency tests to `MessageRouter.test.ts`**

Add the three tests from "Amendment B" above.

- [ ] **Step 9: Run `MessageRouter` tests**

```bash
npx vitest run packages/core/src/runtime/MessageRouter.test.ts
```

Expected: PASS (all existing tests + 3 new concurrency tests).

- [ ] **Step 10: Run the full `@legion/core` test suite**

```bash
npm test --workspace @legion/core
```

Expected: All tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/runtime/UserDeliveryRuntime.ts \
        packages/core/src/runtime/UserDeliveryRuntime.test.ts \
        packages/core/src/events/EventBus.ts \
        packages/core/src/events/EventBus.test.ts \
        packages/core/src/runtime/MessageRouter.ts \
        packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat(core): connector-aware delivery, EventBus.onAny, MessageRouter per-conv lock"
```

---

## Task 4: `WebConnector` — HTTP server

**Files:**

1. Create: `packages/runtime/src/server/auth.ts`
2. Create: `packages/runtime/src/server/routes/health.ts`
3. Create: `packages/runtime/src/server/routes/auth.ts`
4. Create: `packages/runtime/src/server/routes/execute.ts`
5. Create: `packages/runtime/src/server/WebConnector.ts`
6. Create: `packages/runtime/src/server/WebConnector.test.ts`

---

### `packages/runtime/src/server/auth.ts`

```typescript
import { SignJWT, jwtVerify } from 'jose';

export type JwtSecret = Uint8Array;

export async function signToken(participantId: string, secret: JwtSecret): Promise<string> {
  return new SignJWT({ sub: participantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
}

export async function verifyToken(
  token: string,
  secret: JwtSecret,
): Promise<{ participantId: string }> {
  const { payload } = await jwtVerify(token, secret);
  if (typeof payload.sub !== 'string') {
    throw new Error('Invalid token: missing sub');
  }
  return { participantId: payload.sub };
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}
```

---

### `packages/runtime/src/server/routes/health.ts`

```typescript
import type { FastifyInstance } from 'fastify';

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_req, reply) => {
    return reply.send({ status: 'ok' });
  });
}
```

---

### `packages/runtime/src/server/routes/auth.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import type { Collective } from '@legion/core';
import type { CredentialStore } from '@legion/core';
import { signToken, verifyToken, extractBearerToken } from '../auth.js';
import type { JwtSecret } from '../auth.js';

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    collective: Collective;
    credentials: CredentialStore;
    jwtSecret: JwtSecret;
  },
): Promise<void> {
  const { collective, credentials, jwtSecret } = deps;

  /**
   * POST /api/auth/login
   * Body: { name: string; password: string }
   * Returns: { token: string; participantId: string }
   */
  app.post<{ Body: { name?: string; password?: string } }>(
    '/api/auth/login',
    async (req, reply) => {
      const { name, password } = req.body ?? {};
      if (!name || !password) {
        return reply.status(400).send({ error: 'name and password are required' });
      }

      const participant = collective
        .listActive()
        .find((p) => p.name.toLowerCase() === name.toLowerCase());

      if (!participant) {
        return reply.status(401).send({ error: 'Invalid name or password' });
      }

      const ok = await credentials.verify(participant.id, password);
      if (!ok) {
        return reply.status(401).send({ error: 'Invalid name or password' });
      }

      const token = await signToken(participant.id, jwtSecret);
      return reply.send({ token, participantId: participant.id });
    },
  );

  /**
   * POST /api/auth/logout
   * JWT is stateless — this is a client-side operation, but we acknowledge it.
   */
  app.post('/api/auth/logout', async (_req, reply) => {
    return reply.send({ ok: true });
  });

  /**
   * GET /api/auth/me
   * Returns the authenticated participant's info.
   */
  app.get('/api/auth/me', async (req, reply) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return reply.status(401).send({ error: 'Unauthenticated' });

    let participantId: string;
    try {
      ({ participantId } = await verifyToken(token, jwtSecret));
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    const participant = collective.get(participantId);
    if (!participant) return reply.status(401).send({ error: 'Participant not found' });

    return reply.send({
      id: participant.id,
      name: participant.name,
      type: participant.type,
      operator: participant.operator ?? false,
      tools: Object.keys(participant.tools),
      approvalAuthority: participant.approvalAuthority ?? null,
    });
  });
}
```

---

### `packages/runtime/src/server/routes/execute.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import { verifyToken, extractBearerToken } from '../auth.js';
import type { JwtSecret } from '../auth.js';
import type { ConnectorContext } from '@legion/core';
import type { Collective } from '@legion/core';

export async function registerExecuteRoute(
  app: FastifyInstance,
  deps: {
    collective: Collective;
    ctx: ConnectorContext;
    jwtSecret: JwtSecret;
  },
): Promise<void> {
  const { collective, ctx, jwtSecret } = deps;

  /**
   * POST /api/execute
   * Body: { tool: string; args?: unknown; conversationId?: string }
   * Returns: { result: ToolResult; conversationId: string }
   */
  app.post<{ Body: { tool?: string; args?: unknown; conversationId?: string } }>(
    '/api/execute',
    async (req, reply) => {
      // Authenticate
      const token = extractBearerToken(req.headers.authorization);
      if (!token) return reply.status(401).send({ error: 'Unauthenticated' });

      let participantId: string;
      try {
        ({ participantId } = await verifyToken(token, jwtSecret));
      } catch {
        return reply.status(401).send({ error: 'Invalid or expired token' });
      }

      if (!collective.get(participantId)) {
        return reply.status(401).send({ error: 'Participant not found' });
      }

      // Validate body
      const { tool: toolName, args = {}, conversationId } = req.body ?? {};
      if (!toolName) {
        return reply.status(400).send({ error: 'tool is required' });
      }

      // Execute via ConnectorContext (authorization + routing handled inside)
      const { result, conversationId: convId } = await ctx.callTool(participantId, toolName, args, {
        conversationId,
      });

      return reply.send({ result, conversationId: convId });
    },
  );
}
```

---

### `packages/runtime/src/server/WebConnector.ts`

```typescript
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import type { WebSocket } from 'ws';
import type { Connector, ConnectorContext } from '@legion/core';
import type {
  Collective,
  CredentialStore,
  EventBus,
  LegionEventName,
  ServerConfig,
} from '@legion/core';
import { signToken, verifyToken, extractBearerToken } from './auth.js';
import type { JwtSecret } from './auth.js';
import { registerHealthRoute } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerExecuteRoute } from './routes/execute.js';

export interface WebConnectorDeps {
  collective: Collective;
  credentials: CredentialStore;
  eventBus: EventBus;
  serverConfig?: ServerConfig;
  /** Absolute path to built SPA files (packages/web/dist). Optional; skipped if absent. */
  webDistPath?: string;
}

/** Auth timeout for WebSocket connections: close if no auth message within this window. */
const WS_AUTH_TIMEOUT_MS = 10_000;

export class WebConnector implements Connector {
  readonly name = 'web';

  private app?: FastifyInstance;
  private ctx?: ConnectorContext;
  /** Fresh random secret per process — sessions invalidated on restart. */
  private readonly jwtSecret: JwtSecret = crypto.getRandomValues(new Uint8Array(32));
  /** participantId → active WS sockets (for outbound deliver()). */
  private connections = new Map<string, Set<WebSocket>>();

  constructor(private deps: WebConnectorDeps) {}

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
    const app = Fastify({ logger: false });
    this.app = app;

    // ── Plugins ──────────────────────────────────────────────────────────────
    await app.register(websocketPlugin);

    const { webDistPath } = this.deps;
    if (webDistPath && existsSync(webDistPath)) {
      await app.register(staticPlugin, {
        root: webDistPath,
        wildcard: false,
      });
      // SPA client-side routing fallback
      app.setNotFoundHandler((_req, reply) => {
        void reply.sendFile('index.html');
      });
    }

    // ── HTTP routes ───────────────────────────────────────────────────────────
    await registerHealthRoute(app);
    await registerAuthRoutes(app, {
      collective: this.deps.collective,
      credentials: this.deps.credentials,
      jwtSecret: this.jwtSecret,
    });
    await registerExecuteRoute(app, {
      collective: this.deps.collective,
      ctx,
      jwtSecret: this.jwtSecret,
    });

    // ── WebSocket route ───────────────────────────────────────────────────────
    app.get('/ws', { websocket: true }, (socket, _request) => {
      this.handleWebSocket(socket as unknown as WebSocket, ctx);
    });

    // ── Startup ───────────────────────────────────────────────────────────────
    const { port = 3000, host = '127.0.0.1' } = this.deps.serverConfig ?? {};

    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.warn(
        `[WebConnector] WARNING: binding to ${host} exposes the server to non-loopback traffic.`,
      );
    }

    await app.listen({ port, host });
  }

  async deliver(message: {
    id: string;
    conversationId: string;
    senderId: string;
    recipientId: string;
    replyTo?: string;
    content: string;
    timestamp: string;
  }): Promise<void> {
    const sockets = this.connections.get(message.recipientId);
    if (!sockets?.size) return;
    const payload = JSON.stringify({ type: 'message', data: message });
    for (const socket of sockets) {
      if ((socket as any).readyState === 1 /* OPEN */) {
        socket.send(payload);
      }
    }
  }

  async stop(): Promise<void> {
    await this.app?.close();
    this.app = undefined;
    this.connections.clear();
  }

  // ── WebSocket handler ────────────────────────────────────────────────────────

  private handleWebSocket(socket: WebSocket, ctx: ConnectorContext): void {
    let participantId: string | null = null;
    let anyOff: (() => void) | null = null;

    // Auth timeout: close if no auth message arrives promptly.
    const authTimer = setTimeout(() => {
      if (!participantId) socket.close(4401, 'Authentication timeout');
    }, WS_AUTH_TIMEOUT_MS);

    socket.on('message', (raw) => {
      let msg: { type?: string; token?: string };
      try {
        msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'auth' && !participantId) {
        const token = msg.token;
        if (!token) {
          socket.close(4401, 'No token provided');
          return;
        }
        verifyToken(token, this.jwtSecret)
          .then(({ participantId: pid }) => {
            clearTimeout(authTimer);
            participantId = pid;

            // Track connection
            ctx.registry.setActive(pid, this.name);
            const set = this.connections.get(pid) ?? new Set<WebSocket>();
            set.add(socket);
            this.connections.set(pid, set);

            // Acknowledge
            socket.send(JSON.stringify({ type: 'connected', participantId: pid }));

            // Bridge EventBus events
            const handler = (event: string, payload: unknown) => {
              if ((socket as any).readyState === 1) {
                socket.send(JSON.stringify({ type: 'event', event, data: payload }));
              }
            };
            anyOff = this.deps.eventBus.onAny(handler);
          })
          .catch(() => {
            socket.close(4401, 'Invalid token');
          });
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (participantId) {
        ctx.registry.clearActive(participantId, this.name);
        this.connections.get(participantId)?.delete(socket);
        if (this.connections.get(participantId)?.size === 0) {
          this.connections.delete(participantId);
        }
      }
      anyOff?.();
    });

    socket.on('error', () => {
      // Errors handled by the 'close' event.
    });
  }
}
```

---

### `packages/runtime/src/server/WebConnector.test.ts`

> Uses Fastify's `app.inject()` for HTTP tests. No real network required.
> Tests create a fully wired `WebConnector` backed by a fake `ConnectorContext` and
> in-memory `Collective` + `CredentialStore`.

```typescript
import { WebConnector } from './WebConnector.js';
import type { ConnectorContext } from '@legion/core';
import type { ToolResult } from '@legion/core';
import { MemoryStorage } from '@legion/core';
import { Collective } from '@legion/core';
import { EventBus } from '@legion/core';
import { FileCredentialStore } from '@legion/core';

// ── Test helpers ─────────────────────────────────────────────────────────────

async function makeCollective() {
  const storage = new MemoryStorage();
  await storage.writeJson('collective/participants/op-1.json', {
    id: 'op-1',
    name: 'Operator',
    type: 'user',
    tools: { list_participants: 'auto' },
    operator: true,
    protected: true,
    status: 'active',
  });
  return Collective.load(storage);
}

function makeCredentials(storage: MemoryStorage) {
  return new FileCredentialStore(storage);
}

function makeConnectorContext(
  toolResult: ToolResult = { status: 'success', data: 'ok' },
): ConnectorContext {
  return {
    submit: vi.fn().mockResolvedValue({ status: 'success', conversationId: 'conv-1' }),
    callTool: vi.fn().mockResolvedValue({ result: toolResult, conversationId: 'conv-test' }),
    registry: {
      setActive: vi.fn(),
      clearActive: vi.fn(),
      register: vi.fn(),
      deregister: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      getActiveConnectors: vi.fn().mockReturnValue([]),
    } as any,
  };
}

async function makeConnector(opts: { toolResult?: ToolResult } = {}) {
  const storage = new MemoryStorage();
  const collective = await makeCollective();
  const credentials = makeCredentials(storage);
  const eventBus = new EventBus();
  await credentials.setCredential('op-1', 'hunter2');

  const connector = new WebConnector({
    collective,
    credentials,
    eventBus,
    serverConfig: { port: 0 }, // port 0 = OS-assigned, not actually bound in inject() mode
  });

  const ctx = makeConnectorContext(opts.toolResult);
  // Use internal Fastify instance for inject() without binding a port
  await connector.start(ctx);

  return { connector, ctx, collective, credentials, eventBus };
}

// Helper: call app.inject() through the connector's internal Fastify instance.
// We expose the internal app via a test accessor.
async function inject(
  connector: WebConnector,
  opts: Parameters<ReturnType<typeof Fastify>['inject']>[0],
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (connector as any).app!.inject(opts);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebConnector: GET /api/health', () => {
  afterEach(async () => {
    // Tests are stateless; no shared connector across all health tests.
  });

  it('returns { status: "ok" }', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, { method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    await connector.stop();
  });
});

describe('WebConnector: POST /api/auth/login', () => {
  it('returns 400 when name or password is missing', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator' },
    });
    expect(res.statusCode).toBe(400);
    await connector.stop();
  });

  it('returns 401 for unknown participant name', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Ghost', password: 'x' },
    });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 401 for wrong password', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 200 and a JWT token on success', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3); // JWT has 3 parts
    expect(body.participantId).toBe('op-1');
    await connector.stop();
  });
});

describe('WebConnector: GET /api/auth/me', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, { method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 401 for an invalid token', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer invalid.token.here' },
    });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 200 + participant info for a valid token', async () => {
    const { connector } = await makeConnector();
    // Login first to obtain a token from the same instance (same JWT secret).
    const loginRes = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    const { token } = JSON.parse(loginRes.body) as { token: string };

    const meRes = await inject(connector, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);
    const body = JSON.parse(meRes.body);
    expect(body.id).toBe('op-1');
    expect(body.name).toBe('Operator');
    await connector.stop();
  });
});

describe('WebConnector: POST /api/execute', () => {
  it('returns 401 when unauthenticated', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/execute',
      payload: { tool: 'list_participants', args: {} },
    });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 400 when tool name is missing', async () => {
    const { connector } = await makeConnector();
    const loginRes = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    const { token } = JSON.parse(loginRes.body) as { token: string };
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { args: {} },
    });
    expect(res.statusCode).toBe(400);
    await connector.stop();
  });

  it('returns 200 + result on success', async () => {
    const { connector } = await makeConnector();
    const loginRes = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    const { token } = JSON.parse(loginRes.body) as { token: string };
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { tool: 'list_participants', args: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBeDefined();
    expect(body.conversationId).toBe('conv-test');
    await connector.stop();
  });

  it('returns conversationId even when not supplied in request', async () => {
    const { connector } = await makeConnector();
    const loginRes = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    const { token } = JSON.parse(loginRes.body) as { token: string };
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { tool: 'list_participants' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.conversationId).toBe('string');
    await connector.stop();
  });
});

describe('WebConnector: POST /api/auth/logout', () => {
  it('returns 200 (JWT is stateless; acknowledgement only)', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, { method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(200);
    await connector.stop();
  });
});

describe('WebConnector: deliver()', () => {
  it('is a no-op when the recipient has no active connections', async () => {
    const { connector } = await makeConnector();
    await expect(
      connector.deliver({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'agent-1',
        recipientId: 'op-1',
        content: 'hello',
        timestamp: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
    await connector.stop();
  });

  it('sends to all open sockets for the recipient', async () => {
    const { connector } = await makeConnector();
    const sent: string[] = [];
    const fakeSocket = {
      readyState: 1, // OPEN
      send: (data: string) => {
        sent.push(data);
      },
    };
    // Directly inject a fake socket into the connections map for testing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (connector as any).connections.set('op-1', new Set([fakeSocket]));

    await connector.deliver({
      id: 'm1',
      conversationId: 'c1',
      senderId: 'agent-1',
      recipientId: 'op-1',
      content: 'hi',
      timestamp: new Date().toISOString(),
    });

    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]) as { type: string };
    expect(msg.type).toBe('message');
    await connector.stop();
  });

  it('skips closed sockets (readyState !== OPEN)', async () => {
    const { connector } = await makeConnector();
    const sent: string[] = [];
    const closedSocket = {
      readyState: 3, // CLOSED
      send: (data: string) => {
        sent.push(data);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (connector as any).connections.set('op-1', new Set([closedSocket]));

    await connector.deliver({
      id: 'm1',
      conversationId: 'c1',
      senderId: 'agent-1',
      recipientId: 'op-1',
      content: 'hi',
      timestamp: new Date().toISOString(),
    });
    expect(sent).toHaveLength(0);
    await connector.stop();
  });
});
```

- [ ] **Step 1: Create all files** (`auth.ts`, route files, `WebConnector.ts`, `WebConnector.test.ts`) with the content above.

- [ ] **Step 2: Run the failing test**

```bash
npx vitest run packages/runtime/src/server/WebConnector.test.ts
```

Expected: FAIL — missing modules.

- [ ] **Step 3: Implement all route files and `WebConnector.ts`** (exact content above).

- [ ] **Step 4: Run tests again**

```bash
npx vitest run packages/runtime/src/server/WebConnector.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/server
git commit -m "feat(runtime): WebConnector HTTP routes and deliver()"
```

---

## Task 5: `WebConnector` — WebSocket (integration test only)

The WebSocket handler is already implemented in `WebConnector.ts` (Task 4). This task adds
the WS-specific integration test, gated by `LEGION_INTEGRATION=1`.

> **Why a separate task?** WS tests require a real network connection (Node 20 has no
> built-in `WebSocket`), so they use the `ws` package and start a real server. The HTTP
> tests in Task 4 use `app.inject()` and are always-on unit tests.

- [ ] **Step 1: Create `packages/runtime/src/server/WebConnector.ws.integration.test.ts`**

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WebConnector } from './WebConnector.js';
import { MemoryStorage } from '@legion/core';
import { Collective } from '@legion/core';
import { EventBus } from '@legion/core';
import { FileCredentialStore } from '@legion/core';

const LIVE = Boolean(process.env['LEGION_INTEGRATION']);

function getPort(server: { address: () => { port: number } | null }): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No port');
  return addr.port;
}

async function setup(port: number) {
  const storage = new MemoryStorage();
  await storage.writeJson('collective/participants/op-1.json', {
    id: 'op-1',
    name: 'Operator',
    type: 'user',
    tools: {},
    operator: true,
    protected: true,
    status: 'active',
  });
  const collective = await Collective.load(storage);
  const credentials = new FileCredentialStore(storage);
  await credentials.setCredential('op-1', 'hunter2');
  const eventBus = new EventBus();

  const connector = new WebConnector({
    collective,
    credentials,
    eventBus,
    serverConfig: { port, host: '127.0.0.1' },
  });

  const ctx: any = {
    submit: async () => ({ status: 'success', conversationId: 'c1' }),
    callTool: async () => ({ result: { status: 'success', data: 'ok' }, conversationId: 'c1' }),
    registry: {
      setActive: () => {},
      clearActive: () => {},
      register: () => {},
      deregister: () => {},
      get: () => undefined,
      getAll: () => [],
      getActiveConnectors: () => [],
    },
  };

  await connector.start(ctx);
  return { connector, eventBus };
}

describe.skipIf(!LIVE)('WebConnector: WebSocket (integration)', () => {
  let dir: string;
  let connector: WebConnector;
  let eventBus: EventBus;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-ws-'));
  });

  afterEach(async () => {
    await connector?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('closes connection if no auth message arrives within timeout', async () => {
    const { connector: c } = await setup(4321);
    connector = c;
    const ws = new WebSocket('ws://127.0.0.1:4321/ws');
    await new Promise<void>((resolve, reject) => {
      ws.on('close', (code) => {
        expect(code).toBe(4401);
        resolve();
      });
      ws.on('error', reject);
    });
  });

  it('receives "connected" ack after sending a valid auth message', async () => {
    const { connector: c, eventBus: eb } = await setup(4322);
    connector = c;
    eventBus = eb;

    // First login to get a token
    const loginRes = await fetch('http://127.0.0.1:4322/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Operator', password: 'hunter2' }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const ws = new WebSocket('ws://127.0.0.1:4322/ws');
    const messages: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        messages.push(msg);
        if ((msg as any).type === 'connected') resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    expect((messages[0] as any).type).toBe('connected');
    expect((messages[0] as any).participantId).toBe('op-1');
    ws.close();
  });

  it('receives EventBus events as {"type":"event",...} after auth', async () => {
    const { connector: c, eventBus: eb } = await setup(4323);
    connector = c;
    eventBus = eb;

    const loginRes = await fetch('http://127.0.0.1:4323/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Operator', password: 'hunter2' }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const ws = new WebSocket('ws://127.0.0.1:4323/ws');
    const events: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if ((msg as any).type === 'connected') {
          // Emit an event after auth
          eventBus.emit('process:ready', { workspaceRoot: '/test' });
        } else if ((msg as any).type === 'event') {
          events.push(msg);
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    expect((events[0] as any).event).toBe('process:ready');
    ws.close();
  });

  it('respond to ping with pong', async () => {
    const { connector: c, eventBus: eb } = await setup(4324);
    connector = c;
    eventBus = eb;

    const loginRes = await fetch('http://127.0.0.1:4324/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Operator', password: 'hunter2' }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const ws = new WebSocket('ws://127.0.0.1:4324/ws');
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if ((msg as any).type === 'connected') {
          ws.send(JSON.stringify({ type: 'ping' }));
        } else if ((msg as any).type === 'pong') {
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    ws.close();
  });
});
```

- [ ] **Step 2: Run integration tests (with env var)**

```bash
LEGION_INTEGRATION=1 npx vitest run packages/runtime/src/server/WebConnector.ws.integration.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 3: Verify skipped without env var**

```bash
npx vitest run packages/runtime/src/server/WebConnector.ws.integration.test.ts
```

Expected: all 4 tests SKIPPED (not failed).

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/server/WebConnector.ws.integration.test.ts
git commit -m "test(runtime): WebConnector WebSocket integration tests"
```

---

## Task 6: `LegionProcess`

**Files:**

1. Create: `packages/runtime/src/LegionProcess.ts`
2. Create: `packages/runtime/src/LegionProcess.integration.test.ts`

---

### `packages/runtime/src/LegionProcess.ts`

```typescript
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  // Core engine
  Collective,
  ConversationThread,
  EventBus,
  FileConversationStore,
  FileCredentialStore,
  FileStorage,
  MemoryStorage,
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
import { WebConnector } from './server/WebConnector.js';

/** The assembled Legion runtime. Returned by `LegionProcess.start()`. */
export class LegionProcess {
  private constructor(
    readonly router: MessageRouter,
    readonly collective: Collective,
    readonly store: FileConversationStore,
    readonly credentials: FileCredentialStore,
    readonly services: ServiceManager,
    readonly connectors: ConnectorRegistry,
    readonly eventBus: EventBus,
    private readonly mcpSources: ToolSource[],
    private readonly webConnector: WebConnector,
  ) {}

  /**
   * Start the Legion process from `workspaceRoot`.
   * Follows the 11-step startup sequence from spec §8.
   */
  static async start(workspaceRoot: string): Promise<LegionProcess> {
    // ── Step 1: Read workspace config ────────────────────────────────────────
    const workspaceConfig = await loadWorkspaceConfig(workspaceRoot);
    const legionRoot = join(workspaceRoot, '.legion');

    // ── Step 2: Load collective; seed bootstrap operator if empty ────────────
    const storage = new FileStorage(legionRoot);
    const collective = await Collective.load(storage);
    const credentials = new FileCredentialStore(storage);
    const seeded = await collective.seedDefaultsIfEmpty();
    if (seeded.length > 0) {
      const password = randomUUID();
      await credentials.setCredential(BOOTSTRAP_OPERATOR_ID, password);
      console.log(
        '\n  ┌─ Legion bootstrap ──────────────────────────────────────────────┐' +
          '\n  │  Bootstrap operator password: ' +
          password +
          '  │' +
          '\n  │  Store this password — it will not be shown again.              │' +
          '\n  └─────────────────────────────────────────────────────────────────┘\n',
      );
    }

    // ── Step 3: Initialise ConversationStore and CredentialStore ─────────────
    const store = new FileConversationStore(storage);

    // ── Step 4: Register runtime factories ───────────────────────────────────
    const connectorRegistry = new ConnectorRegistry();
    const runtimeRegistry = new RuntimeRegistry();
    runtimeRegistry.registerFactory('user', (id) => new UserDeliveryRuntime(id, connectorRegistry));
    runtimeRegistry.registerFactory('mock', (id) => new MockRuntime(id));
    // agent and service factories registered after their dependencies are created (steps 5–8)

    // ── Step 5: Create core engine components ────────────────────────────────
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const authEngine = new AuthEngine();
    const pendingApprovalRegistry = await PendingApprovalRegistry.load(storage);

    const router = new MessageRouter(store, runtimeRegistry, collective, eventBus);

    // ── Step 6: Register global tools ────────────────────────────────────────
    toolRegistry.register(communicateTool);
    toolRegistry.register(approvalResponseTool);
    for (const tool of managementTools) {
      toolRegistry.register(tool);
    }

    // ── Step 7: Load MCP tool sources ────────────────────────────────────────
    const mcpSources = await loadMCPSources(workspaceConfig.mcpServers ?? [], toolRegistry);

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
      workspaceConfig,
      workspaceRoot,
    });

    // Load all service participants
    for (const participant of collective.listActive()) {
      if (participant.type === 'service') {
        await serviceManager.loadService(participant);
      }
    }

    // Register service runtime factory using the cached ServiceRuntime instances
    runtimeRegistry.registerFactory('service', (id) => serviceManager.getRuntime(id));

    // Register agent factory (now that router + context deps are all wired)
    const buildBaseContext = (
      participantId: string,
    ): Omit<ToolContext, 'participant' | 'conversationId' | 'conversation'> => ({
      collective,
      communicationDepth: 0,
      toolRegistry,
      config: workspaceConfig,
      eventBus,
      storage,
      workspaceRoot,
      authEngine,
      pendingApprovalRegistry,
      messageRouter: router,
      serviceManager,
    });
    runtimeRegistry.registerFactory('agent', (id) => {
      const participant = collective.getOrThrow(id);
      return new AgentRuntime(participant, buildBaseContext(id) as ToolContext);
    });

    // ── Step 9: Initialise web connector ─────────────────────────────────────
    const webConnectorConfig = workspaceConfig.server ?? {};
    const webDistPath = join(workspaceRoot, 'packages', 'web', 'dist');
    const webConnector = new WebConnector({
      collective,
      credentials,
      eventBus,
      serverConfig: webConnectorConfig,
      webDistPath,
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
      config: workspaceConfig,
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
      webConnector,
    );
  }

  /** Graceful shutdown: stop all services, connectors, and MCP sources. */
  async stop(): Promise<void> {
    // Stop all running services
    for (const { participantId } of this.services.getAll()) {
      try {
        await this.services.stopService(participantId);
      } catch {
        // Best-effort; log but don't prevent other shutdowns.
      }
    }
    // Stop all connectors
    for (const connector of this.connectors.getAll()) {
      try {
        await connector.stop();
      } catch {
        // Best-effort.
      }
    }
    // Unload MCP sources
    for (const source of this.mcpSources) {
      try {
        await source.unload?.();
      } catch {
        // Best-effort.
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

interface ConnectorContextDeps {
  router: MessageRouter;
  toolRegistry: ToolRegistry;
  authEngine: AuthEngine;
  connectorRegistry: ConnectorRegistry;
  collective: Collective;
  store: FileConversationStore;
  pendingApprovalRegistry: PendingApprovalRegistry;
  eventBus: EventBus;
  storage: FileStorage;
  config: WorkspaceConfig;
  workspaceRoot: string;
  serviceManager: ServiceManager;
}

/** Build the `ConnectorContext` passed to every connector's `start()`. */
function buildConnectorContext(deps: ConnectorContextDeps): ConnectorContext {
  const {
    router,
    toolRegistry,
    authEngine,
    connectorRegistry,
    collective,
    store,
    pendingApprovalRegistry,
    eventBus,
    storage,
    config,
    workspaceRoot,
    serviceManager,
  } = deps;

  return {
    async submit(msg) {
      const baseCtx: ToolContext = {
        participant: collective.getOrThrow(msg.senderId),
        conversationId: msg.conversationId ?? '',
        conversation: undefined as any, // router creates/loads the thread
        collective,
        communicationDepth: 0,
        toolRegistry,
        config,
        eventBus,
        storage,
        workspaceRoot,
        authEngine,
        pendingApprovalRegistry,
        messageRouter: router,
        serviceManager,
      };
      return router.send({
        senderId: msg.senderId,
        recipientId: msg.recipientId,
        message: msg.content,
        conversationId: msg.conversationId,
        replyTo: msg.replyTo,
        context: baseCtx,
      });
    },

    async callTool(participantId, toolName, args, opts) {
      const participant = collective.get(participantId);
      if (!participant) {
        return {
          result: { status: 'error', error: `Participant not found: ${participantId}` },
          conversationId: '',
        };
      }

      const authResult = authEngine.authorize(participantId, toolName, args, participant.tools);
      if (!authResult.authorized) {
        return {
          result: { status: 'error', error: authResult.reason ?? 'Not authorized' },
          conversationId: '',
        };
      }

      const tool = toolRegistry.get(toolName);
      if (!tool) {
        return {
          result: { status: 'error', error: `Tool not found: ${toolName}` },
          conversationId: '',
        };
      }

      // Create or load conversation for this tool call
      let thread: ConversationThread;
      let conversationId: string;
      if (opts?.conversationId) {
        const existing = await store.load(opts.conversationId);
        if (!existing) {
          return {
            result: { status: 'error', error: `Conversation not found: ${opts.conversationId}` },
            conversationId: opts.conversationId,
          };
        }
        conversationId = opts.conversationId;
        thread = new ConversationThread(existing, store);
      } else {
        const data = await store.create({
          schemaVersion: '2.0',
          activeBranchHead: '',
          messages: {},
        });
        conversationId = data.id;
        thread = new ConversationThread(data, store);
      }

      const toolCtx: ToolContext = {
        participant,
        conversationId,
        conversation: thread,
        collective,
        communicationDepth: 0,
        toolRegistry,
        config,
        eventBus,
        storage,
        workspaceRoot,
        authEngine,
        pendingApprovalRegistry,
        messageRouter: router,
        serviceManager,
      };

      const result = await tool.execute(args, toolCtx);
      return { result, conversationId };
    },

    registry: connectorRegistry,
  };
}
```

---

### `packages/runtime/src/LegionProcess.integration.test.ts`

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegionProcess } from './LegionProcess.js';

const LIVE = Boolean(process.env['LEGION_INTEGRATION']);

describe.skipIf(!LIVE)('LegionProcess (integration)', () => {
  let workspaceRoot: string;
  let process_: LegionProcess;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'legion-process-'));
  });

  afterEach(async () => {
    await process_?.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('starts without errors and seeds the bootstrap operator', async () => {
    process_ = await LegionProcess.start(workspaceRoot);
    const participants = process_.collective.listActive();
    expect(participants.length).toBeGreaterThan(0);
    const operator = participants.find((p) => p.operator === true);
    expect(operator).toBeDefined();
  });

  it('web server responds to GET /api/health', async () => {
    process_ = await LegionProcess.start(workspaceRoot);
    // Determine the port from the server config (default 3000)
    const res = await fetch('http://127.0.0.1:3000/api/health');
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('stop() shuts down cleanly without hanging handles', async () => {
    process_ = await LegionProcess.start(workspaceRoot);
    await expect(process_.stop()).resolves.toBeUndefined();
    process_ = undefined!; // prevent double-stop in afterEach
  });

  it('full flow: seed → login → execute list_participants → result', async () => {
    // Start with a custom port to avoid collisions with other integration tests.
    // Write a minimal config.json to use port 3001.
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(workspaceRoot, '.legion'), { recursive: true });
    await writeFile(
      join(workspaceRoot, '.legion', 'config.json'),
      JSON.stringify({ version: '2', server: { port: 3001, host: '127.0.0.1' } }),
    );

    // Capture bootstrap password from stdout (hacky but reliable for integration).
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '));
      origLog(...args);
    };

    process_ = await LegionProcess.start(workspaceRoot);
    console.log = origLog;

    // Extract password from logged output
    const passwordLine = logged.find((l) => l.includes('Bootstrap operator password:'));
    expect(passwordLine).toBeDefined();
    const password = passwordLine!.match(/password:\s+([^\s│]+)/)?.[1];
    expect(password).toBeTruthy();

    // Login
    const loginRes = await fetch('http://127.0.0.1:3001/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Operator', password }),
    });
    expect(loginRes.ok).toBe(true);
    const { token } = (await loginRes.json()) as { token: string };
    expect(token).toBeTruthy();

    // Execute list_participants
    const execRes = await fetch('http://127.0.0.1:3001/api/execute', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tool: 'list_participants', args: {} }),
    });
    expect(execRes.ok).toBe(true);
    const { result, conversationId } = (await execRes.json()) as {
      result: { status: string };
      conversationId: string;
    };
    expect(result.status).toBe('success');
    expect(typeof conversationId).toBe('string');
  });
});
```

- [ ] **Step 1: Create `LegionProcess.ts`** (exact content above)

- [ ] **Step 2: Create `LegionProcess.integration.test.ts`** (exact content above)

- [ ] **Step 3: Build the runtime package to catch type errors**

```bash
npm run build --workspace @legion/runtime
```

Expected: PASS — zero compile errors.

- [ ] **Step 4: Run integration tests (with env var)**

```bash
LEGION_INTEGRATION=1 npx vitest run packages/runtime/src/LegionProcess.integration.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Verify integration tests are skipped without env var**

```bash
npx vitest run packages/runtime/src/LegionProcess.integration.test.ts
```

Expected: 4 tests SKIPPED.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts \
        packages/runtime/src/LegionProcess.integration.test.ts
git commit -m "feat(runtime): LegionProcess assembly and integration test"
```

---

## Task 7: Barrel exports + full suite verification

**Files:**

1. Update: `packages/runtime/src/index.ts`
2. Update: `packages/core/src/index.ts` — verify connectors barrel already added (Task 2)

- [ ] **Step 1: Update `packages/runtime/src/index.ts`**

```typescript
export { LegionProcess } from './LegionProcess.js';
export { WebConnector } from './server/WebConnector.js';
export type { WebConnectorDeps } from './server/WebConnector.js';
```

- [ ] **Step 2: Build all packages**

```bash
npm run build --workspaces
```

Expected: zero errors across `@legion/types`, `@legion/core`, `@legion/runtime`.

- [ ] **Step 3: Run full unit test suite**

```bash
npm test --workspaces
```

Expected: All unit tests PASS; integration tests SKIPPED (env vars not set).

- [ ] **Step 4: Run `@legion/core` integration tests (no extra env needed)**

```bash
npx vitest run packages/core --reporter=verbose
```

Expected: All core tests pass (Plans 1–9 still green after amendments).

- [ ] **Step 5: Run `@legion/runtime` integration tests**

```bash
LEGION_INTEGRATION=1 npm test --workspace @legion/runtime
```

Expected: All 8 integration tests pass (WS + LegionProcess).

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/index.ts
git commit -m "chore(runtime): wire barrel exports; full suite green"
```

---

## Self-review checklist

- [ ] `npm run build --workspaces` — zero TypeScript errors
- [ ] `npm test --workspaces` — all unit tests pass; integration tests skipped
- [ ] `LEGION_INTEGRATION=1 npm test --workspace @legion/runtime` — 8 integration tests pass
- [ ] `npm test --workspace @legion/core` — all prior Plans 1–9 tests still pass (no regressions from amendments)
- [ ] `ConnectorRegistry.test.ts` — 12 tests; no `beforeEach`/`afterEach` needed (pure state)
- [ ] `UserDeliveryRuntime.test.ts` — 7 tests; uses fake connectors, no temp dirs
- [ ] `EventBus.test.ts` — 7 tests (4 original + 3 new `onAny` tests)
- [ ] `MessageRouter.test.ts` — original tests + 3 concurrency tests all pass
- [ ] `WebConnector.test.ts` — all tests use `app.inject()`; no real TCP socket opened
- [ ] `WebConnector.ws.integration.test.ts` — 4 WS tests, `LEGION_INTEGRATION=1` required
- [ ] `LegionProcess.integration.test.ts` — 4 tests, `LEGION_INTEGRATION=1` required
- [ ] `LegionProcess.stop()` fully cleans up services + connectors + MCP sources
- [ ] Bootstrap password printed once to `stdout`; stored as argon2 hash via `FileCredentialStore`
- [ ] JWT secret is `crypto.getRandomValues(new Uint8Array(32))` — never written to disk
- [ ] Non-loopback `host` emits a `console.warn` startup warning
- [ ] SPA static route absent when `packages/web/dist/` does not exist — no crash, no 404 on other routes
- [ ] `@fastify/static` `setNotFoundHandler` only registered when `webDistPath` exists
- [ ] `WebConnector` WS auth timer cancelled on auth message; connection closed on timeout
- [ ] `EventBus.onAny` unsubscribed (`anyOff?.()`) on WS socket close — no memory leak
- [ ] `ConnectorRegistry.clearActive` called on WS socket close — active-participant state clean
- [ ] `deliver()` skips sockets with `readyState !== 1` (OPEN)
- [ ] `FileCredentialStore` (argon2) from Plan 3 imported directly — not re-implemented
- [ ] Zero `@legion/web` imports in `@legion/runtime` (SPA remains isolated until Plan 11)

---

## Key decisions recorded

| Decision                                                   | Value                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Password hashing                                           | argon2 (Plan 3 decision; `FileCredentialStore` in `@legion/core`)                                            |
| Auth sessions                                              | Stateless JWT via `jose`. 8 h expiry. Secret: `crypto.getRandomValues(new Uint8Array(32))`. Never persisted. |
| Per-conversation locking                                   | Hand-rolled lock-chain in `MessageRouter.withLock()`                                                         |
| `Connector`/`ConnectorContext`/`ConnectorRegistry` package | `@legion/core`                                                                                               |
| `WebConnector` / `LegionProcess` package                   | `@legion/runtime`                                                                                            |
| WS auth protocol                                           | First-message `{"type":"auth","token":"..."}`. 10 s timeout.                                                 |
| Login lookup                                               | By participant `name` (case-insensitive), first active match                                                 |
| `/api/execute` conversation                                | New per-call if not provided; existing if `conversationId` supplied                                          |
| Bootstrap password                                         | `randomUUID()` on first init; printed to stdout; never recoverable                                           |
| SPA serving                                                | `@fastify/static`; skipped (no crash) if `packages/web/dist/` absent                                         |
| Integration test gate                                      | `LEGION_INTEGRATION=1`                                                                                       |
