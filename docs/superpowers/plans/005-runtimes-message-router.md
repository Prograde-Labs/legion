# Runtimes & MessageRouter (Mock Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire participants together into a working message loop: the `Runtime` abstraction, `RuntimeContext`, `RuntimeRegistry`, `MockRuntime`, the `communicate` tool, and the `MessageRouter` (synchronous + fire-and-forget). End state: an **end-to-end mock conversation loop** fully exercised by integration tests with zero external dependencies.

**Architecture:** `MessageRouter` is the central dispatch (spec §3) — it loads/creates a conversation, persists the inbound message, resolves the recipient's runtime via `RuntimeRegistry`, invokes it with a `RuntimeContext`, persists the response, and returns. With `replyTo` set, it dispatches in the background and routes the response to the `replyTo` participant. `MockRuntime` returns scripted responses. The `communicate` tool calls `MessageRouter.send`, making agent↔agent (and tool-driven) messaging work. All of this lives in `@legion-collective/core` (the engine). Depends on Plans 1–4.

**Tech Stack:** `@legion-collective/core`, Vitest.

---

## File Structure

```
packages/core/src/runtime/
  Runtime.ts                — Runtime interface, RuntimeContext, RuntimeResult
  RuntimeRegistry.ts        — type -> factory -> Runtime
  RuntimeRegistry.test.ts
  MockRuntime.ts            — scripted responses
  MockRuntime.test.ts
  UserDeliveryRuntime.ts    — no-driver delivery (connector wiring lands in Plan 10)
  MessageRouter.ts          — central dispatch (sync + fire-and-forget)
  MessageRouter.test.ts
  mock-loop.integration.test.ts
packages/core/src/tools/
  communicate-tool.ts       — communicate tool over MessageRouter
  communicate-tool.test.ts
```

All exported from `packages/core/src/index.ts`.

---

## Task 1: Runtime interface + RuntimeContext + RuntimeRegistry

**Files:**

- Create: `packages/core/src/runtime/Runtime.ts`
- Create: `packages/core/src/runtime/RuntimeRegistry.ts`
- Test: `packages/core/src/runtime/RuntimeRegistry.test.ts`

- [ ] **Step 1: Create `Runtime.ts`** (types only)

```typescript
import type { MessageData, ParticipantType } from '@legion-collective/types';
import type { ToolContext } from '../tools/Tool.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { MessageRouterPort } from '../tools/Tool.js';

/**
 * Full execution context (spec §4). Extends ToolContext, tightening the runtime-only
 * collaborators to required and concrete.
 */
export interface RuntimeContext extends ToolContext {
  conversation: ConversationThread;
  authEngine: AuthEngine;
  pendingApprovalRegistry: PendingApprovalRegistry;
  messageRouter: MessageRouterPort;
  serviceManager?: unknown;
}

/** A runtime handles an inbound message addressed to its participant. */
export interface Runtime {
  /** Returns the response content, or void/undefined if the participant produces no reply. */
  handle(incoming: MessageData, context: RuntimeContext): Promise<string | void>;
}

/** Builds a Runtime instance bound to a specific participant. */
export type RuntimeFactory = (participantId: string) => Runtime;

export type { ParticipantType };
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/runtime/RuntimeRegistry.test.ts`:

```typescript
import { RuntimeRegistry } from './RuntimeRegistry.js';
import type { Runtime } from './Runtime.js';

const stubRuntime: Runtime = {
  async handle() {
    return 'ok';
  },
};

describe('RuntimeRegistry', () => {
  it('registers a factory per participant type and builds runtimes', () => {
    const reg = new RuntimeRegistry();
    reg.registerFactory('mock', () => stubRuntime);
    expect(reg.has('mock')).toBe(true);
    expect(reg.build('mock', 'mock-1')).toBe(stubRuntime);
  });

  it('throws building a runtime for an unregistered type', () => {
    const reg = new RuntimeRegistry();
    expect(() => reg.build('agent', 'agent-1')).toThrow(/no runtime factory/i);
  });

  it('rejects duplicate factory registration', () => {
    const reg = new RuntimeRegistry();
    reg.registerFactory('mock', () => stubRuntime);
    expect(() => reg.registerFactory('mock', () => stubRuntime)).toThrow(/already/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/runtime/RuntimeRegistry.test.ts`
Expected: FAIL — `Cannot find module './RuntimeRegistry.js'`.

- [ ] **Step 4: Write minimal implementation**

`packages/core/src/runtime/RuntimeRegistry.ts`:

```typescript
import type { ParticipantType } from '@legion-collective/types';
import { ConflictError, LegionError } from '../errors/LegionError.js';
import type { Runtime, RuntimeFactory } from './Runtime.js';

export class RuntimeRegistry {
  private factories = new Map<ParticipantType, RuntimeFactory>();

  registerFactory(type: ParticipantType, factory: RuntimeFactory): void {
    if (this.factories.has(type)) {
      throw new ConflictError(`Runtime factory already registered for type: ${type}`);
    }
    this.factories.set(type, factory);
  }

  has(type: ParticipantType): boolean {
    return this.factories.has(type);
  }

  build(type: ParticipantType, participantId: string): Runtime {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new LegionError(`No runtime factory for type: ${type}`, 'RUNTIME_FACTORY_MISSING');
    }
    return factory(participantId);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/runtime/RuntimeRegistry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/Runtime.ts packages/core/src/runtime/RuntimeRegistry.ts packages/core/src/runtime/RuntimeRegistry.test.ts
git commit -m "feat(core): add Runtime interface and RuntimeRegistry"
```

---

## Task 2: MockRuntime

**Files:**

- Create: `packages/core/src/runtime/MockRuntime.ts`
- Test: `packages/core/src/runtime/MockRuntime.test.ts`

> Spec §1: `mock` participants return scripted responses, cycling. The runtime reads the
> participant's `responses` from the collective in the context.

- [ ] **Step 1: Write the failing test**

`packages/core/src/runtime/MockRuntime.test.ts`:

```typescript
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { MockRuntime } from './MockRuntime.js';
import type { RuntimeContext } from './Runtime.js';
import type { MessageData } from '@legion-collective/types';

async function ctxFor(responses: string[]): Promise<RuntimeContext> {
  const storage = new MemoryStorage();
  await storage.writeJson('collective/participants/mock-1.json', {
    id: 'mock-1',
    name: 'Mock',
    type: 'mock',
    tools: {},
    responses,
    status: 'active',
  });
  const collective = await Collective.load(storage);
  return {
    participant: collective.getOrThrow('mock-1'),
    collective,
    conversationId: 'c1',
  } as unknown as RuntimeContext;
}

const inbound: MessageData = {
  id: 'm1',
  parentId: null,
  conversationId: 'c1',
  senderId: 'op',
  recipientId: 'mock-1',
  role: 'user',
  content: 'hi',
  status: 'active',
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('MockRuntime', () => {
  it('returns scripted responses in order then cycles', async () => {
    const runtime = new MockRuntime('mock-1');
    const context = await ctxFor(['one', 'two']);
    expect(await runtime.handle(inbound, context)).toBe('one');
    expect(await runtime.handle(inbound, context)).toBe('two');
    expect(await runtime.handle(inbound, context)).toBe('one');
  });

  it('returns a default acknowledgement when no responses are configured', async () => {
    const runtime = new MockRuntime('mock-1');
    const context = await ctxFor([]);
    expect(await runtime.handle(inbound, context)).toBe('[mock:mock-1] no scripted response');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/runtime/MockRuntime.test.ts`
Expected: FAIL — `Cannot find module './MockRuntime.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/runtime/MockRuntime.ts`:

```typescript
import type { MessageData, MockConfig } from '@legion-collective/types';
import type { Runtime, RuntimeContext } from './Runtime.js';

export class MockRuntime implements Runtime {
  private index = 0;

  constructor(private participantId: string) {}

  async handle(_incoming: MessageData, context: RuntimeContext): Promise<string> {
    const participant = context.collective.getOrThrow(this.participantId);
    const responses = participant.type === 'mock' ? (participant as MockConfig).responses : [];
    if (responses.length === 0) {
      return `[mock:${this.participantId}] no scripted response`;
    }
    const response = responses[this.index % responses.length];
    this.index += 1;
    return response;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/runtime/MockRuntime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/MockRuntime.ts packages/core/src/runtime/MockRuntime.test.ts
git commit -m "feat(core): add MockRuntime"
```

---

## Task 3: UserDeliveryRuntime

**Files:**

- Create: `packages/core/src/runtime/UserDeliveryRuntime.ts`

> Spec §8 step 4: `user` → delivery runtime (routes to connector). Connector wiring is
> Plan 10. Here it is a no-driver runtime: it produces no reply and emits `message:delivered`.

- [ ] **Step 1: Create the implementation**

`packages/core/src/runtime/UserDeliveryRuntime.ts`:

```typescript
import type { MessageData } from '@legion-collective/types';
import type { Runtime, RuntimeContext } from './Runtime.js';

export class UserDeliveryRuntime implements Runtime {
  constructor(private participantId: string) {}

  async handle(incoming: MessageData, context: RuntimeContext): Promise<void> {
    // No internal driver. Persistence already happened in the router; signal delivery.
    // Plan 10 replaces this with ConnectorRegistry-based delivery.
    context.eventBus.emit('message:delivered', {
      conversationId: context.conversationId,
      recipientId: this.participantId,
      messageId: incoming.id,
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/runtime/UserDeliveryRuntime.ts
git commit -m "feat(core): add UserDeliveryRuntime placeholder"
```

---

## Task 4: MessageRouter — synchronous send

**Files:**

- Create: `packages/core/src/runtime/MessageRouter.ts`
- Test: `packages/core/src/runtime/MessageRouter.test.ts`

> Spec §3 synchronous path: acquire conversation, append inbound, dispatch to recipient
> runtime (await), append response, return. `MessageRouter` implements `MessageRouterPort`
> (Plan 4) so the `communicate` tool can call it.

- [ ] **Step 1: Write the failing test**

`packages/core/src/runtime/MessageRouter.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { Collective } from '../collective/Collective.js';
import { EventBus } from '../events/EventBus.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { MockRuntime } from './MockRuntime.js';
import { MessageRouter } from './MessageRouter.js';
import type { ToolContext } from '../tools/Tool.js';

async function setup(dir: string) {
  const storage = new FileStorage(dir);
  await storage.writeJson('collective/participants/op.json', {
    id: 'op',
    name: 'Op',
    type: 'user',
    tools: {},
    status: 'active',
  });
  await storage.writeJson('collective/participants/mock-1.json', {
    id: 'mock-1',
    name: 'Mock',
    type: 'mock',
    tools: {},
    responses: ['hello back'],
    status: 'active',
  });
  const collective = await Collective.load(storage);
  const store = new FileConversationStore(storage);
  const eventBus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', (id) => new MockRuntime(id));
  const router = new MessageRouter(store, registry, collective, eventBus);

  const baseContext = {
    collective,
    config: { version: '2' },
    eventBus,
    storage,
    workspaceRoot: dir,
    communicationDepth: 0,
    toolRegistry: new ToolRegistry(),
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
  } as unknown as ToolContext;

  return { collective, store, eventBus, router, baseContext };
}

describe('MessageRouter: synchronous send', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('routes a message to a mock and returns its response', async () => {
    const { router, baseContext, store } = await setup(dir);
    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });
    expect(result.status).toBe('success');
    expect(result.response).toBe('hello back');
    expect(result.conversationId).toMatch(/^conv-/);

    const conv = await store.load(result.conversationId);
    const contents = Object.values(conv!.messages)
      .map((m) => m.content)
      .sort();
    expect(contents).toEqual(['hello', 'hello back']);
  });

  it('continues an existing conversation when conversationId is supplied', async () => {
    const { router, baseContext } = await setup(dir);
    const first = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'one',
      context: baseContext,
    });
    const second = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'two',
      conversationId: first.conversationId,
      context: baseContext,
    });
    expect(second.conversationId).toBe(first.conversationId);
  });

  it('returns an error result for an unknown recipient', async () => {
    const { router, baseContext } = await setup(dir);
    const result = await router.send({
      senderId: 'op',
      recipientId: 'ghost',
      message: 'x',
      context: baseContext,
    });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/ghost/);
  });

  it('emits message:sent for inbound and response', async () => {
    const { router, baseContext, eventBus } = await setup(dir);
    let sent = 0;
    eventBus.on('message:sent', () => (sent += 1));
    await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      context: baseContext,
    });
    expect(sent).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: FAIL — `Cannot find module './MessageRouter.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/runtime/MessageRouter.ts`:

```typescript
import type { ConversationStore } from '../conversation/ConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import type { Collective } from '../collective/Collective.js';
import type { EventBus } from '../events/EventBus.js';
import type { ToolContext, MessageRouterPort, MessageRouterResult } from '../tools/Tool.js';
import { ParticipantNotFoundError } from '../errors/LegionError.js';
import type { RuntimeRegistry } from './RuntimeRegistry.js';
import type { RuntimeContext } from './Runtime.js';

export interface SendOptions {
  senderId: string;
  recipientId: string;
  message: string;
  conversationId?: string;
  replyTo?: string;
  context: ToolContext;
}

const DEFAULT_DEPTH_LIMIT = 10;

export class MessageRouter implements MessageRouterPort {
  private background = new Set<Promise<void>>();

  constructor(
    private store: ConversationStore,
    private registry: RuntimeRegistry,
    private collective: Collective,
    private eventBus: EventBus,
  ) {}

  /** Await all in-flight fire-and-forget dispatches (test/shutdown aid). */
  async drain(): Promise<void> {
    await Promise.all([...this.background]);
  }

  private async getThread(conversationId?: string): Promise<ConversationThread> {
    if (conversationId) {
      const existing = await this.store.load(conversationId);
      if (existing) return new ConversationThread(existing, this.store);
    }
    const created = await this.store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    this.eventBus.emit('conversation:created', { conversationId: created.id });
    return new ConversationThread(created, this.store);
  }

  async send(opts: SendOptions): Promise<MessageRouterResult> {
    const recipient = this.collective.get(opts.recipientId);
    if (!recipient) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: new ParticipantNotFoundError(opts.recipientId).message,
      };
    }

    const depth = opts.context.communicationDepth ?? 0;
    if (depth > DEFAULT_DEPTH_LIMIT) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: `Communication depth limit exceeded (${DEFAULT_DEPTH_LIMIT})`,
      };
    }

    const thread = await this.getThread(opts.conversationId);

    const inbound = await thread.append({
      senderId: opts.senderId,
      recipientId: opts.recipientId,
      role: 'user',
      content: opts.message,
      replyTo: opts.replyTo,
    });
    this.eventBus.emit('message:sent', {
      conversationId: thread.id,
      senderId: opts.senderId,
      recipientId: opts.recipientId,
      messageId: inbound.id,
    });

    const runtime = this.registry.build(recipient.type, recipient.id);
    const runtimeContext: RuntimeContext = {
      ...(opts.context as RuntimeContext),
      participant: recipient,
      conversationId: thread.id,
      conversation: thread,
      communicationDepth: depth,
      messageRouter: this,
    };

    if (opts.replyTo) {
      const task = this.dispatchAsync(runtime, inbound, runtimeContext, thread, opts);
      this.background.add(task);
      void task.finally(() => this.background.delete(task));
      return { conversationId: thread.id, status: 'dispatched' };
    }

    const response = await runtime.handle(inbound, runtimeContext);
    if (typeof response === 'string') {
      const responseMsg = await thread.append({
        senderId: opts.recipientId,
        recipientId: opts.senderId,
        role: 'assistant',
        content: response,
      });
      this.eventBus.emit('message:sent', {
        conversationId: thread.id,
        senderId: opts.recipientId,
        recipientId: opts.senderId,
        messageId: responseMsg.id,
      });
      return { conversationId: thread.id, response, status: 'success' };
    }
    return { conversationId: thread.id, status: 'success' };
  }

  private async dispatchAsync(
    runtime: ReturnType<RuntimeRegistry['build']>,
    inbound: Awaited<ReturnType<ConversationThread['append']>>,
    runtimeContext: RuntimeContext,
    thread: ConversationThread,
    opts: SendOptions,
  ): Promise<void> {
    const response = await runtime.handle(inbound, runtimeContext);
    if (typeof response !== 'string') return;
    // Route the response to the replyTo participant (spec §3).
    const replyTarget = opts.replyTo!;
    const responseMsg = await thread.append({
      senderId: opts.recipientId,
      recipientId: replyTarget,
      role: 'assistant',
      content: response,
    });
    this.eventBus.emit('message:delivered', {
      conversationId: thread.id,
      recipientId: replyTarget,
      messageId: responseMsg.id,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat(core): add MessageRouter synchronous send"
```

---

## Task 5: MessageRouter — fire-and-forget

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.test.ts` (add cases)

> The fire-and-forget code path was implemented in Task 4 (`replyTo` branch + `dispatchAsync`).
> This task adds the tests that lock its behaviour.

- [ ] **Step 1: Add the failing test**

Append to `MessageRouter.test.ts`:

```typescript
describe('MessageRouter: fire-and-forget', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-faf-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns dispatched immediately and routes the response to replyTo', async () => {
    const { router, baseContext, store, eventBus } = await setup(dir);
    let delivered: { recipientId: string } | null = null;
    eventBus.on('message:delivered', (p) => (delivered = { recipientId: p.recipientId }));

    const result = await router.send({
      senderId: 'svc',
      recipientId: 'mock-1',
      message: 'analyze',
      replyTo: 'op',
      context: baseContext,
    });
    expect(result.status).toBe('dispatched');
    expect(result.response).toBeUndefined();

    await router.drain();

    expect(delivered).toEqual({ recipientId: 'op' });
    const conv = await store.load(result.conversationId);
    const toOp = Object.values(conv!.messages).find(
      (m) => m.recipientId === 'op' && m.role === 'assistant',
    );
    expect(toOp?.content).toBe('hello back');
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes)**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "fire-and-forget"`
Expected: PASS — implemented in Task 4. If it FAILS, fix `dispatchAsync`/`replyTo` branch until green.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/runtime/MessageRouter.test.ts
git commit -m "test(core): cover MessageRouter fire-and-forget"
```

---

## Task 6: communicate tool

**Files:**

- Create: `packages/core/src/tools/communicate-tool.ts`
- Test: `packages/core/src/tools/communicate-tool.test.ts`

> Spec §3: the primary participant-to-participant send. Calls `context.messageRouter.send`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/tools/communicate-tool.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { Collective } from '../collective/Collective.js';
import { EventBus } from '../events/EventBus.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ToolRegistry } from './ToolRegistry.js';
import { RuntimeRegistry } from '../runtime/RuntimeRegistry.js';
import { MockRuntime } from '../runtime/MockRuntime.js';
import { MessageRouter } from '../runtime/MessageRouter.js';
import { communicateTool } from './communicate-tool.js';
import type { ToolContext } from './Tool.js';

async function setup(dir: string) {
  const storage = new FileStorage(dir);
  await storage.writeJson('collective/participants/agent-a.json', {
    id: 'agent-a',
    name: 'A',
    type: 'mock',
    tools: { communicate: 'auto' },
    responses: [],
    status: 'active',
  });
  await storage.writeJson('collective/participants/agent-b.json', {
    id: 'agent-b',
    name: 'B',
    type: 'mock',
    tools: {},
    responses: ['B replies'],
    status: 'active',
  });
  const collective = await Collective.load(storage);
  const store = new FileConversationStore(storage);
  const eventBus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', (id) => new MockRuntime(id));
  const router = new MessageRouter(store, registry, collective, eventBus);

  const context = {
    participant: collective.getOrThrow('agent-a'),
    conversationId: 'seed',
    collective,
    config: { version: '2' },
    eventBus,
    storage,
    workspaceRoot: dir,
    communicationDepth: 0,
    toolRegistry: new ToolRegistry(),
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
    messageRouter: router,
  } as unknown as ToolContext;

  return { context, router };
}

describe('communicate tool', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-comm-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends a synchronous message and returns the recipient response', async () => {
    const { context } = await setup(dir);
    const result = await communicateTool.execute({ to: 'agent-b', message: 'hi B' }, context);
    expect(result.status).toBe('success');
    expect((result.data as { response: string }).response).toBe('B replies');
  });

  it('returns dispatched for fire-and-forget', async () => {
    const { context, router } = await setup(dir);
    const result = await communicateTool.execute(
      { to: 'agent-b', message: 'async', replyTo: 'agent-a' },
      context,
    );
    expect(result.status).toBe('success');
    expect((result.data as { status: string }).status).toBe('dispatched');
    await router.drain();
  });

  it('returns a tool error when messageRouter is missing', async () => {
    const { context } = await setup(dir);
    const broken = { ...context, messageRouter: undefined } as unknown as ToolContext;
    const result = await communicateTool.execute({ to: 'agent-b', message: 'x' }, broken);
    expect(result.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/communicate-tool.test.ts`
Expected: FAIL — `Cannot find module './communicate-tool.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/tools/communicate-tool.ts`:

```typescript
import type { JSONSchema, ToolResult } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';

export const communicateTool: Tool = {
  name: 'communicate',
  description:
    'Send a message to another participant. Synchronous by default; pass replyTo to fire-and-forget.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target participant id' },
      message: { type: 'string' },
      conversationId: { type: 'string', description: 'Join an existing thread' },
      replyTo: { type: 'string', description: 'Route the response to this participant instead' },
    },
    required: ['to', 'message'],
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    const { to, message, conversationId, replyTo } = args as {
      to: string;
      message: string;
      conversationId?: string;
      replyTo?: string;
    };
    if (!context.messageRouter) {
      return { status: 'error', error: 'messageRouter unavailable in context' };
    }
    const result = await context.messageRouter.send({
      senderId: context.participant.id,
      recipientId: to,
      message,
      conversationId: conversationId ?? context.conversationId,
      replyTo,
      context: { ...context, communicationDepth: (context.communicationDepth ?? 0) + 1 },
    });
    if (result.status === 'error') {
      return { status: 'error', error: result.error };
    }
    return {
      status: 'success',
      data: {
        conversationId: result.conversationId,
        response: result.response,
        status: result.status,
      },
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/communicate-tool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Export runtime + communicate from the core barrel**

Append to `packages/core/src/index.ts`:

```typescript
export * from './runtime/Runtime.js';
export * from './runtime/RuntimeRegistry.js';
export * from './runtime/MockRuntime.js';
export * from './runtime/UserDeliveryRuntime.js';
export * from './runtime/MessageRouter.js';
export * from './tools/communicate-tool.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/communicate-tool.ts packages/core/src/tools/communicate-tool.test.ts packages/core/src/index.ts
git commit -m "feat(core): add communicate tool over MessageRouter"
```

---

## Task 7: End-to-end mock loop integration test

**Files:**

- Create: `packages/core/src/runtime/mock-loop.integration.test.ts`

> The capstone of this batch: a full collective loop where a participant sends a message
> that triggers a chain, all through the real `MessageRouter`, `Collective`,
> `FileConversationStore`, `RuntimeRegistry`, and `MockRuntime` — no mocks of internals,
> no LLM, no network.

- [ ] **Step 1: Write the integration test**

`packages/core/src/runtime/mock-loop.integration.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { Collective } from '../collective/Collective.js';
import { EventBus } from '../events/EventBus.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { communicateTool } from '../tools/communicate-tool.js';
import { getActiveChain } from '../conversation/conversation-ops.js';
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { MockRuntime } from './MockRuntime.js';
import { UserDeliveryRuntime } from './UserDeliveryRuntime.js';
import { MessageRouter } from './MessageRouter.js';
import type { ToolContext } from '../tools/Tool.js';

describe('integration: end-to-end mock loop', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-loop-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('routes an operator message through a mock agent and persists the full thread', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/operator.json', {
      id: 'operator',
      name: 'Operator',
      type: 'user',
      tools: { communicate: 'auto' },
      operator: true,
      protected: true,
      status: 'active',
    });
    await storage.writeJson('collective/participants/assistant.json', {
      id: 'assistant',
      name: 'Assistant',
      type: 'mock',
      tools: {},
      responses: ['Hello, operator!'],
      status: 'active',
    });

    const collective = await Collective.load(storage);
    const store = new FileConversationStore(storage);
    const eventBus = new EventBus();

    const registry = new RuntimeRegistry();
    registry.registerFactory('mock', (id) => new MockRuntime(id));
    registry.registerFactory('user', (id) => new UserDeliveryRuntime(id));

    const router = new MessageRouter(store, registry, collective, eventBus);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(communicateTool);

    const events: string[] = [];
    eventBus.on('conversation:created', () => events.push('conversation:created'));
    eventBus.on('message:sent', () => events.push('message:sent'));

    const operatorContext = {
      participant: collective.getOrThrow('operator'),
      conversationId: '',
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
      messageRouter: router,
    } as unknown as ToolContext;

    // Operator uses the communicate tool to message the assistant.
    const result = await toolRegistry.execute(
      'communicate',
      { to: 'assistant', message: 'Hi assistant' },
      operatorContext,
    );

    expect(result.status).toBe('success');
    const data = result.data as { conversationId: string; response: string };
    expect(data.response).toBe('Hello, operator!');

    // The conversation persists both messages in order.
    const conversation = await store.load(data.conversationId);
    expect(conversation).not.toBeNull();
    const chain = getActiveChain(conversation!);
    expect(chain.map((m) => ({ sender: m.senderId, content: m.content }))).toEqual([
      { sender: 'operator', content: 'Hi assistant' },
      { sender: 'assistant', content: 'Hello, operator!' },
    ]);

    // Events fired: one creation + two sends.
    expect(events.filter((e) => e === 'conversation:created').length).toBe(1);
    expect(events.filter((e) => e === 'message:sent').length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run packages/core/src/runtime/mock-loop.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/runtime/mock-loop.integration.test.ts
git commit -m "test(core): add end-to-end mock loop integration test"
```

---

## Task 8: Full build + test gate

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Run the entire suite**

Run: `npm test`
Expected: PASS — Plans 1–5 green, including the mock-loop integration test.

- [ ] **Step 3: Format + commit fixes**

```bash
npm run format
git add -A
git commit -m "chore: format runtime sources" || echo "nothing to format"
```

---

## Self-Review Checklist

- **Spec §3 communicate tool (to/message/conversationId/replyTo):** Task 6. ✅
- **Spec §3 synchronous call (lock → append → dispatch → append → return):** Task 4. (Note: file store serializes via single-file writes; explicit per-conversation locking is deferred — see deviation below.) ✅
- **Spec §3 fire-and-forget (returns conversationId immediately, routes response to replyTo):** Tasks 4–5. ✅
- **Spec §3 MessageRouter constructor (store, registry, collective, eventBus) + MessageRouterResult:** Task 4. ✅
- **Spec §4 RuntimeContext shape:** Task 1 (extends ToolContext; `serviceManager` added concretely in Plan 8, `authEngine`/`pendingApprovalRegistry`/`messageRouter` required). ✅
- **Spec §8 runtime factories (mock, user delivery):** Tasks 2, 3, 7. (`agent`→Plan 6, `service`→Plan 8.) ✅
- **End-to-end mock loop (first batch deliverable):** Task 7. ✅
- **Deviation noted:** spec mentions a conversation lock; this plan relies on serialized single-file persistence and awaited dispatch. A real mutex per conversation is added when concurrency matters (revisit in Plan 10 web connector). Documented here.
- **Deviation noted:** `MessageRouter.send` accepts the full `ToolContext` (per Plan 4's `MessageRouterPort`) and overrides `participant`/`conversationId`/`conversation`, rather than the spec's `Omit<RuntimeContext, ...>` argument. Behaviourally equivalent; simpler for the `communicate` tool.
- **Placeholder scan:** all steps contain full code/commands. ✅
- **Type consistency:** `Runtime`, `RuntimeContext`, `RuntimeRegistry`, `MockRuntime`, `MessageRouter`, `SendOptions`, `communicateTool` are consumed verbatim by Plans 6–10. `MessageRouterPort`/`MessageRouterResult` match Plan 4. ✅
