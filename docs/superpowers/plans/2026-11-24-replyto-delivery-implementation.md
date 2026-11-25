# replyTo Response Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a response routed to `replyTo` by invoking the target participant's runtime, so connector-bound humans actually receive it, with an opt-in recursive mode for all participant types.

**Architecture:** `dispatchAsync` already persists the recipient's response addressed to `replyTo`. After persisting, a new `deliverReplyTo` helper builds the `replyTo` target's runtime via `RuntimeRegistry.build` (the same pattern as `dispatchApprovalRequests`), invokes `handle`, and completes the resulting response. Default `'users'` mode invokes only `type: 'user'` targets (whose `UserDeliveryRuntime` calls `connector.deliver`); opt-in `'all'` mode invokes every type and recurses up to the depth limit.

**Tech Stack:** TypeScript, Vitest, Legion core (`@legion-collective/core`) and types (`@legion-collective/types`).

**Spec:** `docs/superpowers/specs/2026-11-24-replyto-delivery-design.md`

**Worktree:** `/home/chris/workspace/threads/2026-11-24-replyto-delivery/legion`, branch `fix/replyto-delivery` (based on `fix/replyto-approval-routing`). All commands run from that directory.

## Global Constraints

- `communication.replyToDelivery` accepts `'users' | 'all'`. Absent → `'users'`. Any other value → `'users'` plus a one-time `console.warn` from `MessageRouter`.
- Default `'users'`: invoke the runtime only when the `replyTo` participant is `type: 'user'`. Non-user targets keep today's persist-only behavior.
- `'all'`: invoke the runtime of every target type, and recurse on each returned response until a `void` result, `pending_approval`, an error, or `DEFAULT_DEPTH_LIMIT` (10). First delivery runs at `(opts.context.communicationDepth ?? 0) + 1`.
- Only the async `replyTo` path changes. Synchronous sends, `message:delivered` semantics, and approval routing stay as they are; a duplicate `message:delivered` for `replyTo` delivery is accepted.
- The caller must still receive `status: 'dispatched'`. `deliverReplyTo` never throws into `dispatchAsync`; failures are logged and emitted as the existing `error` event.
- Skip delivery when `responseMessage.recipientId === responseMessage.senderId` (equivalently `replyTo === opts.recipientId`).
- Delivery turns use `buildRuntimeContext(..., middlewareState = undefined)`, mirroring `dispatchApprovalRequests`. Full inbound middleware for delivery turns is out of scope.
- Runtime instances are built with `RuntimeRegistry.build(type, id)`; there is no cached runtime to reuse.
- No per-participant override; collective-level config only.
- Exact values: `DEFAULT_DEPTH_LIMIT = 10`; fallback literal `'users'`; error event shape `{ conversationId, error: { name, message } }`.

---

### Task 1: Config option and resolution

**Files:**

- Modify: `packages/types/src/config.ts:77-85`
- Modify: `packages/core/src/runtime/MessageRouter.ts:76-87` (constructor)
- Test: `packages/core/src/runtime/MessageRouter.test.ts`

**Interfaces:**

- Consumes: existing `CommunicationConfig` and `MessageRouter` constructor signature `(store, registry, collective, eventBus, lifecycle?, middlewareRunner?, communication?)`.
- Produces: `CommunicationConfig.replyToDelivery?: 'users' | 'all'`; `MessageRouter` private field `replyToDelivery: 'users' | 'all'` resolved once in the constructor.

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `packages/core/src/runtime/MessageRouter.test.ts` (after the `fire-and-forget` describe):

```ts
describe('MessageRouter: replyTo delivery config', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-router-replyto-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('warns and falls back to users for an invalid replyToDelivery', async () => {
    const { collective, store, eventBus } = await setup(dir);
    const registry = new RuntimeRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new MessageRouter(store, registry, collective, eventBus, undefined, undefined, {
      replyToDelivery: 'bogus' as never,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replyToDelivery'));
    warn.mockRestore();
  });

  it('accepts replyToDelivery all without warning', async () => {
    const { collective, store, eventBus } = await setup(dir);
    const registry = new RuntimeRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new MessageRouter(store, registry, collective, eventBus, undefined, undefined, {
      replyToDelivery: 'all',
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "replyTo delivery config"`
Expected: FAIL — `replyToDelivery` is not a known `CommunicationConfig` property / no warning is emitted.

- [ ] **Step 3: Add the config field**

In `packages/types/src/config.ts`, replace the `CommunicationConfig` interface with:

```ts
export interface CommunicationConfig {
  /**
   * Milliseconds a synchronous communicate to a human participant waits for
   * their next message in the conversation. `null` waits indefinitely.
   * Defaults to 30 minutes when unset.
   */
  replyTimeoutMs?: number | null;

  /**
   * How responses routed to `replyTo` are delivered.
   * - `'users'` (default): invoke the runtime of `type: 'user'` targets only.
   * - `'all'`: invoke the runtime of every target type and recurse on each
   *   returned response until a void result or the depth limit. Two agents
   *   replying to each other can consume up to the depth limit (10) turns
   *   with no human in the loop.
   */
  replyToDelivery?: 'users' | 'all';
}
```

- [ ] **Step 4: Resolve the setting in the constructor**

In `packages/core/src/runtime/MessageRouter.ts`, add the field and constructor body:

```ts
export class MessageRouter implements MessageRouterPort {
  private background = new Set<Promise<void>>();
  private locks = new Map<string, Promise<void>>();
  private replyWaiters = new Map<string, Set<(text: string) => void>>();
  private replyToDelivery: 'users' | 'all';

  constructor(
    private store: ConversationStore,
    private registry: RuntimeRegistry,
    private collective: Collective,
    private eventBus: EventBus,
    private lifecycle?: MiddlewareLifecycle,
    private middlewareRunner?: MiddlewareRunner,
    private communication?: CommunicationConfig,
  ) {
    const configured = communication?.replyToDelivery;
    if (configured === 'users' || configured === 'all') {
      this.replyToDelivery = configured;
    } else {
      if (configured !== undefined) {
        console.warn(
          `[MessageRouter] unknown communication.replyToDelivery '${String(configured)}'; using 'users'`,
        );
      }
      this.replyToDelivery = 'users';
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "replyTo delivery config"`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the whole router suite for regressions**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/config.ts packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat(core): add communication.replyToDelivery config"
```

---

### Task 2: Persisted response message plumbing

**Files:**

- Modify: `packages/core/src/middleware/MiddlewareLifecycle.ts:205-216`
- Modify: `packages/core/src/runtime/MessageRouter.ts:389-427` (`persistResponse`), `:2427-2486` (`completeResponse`)
- Test: `packages/core/src/middleware/MiddlewareLifecycle.test.ts:150-180`
- Test: `packages/core/src/runtime/MessageRouter.test.ts` (existing suites)

**Interfaces:**

- Consumes: `MiddlewareLifecycle.respond` returns `MessageRouterResult`, which already declares `storedMessageId?: string`.
- Produces: `persistResponse(...)` returns `Promise<{ result: MessageRouterResult; message?: MessageData }>`; `completeResponseDetailed(operation, result)` returns the same shape; `completeResponse(operation, result)` remains `Promise<MessageRouterResult>` (thin wrapper). `MessageData` is imported from `@legion-collective/types`.

- [ ] **Step 1: Write the failing lifecycle assertion**

In `packages/core/src/middleware/MiddlewareLifecycle.test.ts`, extend the existing success test (the one that asserts `status: 'success'` and `response: 'response:recipient:send:sender:receive'`) with:

```ts
expect(response.storedMessageId).toBeDefined();
const stored = (await f.store.load(f.thread.id))!.messages[response.storedMessageId!];
expect(stored.content).toBe('response:recipient:send:sender:receive');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/middleware/MiddlewareLifecycle.test.ts`
Expected: FAIL — `storedMessageId` is `undefined` on the success path.

- [ ] **Step 3: Return `storedMessageId` from a successful `respond`**

In `packages/core/src/middleware/MiddlewareLifecycle.ts`, change the success branch of `respond`:

```ts
if (result.kind === 'continue' || result.kind === 'complete') {
  this.eventBus.emit('message:delivered', {
    conversationId: input.thread.id,
    recipientId: result.value.recipientId,
    messageId: result.value.id,
  });
  return {
    conversationId: input.thread.id,
    response: result.value.content,
    status: 'success',
    storedMessageId: result.value.id,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/middleware/MiddlewareLifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Change `persistResponse` to return the persisted message**

In `packages/core/src/runtime/MessageRouter.ts`, add `MessageData` to the `@legion-collective/types` type import at the top, then replace `persistResponse` with:

```ts
  private async persistResponse(
    thread: ConversationThread,
    senderId: string,
    recipientId: string,
    response: { content: string; reasoning?: string; usage?: MessageUsage },
    lifecycleState?: {
      operationId: string;
      actions: MiddlewareActionResult[];
      context: ToolContext;
      storedMessageId?: string;
    },
  ): Promise<{ result: MessageRouterResult; message?: MessageData }> {
    if (this.lifecycle && lifecycleState) {
      const result = await this.respondWithLifecycle(
        thread,
        {
          senderId,
          recipientId,
          role: 'assistant',
          content: response.content,
          ...(response.reasoning === undefined ? {} : { reasoning: response.reasoning }),
        },
        lifecycleState,
        response.usage,
      );
      const storedMessageId = result.storedMessageId;
      return {
        result,
        ...(storedMessageId === undefined
          ? {}
          : { message: thread.data.messages[storedMessageId] }),
      };
    }
    const responseMsg = await thread.append({
      senderId,
      recipientId,
      role: 'assistant',
      content: response.content,
      reasoning: response.reasoning,
      usage: response.usage,
    });
    this.eventBus.emit('message:delivered', {
      conversationId: thread.id,
      recipientId,
      messageId: responseMsg.id,
    });
    return {
      result: { conversationId: thread.id, response: response.content, status: 'success' },
      message: responseMsg,
    };
  }
```

- [ ] **Step 6: Split `completeResponse` into a detailed variant and a wrapper**

Replace `completeResponse` with:

```ts
  private async completeResponseDetailed(
    operation: ResponseOperation,
    result: RuntimeResult,
  ): Promise<{ result: MessageRouterResult; message?: MessageData }> {
    const lifecycleState = this.withRuntimeActions(operation.lifecycleState, result);
    if (result.kind === 'response') {
      return this.persistResponse(
        operation.thread,
        operation.recipientId,
        operation.responseRecipientId,
        result,
        lifecycleState,
      );
    }
    if (result.kind === 'pending_approval') {
      return {
        result: {
          conversationId: operation.thread.id,
          status: 'pending_approval',
          approvalRequests: result.approvalRequests,
        },
      };
    }
    if (result.kind === 'middleware_pending') {
      return {
        result: {
          conversationId: operation.thread.id,
          status: 'pending_approval',
          approvalId: result.approvalId,
          checkpointId: result.checkpointId,
          pendingParticipantId: operation.recipientId,
          approvalRequests: lifecycleState
            ? this.approvalRequests(lifecycleState.context, result.approvalId)
            : [],
          ...(lifecycleState?.storedMessageId === undefined
            ? {}
            : { partial: true, storedMessageId: lifecycleState.storedMessageId }),
        },
      };
    }
    if (result.kind === 'middleware_abort') {
      return {
        result: {
          conversationId: operation.thread.id,
          status: 'error',
          error: result.error,
          ...(lifecycleState?.storedMessageId === undefined
            ? {}
            : { partial: true, storedMessageId: lifecycleState.storedMessageId }),
        },
      };
    }
    // kind === 'void'
    if (
      result.delivery &&
      result.delivery.status !== 'delivered' &&
      result.delivery.status !== 'accepted'
    ) {
      return {
        result: {
          conversationId: operation.thread.id,
          status: 'error',
          error: result.delivery.reason ?? result.delivery.status,
        },
      };
    }
    return { result: { conversationId: operation.thread.id, status: 'success' } };
  }

  private async completeResponse(
    operation: ResponseOperation,
    result: RuntimeResult,
  ): Promise<MessageRouterResult> {
    return (await this.completeResponseDetailed(operation, result)).result;
  }
```

- [ ] **Step 7: Run the affected suites**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts packages/core/src/middleware/MiddlewareLifecycle.test.ts`
Expected: PASS. Existing synchronous, streaming, middleware, and approval tests must be unchanged in outcome.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/middleware/MiddlewareLifecycle.ts packages/core/src/runtime/MessageRouter.ts packages/core/src/middleware/MiddlewareLifecycle.test.ts
git commit -m "refactor(core): expose persisted response message from completion"
```

---

### Task 3: `deliverReplyTo` for users mode

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.ts:2488-2530` (`dispatchAsync`) and add `deliverReplyTo`
- Test: `packages/core/src/runtime/MessageRouter.test.ts` (new tests in the `fire-and-forget` describe)

**Interfaces:**

- Consumes: `completeResponseDetailed` from Task 2; `replyToDelivery` from Task 1; `RuntimeRegistry.build`, `buildRuntimeContext`.
- Produces: `private async deliverReplyTo(thread: ConversationThread, responseMessage: MessageData, opts: SendOptions, depth: number): Promise<void>`. `dispatchAsync` uses `completeResponseDetailed` and calls the helper when a message was persisted.

- [ ] **Step 1: Write the failing tests**

Add these tests inside `describe('MessageRouter: fire-and-forget')` in `packages/core/src/runtime/MessageRouter.test.ts`:

```ts
it('delivers a replyTo response to a user target by default', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  const received: MessageData[] = [];
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', (id) => new MockRuntime(id));
  registry.registerFactory('user', () => ({
    async handle(incoming: MessageData): Promise<RuntimeResult> {
      received.push(incoming);
      return { kind: 'void' };
    },
  }));
  const router = new MessageRouter(store, registry, collective, eventBus);

  const result = await router.send({
    senderId: 'svc',
    recipientId: 'mock-1',
    message: 'analyze',
    replyTo: 'op',
    context: baseContext,
  });
  expect(result.status).toBe('dispatched');
  await router.drain();

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    senderId: 'mock-1',
    recipientId: 'op',
    content: 'hello back',
  });
});

it('does not invoke a non-user replyTo target by default', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  let agentTurns = 0;
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', (id) => new MockRuntime(id));
  registry.registerFactory('agent', () => ({
    async handle(): Promise<RuntimeResult> {
      agentTurns += 1;
      return { kind: 'response', content: 'agent reply' };
    },
  }));
  const router = new MessageRouter(store, registry, collective, eventBus);

  const result = await router.send({
    senderId: 'svc',
    recipientId: 'mock-1',
    message: 'analyze',
    replyTo: 'agent',
    context: baseContext,
  });
  expect(result.status).toBe('dispatched');
  await router.drain();

  expect(agentTurns).toBe(0);
  const conv = await store.load(result.conversationId);
  expect(
    Object.values(conv!.messages).find((m) => m.recipientId === 'agent' && m.role === 'assistant')
      ?.content,
  ).toBe('hello back');
});

it('skips delivery when replyTo is the recipient itself', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  let handleCalls = 0;
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', () => ({
    async handle(): Promise<RuntimeResult> {
      handleCalls += 1;
      return { kind: 'response', content: 'hello back' };
    },
  }));
  const router = new MessageRouter(store, registry, collective, eventBus);

  const result = await router.send({
    senderId: 'svc',
    recipientId: 'mock-1',
    message: 'analyze',
    replyTo: 'mock-1',
    context: baseContext,
  });
  expect(result.status).toBe('dispatched');
  await router.drain();

  expect(handleCalls).toBe(1);
});

it('warns and continues when the replyTo participant does not exist', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', (id) => new MockRuntime(id));
  const router = new MessageRouter(store, registry, collective, eventBus);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  const result = await router.send({
    senderId: 'svc',
    recipientId: 'mock-1',
    message: 'analyze',
    replyTo: 'ghost',
    context: baseContext,
  });
  expect(result.status).toBe('dispatched');
  await router.drain();

  expect(warn).toHaveBeenCalledWith(expect.stringContaining('ghost'));
  warn.mockRestore();
});

it('emits an error when user delivery fails and still returns dispatched', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', (id) => new MockRuntime(id));
  registry.registerFactory('user', () => ({
    async handle(): Promise<RuntimeResult> {
      return { kind: 'void', delivery: { status: 'failed', reason: 'no live bot' } };
    },
  }));
  const router = new MessageRouter(store, registry, collective, eventBus);
  const errors: { message: string }[] = [];
  eventBus.on('error', (payload) => errors.push(payload.error));

  const result = await router.send({
    senderId: 'svc',
    recipientId: 'mock-1',
    message: 'analyze',
    replyTo: 'op',
    context: baseContext,
  });
  expect(result.status).toBe('dispatched');
  await router.drain();

  expect(errors).toHaveLength(1);
  expect(errors[0].message).toBe('no live bot');
});

it('delivers a persisted runtime-error response to replyTo', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  const received: MessageData[] = [];
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', () => ({
    async handle(): Promise<RuntimeResult> {
      throw new Error('provider boom');
    },
  }));
  registry.registerFactory('user', () => ({
    async handle(incoming: MessageData): Promise<RuntimeResult> {
      received.push(incoming);
      return { kind: 'void' };
    },
  }));
  const router = new MessageRouter(store, registry, collective, eventBus);

  const result = await router.send({
    senderId: 'svc',
    recipientId: 'mock-1',
    message: 'analyze',
    replyTo: 'op',
    context: baseContext,
  });
  expect(result.status).toBe('dispatched');
  await router.drain();

  expect(received).toHaveLength(1);
  expect(received[0].content).toMatch(/provider boom/);
  expect(received[0].recipientId).toBe('op');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "delivers a replyTo response to a user target by default"`
Expected: FAIL — the user runtime is never invoked.

- [ ] **Step 3: Add `deliverReplyTo`**

Add this method to `MessageRouter` (near `dispatchApprovalRequests`):

```ts
  private async deliverReplyTo(
    thread: ConversationThread,
    responseMessage: MessageData,
    opts: SendOptions,
    depth: number,
  ): Promise<void> {
    const replyTo = opts.replyTo;
    if (!replyTo) return;
    if (responseMessage.recipientId === responseMessage.senderId) return;
    if (depth > DEFAULT_DEPTH_LIMIT) return;
    const target = this.collective.get(replyTo);
    if (!target) {
      console.warn(`[MessageRouter] replyTo target '${replyTo}' does not exist`);
      return;
    }
    if (this.replyToDelivery === 'users' && target.type !== 'user') return;

    try {
      const runtime = this.registry.build(target.type, target.id);
      const runtimeContext = this.buildRuntimeContext(
        thread,
        target.id,
        { ...opts.context, communicationDepth: depth },
        depth,
        undefined,
      );
      const result = await runtime.handle(responseMessage, runtimeContext);
      const completed = await this.completeResponseDetailed(
        {
          thread,
          recipientId: target.id,
          responseRecipientId: responseMessage.senderId,
        },
        result,
      );
      if (completed.result.status === 'error') {
        const message = completed.result.error ?? 'replyTo delivery failed';
        console.warn(`[MessageRouter] replyTo delivery to '${target.id}' failed: ${message}`);
        this.eventBus.emit('error', {
          conversationId: thread.id,
          error: { name: 'ReplyToDeliveryError', message },
        });
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[MessageRouter] replyTo delivery to '${replyTo}' failed: ${err.message}`);
      this.eventBus.emit('error', {
        conversationId: thread.id,
        error: { name: err.name, message: err.message },
      });
    }
  }
```

- [ ] **Step 4: Wire the helper into `dispatchAsync`**

Replace the body of `dispatchAsync` with:

```ts
  private async dispatchAsync(
    runtime: ReturnType<RuntimeRegistry['build']>,
    inbound: Awaited<ReturnType<ConversationThread['append']>>,
    runtimeContext: RuntimeContext,
    thread: ConversationThread,
    opts: SendOptions,
    lifecycleState?: {
      operationId: string;
      actions: MiddlewareActionResult[];
      context: ToolContext;
      storedMessageId?: string;
    },
  ): Promise<void> {
    await this.withLock(thread.id, async () => undefined);
    const backgroundThread = this.createAppendSafeThread(thread);
    const backgroundContext: RuntimeContext = {
      ...runtimeContext,
      conversation: backgroundThread,
    };
    const depth = (opts.context.communicationDepth ?? 0) + 1;

    try {
      const result = await runtime.handle(inbound, backgroundContext);
      const completed = await this.completeResponseDetailed(
        {
          thread: backgroundThread,
          recipientId: opts.recipientId,
          responseRecipientId: opts.replyTo!,
          lifecycleState,
        },
        result,
      );
      if (completed.result.status === 'pending_approval' && completed.result.approvalRequests?.length) {
        await this.dispatchApprovalRequests(
          backgroundThread,
          opts,
          completed.result.approvalRequests,
        );
      }
      if (completed.message) {
        await this.deliverReplyTo(backgroundThread, completed.message, opts, depth);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const completed = await this.completeResponseDetailed(
        {
          thread: backgroundThread,
          recipientId: opts.recipientId,
          responseRecipientId: opts.replyTo!,
          lifecycleState,
        },
        { kind: 'response', content: `[Runtime error: ${msg}]` },
      );
      if (completed.message) {
        await this.deliverReplyTo(backgroundThread, completed.message, opts, depth);
      }
    }
  }
```

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "fire-and-forget"`
Expected: PASS, including all six new tests.

- [ ] **Step 6: Run the whole router suite**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: PASS. Note: existing fire-and-forget tests that use `replyTo: 'op'` with only a `mock` factory registered now hit the missing-`user`-factory path and emit an `error` event; their assertions must still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat(core): deliver replyTo responses to user targets"
```

---

### Task 4: `'all'` mode recursion and approval bubbling

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.ts` (`deliverReplyTo`)
- Test: `packages/core/src/runtime/MessageRouter.test.ts`

**Interfaces:**

- Consumes: `deliverReplyTo` from Task 3, `dispatchApprovalRequests`, `replyToDelivery`.
- Produces: recursion for `'all'` mode; approval bubbling from a delivery target back to `responseMessage.senderId`.

- [ ] **Step 1: Write the failing tests**

Add to `describe('MessageRouter: fire-and-forget')`:

```ts
it('invokes an agent replyTo target and recurses until void in all mode', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  const agentTurns: MessageData[] = [];
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', (id) => new MockRuntime(id));
  registry.registerFactory('agent', () => ({
    async handle(incoming: MessageData): Promise<RuntimeResult> {
      agentTurns.push(incoming);
      if (agentTurns.length === 1) {
        return { kind: 'response', content: 'agent reply' };
      }
      return { kind: 'void' };
    },
  }));
  const router = new MessageRouter(store, registry, collective, eventBus, undefined, undefined, {
    replyToDelivery: 'all',
  });

  const result = await router.send({
    senderId: 'svc',
    recipientId: 'mock-1',
    message: 'analyze',
    replyTo: 'agent',
    context: baseContext,
  });
  expect(result.status).toBe('dispatched');
  await router.drain();

  expect(agentTurns).toHaveLength(2);
  expect(agentTurns[0].content).toBe('hello back');
  expect(agentTurns[1].content).toBe('hello back');
});

it('stops at the communication depth limit in all mode', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  const received: MessageData[] = [];
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', () => ({
    async handle(incoming: MessageData): Promise<RuntimeResult> {
      received.push(incoming);
      return { kind: 'response', content: `reply:${received.length}` };
    },
  }));
  const router = new MessageRouter(store, registry, collective, eventBus, undefined, undefined, {
    replyToDelivery: 'all',
  });

  await router.send({
    senderId: 'op',
    recipientId: 'mock-1',
    message: 'start',
    replyTo: 'svc',
    context: baseContext,
  });
  await router.drain();

  // One initial recipient turn plus ten delivery turns (depth 1..10).
  expect(received).toHaveLength(11);
});

it('bubbles an all-mode delivery approval back to the triggering sender', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  const received: MessageData[] = [];
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', () => ({
    async handle(incoming: MessageData): Promise<RuntimeResult> {
      received.push(incoming);
      return { kind: 'response', content: 'hello back' };
    },
  }));
  registry.registerFactory('agent', () => ({
    async handle(): Promise<RuntimeResult> {
      return {
        kind: 'pending_approval',
        approvalRequests: [
          {
            approvalId: 'appr-all',
            conversationId: 'conv-all',
            requesterId: 'agent',
            tool: 'write_file',
            args: {},
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
    },
  }));
  const router = new MessageRouter(store, registry, collective, eventBus, undefined, undefined, {
    replyToDelivery: 'all',
  });

  const result = await router.send({
    senderId: 'svc',
    recipientId: 'mock-1',
    message: 'analyze',
    replyTo: 'agent',
    context: baseContext,
  });
  expect(result.status).toBe('dispatched');
  await router.drain();

  const approvals = received.filter((m) => m.content.includes('appr-all'));
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({
    senderId: 'agent',
    recipientId: 'mock-1',
    replyTo: 'agent',
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "all mode"`
Expected: FAIL — the agent target is not invoked in `'all'` mode and no recursion happens.

- [ ] **Step 3: Add approval bubbling and recursion to `deliverReplyTo`**

After the `if (completed.result.status === 'error') { ... }` block in `deliverReplyTo`, add:

```ts
if (completed.result.status === 'pending_approval') {
  await this.dispatchApprovalRequests(
    thread,
    {
      ...opts,
      senderId: target.id,
      recipientId: target.id,
      replyTo: responseMessage.senderId,
      context: { ...opts.context, communicationDepth: depth },
    },
    completed.result.approvalRequests ?? [],
  );
  return;
}
if (this.replyToDelivery === 'all' && completed.message) {
  const nextReplyTo = completed.message.recipientId;
  if (nextReplyTo !== completed.message.senderId) {
    await this.deliverReplyTo(
      thread,
      completed.message,
      {
        ...opts,
        senderId: completed.message.senderId,
        recipientId: completed.message.senderId,
        replyTo: nextReplyTo,
        context: { ...opts.context, communicationDepth: depth + 1 },
      },
      depth + 1,
    );
  }
}
```

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "all mode"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole router suite and typecheck**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat(core): recurse replyTo delivery in all mode and bubble approvals"
```

---

### Task 5: Document the config and default

**Files:**

- Modify: `docs/legion-v2-greenfield-spec.md` (fire-and-forget section, §3; delivery section, §6.7)

**Interfaces:**

- Consumes: the config and behavior from Tasks 1-4.
- Produces: documentation only.

- [ ] **Step 1: Update §3 fire-and-forget**

After the line "`replyTo` always names a **participant**. Delivery to a connector-bound participant goes through its connector (§6.7)." add:

```markdown
Delivery to `replyTo` follows the collective's `communication.replyToDelivery`
setting. The default, `'users'`, invokes the delivery runtime only when the
`replyTo` participant is `type: 'user'`, so connector-bound humans receive the
response. Setting it to `'all'` invokes the target's runtime for every
participant type and recursively delivers each resulting response, up to the
communication depth limit (10). With `'all'`, two agents replying to each other
via `replyTo` can consume up to 10 turns with no human in the loop.
```

- [ ] **Step 2: Update §6.7**

After the paragraph beginning "When `MessageRouter` routes a message to a connector-bound participant..." add:

```markdown
A response routed to `replyTo` is delivered by invoking the target's runtime
after the response is persisted. `communication.replyToDelivery` controls the
scope: `'users'` (default) delivers only to `type: 'user'` targets, while
`'all'` delivers to every participant type and recurses up to the depth limit.
```

- [ ] **Step 3: Commit**

```bash
git add docs/legion-v2-greenfield-spec.md
git commit -m "docs: document communication.replyToDelivery"
```

---

## Self-Review

**Spec coverage:**

- §4 config → Task 1. ✔
- §6.1 persisted message plumbing → Task 2. ✔
- §6.2 `deliverReplyTo` → Tasks 3-4. ✔
- §6.3 `'users'` mode → Task 3. ✔
- §6.4 `'all'` recursion and depth limit → Task 4. ✔
- §6.5 approvals → Task 4. ✔
- §6.6 failures → Task 3 (error event, missing target, self-delivery, caller still dispatched). ✔
- §6.7 middleware limitation → Task 3 uses `middlewareState = undefined`; no test needed beyond existing behavior. ✔
- §7 event semantics → preserved; Task 3 tests observe delivery without changing event behavior. ✔
- §8 compatibility → existing suites in Tasks 1-4. ✔
- §9 testing items 1-10 → covered across Tasks 1-4 (item 10: `send`, `sendStream`, `generate`, `resume`, `resumeApproval` all go through `dispatchAsync`; existing suites exercise them). ✔
- §10 files → all named. ✔
- §11 rollout → base branch and default config documented. ✔

**Placeholder scan:** No TBD/TODO/"implement later"/"similar to Task N" in the steps; every code step carries complete code.

**Type consistency:** `deliverReplyTo(thread, responseMessage: MessageData, opts: SendOptions, depth: number)` is defined in Task 3 and called with the same signature in Task 4. `completeResponseDetailed` returns `{ result, message? }` in Task 2 and is consumed with that shape in Tasks 3-4. `replyToDelivery` is `'users' | 'all'` in Task 1 and checked identically in Tasks 3-4.
