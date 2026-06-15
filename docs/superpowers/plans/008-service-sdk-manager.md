# Service SDK & ServiceManager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `LegionService` SDK (`LegionService`, `ServiceContext`, `ServiceRuntime`) and the `ServiceManager` that loads service modules, manages their full lifecycle, and routes inbound messages to `onMessage()`.

**Architecture:** Services are code-backed npm-module participants. `ServiceManager` dynamically imports each module (expecting a named `service` export), creates one `ServiceRuntime` per service (cached for the Plan 10 factory), and tracks lifecycle state (`stopped → starting → running → stopping → stopped | failed`). A per-call `ServiceContextImpl` gives each `onMessage()` invocation a typed handle over `communicate`, `callTool`, and `sleep`. The `start()` call receives a long-lived context bound to a real startup conversation; `onMessage()` calls each receive a fresh context bound to the incoming message's conversationId. All service types live in `@legion/core` because they reference `Storage` and `EventBus`, which are not in `@legion/types`. Depends on Plans 1–7.

**Tech Stack:** TypeScript strict ESM, Vitest globals, Node 20+ (dynamic `import()`, `AbortController`).

---

## File Structure

**New files — all under `packages/core/src/service/`:**

| File | Responsibility |
|------|---------------|
| `LegionService.ts` | `LegionService`, `ServiceContext`, `IncomingMessage`, `CommunicateResult`, `ServiceStatus`, `ServiceInfo` interfaces |
| `LegionService.test.ts` | Type-shape tests |
| `ServiceRuntime.ts` | `Runtime` adapter — calls `onMessage()` from `MessageRouter` dispatch |
| `ServiceRuntime.test.ts` | Unit tests |
| `ServiceContextImpl.ts` | Concrete `ServiceContext`; `callTool` auth flow, `communicate`, `sleep` |
| `ServiceContextImpl.test.ts` | Unit tests |
| `ServiceManager.ts` | Lifecycle management — load, start, stop, autoStart, error notification |
| `ServiceManager.test.ts` | Unit tests |
| `service.integration.test.ts` | End-to-end: load → start → handle → stop |

**Amended files:**

| File | Change |
|------|--------|
| `packages/types/src/participant.ts` | Add `errorNotify?: string` to `ServiceConfig` |
| `packages/core/src/runtime/Runtime.ts` | `serviceManager?: unknown` → `serviceManager?: ServiceManager` |
| `packages/core/src/index.ts` | Add service barrel exports |

---

## Task 1: LegionService SDK interfaces

**Files:**
- Create: `packages/core/src/service/LegionService.ts`
- Create: `packages/core/src/service/LegionService.test.ts`

> Spec §5. Public SDK contract for service module authors.
> Named `service` export convention: `export const service: LegionService = { ... }`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/service/LegionService.test.ts`:

```typescript
import type {
  CommunicateResult,
  IncomingMessage,
  LegionService,
  ServiceContext,
  ServiceInfo,
  ServiceStatus,
} from './LegionService.js';

describe('LegionService SDK type shapes', () => {
  it('LegionService can be implemented with only start and stop', () => {
    const svc: LegionService = {
      async start(_ctx: ServiceContext) {},
      async stop() {},
    };
    expect(typeof svc.start).toBe('function');
    expect(typeof svc.stop).toBe('function');
    expect(svc.onMessage).toBeUndefined();
  });

  it('LegionService can implement optional onMessage', () => {
    const svc: LegionService = {
      async start(_ctx) {},
      async stop() {},
      async onMessage(msg, _ctx) {
        return `echo: ${msg.content}`;
      },
    };
    expect(typeof svc.onMessage).toBe('function');
  });

  it('ServiceStatus covers all five lifecycle states', () => {
    const states: ServiceStatus[] = ['starting', 'running', 'stopping', 'stopped', 'failed'];
    expect(states).toHaveLength(5);
  });

  it('CommunicateResult includes all three status values', () => {
    const ok: CommunicateResult = { conversationId: 'c1', response: 'hi', status: 'success' };
    const dispatched: CommunicateResult = { conversationId: 'c1', status: 'dispatched' };
    const err: CommunicateResult = { conversationId: 'c1', status: 'error', error: 'oops' };
    expect(ok.status).toBe('success');
    expect(dispatched.status).toBe('dispatched');
    expect(err.error).toBe('oops');
  });

  it('IncomingMessage has all required fields and optional replyTo', () => {
    const msg: IncomingMessage = {
      id: 'msg-1',
      conversationId: 'c-1',
      senderId: 'agent-a',
      recipientId: 'svc-1',
      content: 'hello',
      timestamp: new Date().toISOString(),
    };
    expect(msg.replyTo).toBeUndefined();
  });

  it('ServiceInfo can carry an error', () => {
    const info: ServiceInfo = {
      participantId: 'svc-1',
      status: 'failed',
      error: 'Module not found',
    };
    expect(info.error).toBe('Module not found');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run packages/core/src/service/LegionService.test.ts
```

Expected: FAIL — `Cannot find module './LegionService.js'`.

- [ ] **Step 3: Implement the interfaces**

`packages/core/src/service/LegionService.ts`:

```typescript
import type { EventBus } from '../events/EventBus.js';
import type { Storage } from '../storage/Storage.js';
import type { ToolResult } from '@legion/types';

/**
 * A message delivered inbound to a service (spec §5).
 * Mirrors the fields of MessageData that a service needs to handle a request.
 */
export interface IncomingMessage {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  replyTo?: string;
  content: string;
  timestamp: string;
}

/**
 * Result of ServiceContext.communicate() — mirrors MessageRouterResult (spec §3).
 */
export interface CommunicateResult {
  conversationId: string;
  response?: string;
  status: 'success' | 'error' | 'dispatched';
  error?: string;
}

/** Lifecycle state of a managed service. */
export type ServiceStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

/** Public summary of a loaded service — used by management tooling (Plan 10). */
export interface ServiceInfo {
  participantId: string;
  status: ServiceStatus;
  error?: string;
}

/**
 * The execution context given to a LegionService (spec §5).
 *
 * Two distinct context lifetimes:
 *  - Startup context (passed to `start()`): long-lived, bound to a startup conversation.
 *    Services that do background work (timers, polling) hold a reference to this.
 *  - Per-call context (passed to `onMessage()`): short-lived, bound to the inbound
 *    message's conversationId. Created fresh for each message dispatch.
 */
export interface ServiceContext {
  /** The participant ID this service is bound to. */
  participantId: string;
  /** Aborted when the service is stopped. Honor this in long-running background work. */
  stopped: AbortSignal;
  /** Storage scoped to `.legion/services/<participantId>/`. */
  storage: Storage;
  /** Process-level typed event bus. */
  eventBus: EventBus;
  /**
   * Send a message to another participant.
   * Creates a new conversation if `opts.conversationId` is omitted.
   */
  communicate(
    to: string,
    message: string,
    opts?: { conversationId?: string; replyTo?: string },
  ): Promise<CommunicateResult>;
  /**
   * Execute a registered tool as this service participant.
   * Authorization is enforced (spec §7: "all authorized identically").
   * `requires_approval` fails closed — no authority chain exists in service context.
   */
  callTool(toolName: string, args: unknown): Promise<ToolResult>;
  /**
   * Sleep for `ms` milliseconds.
   * Resolves early (without throwing) if the service's `stopped` signal is aborted.
   */
  sleep(ms: number): Promise<void>;
}

/**
 * Implemented by any npm module that participates as a service (spec §5).
 *
 * Module export convention — service modules must export a named `service` constant:
 *
 * ```typescript
 * import type { LegionService } from '@legion/core';
 *
 * export const service: LegionService = {
 *   async start(ctx) {
 *     // initialise background work; store ctx for later use
 *   },
 *   async stop() {
 *     // clean up background work; ctx.stopped is already aborted
 *   },
 *   async onMessage(msg, ctx) {
 *     return `Received: ${msg.content}`;
 *   },
 * };
 * ```
 *
 * `onMessage` is optional. A service without it (or with `canReceive: false` in config)
 * returns a polite decline to any inbound message rather than erroring.
 */
export interface LegionService {
  start(context: ServiceContext): Promise<void>;
  stop(): Promise<void>;
  onMessage?(message: IncomingMessage, context: ServiceContext): Promise<string | void>;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run packages/core/src/service/LegionService.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/service/LegionService.ts packages/core/src/service/LegionService.test.ts
git commit -m "feat(core): add LegionService SDK type interfaces"
```

---

## Task 2: Type amendments — ServiceConfig.errorNotify + RuntimeContext.serviceManager

**Files:**
- Modify: `packages/types/src/participant.ts`
- Modify: `packages/core/src/runtime/Runtime.ts`

> Two targeted amendments. No new behaviour in this task — just type narrowing and an
> additive field. Tests are the existing Plan 1 / Plan 7 build checks.

- [ ] **Step 1: Amend `ServiceConfig` in `@legion/types`**

Open `packages/types/src/participant.ts`. Find the `ServiceConfig` interface:

```typescript
export interface ServiceConfig extends BaseParticipant {
  type: 'service';
  module: string;
  config?: Record<string, unknown>;
  canReceive?: boolean;
  autoStart?: boolean;
```

Add `errorNotify` before the closing brace:

```typescript
export interface ServiceConfig extends BaseParticipant {
  type: 'service';
  module: string;
  config?: Record<string, unknown>;
  canReceive?: boolean;
  autoStart?: boolean;
  /**
   * Participant ID to notify when this service fails to start or crashes during onMessage.
   * ServiceManager sends the error details as a message to this participant.
   */
  errorNotify?: string;
```

- [ ] **Step 2: Verify `@legion/types` builds cleanly**

```bash
npx tsc --build packages/types/tsconfig.json
```

Expected: exits 0 with no errors.

- [ ] **Step 3: Amend `RuntimeContext.serviceManager` in `@legion/core`**

Open `packages/core/src/runtime/Runtime.ts`. Find:

```typescript
  serviceManager?: unknown;
```

Replace with:

```typescript
  serviceManager?: import('../service/ServiceManager.js').ServiceManager;
```

> Using an inline `import(...)` type avoids a circular module reference at the TypeScript
> declaration level: `Runtime.ts` needs `ServiceManager`, and (transitively, via
> `ServiceContextImpl`) `ServiceManager` imports `RuntimeContext` from `Runtime.ts`.
> Both are `import type` — erased at runtime, safe for TypeScript's type-checker.

- [ ] **Step 4: Verify `@legion/core` builds cleanly**

```bash
npx tsc --build packages/core/tsconfig.json
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/participant.ts packages/core/src/runtime/Runtime.ts
git commit -m "feat(types,core): ServiceConfig.errorNotify + RuntimeContext.serviceManager typed"
```

---

## Task 3: ServiceRuntime

**Files:**
- Create: `packages/core/src/service/ServiceRuntime.ts`
- Create: `packages/core/src/service/ServiceRuntime.test.ts`

> Implements `Runtime`. Called by `MessageRouter` when a message is dispatched to a
> `service`-type participant. Maps `MessageData + RuntimeContext` → `IncomingMessage +
> ServiceContext` → `LegionService.onMessage()` → `RuntimeResult`.
>
> The `makeContext` factory (provided by `ServiceManager.loadService()`) creates a fresh
> `ServiceContext` bound to the incoming message's conversationId. This keeps
> `ServiceRuntime` thin and free of lifecycle dependencies.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/service/ServiceRuntime.test.ts`:

```typescript
import type { MessageData } from '@legion/types';
import type { RuntimeContext } from '../runtime/Runtime.js';
import type { LegionService, ServiceContext } from './LegionService.js';
import { ServiceRuntime } from './ServiceRuntime.js';

// Minimal MessageData for test dispatch.
function makeIncoming(overrides: Partial<MessageData> = {}): MessageData {
  return {
    id: 'msg-1',
    parentId: null,
    conversationId: 'conv-1',
    senderId: 'agent-a',
    recipientId: 'svc-1',
    role: 'user',
    content: 'hello',
    status: 'active',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ServiceRuntime ignores RuntimeContext (it uses makeContext instead).
function stubRuntimeCtx(): RuntimeContext {
  return {} as RuntimeContext;
}

function stubContextFactory(_conversationId: string): ServiceContext {
  return {
    participantId: 'svc-1',
    stopped: new AbortController().signal,
    communicate: vi.fn(),
    callTool: vi.fn(),
    sleep: vi.fn(),
    storage: {} as ServiceContext['storage'],
    eventBus: {} as ServiceContext['eventBus'],
  };
}

describe('ServiceRuntime', () => {
  it('calls onMessage and returns a response RuntimeResult', async () => {
    const svc: LegionService = {
      async start() {},
      async stop() {},
      async onMessage(msg) { return `echo: ${msg.content}`; },
    };
    const runtime = new ServiceRuntime(svc, {}, stubContextFactory);
    const result = await runtime.handle(makeIncoming(), stubRuntimeCtx());
    expect(result).toEqual({ kind: 'response', content: 'echo: hello' });
  });

  it('returns void RuntimeResult when onMessage returns undefined', async () => {
    const svc: LegionService = {
      async start() {},
      async stop() {},
      async onMessage() { return undefined; },
    };
    const runtime = new ServiceRuntime(svc, {}, stubContextFactory);
    const result = await runtime.handle(makeIncoming(), stubRuntimeCtx());
    expect(result).toEqual({ kind: 'void' });
  });

  it('declines gracefully when canReceive is false', async () => {
    const svc: LegionService = {
      async start() {},
      async stop() {},
      async onMessage() { return 'never called'; },
    };
    const runtime = new ServiceRuntime(svc, { canReceive: false }, stubContextFactory);
    const result = await runtime.handle(makeIncoming(), stubRuntimeCtx());
    expect(result).toEqual({ kind: 'response', content: expect.stringContaining('does not accept') });
  });

  it('declines gracefully when onMessage is absent', async () => {
    const svc: LegionService = { async start() {}, async stop() {} };
    const runtime = new ServiceRuntime(svc, {}, stubContextFactory);
    const result = await runtime.handle(makeIncoming(), stubRuntimeCtx());
    expect(result).toEqual({ kind: 'response', content: expect.stringContaining('does not accept') });
  });

  it('passes the incoming conversationId to the context factory', async () => {
    const seen: string[] = [];
    const factory = (id: string): ServiceContext => { seen.push(id); return stubContextFactory(id); };
    const svc: LegionService = { async start() {}, async stop() {}, async onMessage() { return 'ok'; } };
    const runtime = new ServiceRuntime(svc, {}, factory);
    await runtime.handle(makeIncoming({ conversationId: 'conv-42' }), stubRuntimeCtx());
    expect(seen).toEqual(['conv-42']);
  });

  it('maps all IncomingMessage fields from MessageData', async () => {
    let seen: unknown;
    const svc: LegionService = {
      async start() {},
      async stop() {},
      async onMessage(msg) { seen = msg; return 'ok'; },
    };
    const runtime = new ServiceRuntime(svc, {}, stubContextFactory);
    const incoming = makeIncoming({ senderId: 'op-1', replyTo: 'user-1', content: 'ping' });
    await runtime.handle(incoming, stubRuntimeCtx());
    expect(seen).toMatchObject({
      id: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'op-1',
      recipientId: 'svc-1',
      replyTo: 'user-1',
      content: 'ping',
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run packages/core/src/service/ServiceRuntime.test.ts
```

Expected: FAIL — `Cannot find module './ServiceRuntime.js'`.

- [ ] **Step 3: Implement ServiceRuntime**

`packages/core/src/service/ServiceRuntime.ts`:

```typescript
import type { MessageData } from '@legion/types';
import type { Runtime, RuntimeContext, RuntimeResult } from '../runtime/Runtime.js';
import type { IncomingMessage, LegionService, ServiceContext } from './LegionService.js';

/**
 * Runtime adapter for `service`-type participants (spec §8 step 4).
 *
 * Registered in `RuntimeRegistry` via the `service` factory (wired in Plan 10):
 *   `registry.registerFactory('service', (id) => serviceManager.getRuntime(id))`
 *
 * Lifecycle dependencies (stopped signal, scoped storage, etc.) are encapsulated in
 * the `makeContext` factory provided by `ServiceManager.loadService()`. This keeps
 * `ServiceRuntime` stateless and testable in isolation.
 */
export class ServiceRuntime implements Runtime {
  constructor(
    private readonly service: LegionService,
    /** Only `canReceive` is consulted — full config lives in ServiceManager. */
    private readonly config: { canReceive?: boolean },
    /**
     * Factory producing a fresh per-call `ServiceContext`.
     * Called with the inbound message's `conversationId`.
     */
    private readonly makeContext: (conversationId: string) => ServiceContext,
  ) {}

  async handle(incoming: MessageData, _context: RuntimeContext): Promise<RuntimeResult> {
    if (this.config.canReceive === false || !this.service.onMessage) {
      return { kind: 'response', content: 'Service does not accept incoming messages.' };
    }

    const msg: IncomingMessage = {
      id: incoming.id,
      conversationId: incoming.conversationId,
      senderId: incoming.senderId,
      recipientId: incoming.recipientId,
      replyTo: incoming.replyTo,
      content: incoming.content,
      timestamp: incoming.timestamp,
    };

    const svcCtx = this.makeContext(incoming.conversationId);
    const result = await this.service.onMessage(msg, svcCtx);

    if (result == null) return { kind: 'void' };
    return { kind: 'response', content: result };
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run packages/core/src/service/ServiceRuntime.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/service/ServiceRuntime.ts packages/core/src/service/ServiceRuntime.test.ts
git commit -m "feat(core): add ServiceRuntime adapter"
```

---

## Task 4: ServiceContextImpl

**Files:**
- Create: `packages/core/src/service/ServiceContextImpl.ts`
- Create: `packages/core/src/service/ServiceContextImpl.test.ts`

> Concrete implementation of `ServiceContext`. Created fresh per-call by `ServiceManager`'s
> `makeContext` closure. All fields are set at construction; `conversationId` is the only
> thing that varies between the startup context and per-message contexts.
>
> `callTool`: runs `AuthEngine.authorize` before delegating to `ToolRegistry.execute`.
> `requires_approval` fails closed — no `callingParticipantId` means no authority chain.
> `sleep`: `setTimeout` with `AbortSignal` early-resolution (no throw on abort).
> `communicate`: delegates to `MessageRouterPort.send`; maps result to `CommunicateResult`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/service/ServiceContextImpl.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceConfig, ToolResult } from '@legion/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileStorage } from '../storage/FileStorage.js';
import type { MessageRouterPort, MessageRouterResult, ToolRegistryLike } from '../tools/Tool.js';
import { ServiceContextImpl, type ServiceContextDeps } from './ServiceContextImpl.js';

const BASE_CONFIG: ServiceConfig = {
  id: 'svc-test',
  name: 'Test Service',
  type: 'service',
  module: './test-svc.js',
  tools: { file_read: 'auto' },
};

function makeMockToolRegistry(toolResult: ToolResult): ToolRegistryLike {
  const tool = {
    name: 'file_read',
    description: 'reads a file',
    parameters: {},
    execute: async () => toolResult,
  };
  return {
    get: (name: string) => (name === 'file_read' ? tool : undefined),
    has: (name: string) => name === 'file_read',
    list: () => [tool],
    execute: async (name: string, _args: unknown, _ctx: unknown) =>
      name === 'file_read'
        ? toolResult
        : ({ status: 'error', error: `Tool '${name}' not found` } as ToolResult),
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'legion-svc-ctx-'));
  const storage = new FileStorage(dir);
  const store = new FileConversationStore(storage);
  const conv = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
  const abortController = new AbortController();

  const routerResult: MessageRouterResult = {
    conversationId: conv.id,
    status: 'success',
    response: 'router response',
  };
  const mockRouter: MessageRouterPort = {
    send: vi.fn().mockResolvedValue(routerResult),
    resume: vi.fn(),
  };

  const deps: ServiceContextDeps = {
    participant: BASE_CONFIG,
    conversationId: conv.id,
    store,
    collective: {
      getOrThrow: vi.fn().mockReturnValue(BASE_CONFIG),
      get: vi.fn(),
      list: vi.fn(),
    } as any,
    toolRegistry: makeMockToolRegistry({ status: 'success', data: 'file content' }),
    workspaceConfig: { version: '2' } as any,
    eventBus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() } as any,
    scopedStorage: storage.scope('services/svc-test'),
    rawStorage: storage,
    workspaceRoot: dir,
    authEngine: new AuthEngine({ defaultPolicy: 'auto' }),
    pendingApprovalRegistry: {
      create: vi.fn(), get: vi.fn(), resolve: vi.fn(), getAll: vi.fn(),
    } as any,
    messageRouter: mockRouter,
    stopped: abortController.signal,
    serviceManager: undefined,
  };

  return { dir, deps, conv, mockRouter, abortController };
}

describe('ServiceContextImpl', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('exposes participantId from the participant config', async () => {
    const { dir: d, deps } = await setup();
    dir = d;
    const ctx = new ServiceContextImpl(deps);
    expect(ctx.participantId).toBe('svc-test');
  });

  it('exposes the stopped AbortSignal', async () => {
    const { dir: d, deps } = await setup();
    dir = d;
    const ctx = new ServiceContextImpl(deps);
    expect(ctx.stopped).toBe(deps.stopped);
  });

  it('exposes scoped storage (not raw storage)', async () => {
    const { dir: d, deps } = await setup();
    dir = d;
    const ctx = new ServiceContextImpl(deps);
    expect(ctx.storage).toBe(deps.scopedStorage);
    expect(ctx.storage).not.toBe(deps.rawStorage);
  });

  it('exposes the eventBus', async () => {
    const { dir: d, deps } = await setup();
    dir = d;
    const ctx = new ServiceContextImpl(deps);
    expect(ctx.eventBus).toBe(deps.eventBus);
  });

  describe('callTool', () => {
    it('executes an authorized tool and returns the result', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      const result = await ctx.callTool('file_read', { path: 'test.txt' });
      expect(result).toEqual({ status: 'success', data: 'file content' });
    });

    it('returns error result when tool is denied', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl({
        ...deps,
        authEngine: new AuthEngine({ defaultPolicy: 'deny' }),
      });
      const result = await ctx.callTool('file_read', {});
      expect(result.status).toBe('error');
      expect((result as any).error).toMatch(/deny/i);
    });

    it('fails closed for requires_approval (no authority chain in service context)', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl({
        ...deps,
        participant: { ...BASE_CONFIG, tools: { file_read: 'requires_approval' } },
      });
      const result = await ctx.callTool('file_read', {});
      expect(result.status).toBe('error');
      expect((result as any).error).toMatch(/requires_approval/i);
    });
  });

  describe('communicate', () => {
    it('calls messageRouter.send with correct sender, recipient, and message', async () => {
      const { dir: d, deps, mockRouter } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      await ctx.communicate('agent-b', 'hello there');
      expect(mockRouter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: 'svc-test',
          recipientId: 'agent-b',
          message: 'hello there',
        }),
      );
    });

    it('returns a CommunicateResult mapped from MessageRouterResult', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      const result = await ctx.communicate('agent-b', 'ping');
      expect(result.status).toBe('success');
      expect(result.response).toBe('router response');
    });

    it('passes replyTo when provided in opts', async () => {
      const { dir: d, deps, mockRouter } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      await ctx.communicate('agent-b', 'async task', { replyTo: 'op-1' });
      expect(mockRouter.send).toHaveBeenCalledWith(
        expect.objectContaining({ replyTo: 'op-1' }),
      );
    });

    it('uses supplied conversationId when provided', async () => {
      const { dir: d, deps, mockRouter } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      await ctx.communicate('agent-b', 'msg', { conversationId: 'conv-override' });
      expect(mockRouter.send).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-override' }),
      );
    });
  });

  describe('sleep', () => {
    it('resolves after the given number of milliseconds', async () => {
      const { dir: d, deps } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      const start = Date.now();
      await ctx.sleep(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });

    it('resolves early (without throwing) when the stopped signal fires', async () => {
      const { dir: d, deps, abortController } = await setup();
      dir = d;
      const ctx = new ServiceContextImpl(deps);
      // Abort after 20ms while sleep is waiting for 5000ms.
      setTimeout(() => abortController.abort(), 20);
      const start = Date.now();
      await ctx.sleep(5000);
      expect(Date.now() - start).toBeLessThan(300);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run packages/core/src/service/ServiceContextImpl.test.ts
```

Expected: FAIL — `Cannot find module './ServiceContextImpl.js'`.

- [ ] **Step 3: Implement ServiceContextImpl**

`packages/core/src/service/ServiceContextImpl.ts`:

```typescript
import type { ServiceConfig, ToolResult, WorkspaceConfig } from '@legion/types';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { Collective } from '../collective/Collective.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import type { EventBus } from '../events/EventBus.js';
import type { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { Storage } from '../storage/Storage.js';
import type { MessageRouterPort, ToolContext, ToolRegistryLike } from '../tools/Tool.js';
import type { ServiceManager } from './ServiceManager.js';
import type { CommunicateResult, ServiceContext } from './LegionService.js';

export interface ServiceContextDeps {
  participant: ServiceConfig;
  /** The active conversationId for this context instance. */
  conversationId: string;
  store: ConversationStore;
  collective: Collective;
  toolRegistry: ToolRegistryLike;
  workspaceConfig: WorkspaceConfig;
  eventBus: EventBus;
  /** Storage scoped to `.legion/services/<id>/` — exposed as `ServiceContext.storage`. */
  scopedStorage: Storage;
  /** Process-level raw storage — placed in `ToolContext.storage` for tool execution. */
  rawStorage: Storage;
  workspaceRoot: string;
  authEngine: AuthEngine;
  pendingApprovalRegistry: PendingApprovalRegistry;
  messageRouter: MessageRouterPort;
  stopped: AbortSignal;
  serviceManager: ServiceManager | undefined;
}

/**
 * Concrete implementation of `ServiceContext` (spec §5).
 *
 * Created fresh per-call by `ServiceManager`'s `makeContext` closure:
 *   - Startup context: `conversationId` = the service's startup conversation
 *   - Per-message context: `conversationId` = the incoming message's conversationId
 *
 * `callTool` builds a minimal `ToolContext` from deps and calls `AuthEngine.authorize`
 * before delegating to `ToolRegistry.execute`. The `ToolContext` index signature
 * (`[key: string]: unknown`) carries `authEngine`, `pendingApprovalRegistry`, and
 * `serviceManager` through to any tools that need them.
 */
export class ServiceContextImpl implements ServiceContext {
  constructor(private readonly deps: ServiceContextDeps) {}

  get participantId(): string {
    return this.deps.participant.id;
  }

  get stopped(): AbortSignal {
    return this.deps.stopped;
  }

  get storage(): Storage {
    return this.deps.scopedStorage;
  }

  get eventBus(): EventBus {
    return this.deps.eventBus;
  }

  async communicate(
    to: string,
    message: string,
    opts?: { conversationId?: string; replyTo?: string },
  ): Promise<CommunicateResult> {
    const result = await this.deps.messageRouter.send({
      senderId: this.deps.participant.id,
      recipientId: to,
      message,
      conversationId: opts?.conversationId ?? this.deps.conversationId,
      replyTo: opts?.replyTo,
      context: this.buildToolContext(),
    });
    return {
      conversationId: result.conversationId,
      response: result.response,
      status: result.status === 'dispatched'
        ? 'dispatched'
        : result.status === 'error'
          ? 'error'
          : 'success',
      error: result.error,
    };
  }

  async callTool(toolName: string, args: unknown): Promise<ToolResult> {
    const { participant, authEngine } = this.deps;

    const authResult = authEngine.authorize(participant.id, toolName, args, participant.tools);
    if (!authResult.authorized) {
      const reason =
        authResult.reason === 'requires_approval'
          ? 'requires_approval — no authority chain in service context (denied)'
          : (authResult.reason ?? 'denied');
      return { status: 'error', error: reason };
    }

    return this.deps.toolRegistry.execute(toolName, args, this.buildToolContext());
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const tid = setTimeout(resolve, ms);
      this.deps.stopped.addEventListener('abort', () => {
        clearTimeout(tid);
        resolve();
      });
    });
  }

  /**
   * Builds a minimal `ToolContext` for use in `communicate` and `callTool`.
   * The index signature on `ToolContext` (`[key: string]: unknown`) allows carrying
   * `authEngine`, `pendingApprovalRegistry`, and `serviceManager` through to tools.
   */
  private buildToolContext(): ToolContext {
    const {
      participant, conversationId, collective, workspaceConfig, eventBus, rawStorage,
      workspaceRoot, authEngine, pendingApprovalRegistry, messageRouter, serviceManager,
      toolRegistry,
    } = this.deps;

    return {
      participant,
      conversationId,
      collective,
      config: workspaceConfig,
      eventBus,
      storage: rawStorage,
      workspaceRoot,
      communicationDepth: 0,
      toolRegistry,
      messageRouter,
      authEngine,
      pendingApprovalRegistry,
      serviceManager,
    };
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run packages/core/src/service/ServiceContextImpl.test.ts
```

Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/service/ServiceContextImpl.ts packages/core/src/service/ServiceContextImpl.test.ts
git commit -m "feat(core): add ServiceContextImpl (callTool, communicate, sleep)"
```

---

## Task 5: ServiceManager

**Files:**
- Create: `packages/core/src/service/ServiceManager.ts`
- Create: `packages/core/src/service/ServiceManager.test.ts`

> Loads service modules by dynamic `import()`, manages the
> `stopped → starting → running → stopping → stopped | failed` lifecycle, and caches
> `ServiceRuntime` instances for the Plan 10 factory closure.
>
> Error handling policy (agreed in brainstorming):
>   - `start()` throws → status `'failed'`, emit `error` event, if `errorNotify` is set
>     send a message to that participant (fire-and-forget, failures swallowed).
>   - `stop()` throws → emit `error` event, transition to `'stopped'` anyway (abort was
>     already fired; the service is considered stopped).
>   - `onMessage()` throws → `ServiceRuntime` lets the exception propagate up to
>     `MessageRouter` which wraps it as an error result; does NOT change lifecycle state
>     (the service is still running after a handler error).

- [ ] **Step 1: Write the failing tests**

`packages/core/src/service/ServiceManager.test.ts`:

```typescript
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServiceConfig } from '@legion/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileStorage } from '../storage/FileStorage.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { MessageRouterPort } from '../tools/Tool.js';
import { ServiceManager, type ServiceManagerDeps } from './ServiceManager.js';

// A minimal ServiceConfig — override `module` per-test after writing the file.
const BASE_CONFIG: ServiceConfig = {
  id: 'svc-1',
  name: 'Test Service',
  type: 'service',
  module: '',       // filled in per-test
  tools: {},
  autoStart: false, // don't auto-start unless the test opts in
};

/** Write a simple ESM service module to disk and return its absolute path. */
async function writeModule(dir: string, src: string): Promise<string> {
  const path = join(dir, `svc-${Date.now()}.mjs`);
  await writeFile(path, src, 'utf8');
  return path;
}

/** Standard echo service: echoes message content in onMessage. */
const ECHO_SRC = `
export const service = {
  async start(_ctx) {},
  async stop() {},
  async onMessage(msg, _ctx) { return 'echo: ' + msg.content; },
};
`.trimStart();

/** Crashing service: throws in start(). */
const CRASH_SRC = `
export const service = {
  async start() { throw new Error('boot failure'); },
  async stop() {},
};
`.trimStart();

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'legion-svcmgr-'));
  const storage = new FileStorage(dir);
  const store = new FileConversationStore(storage);

  const mockRouter: MessageRouterPort = {
    send: vi.fn().mockResolvedValue({ conversationId: 'c1', status: 'success' }),
    resume: vi.fn(),
  };
  const eventBus = { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() } as any;
  const collective = {
    getOrThrow: vi.fn().mockReturnValue(BASE_CONFIG),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    listActive: vi.fn().mockReturnValue([]),
  } as any;
  const toolRegistry = { get: vi.fn(), has: vi.fn(), list: vi.fn(), execute: vi.fn() } as any;

  const deps: ServiceManagerDeps = {
    collective,
    store,
    toolRegistry,
    authEngine: new AuthEngine({ defaultPolicy: 'auto' }),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
    messageRouter: mockRouter,
    eventBus,
    storage,
    workspaceConfig: { version: '2' } as any,
    workspaceRoot: dir,
  };

  const manager = new ServiceManager(deps);
  return { dir, manager, mockRouter, eventBus };
}

describe('ServiceManager', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // ── loadService ──────────────────────────────────────────────────────────────

  it('loadService stores the runtime and sets status to stopped', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    expect(manager.getStatus('svc-1')).toBe('stopped');
    expect(manager.getRuntime('svc-1')).toBeDefined();
  });

  it('loadService throws ConfigError when the module lacks a service export', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, `export const notAService = {};`);
    await expect(manager.loadService({ ...BASE_CONFIG, module: modPath })).rejects.toThrow(
      /service.*export|named.*service/i,
    );
  });

  it('getRuntime throws ParticipantNotFoundError for an unloaded service', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    expect(() => manager.getRuntime('ghost')).toThrow(/ghost/);
  });

  // ── startService ─────────────────────────────────────────────────────────────

  it('startService transitions status to running', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.startService('svc-1');
    expect(manager.getStatus('svc-1')).toBe('running');
  });

  it('startService is idempotent when already running', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.startService('svc-1');
    await manager.startService('svc-1'); // second call — no throw
    expect(manager.getStatus('svc-1')).toBe('running');
  });

  it('marks service failed and emits error event when start() throws', async () => {
    const { manager, dir: d, eventBus } = await setup();
    dir = d;
    const modPath = await writeModule(d, CRASH_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.startService('svc-1'); // must not throw itself
    expect(manager.getStatus('svc-1')).toBe('failed');
    const info = manager.getAll().find((s) => s.participantId === 'svc-1');
    expect(info?.error).toMatch(/boot failure/);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ error: expect.objectContaining({ message: 'boot failure' }) }),
    );
  });

  it('sends errorNotify message when start() throws and errorNotify is set', async () => {
    const { manager, dir: d, mockRouter } = await setup();
    dir = d;
    const modPath = await writeModule(d, CRASH_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath, errorNotify: 'op-1' });
    await manager.startService('svc-1');
    expect(mockRouter.send).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: 'svc-1', recipientId: 'op-1' }),
    );
  });

  // ── stopService ──────────────────────────────────────────────────────────────

  it('stopService transitions status to stopped', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.startService('svc-1');
    expect(manager.getStatus('svc-1')).toBe('running');
    await manager.stopService('svc-1');
    expect(manager.getStatus('svc-1')).toBe('stopped');
  });

  it('stopService is idempotent when already stopped', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    await manager.stopService('svc-1'); // never started — still no throw
    expect(manager.getStatus('svc-1')).toBe('stopped');
  });

  // ── autoStart ────────────────────────────────────────────────────────────────

  it('autoStart starts services where autoStart is not false', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath, autoStart: true });
    await manager.autoStart();
    expect(manager.getStatus('svc-1')).toBe('running');
  });

  it('autoStart skips services where autoStart is explicitly false', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath, autoStart: false });
    await manager.autoStart();
    expect(manager.getStatus('svc-1')).toBe('stopped');
  });

  // ── getAll ───────────────────────────────────────────────────────────────────

  it('getAll returns ServiceInfo for every loaded service', async () => {
    const { manager, dir: d } = await setup();
    dir = d;
    const modPath = await writeModule(d, ECHO_SRC);
    await manager.loadService({ ...BASE_CONFIG, module: modPath });
    const all = manager.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ participantId: 'svc-1', status: 'stopped' });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run packages/core/src/service/ServiceManager.test.ts
```

Expected: FAIL — `Cannot find module './ServiceManager.js'`.

- [ ] **Step 3: Implement ServiceManager**

`packages/core/src/service/ServiceManager.ts`:

```typescript
import { isAbsolute, resolve } from 'node:path';
import type { ServiceConfig, WorkspaceConfig } from '@legion/types';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { Collective } from '../collective/Collective.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import type { EventBus } from '../events/EventBus.js';
import type { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { Storage } from '../storage/Storage.js';
import type { MessageRouterPort, ToolContext, ToolRegistryLike } from '../tools/Tool.js';
import { ConfigError, ParticipantNotFoundError } from '../errors/LegionError.js';
import type { LegionService, ServiceInfo, ServiceStatus } from './LegionService.js';
import { ServiceContextImpl, type ServiceContextDeps } from './ServiceContextImpl.js';
import { ServiceRuntime } from './ServiceRuntime.js';

export interface ServiceManagerDeps {
  collective: Collective;
  store: ConversationStore;
  toolRegistry: ToolRegistryLike;
  authEngine: AuthEngine;
  pendingApprovalRegistry: PendingApprovalRegistry;
  messageRouter: MessageRouterPort;
  eventBus: EventBus;
  storage: Storage;
  workspaceConfig: WorkspaceConfig;
  workspaceRoot: string;
}

interface ServiceEntry {
  config: ServiceConfig;
  service: LegionService;
  runtime: ServiceRuntime;
  abortController: AbortController;
  /** Factory stored on the entry so startService can reuse it for the startup context. */
  makeContext: (conversationId: string) => ServiceContextImpl;
  status: ServiceStatus;
  startupConversationId?: string;
  error?: string;
}

/**
 * Manages the lifecycle of all `service`-type participants (spec §5, §8 steps 8 & 10).
 *
 * Plan 10 wiring:
 *   1. Construct `ServiceManager`.
 *   2. Register the factory: `registry.registerFactory('service', (id) => manager.getRuntime(id))`.
 *   3. Call `loadService(config)` for each service participant.
 *   4. Call `autoStart()` after all services are loaded (startup step 10).
 */
export class ServiceManager {
  private readonly entries = new Map<string, ServiceEntry>();

  constructor(private readonly deps: ServiceManagerDeps) {}

  /**
   * Dynamically imports the service module, validates the named `service` export,
   * creates a `ServiceRuntime` backed by a `makeContext` factory, and stores the entry.
   * Status is `'stopped'` after this call. Call `startService(id)` to boot the service.
   */
  async loadService(config: ServiceConfig): Promise<void> {
    const modPath = isAbsolute(config.module)
      ? config.module
      : resolve(this.deps.workspaceRoot, config.module);

    const mod = (await import(modPath)) as Record<string, unknown>;
    const service = mod['service'] as LegionService | undefined;

    if (
      !service ||
      typeof service.start !== 'function' ||
      typeof service.stop !== 'function'
    ) {
      throw new ConfigError(
        `Service module '${config.module}' must export a named 'service' constant implementing LegionService ` +
          `(has start() and stop()).`,
      );
    }

    const abortController = new AbortController();
    const scopedStorage = this.deps.storage.scope(`services/${config.id}`);
    const manager = this;

    const makeContext = (conversationId: string): ServiceContextImpl => {
      const ctxDeps: ServiceContextDeps = {
        participant: config,
        conversationId,
        store: manager.deps.store,
        collective: manager.deps.collective,
        toolRegistry: manager.deps.toolRegistry,
        workspaceConfig: manager.deps.workspaceConfig,
        eventBus: manager.deps.eventBus,
        scopedStorage,
        rawStorage: manager.deps.storage,
        workspaceRoot: manager.deps.workspaceRoot,
        authEngine: manager.deps.authEngine,
        pendingApprovalRegistry: manager.deps.pendingApprovalRegistry,
        messageRouter: manager.deps.messageRouter,
        stopped: abortController.signal,
        serviceManager: manager,
      };
      return new ServiceContextImpl(ctxDeps);
    };

    const runtime = new ServiceRuntime(service, config, makeContext);

    this.entries.set(config.id, {
      config,
      service,
      runtime,
      abortController,
      makeContext,
      status: 'stopped',
    });
  }

  /**
   * Creates a persistent startup conversation, calls `service.start()` with a context
   * bound to it, and transitions status to `'running'`.
   *
   * On failure: transitions to `'failed'`, emits `error` event, and — if `errorNotify`
   * is configured — sends a message to that participant (fire-and-forget; failures swallowed).
   */
  async startService(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new ParticipantNotFoundError(id);
    if (entry.status === 'running') return;

    entry.status = 'starting';
    entry.error = undefined;

    // A real conversation gives callTool / communicate a durable context for startup work.
    const startupConv = await this.deps.store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      title: `Service startup: ${id}`,
    });
    entry.startupConversationId = startupConv.id;

    const ctx = entry.makeContext(startupConv.id);

    try {
      await entry.service.start(ctx);
      entry.status = 'running';
    } catch (rawErr) {
      const err = rawErr as Error;
      entry.status = 'failed';
      entry.error = err.message;

      this.deps.eventBus.emit('error', {
        conversationId: startupConv.id,
        error: { name: err.name, message: err.message },
      });

      if (entry.config.errorNotify) {
        try {
          await this.deps.messageRouter.send({
            senderId: id,
            recipientId: entry.config.errorNotify,
            message: `Service '${id}' failed to start: ${err.message}`,
            context: this.buildBaseToolContext(id, startupConv.id),
          });
        } catch {
          // Notification failures must not mask the service error state.
        }
      }
    }
  }

  /**
   * Aborts the service's stopped signal and calls `service.stop()`.
   * Errors from `stop()` are emitted as `error` events but do not prevent
   * status transitioning to `'stopped'`.
   */
  async stopService(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new ParticipantNotFoundError(id);
    if (entry.status === 'stopped') return;

    entry.status = 'stopping';
    entry.abortController.abort();

    try {
      await entry.service.stop();
    } catch (rawErr) {
      const err = rawErr as Error;
      this.deps.eventBus.emit('error', {
        error: { name: err.name, message: err.message },
      });
    }

    entry.status = 'stopped';
  }

  /**
   * Starts all loaded services whose `autoStart` is not explicitly `false`.
   * Called by Plan 10 after `loadService()` has been called for all participants
   * (startup sequence step 10).
   */
  async autoStart(): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.config.autoStart !== false && entry.status === 'stopped') {
        await this.startService(id);
      }
    }
  }

  /**
   * Returns the cached `ServiceRuntime` for the given participant ID.
   * Used by the Plan 10 factory closure:
   *   `registry.registerFactory('service', (id) => manager.getRuntime(id))`
   */
  getRuntime(id: string): ServiceRuntime {
    const entry = this.entries.get(id);
    if (!entry) throw new ParticipantNotFoundError(id);
    return entry.runtime;
  }

  getStatus(id: string): ServiceStatus | undefined {
    return this.entries.get(id)?.status;
  }

  getAll(): ServiceInfo[] {
    return [...this.entries.values()].map((e) => ({
      participantId: e.config.id,
      status: e.status,
      error: e.error,
    }));
  }

  /**
   * Builds a minimal `ToolContext` for `messageRouter.send()` in error notifications.
   * Only used internally; `senderId` is always the failing service's ID.
   */
  private buildBaseToolContext(participantId: string, conversationId: string): ToolContext {
    const config = this.deps.collective.getOrThrow(participantId);
    return {
      participant: config,
      conversationId,
      collective: this.deps.collective,
      config: this.deps.workspaceConfig,
      eventBus: this.deps.eventBus,
      storage: this.deps.storage,
      workspaceRoot: this.deps.workspaceRoot,
      communicationDepth: 0,
      toolRegistry: this.deps.toolRegistry,
      messageRouter: this.deps.messageRouter,
      authEngine: this.deps.authEngine,
      pendingApprovalRegistry: this.deps.pendingApprovalRegistry,
    };
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run packages/core/src/service/ServiceManager.test.ts
```

Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/service/ServiceManager.ts packages/core/src/service/ServiceManager.test.ts
git commit -m "feat(core): add ServiceManager (load, start, stop, autoStart, errorNotify)"
```

---

## Task 6: Integration test + barrel exports

**Files:**
- Create: `packages/core/src/service/service.integration.test.ts`
- Modify: `packages/core/src/index.ts`

> End-to-end combined flow: `ServiceManager.loadService()` → `startService()` →
> `ServiceRuntime.handle()` → `stopService()`. Uses real `FileStorage`, real
> `FileConversationStore`, real `AuthEngine`, and a real on-disk ESM service module.
> Validates that all the pieces wire together correctly.

- [ ] **Step 1: Write the integration test**

`packages/core/src/service/service.integration.test.ts`:

```typescript
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MessageData, ServiceConfig } from '@legion/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileStorage } from '../storage/FileStorage.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { MessageRouterPort } from '../tools/Tool.js';
import { ServiceManager } from './ServiceManager.js';

describe('Service SDK integration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-svc-int-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('full lifecycle: load → start → handle message → stop', async () => {
    // ── Write a real service module to disk ────────────────────────────────────
    const modPath = join(dir, 'echo-service.mjs');
    await writeFile(
      modPath,
      `
export const service = {
  started: false,
  stopped: false,
  async start(_ctx) { this.started = true; },
  async stop() { this.stopped = true; },
  async onMessage(msg, _ctx) {
    return 'Echo from service: ' + msg.content;
  },
};
`.trimStart(),
    );

    // ── Assemble real dependencies ─────────────────────────────────────────────
    const storage = new FileStorage(dir);
    const store = new FileConversationStore(storage);
    const authEngine = new AuthEngine({ defaultPolicy: 'auto' });
    const pendingApprovalRegistry = new PendingApprovalRegistry();
    const eventBus = { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() } as any;

    const mockRouter: MessageRouterPort = {
      send: vi.fn().mockResolvedValue({ conversationId: 'c1', status: 'success' }),
      resume: vi.fn(),
    };

    const collective = {
      getOrThrow: vi.fn().mockReturnValue({ id: 'svc-echo', type: 'service', tools: {} }),
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      listActive: vi.fn().mockReturnValue([]),
    } as any;

    const toolRegistry = {
      get: vi.fn().mockReturnValue(undefined),
      has: vi.fn().mockReturnValue(false),
      list: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockResolvedValue({ status: 'error', error: 'not found' }),
    } as any;

    const manager = new ServiceManager({
      collective,
      store,
      toolRegistry,
      authEngine,
      pendingApprovalRegistry,
      messageRouter: mockRouter,
      eventBus,
      storage,
      workspaceConfig: { version: '2' } as any,
      workspaceRoot: dir,
    });

    const config: ServiceConfig = {
      id: 'svc-echo',
      name: 'Echo Service',
      type: 'service',
      module: modPath,
      tools: {},
      autoStart: false,
    };

    // ── Load and start ─────────────────────────────────────────────────────────
    await manager.loadService(config);
    expect(manager.getStatus('svc-echo')).toBe('stopped');

    await manager.startService('svc-echo');
    expect(manager.getStatus('svc-echo')).toBe('running');

    // ── Dispatch a message via the ServiceRuntime ──────────────────────────────
    const runtime = manager.getRuntime('svc-echo');

    const conv = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    const incomingMsg: MessageData = {
      id: 'msg-1',
      parentId: null,
      conversationId: conv.id,
      senderId: 'op-1',
      recipientId: 'svc-echo',
      role: 'user',
      content: 'integration test ping',
      status: 'active',
      timestamp: new Date().toISOString(),
    };

    const result = await runtime.handle(incomingMsg, {} as any);
    expect(result).toEqual({
      kind: 'response',
      content: 'Echo from service: integration test ping',
    });

    // ── Stop ───────────────────────────────────────────────────────────────────
    await manager.stopService('svc-echo');
    expect(manager.getStatus('svc-echo')).toBe('stopped');

    // ── getAll reflects final state ────────────────────────────────────────────
    const all = manager.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ participantId: 'svc-echo', status: 'stopped' });
  });

  it('service without onMessage declines inbound messages gracefully', async () => {
    const modPath = join(dir, 'silent-service.mjs');
    await writeFile(
      modPath,
      `export const service = { async start() {}, async stop() {} };\n`,
    );

    const storage = new FileStorage(dir);
    const store = new FileConversationStore(storage);

    const manager = new ServiceManager({
      collective: { getOrThrow: vi.fn(), get: vi.fn(), list: vi.fn(), listActive: vi.fn().mockReturnValue([]) } as any,
      store,
      toolRegistry: { get: vi.fn(), has: vi.fn(), list: vi.fn(), execute: vi.fn() } as any,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
      messageRouter: { send: vi.fn(), resume: vi.fn() } as any,
      eventBus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() } as any,
      storage,
      workspaceConfig: { version: '2' } as any,
      workspaceRoot: dir,
    });

    await manager.loadService({
      id: 'svc-silent',
      name: 'Silent',
      type: 'service',
      module: modPath,
      tools: {},
    });
    await manager.startService('svc-silent');

    const runtime = manager.getRuntime('svc-silent');
    const result = await runtime.handle(
      {
        id: 'msg-1', parentId: null, conversationId: 'c1', senderId: 'op-1',
        recipientId: 'svc-silent', role: 'user', content: 'hi', status: 'active',
        timestamp: new Date().toISOString(),
      },
      {} as any,
    );
    expect(result.kind).toBe('response');
    expect((result as any).content).toMatch(/does not accept/i);
  });
});
```

- [ ] **Step 2: Run the integration tests to confirm they fail**

```bash
npx vitest run packages/core/src/service/service.integration.test.ts
```

Expected: FAIL — `Cannot find module './ServiceManager.js'` (barrel not exported yet) or import errors. This confirms the test is wired correctly before the barrel is added.

- [ ] **Step 3: Add service barrel exports to `packages/core/src/index.ts`**

Append to `packages/core/src/index.ts`:

```typescript
export * from './service/LegionService.js';
export * from './service/ServiceContextImpl.js';
export * from './service/ServiceRuntime.js';
export * from './service/ServiceManager.js';
```

- [ ] **Step 4: Run the full service test suite**

```bash
npx vitest run packages/core/src/service/
```

Expected: all tests in `LegionService.test.ts`, `ServiceRuntime.test.ts`, `ServiceContextImpl.test.ts`, `ServiceManager.test.ts`, and `service.integration.test.ts` pass.

- [ ] **Step 5: Run the full core test suite to check for regressions**

```bash
npx vitest run packages/core/
```

Expected: all existing tests still pass.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --build packages/core/tsconfig.json
```

Expected: exits 0 with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/service/service.integration.test.ts packages/core/src/index.ts
git commit -m "feat(core): Service SDK integration test + barrel exports"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task covering it |
|-----------------|-----------------|
| §5 `LegionService` interface (`start`, `stop`, `onMessage?`) | Task 1 |
| §5 `ServiceContext` (`participantId`, `stopped`, `storage`, `eventBus`, `communicate`, `callTool`, `sleep`) | Tasks 1, 4 |
| §5 `IncomingMessage` shape | Task 1 |
| §5 `CommunicateResult` shape | Task 1 |
| §5 `ServiceContext.storage` scoped to `.legion/services/<id>/` | Tasks 4, 5 |
| §1 `ServiceConfig.canReceive` respected | Task 3 (`ServiceRuntime`) |
| §1 `ServiceConfig.autoStart` respected | Task 5 (`autoStart()`) |
| §7 "all authorized identically" — `callTool` goes through `AuthEngine` | Task 4 |
| §8 step 8 "Create ServiceManager, load all service modules" | Task 5 |
| §8 step 10 "Auto-start services with `autoStart: true`" | Task 5 (`autoStart()`) |
| §4 `RuntimeContext.serviceManager` typed concretely | Task 2 |
| Named `service` export convention | Task 1 (documented), Task 5 (enforced in `loadService`) |
| Error notification (`errorNotify`) | Task 2 (field), Task 5 (notification) |
| Full lifecycle states (starting/running/stopping/stopped/failed) | Task 1 (`ServiceStatus`), Task 5 |
| `sleep` honors abort signal | Task 4 |
| `requires_approval` fails closed in service context | Task 4 |
| Startup conversation created for `start()` context | Task 5 |
| `getRuntime(id)` for Plan 10 factory closure | Task 5 |

### Key design decisions to carry into Plan 9 / Plan 10

- **Plan 10 factory registration (step 4):** `registry.registerFactory('service', (id) => manager.getRuntime(id))`. Must happen before `loadService()` calls, but `ServiceManager` is constructed first so the factory closure can capture `manager`.
- **`onMessage` throws:** propagates up through `ServiceRuntime.handle()` to `MessageRouter`, which wraps it as an error result and persists it. Does NOT change service lifecycle status.
- **`RuntimeContext.serviceManager` inline import type:** avoids a circular declaration chain — see Task 2 Step 3 comment.
- **`autoStart` default:** `undefined` (absent) means auto-start (`autoStart !== false`), not `autoStart === true`. Matches spec "default: true".
