# Synchronous Human Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a synchronous `communicate` to a human participant (`type: 'user'`) block until that human's next message in the same conversation arrives, and return that text as the tool result without dispatching the reply to the recipient's bot.

**Architecture:** Add a waiter registry to `MessageRouter`, keyed by `(conversationId, participantId)`. Register the waiter before delivering the outbound message, release the conversation lock before awaiting, and consume the human's inbound reply in the inbound append path. Timeouts come from a new collective `communication.replyTimeoutMs`, an optional per-participant `replyTimeoutMs`, and the existing per-call `timeoutMs`, with `null` meaning indefinite.

**Tech Stack:** TypeScript (Node >= 20, pure ESM, NodeNext), npm workspaces, Vitest, Prettier.

**Spec:** `docs/superpowers/specs/2026-11-23-synchronous-human-reply-design.md`

**Working directory:** `threads/2026-11-23-human-reply-wait/legion` (branch `feat/human-reply-wait`).

## Global Constraints

- Node >= 20; pure ESM; relative imports use `.js` extensions in `.ts` source.
- TypeScript strict, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`; type-only imports use `import type`.
- Prettier: single quotes, semicolons, trailing commas, 100 cols, 2 spaces.
- Required verification order: `npm run format:check` → `npm run typecheck` → `npm test`.
- No connector changes. No outbox, retries, delivery receipts, new connector API, or UI changes.
- Reply timeout precedence: explicit `timeoutMs` → sender participant `replyTimeoutMs` → collective `communication.replyTimeoutMs` → 30 minutes. `null` at participant or collective level means wait indefinitely. Invalid values (not a positive integer) fall back to the next level with a `console.warn`.
- Both router dispatch paths get the behavior: `send` (connector/service path) and `sendStream` (the `communicate` tool path).
- Only `packages/types`, `packages/core`, and `packages/runtime` are modified.

---

## File Structure

| File                                                   | Responsibility                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/config.ts`                         | Add `CommunicationConfig`; add `WorkspaceConfig.communication`.                                                             |
| `packages/types/src/participant.ts`                    | Add `BaseParticipant.replyTimeoutMs`.                                                                                       |
| `packages/types/type-tests/communication-contracts.ts` | New type test for the config surface.                                                                                       |
| `packages/core/src/tools/Tool.ts`                      | Update the `SendOptions.timeoutMs` doc comment.                                                                             |
| `packages/core/src/runtime/MessageRouter.ts`           | Waiter registry, timeout resolution, early lock release, waiting in `sendInner` and `sendStreamInner`, inbound consumption. |
| `packages/core/src/runtime/MessageRouter.test.ts`      | Unit tests for the sync and stream paths.                                                                                   |
| `packages/core/src/service/ServiceContextImpl.ts`      | Map router `timeout` to `error: 'deadline exceeded'`.                                                                       |
| `packages/core/src/service/ServiceContextImpl.test.ts` | Test the timeout mapping.                                                                                                   |
| `packages/runtime/src/LegionProcess.ts`                | Pass merged `communication` config into `MessageRouter`.                                                                    |
| `docs/legion-v2-greenfield-spec.md`                    | Document the human-reply behavior in the synchronous-call section.                                                          |

---

## Task 1: Config surface and router plumbing

**Files:**

- Create: `packages/types/type-tests/communication-contracts.ts`
- Modify: `packages/types/src/config.ts`
- Modify: `packages/types/src/participant.ts`
- Modify: `packages/core/src/runtime/MessageRouter.ts` (constructor only)
- Modify: `packages/runtime/src/LegionProcess.ts:222-230`

**Interfaces:**

- Produces:
  - `export interface CommunicationConfig { replyTimeoutMs?: number | null }`
  - `WorkspaceConfig.communication?: CommunicationConfig`
  - `BaseParticipant.replyTimeoutMs?: number | null`
  - `new MessageRouter(store, registry, collective, eventBus, lifecycle?, middlewareRunner?, communication?: CommunicationConfig)`

- [ ] **Step 1: Write the failing type test**

Create `packages/types/type-tests/communication-contracts.ts`:

```ts
import type {
  AgentConfig,
  BaseParticipant,
  CommunicationConfig,
  WorkspaceConfig,
} from '../src/index.js';

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type IsOptional<T, TKey extends keyof T> = {} extends Pick<T, TKey> ? true : false;

type CommunicationIsOptional = Expect<Equal<IsOptional<WorkspaceConfig, 'communication'>, true>>;
type ReplyTimeoutIsOptional = Expect<Equal<IsOptional<BaseParticipant, 'replyTimeoutMs'>, true>>;

const workspace = {
  version: '2',
  communication: { replyTimeoutMs: null },
} satisfies WorkspaceConfig;

const agent = {
  id: 'agent-1',
  name: 'Agent',
  type: 'agent',
  tools: {},
  systemPrompt: 'You are helpful.',
  model: { model: 'gpt-4o-mini' },
  maxIterations: 10,
  replyTimeoutMs: 60_000,
} satisfies AgentConfig;

const communication: CommunicationConfig = { replyTimeoutMs: 1000 };

void [
  workspace,
  agent,
  communication,
  null as unknown as CommunicationIsOptional,
  null as unknown as ReplyTimeoutIsOptional,
];
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm run typecheck`

Expected: FAIL — `CommunicationConfig` is not exported, `communication` is not a property of `WorkspaceConfig`, and `replyTimeoutMs` is not a property of `BaseParticipant`/`AgentConfig`.

- [ ] **Step 3: Add the types**

In `packages/types/src/config.ts`, add above `WorkspaceConfig`:

```ts
export interface CommunicationConfig {
  /**
   * Milliseconds a synchronous communicate to a human participant waits for
   * their next message in the conversation. `null` waits indefinitely.
   * Defaults to 30 minutes when unset.
   */
  replyTimeoutMs?: number | null;
}
```

Add to `WorkspaceConfig` after `middlewareModules`:

```ts
  communication?: CommunicationConfig;
```

In `packages/types/src/participant.ts`, add to `BaseParticipant` after `middlewareRevision`:

```ts
  /**
   * Milliseconds a synchronous communicate from this participant waits for a
   * human reply. Overrides the collective `communication.replyTimeoutMs`.
   * `null` waits indefinitely.
   */
  replyTimeoutMs?: number | null;
```

- [ ] **Step 4: Add the router constructor argument and pass the config**

In `packages/core/src/runtime/MessageRouter.ts`, add `CommunicationConfig` to the existing `@legion-collective/types` type import:

```ts
import type {
  AgentConfig,
  CommunicationConfig,
  ConversationOrigin,
  MessageUsage,
  LLMChunk,
  MessageDraft,
  MiddlewareActionResult,
} from '@legion-collective/types';
```

Change the constructor:

```ts
  constructor(
    private store: ConversationStore,
    private registry: RuntimeRegistry,
    private collective: Collective,
    private eventBus: EventBus,
    private lifecycle?: MiddlewareLifecycle,
    private middlewareRunner?: MiddlewareRunner,
    private communication?: CommunicationConfig,
  ) {}
```

In `packages/runtime/src/LegionProcess.ts`, pass the merged config as the seventh argument:

```ts
router = new MessageRouter(
  store,
  runtimeRegistry,
  collective,
  eventBus,
  middlewareLifecycle,
  middlewareRunner,
  mergedConfig.communication,
);
```

- [ ] **Step 5: Run typecheck to verify it passes**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/types/src/config.ts packages/types/src/participant.ts \
  packages/types/type-tests/communication-contracts.ts \
  packages/core/src/runtime/MessageRouter.ts packages/runtime/src/LegionProcess.ts
git add packages/types packages/core/src/runtime/MessageRouter.ts packages/runtime/src/LegionProcess.ts
git commit -m "feat(types): add reply timeout configuration surface"
```

---

## Task 2: Waiter registry and synchronous waiting in `sendInner`

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.ts`
- Modify: `packages/core/src/tools/Tool.ts` (doc comment only)
- Test: `packages/core/src/runtime/MessageRouter.test.ts` (new `describe` block)

**Interfaces:**

- Consumes: `CommunicationConfig` and `BaseParticipant.replyTimeoutMs` from Task 1.
- Produces:
  - `MessageRouter.send` waits for human replies when the recipient is `type: 'user'` and `replyTo` is absent.
  - `MessageRouterResult` for a consumed reply: `{ conversationId, status: 'success', response: <human text> }`.
  - Timeout: `{ conversationId, status: 'timeout', partial: true }`.
  - Cancellation: `{ conversationId, status: 'error', error: 'Runtime cancelled' }`.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `packages/core/src/runtime/MessageRouter.test.ts` (the file already imports `mkdtemp`, `rm`, `tmpdir`, `join`, `RuntimeRegistry`, `MessageRouter`, `withResolvers`, `LLMChunk`, and `RuntimeResult`):

```ts
describe('MessageRouter: synchronous human reply', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-human-reply-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setupHumanRouter(options?: {
    communication?: { replyTimeoutMs?: number | null };
    userDelivery?: RuntimeResult;
  }) {
    const base = await setup(dir);
    const registry = new RuntimeRegistry();
    const handleCalls: string[] = [];
    const delivered = withResolvers<void>();
    registry.registerFactory('user', () => ({
      async handle() {
        delivered.resolve();
        return (
          options?.userDelivery ?? {
            kind: 'void' as const,
            delivery: { status: 'delivered' as const },
          }
        );
      },
    }));
    registry.registerFactory('mock', (id) => ({
      async handle() {
        handleCalls.push(id);
        return { kind: 'response' as const, content: 'hello back' };
      },
    }));
    const router = new MessageRouter(
      base.store,
      registry,
      base.collective,
      base.eventBus,
      undefined,
      undefined,
      options?.communication,
    );
    return { ...base, router, handleCalls, delivered: delivered.promise };
  }

  async function newConversation(store: Awaited<ReturnType<typeof setup>>['store']) {
    return store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
  }

  it('consumes the human reply without dispatching the bot', async () => {
    const { router, baseContext, store, handleCalls, delivered } = await setupHumanRouter();
    const conversation = await newConversation(store);

    const pending = router.send({
      senderId: 'mock-1',
      recipientId: 'op',
      message: 'question?',
      conversationId: conversation.id,
      context: baseContext,
    });
    await delivered;

    const reply = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'the answer',
      conversationId: conversation.id,
      context: baseContext,
    });
    expect(reply).toMatchObject({ status: 'success' });
    expect(reply.response).toBeUndefined();

    const result = await pending;
    expect(result).toMatchObject({
      conversationId: conversation.id,
      status: 'success',
      response: 'the answer',
    });
    expect(handleCalls).toEqual([]);

    const loaded = await store.load(conversation.id);
    const messages = Object.values(loaded!.messages);
    expect(messages.map((m) => m.content)).toEqual(['question?', 'the answer']);
    expect(messages.every((m) => m.role === 'user')).toBe(true);
  });

  it('dispatches a human message normally when no call is waiting', async () => {
    const { router, baseContext, store, handleCalls } = await setupHumanRouter();
    const conversation = await newConversation(store);

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hello',
      conversationId: conversation.id,
      context: baseContext,
    });

    expect(result).toMatchObject({ status: 'success', response: 'hello back' });
    expect(handleCalls).toEqual(['mock-1']);
  });

  it('times out and leaves a late reply to route normally', async () => {
    const { router, baseContext, store, handleCalls, delivered } = await setupHumanRouter({
      communication: { replyTimeoutMs: 25 },
    });
    const conversation = await newConversation(store);

    const pending = router.send({
      senderId: 'mock-1',
      recipientId: 'op',
      message: 'question?',
      conversationId: conversation.id,
      context: baseContext,
    });
    await delivered;

    const result = await pending;
    expect(result).toMatchObject({ status: 'timeout', partial: true });
    expect(handleCalls).toEqual([]);

    const late = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'late reply',
      conversationId: conversation.id,
      context: baseContext,
    });
    expect(late).toMatchObject({ status: 'success', response: 'hello back' });
    expect(handleCalls).toEqual(['mock-1']);
  });

  it('cancels on caller abort and removes the waiter', async () => {
    const { router, baseContext, store, handleCalls, delivered } = await setupHumanRouter();
    const conversation = await newConversation(store);
    const controller = new AbortController();

    const pending = router.send({
      senderId: 'mock-1',
      recipientId: 'op',
      message: 'question?',
      conversationId: conversation.id,
      context: { ...baseContext, signal: controller.signal },
    });
    await delivered;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: 'Runtime cancelled',
    });

    const reply = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'late reply',
      conversationId: conversation.id,
      context: baseContext,
    });
    expect(reply).toMatchObject({ status: 'success', response: 'hello back' });
    expect(handleCalls).toEqual(['mock-1']);
  });

  it('returns the delivery error and removes the waiter', async () => {
    const { router, baseContext, store, handleCalls } = await setupHumanRouter({
      userDelivery: {
        kind: 'void',
        delivery: { status: 'failed', reason: 'no live bot' },
      },
    });
    const conversation = await newConversation(store);

    const result = await router.send({
      senderId: 'mock-1',
      recipientId: 'op',
      message: 'question?',
      conversationId: conversation.id,
      context: baseContext,
    });
    expect(result).toMatchObject({ status: 'error', error: 'no live bot' });

    const reply = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'late reply',
      conversationId: conversation.id,
      context: baseContext,
    });
    expect(reply).toMatchObject({ status: 'success', response: 'hello back' });
    expect(handleCalls).toEqual(['mock-1']);
  });

  it('does not wait when replyTo is set', async () => {
    const { router, baseContext, store } = await setupHumanRouter({
      communication: { replyTimeoutMs: null },
    });
    const conversation = await newConversation(store);

    const result = await router.send({
      senderId: 'mock-1',
      recipientId: 'op',
      message: 'hi',
      conversationId: conversation.id,
      replyTo: 'mock-1',
      context: baseContext,
    });
    expect(result).toMatchObject({ status: 'dispatched' });
    await router.drain();
  });

  it('returns the response for non-user recipients without waiting', async () => {
    const { router, baseContext } = await setupHumanRouter();

    const result = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'hi',
      context: baseContext,
    });
    expect(result).toMatchObject({ status: 'success', response: 'hello back' });
  });

  it('prefers the sender participant timeout over the collective default', async () => {
    const { router, baseContext, store, collective, delivered } = await setupHumanRouter({
      communication: { replyTimeoutMs: 5000 },
    });
    await collective.update('mock-1', { replyTimeoutMs: 25 });
    const conversation = await newConversation(store);
    const started = Date.now();

    const pending = router.send({
      senderId: 'mock-1',
      recipientId: 'op',
      message: 'question?',
      conversationId: conversation.id,
      context: baseContext,
    });
    await delivered;

    const result = await pending;
    expect(result).toMatchObject({ status: 'timeout', partial: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('prefers the explicit timeoutMs over the participant timeout', async () => {
    const { router, baseContext, store, collective, delivered } = await setupHumanRouter();
    await collective.update('mock-1', { replyTimeoutMs: 5000 });
    const conversation = await newConversation(store);

    const pending = router.send({
      senderId: 'mock-1',
      recipientId: 'op',
      message: 'question?',
      conversationId: conversation.id,
      timeoutMs: 25,
      context: baseContext,
    });
    await delivered;

    const result = await pending;
    expect(result).toMatchObject({ status: 'timeout', partial: true });
  });

  it('ignores a non-positive participant timeout and uses the collective value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { router, baseContext, store, collective, delivered } = await setupHumanRouter({
      communication: { replyTimeoutMs: 25 },
    });
    await collective.update('mock-1', { replyTimeoutMs: 0 });
    const conversation = await newConversation(store);

    const pending = router.send({
      senderId: 'mock-1',
      recipientId: 'op',
      message: 'question?',
      conversationId: conversation.id,
      context: baseContext,
    });
    await delivered;

    const result = await pending;
    expect(result).toMatchObject({ status: 'timeout', partial: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replyTimeoutMs'));
    warn.mockRestore();
  });

  it('waits indefinitely when the collective timeout is null', async () => {
    const { router, baseContext, store, delivered } = await setupHumanRouter({
      communication: { replyTimeoutMs: null },
    });
    const conversation = await newConversation(store);

    const pending = router.send({
      senderId: 'mock-1',
      recipientId: 'op',
      message: 'question?',
      conversationId: conversation.id,
      context: baseContext,
    });
    await delivered;

    const stillPending = await Promise.race([
      pending.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ]);
    expect(stillPending).toBe('pending');

    const reply = await router.send({
      senderId: 'op',
      recipientId: 'mock-1',
      message: 'the answer',
      conversationId: conversation.id,
      context: baseContext,
    });
    expect(reply).toMatchObject({ status: 'success' });
    await expect(pending).resolves.toMatchObject({
      status: 'success',
      response: 'the answer',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "synchronous human reply"`

Expected: FAIL — the sync call returns `status: 'success'` with no `response` immediately instead of waiting.

- [ ] **Step 3: Add the waiter registry and timeout helpers**

In `packages/core/src/runtime/MessageRouter.ts`, after `const DEFAULT_DEPTH_LIMIT = 10;`:

```ts
const DEFAULT_REPLY_TIMEOUT_MS = 30 * 60 * 1000;

type ReplyWaiterHandle = {
  promise: Promise<string>;
  unregister: () => void;
};

type ReplyOutcome = { kind: 'reply'; text: string } | { kind: 'timeout' } | { kind: 'cancelled' };
```

Add the field after `private locks = new Map<string, Promise<void>>();`:

```ts
  private replyWaiters = new Map<string, Set<(text: string) => void>>();
```

Add these methods after `acquireLock`:

```ts
  private replyWaiterKey(conversationId: string, participantId: string): string {
    return `${conversationId}\u0000${participantId}`;
  }

  private registerReplyWaiter(
    conversationId: string,
    participantId: string,
  ): ReplyWaiterHandle {
    const key = this.replyWaiterKey(conversationId, participantId);
    let resolve!: (text: string) => void;
    const promise = new Promise<string>((res) => {
      resolve = res;
    });
    const waiters = this.replyWaiters.get(key) ?? new Set<(text: string) => void>();
    waiters.add(resolve);
    this.replyWaiters.set(key, waiters);
    const unregister = () => {
      waiters.delete(resolve);
      if (waiters.size === 0 && this.replyWaiters.get(key) === waiters) {
        this.replyWaiters.delete(key);
      }
    };
    return { promise, unregister };
  }

  private resolveReplyWaiters(
    conversationId: string,
    participantId: string,
    text: string,
  ): boolean {
    const key = this.replyWaiterKey(conversationId, participantId);
    const waiters = this.replyWaiters.get(key);
    if (!waiters || waiters.size === 0) return false;
    this.replyWaiters.delete(key);
    for (const resolve of waiters) resolve(text);
    return true;
  }

  private async awaitReply(
    waiter: Promise<string>,
    timeoutMs: number | null,
    signal: AbortSignal | undefined,
  ): Promise<ReplyOutcome> {
    if (signal?.aborted) return { kind: 'cancelled' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timedOut =
      timeoutMs === null
        ? new Promise<never>(() => undefined)
        : new Promise<ReplyOutcome>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
          });
    const cancelled = new Promise<ReplyOutcome>((resolve) => {
      onAbort = () => resolve({ kind: 'cancelled' });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        waiter.then((text): ReplyOutcome => ({ kind: 'reply', text })),
        timedOut,
        cancelled,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }
  }

  private resolveReplyTimeout(opts: SendOptions): number | null {
    const candidates: Array<{ source: string; value: number | null | undefined }> = [
      { source: 'timeoutMs', value: opts.timeoutMs },
      {
        source: `participant '${opts.senderId}'.replyTimeoutMs`,
        value: this.collective.get(opts.senderId)?.replyTimeoutMs,
      },
      {
        source: 'communication.replyTimeoutMs',
        value: this.communication?.replyTimeoutMs,
      },
    ];
    for (const { source, value } of candidates) {
      if (value === undefined) continue;
      if (value === null) return null;
      if (Number.isInteger(value) && value > 0) return value;
      console.warn(`[router] ignoring invalid ${source}: ${String(value)}`);
    }
    return DEFAULT_REPLY_TIMEOUT_MS;
  }

  private isDeliveredVoid(result: RuntimeResult): boolean {
    return (
      result.kind === 'void' &&
      (result.delivery?.status === 'delivered' || result.delivery?.status === 'accepted')
    );
  }
```

- [ ] **Step 4: Refactor `send` to release the lock early**

Replace the existing `send` method body (after the two participant checks) with:

```ts
let release: (() => void) | undefined;
if (opts.conversationId) {
  release = await this.acquireLock(opts.conversationId);
}
const releaseLock = () => {
  release?.();
  release = undefined;
};
try {
  return await this.sendInner(opts, releaseLock);
} finally {
  releaseLock();
}
```

Also update the method doc comment:

```ts
/**
 * Synchronous send. For human recipients (`type: 'user'`) this waits for the
 * human's next message and returns its text as `response`. The reply deadline
 * is `opts.timeoutMs` when supplied, else the sender participant's
 * `replyTimeoutMs`, else the collective `communication.replyTimeoutMs`, else
 * 30 minutes; `null` waits indefinitely.
 */
```

- [ ] **Step 5: Add registration, waiting, and consumption to `sendInner`**

Change the signature:

```ts
  private async sendInner(
    opts: SendOptions,
    releaseLock: () => void,
  ): Promise<MessageRouterResult> {
```

After the inbound append/lifecycle block and before `const runtime = this.registry.build(...)`, insert:

```ts
if (this.resolveReplyWaiters(thread.id, opts.senderId, inbound.content)) {
  return { conversationId: thread.id, status: 'success' };
}

const expectsHumanReply = recipient.type === 'user' && opts.replyTo === undefined;
const replyWaiter = expectsHumanReply
  ? this.registerReplyWaiter(thread.id, recipient.id)
  : undefined;
```

Replace the existing `try`/`catch` dispatch block with:

```ts
try {
  const result = await runtime.handle(inbound, runtimeContext);
  let humanReply: string | undefined;
  if (replyWaiter && this.isDeliveredVoid(result)) {
    const timeoutMs = this.resolveReplyTimeout(opts);
    releaseLock();
    const outcome = await this.awaitReply(replyWaiter.promise, timeoutMs, opts.context.signal);
    if (outcome.kind === 'reply') {
      humanReply = outcome.text;
    } else {
      replyWaiter.unregister();
      if (outcome.kind === 'timeout') {
        return { conversationId: thread.id, status: 'timeout', partial: true };
      }
      return { conversationId: thread.id, status: 'error', error: 'Runtime cancelled' };
    }
  }
  const completed = await this.completeResponse(
    {
      thread,
      recipientId: recipient.id,
      responseRecipientId: opts.senderId,
      lifecycleState,
    },
    result,
  );
  return humanReply === undefined ? completed : { ...completed, response: humanReply };
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { conversationId: thread.id, status: 'error', error: msg };
} finally {
  replyWaiter?.unregister();
}
```

- [ ] **Step 6: Update the `SendOptions.timeoutMs` doc comment**

In `packages/core/src/tools/Tool.ts`, replace:

```ts
/**
 * Per-call deadline for the recipient's response. Enforced by `sendStream`
 * only — the synchronous `send` path ignores it (partial-response
 * persistence is a streaming concept).
 */
```

with:

```ts
/**
 * Per-call deadline for the recipient's response. Enforced by `sendStream`
 * and by synchronous sends to human participants (`type: 'user'`).
 */
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "synchronous human reply"`

Expected: PASS (all tests in the new block).

- [ ] **Step 8: Run the full router test file**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`

Expected: PASS — no regressions in existing send/delivery behavior.

- [ ] **Step 9: Commit**

```bash
npx prettier --write packages/core/src/runtime/MessageRouter.ts \
  packages/core/src/runtime/MessageRouter.test.ts packages/core/src/tools/Tool.ts
git add packages/core/src/runtime/MessageRouter.ts \
  packages/core/src/runtime/MessageRouter.test.ts packages/core/src/tools/Tool.ts
git commit -m "feat(core): wait for human replies in synchronous send"
```

---

## Task 3: Waiting and consumption in `sendStreamInner`

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.ts`
- Test: `packages/core/src/runtime/MessageRouter.test.ts` (same `describe` block)

**Interfaces:**

- Consumes: the helpers and config from Task 2.
- Produces:
  - `MessageRouter.sendStream` waits for human replies on the same conditions as `send`.
  - Success: `{ conversationId, status: 'success', response: <human text> }` with no assistant chunks.
  - Timeout: one `{ type: 'call_timeout', timeoutMs }` chunk, then `{ conversationId, status: 'timeout', partial: true }`.
  - Cancellation: `{ conversationId, status: 'error', error: 'Runtime cancelled' }`.
  - Inbound replies routed through `sendStream` are consumed too.

- [ ] **Step 1: Write the failing tests**

Append these tests inside the `describe('MessageRouter: synchronous human reply', ...)` block from Task 2:

```ts
it('returns the human reply as the stream result', async () => {
  const { router, baseContext, store, handleCalls, delivered } = await setupHumanRouter();
  const conversation = await newConversation(store);

  const stream = router.sendStream({
    senderId: 'mock-1',
    recipientId: 'op',
    message: 'question?',
    conversationId: conversation.id,
    context: baseContext,
  });
  const iteration = (async () => {
    const chunks: LLMChunk[] = [];
    let next = await stream.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await stream.next();
    }
    return { chunks, result: next.value };
  })();
  await delivered;

  const reply = await router.send({
    senderId: 'op',
    recipientId: 'mock-1',
    message: 'the answer',
    conversationId: conversation.id,
    context: baseContext,
  });
  expect(reply).toMatchObject({ status: 'success' });

  const { chunks, result } = await iteration;
  expect(chunks).toEqual([]);
  expect(result).toMatchObject({ status: 'success', response: 'the answer' });
  expect(handleCalls).toEqual([]);
});

it('consumes a reply routed through sendStream', async () => {
  const { router, baseContext, store, handleCalls, delivered } = await setupHumanRouter();
  const conversation = await newConversation(store);

  const pending = router.send({
    senderId: 'mock-1',
    recipientId: 'op',
    message: 'question?',
    conversationId: conversation.id,
    context: baseContext,
  });
  await delivered;

  const stream = router.sendStream({
    senderId: 'op',
    recipientId: 'mock-1',
    message: 'the answer',
    conversationId: conversation.id,
    context: baseContext,
  });
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  expect(next.value).toMatchObject({ status: 'success' });

  await expect(pending).resolves.toMatchObject({
    status: 'success',
    response: 'the answer',
  });
  expect(handleCalls).toEqual([]);
});

it('times out the stream with a call_timeout chunk', async () => {
  const { router, baseContext, store } = await setupHumanRouter({
    communication: { replyTimeoutMs: 20 },
  });
  const conversation = await newConversation(store);

  const stream = router.sendStream({
    senderId: 'mock-1',
    recipientId: 'op',
    message: 'question?',
    conversationId: conversation.id,
    context: baseContext,
  });
  const chunks: LLMChunk[] = [];
  let next = await stream.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await stream.next();
  }

  expect(chunks).toContainEqual({ type: 'call_timeout', timeoutMs: 20 });
  expect(next.value).toMatchObject({ status: 'timeout', partial: true });
});

it('uses explicit timeoutMs as the stream reply deadline', async () => {
  const { router, baseContext, store } = await setupHumanRouter();
  const conversation = await newConversation(store);

  const stream = router.sendStream({
    senderId: 'mock-1',
    recipientId: 'op',
    message: 'question?',
    conversationId: conversation.id,
    timeoutMs: 20,
    context: baseContext,
  });
  const chunks: LLMChunk[] = [];
  let next = await stream.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await stream.next();
  }

  expect(chunks).toContainEqual({ type: 'call_timeout', timeoutMs: 20 });
  expect(next.value).toMatchObject({ status: 'timeout', partial: true });
});

it('cancels the stream wait on caller abort', async () => {
  const { router, baseContext, store, delivered } = await setupHumanRouter({
    communication: { replyTimeoutMs: null },
  });
  const conversation = await newConversation(store);
  const controller = new AbortController();

  const stream = router.sendStream({
    senderId: 'mock-1',
    recipientId: 'op',
    message: 'question?',
    conversationId: conversation.id,
    context: { ...baseContext, signal: controller.signal },
  });
  const terminal = (async () => {
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    return next.value;
  })();
  await delivered;
  controller.abort();

  await expect(terminal).resolves.toMatchObject({
    status: 'error',
    error: 'Runtime cancelled',
  });
});

it('returns dispatched immediately from sendStream when replyTo is set', async () => {
  const { router, baseContext, store } = await setupHumanRouter({
    communication: { replyTimeoutMs: null },
  });
  const conversation = await newConversation(store);

  const stream = router.sendStream({
    senderId: 'mock-1',
    recipientId: 'op',
    message: 'hi',
    conversationId: conversation.id,
    replyTo: 'mock-1',
    context: baseContext,
  });
  const next = await stream.next();
  expect(next).toMatchObject({ done: true, value: { status: 'dispatched' } });
  await router.drain();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "human reply as the stream result"`

Expected: FAIL — the stream returns success immediately without `response`.

- [ ] **Step 3: Add early lock release to `sendStreamWithController`**

Replace the method body with:

```ts
  private async *sendStreamWithController(
    opts: SendOptions,
  ): AsyncGenerator<LLMChunk, MessageRouterResult> {
    let release: (() => void) | undefined;
    let lockedConversationId: string | undefined;
    const ensureLock = async (conversationId: string) => {
      if (lockedConversationId === conversationId) return;
      release?.();
      release = await this.acquireLock(conversationId);
      lockedConversationId = conversationId;
    };
    const releaseLock = () => {
      release?.();
      release = undefined;
      lockedConversationId = undefined;
    };
    try {
      if (opts.conversationId) await ensureLock(opts.conversationId);
      return yield* this.sendStreamInner(opts, ensureLock, releaseLock);
    } finally {
      releaseLock();
    }
  }
```

- [ ] **Step 4: Add registration, waiting, and consumption to `sendStreamInner`**

Change the signature:

```ts
  private async *sendStreamInner(
    opts: SendOptions,
    ensureLock: (conversationId: string) => Promise<void>,
    releaseLock: () => void,
  ): AsyncGenerator<LLMChunk, MessageRouterResult> {
```

After the inbound append/lifecycle block and before `const runtime = this.registry.build(...)`, insert:

```ts
if (this.resolveReplyWaiters(thread.id, opts.senderId, inbound.content)) {
  return { conversationId: thread.id, status: 'success' };
}

const expectsHumanReply = recipient.type === 'user' && opts.replyTo === undefined;
const replyWaiter = expectsHumanReply
  ? this.registerReplyWaiter(thread.id, recipient.id)
  : undefined;
```

Replace the non-streaming branch (the `else` after `if (runtime.handleStream)`) with:

```ts
      } else {
        const result = await runtime.handle(inbound, runtimeContext);
        let humanReply: string | undefined;
        if (replyWaiter && this.isDeliveredVoid(result)) {
          const timeoutMs = this.resolveReplyTimeout(opts);
          releaseLock();
          const outcome = await this.awaitReply(
            replyWaiter.promise,
            timeoutMs,
            opts.context.signal,
          );
          if (outcome.kind === 'reply') {
            humanReply = outcome.text;
          } else {
            replyWaiter.unregister();
            if (outcome.kind === 'timeout') {
              yield { type: 'call_timeout', timeoutMs: timeoutMs! };
              return { conversationId: thread.id, status: 'timeout', partial: true };
            }
            return { conversationId: thread.id, status: 'error', error: 'Runtime cancelled' };
          }
        }
        replyWaiter?.unregister();
        if (transformer) {
          try {
            const finished = await transformer.finish(result);
            for (const chunk of finished.chunks) yield chunk;
            if (result.kind === 'response') return finished.result;
          } catch (error) {
            if (error instanceof MiddlewareStreamError) {
              for (const chunk of error.chunks) yield chunk;
              return this.mapLifecycleResult(error.lifecycleResult, thread.id, opts.context);
            }
            throw error;
          }
        }
        const completed = await this.completeResponse(
          {
            thread,
            recipientId: recipient.id,
            responseRecipientId: opts.replyTo ?? opts.senderId,
            lifecycleState,
          },
          result,
        );
        return humanReply === undefined ? completed : { ...completed, response: humanReply };
      }
```

Add waiter cleanup to the existing `finally` block at the end of `sendStreamInner`, before the runtime-stream cleanup:

```ts
    } finally {
      replyWaiter?.unregister();
      if (!streamFinished && runtimeStream) {
```

- [ ] **Step 5: Avoid a duplicate `call_timeout` chunk**

In `sendStreamWithDeadline`, replace:

```ts
      if (!timedOut) return result;
      yield { type: 'call_timeout', timeoutMs: opts.timeoutMs! };
      return { ...result, status: 'timeout', partial: true };
```

with:

```ts
      if (!timedOut || result.status === 'timeout') return result;
      yield { type: 'call_timeout', timeoutMs: opts.timeoutMs! };
      return { ...result, status: 'timeout', partial: true };
```

- [ ] **Step 6: Run the new stream tests**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "synchronous human reply"`

Expected: PASS.

- [ ] **Step 7: Run the full router test file**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`

Expected: PASS — existing stream timeout, cancellation, and middleware tests unchanged.

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/core/src/runtime/MessageRouter.ts \
  packages/core/src/runtime/MessageRouter.test.ts
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat(core): wait for human replies in streaming send"
```

---

## Task 4: Service context timeout mapping

**Files:**

- Modify: `packages/core/src/service/ServiceContextImpl.ts:70-90`
- Test: `packages/core/src/service/ServiceContextImpl.test.ts`

**Interfaces:**

- Consumes: `MessageRouterResult.status === 'timeout'` from Task 2.
- Produces: `ServiceContext.communicate` returns `{ status: 'error', error: 'deadline exceeded', conversationId }` on a router timeout.

- [ ] **Step 1: Write the failing test**

Add inside `describe('communicate', ...)` in `packages/core/src/service/ServiceContextImpl.test.ts`:

```ts
it('maps a router timeout to deadline exceeded', async () => {
  const { dir: d, deps, mockRouter } = await setup();
  dir = d;
  vi.mocked(mockRouter.send).mockResolvedValueOnce({
    conversationId: 'conv-timeout',
    status: 'timeout',
    partial: true,
  });
  const ctx = new ServiceContextImpl(deps);

  const result = await ctx.communicate('op-1', 'question');

  expect(result).toMatchObject({
    conversationId: 'conv-timeout',
    status: 'error',
    error: 'deadline exceeded',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/service/ServiceContextImpl.test.ts -t "maps a router timeout"`

Expected: FAIL — status is `'success'` because the current mapping falls through.

- [ ] **Step 3: Implement the mapping**

In `packages/core/src/service/ServiceContextImpl.ts`, replace the return block in `communicate`:

```ts
return {
  conversationId: result.conversationId,
  response: result.response,
  status:
    result.status === 'dispatched'
      ? 'dispatched'
      : result.status === 'error' || result.status === 'timeout'
        ? 'error'
        : 'success',
  error: result.status === 'timeout' ? 'deadline exceeded' : result.error,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/service/ServiceContextImpl.test.ts -t "maps a router timeout"`

Expected: PASS.

- [ ] **Step 5: Run the full service context test file**

Run: `npx vitest run packages/core/src/service/ServiceContextImpl.test.ts`

Expected: PASS — existing success, dispatched, and replyTo mappings unchanged.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/core/src/service/ServiceContextImpl.ts \
  packages/core/src/service/ServiceContextImpl.test.ts
git add packages/core/src/service/ServiceContextImpl.ts \
  packages/core/src/service/ServiceContextImpl.test.ts
git commit -m "feat(core): report human reply timeouts from service communicate"
```

---

## Task 5: Documentation and full verification

**Files:**

- Modify: `docs/legion-v2-greenfield-spec.md:203-213`
- Verify: whole repo.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: updated design documentation and a clean verification run.

- [ ] **Step 1: Update the greenfield spec**

After the synchronous-call code block in `docs/legion-v2-greenfield-spec.md`, add:

```markdown
For a `user` participant (`type: 'user'`), a synchronous `communicate` blocks
until that human's next message in the same conversation arrives and returns its
text as the tool result. The reply is persisted and consumed by the waiting
call, so it is not also dispatched to the recipient's bot. The wait is bounded
by the collective `communication.replyTimeoutMs` (default 30 minutes; `null`
waits indefinitely), overridable per participant via `replyTimeoutMs` and per
call via `timeoutMs`.
```

- [ ] **Step 2: Run formatting**

Run: `npm run format:check`

Expected: PASS. If it fails, run `npx prettier --write` on the reported files and re-run.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Run the full unit test suite**

Run: `npm test`

Expected: PASS. The baseline at `4a173a9` was 1360 passed / 21 skipped; the new tests add to the passed count.

- [ ] **Step 5: Commit**

```bash
npx prettier --write docs/legion-v2-greenfield-spec.md
git add docs/legion-v2-greenfield-spec.md
git commit -m "docs: describe synchronous human reply waiting"
```

---

## Self-Review

**Spec coverage:**

- §3 semantics (user recipient, no `replyTo`, `void` + delivered/accepted): Task 2 Steps 3 and 5; Task 3 Step 4.
- §4.1 waiter registry: Task 2 Step 3.
- §4.2 registration before delivery, early lock release, `completeResponse` then response: Task 2 Steps 4-5; Task 3 Steps 3-4.
- §4.3 inbound consumption in both paths, middleware `respond` precedence: Task 2 Step 5 and Task 3 Step 4 (inserted after the lifecycle block).
- §4.4 timeout precedence, invalid-value warning, timeout result and `call_timeout`, cancellation: Task 2 Step 3 and Steps 1/5; Task 3 Steps 1/4/5.
- §5 configuration and constructor plumbing: Task 1.
- §6 service-context timeout mapping: Task 4.
- §7 connector behavior: no connector changes; documentation in Task 5.
- §8 edge cases: covered by the waiter-before-delivery design and the tests for no-waiter, late reply, cancellation, and delivery failure.
- §10 tests: Tasks 2, 3, and 4.
- §11 compatibility: optional constructor argument and optional participant field; existing call sites compile unchanged.

**Placeholder scan:** No TBD/TODO; every code step contains the actual code.

**Type consistency:** `CommunicationConfig`, `replyTimeoutMs`, `ReplyWaiterHandle`, `ReplyOutcome`, `resolveReplyTimeout`, `isDeliveredVoid`, `registerReplyWaiter`, `resolveReplyWaiters`, and `awaitReply` are defined once in Task 2 and reused verbatim in Task 3. `MessageRouterResult.status` already includes `'timeout'` and `partial` already exists, so no type changes are needed there.
