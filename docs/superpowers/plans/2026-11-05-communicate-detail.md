# `communicate` Detail, Model Override and Deadline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `detail`, `model` and `timeoutMs` to the `communicate` tool, plumb them through the router and runtimes, and render detail in the web and Telegram connectors.

**Architecture:** The tool validates and passes parameters into `MessageRouter`. The router owns the deadline, attaches run metadata, and forwards a model override into the recipient's `RuntimeContext`. Connectors clamp the requested detail against their own maximum and decide rendering.

**Tech Stack:** TypeScript (strict, NodeNext, ESM), Vitest, Vue 3 + Vite + Tailwind, grammY, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-05-communicate-detail-design.md`

## Global Constraints

- Node >= 20; pure ESM; `.js` extensions on relative imports in `.ts` source.
- `verbatimModuleSyntax`: type-only imports use `import type`.
- Prettier: single quotes, semicolons, trailing commas, 100 cols, 2 spaces.
- Legion gate before claiming done: `npm run format:check` → `npm run typecheck` → `npm test`; web changes also `npm run test --workspace=packages/web`.
- Telegram repo gate: `npm run format:check` → `npm run typecheck` → `npm test` inside `repos/legion-connector-telegram-v2`.
- Do not add authorization logic to the tool; `AuthEngine` remains the policy layer.
- Do not change behaviour for calls that omit the new parameters.
- Legion work happens in `/home/chris/workspace/threads/2026-11-02-legion-v2/legion-integration` on branch `integration/telegram-v2-and-web-ui`.
- Telegram work happens in `/home/chris/workspace/repos/legion-connector-telegram-v2` on a new branch `feat/communicate-detail` created from `connector-v2`.
- Never edit `dist/`; build it with `npm run build`.

---

### Task 1: Core contract — types, send options, tool parameters

**Files:**

- Modify: `packages/types/src/streaming.ts`
- Modify: `packages/core/src/tools/Tool.ts`
- Modify: `packages/core/src/runtime/Runtime.ts`
- Modify: `packages/core/src/tools/communicate-tool.ts`
- Test: `packages/core/src/tools/communicate-tool.test.ts`

**Interfaces:**

- Consumes: existing `ToolContext`, `MessageRouterPort`.
- Produces: `DetailLevel = 'minimal' | 'standard' | 'full'`; `LLMChunk` gains `{ type: 'call_timeout'; timeoutMs: number }`; `SendOptions` gains `detail?: DetailLevel`, `model?: string`, `timeoutMs?: number`; `MessageRouterResult` gains `status: 'timeout'` and `meta?: { model?: string; usage?: MessageUsage; iterations?: number }`; `RuntimeContext` gains `modelOverride?: string`.

- [ ] **Step 1: Add the shared types**

In `packages/types/src/streaming.ts`, add above `LLMChunk`:

```ts
/** Presentation level requested by a caller; connectors clamp it to their own maximum. */
export type DetailLevel = 'minimal' | 'standard' | 'full';
```

Add the new variant to `LLMChunk`:

```ts
export type LLMChunk =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'message_snapshot'; content: string; reasoning?: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string }
  | { type: 'call_timeout'; timeoutMs: number };
```

Export `DetailLevel` automatically: `packages/types/src/index.ts` already has
`export * from './streaming.js';`, so no index change is needed.

In `packages/core/src/tools/Tool.ts`:

```ts
import type {
  DetailLevel,
  JSONSchema,
  ToolResult,
  ParticipantConfig,
  WorkspaceConfig,
  StreamChunk,
  LLMChunk,
  ConversationOrigin,
  MessageUsage,
  MiddlewareInstanceConfig,
  MiddlewareCheckpoint,
} from '@legion-collective/types';
```

Update `MessageRouterResult`:

```ts
export interface MessageRouterResult {
  conversationId: string;
  response?: string;
  status: 'success' | 'error' | 'dispatched' | 'pending_approval' | 'timeout';
  error?: string;
  partial?: boolean;
  storedMessageId?: string;
  approvalId?: string;
  checkpointId?: string;
  pendingParticipantId?: string;
  approvalRequests?: PendingApproval[];
  meta?: { model?: string; usage?: MessageUsage; iterations?: number };
}
```

Update `SendOptions` and the `MessageRouterPort.send` / `sendStream` option types:

```ts
export interface SendOptions {
  senderId: string;
  recipientId: string;
  message: string;
  conversationId?: string;
  replyTo?: string;
  origin?: ConversationOrigin;
  detail?: DetailLevel;
  model?: string;
  timeoutMs?: number;
  context: ToolContext;
}
```

```ts
send(opts: {
  senderId: string;
  recipientId: string;
  message: string;
  conversationId?: string;
  replyTo?: string;
  origin?: ConversationOrigin;
  detail?: DetailLevel;
  model?: string;
  timeoutMs?: number;
  context: ToolContext;
}): Promise<MessageRouterResult>;
```

and the same three fields on `sendStream`'s inline option type.

In `packages/core/src/runtime/Runtime.ts`, add to `RuntimeContext`:

```ts
  /** Per-call model override supplied by the caller; falls back to the participant's model. */
  modelOverride?: string;
```

- [ ] **Step 2: Write failing tool tests**

Append to `packages/core/src/tools/communicate-tool.test.ts`:

```ts
describe('communicate parameter handling', () => {
  function fakeRouter(captured: unknown[]) {
    return {
      sendStream(opts: unknown) {
        captured.push(opts);
        return (async function* () {
          return { conversationId: 'conv-1', response: 'ok', status: 'success' } as const;
        })();
      },
    };
  }

  function contextWith(router: unknown): ToolContext {
    return {
      participant: { id: 'agent-a', name: 'A', type: 'mock', tools: {}, status: 'active' },
      conversationId: 'seed',
      communicationDepth: 0,
      messageRouter: router,
    } as unknown as ToolContext;
  }

  async function run(args: unknown, router: unknown) {
    const stream = communicateTool.stream(args, contextWith(router));
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    return next.value;
  }

  it('rejects an invalid detail level', async () => {
    const result = await run({ to: 'b', message: 'hi', detail: 'verbose' }, fakeRouter([]));
    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid detail');
  });

  it('rejects a non-positive timeoutMs', async () => {
    const result = await run({ to: 'b', message: 'hi', timeoutMs: 0 }, fakeRouter([]));
    expect(result.status).toBe('error');
    expect(result.error).toContain('timeoutMs');
  });

  it('clamps timeoutMs to 24 hours and passes detail and model through', async () => {
    const captured: unknown[] = [];
    const result = await run(
      { to: 'b', message: 'hi', detail: 'full', model: 'fast-model', timeoutMs: 999_999_999 },
      fakeRouter(captured),
    );
    expect(result.status).toBe('success');
    expect(captured[0]).toMatchObject({
      detail: 'full',
      model: 'fast-model',
      timeoutMs: 86_400_000,
    });
  });

  it('defaults detail to standard', async () => {
    const captured: unknown[] = [];
    await run({ to: 'b', message: 'hi' }, fakeRouter(captured));
    expect(captured[0]).toMatchObject({ detail: 'standard' });
  });

  it('maps a timeout result to a partial error', async () => {
    const router = {
      sendStream() {
        return (async function* () {
          return {
            conversationId: 'conv-1',
            response: 'half an answer',
            status: 'timeout',
            partial: true,
          } as const;
        })();
      },
    };
    const result = await run({ to: 'b', message: 'hi', timeoutMs: 10 }, router);
    expect(result).toEqual({
      status: 'error',
      error: 'deadline exceeded',
      data: { conversationId: 'conv-1', response: 'half an answer', partial: true },
    });
  });

  it('returns meta only at full detail', async () => {
    const router = {
      sendStream() {
        return (async function* () {
          return {
            conversationId: 'conv-1',
            response: 'ok',
            status: 'success',
            meta: { model: 'fast-model', iterations: 2 },
          } as const;
        })();
      },
    };
    const full = await run({ to: 'b', message: 'hi', detail: 'full' }, router);
    expect(full.data).toMatchObject({ meta: { model: 'fast-model', iterations: 2 } });
    const standard = await run({ to: 'b', message: 'hi' }, router);
    expect((standard.data as Record<string, unknown>).meta).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/communicate-tool.test.ts -t "communicate parameter handling"`
Expected: FAIL — invalid `detail` is accepted and the options are not passed.

- [ ] **Step 4: Implement validation and passthrough**

Replace `packages/core/src/tools/communicate-tool.ts` with:

```ts
import type { DetailLevel, ToolResult, LLMChunk } from '@legion-collective/types';
import type { MessageRouterResult, StreamingTool, ToolContext } from './Tool.js';

const DETAIL_LEVELS: readonly DetailLevel[] = ['minimal', 'standard', 'full'];
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseDetail(value: unknown): Parsed<DetailLevel> {
  if (value === undefined) return { ok: true, value: 'standard' };
  if (typeof value === 'string' && (DETAIL_LEVELS as readonly string[]).includes(value)) {
    return { ok: true, value: value as DetailLevel };
  }
  return {
    ok: false,
    error: `communicate: invalid detail '${String(value)}' (expected minimal, standard or full)`,
  };
}

function parseTimeout(value: unknown): Parsed<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'communicate: timeoutMs must be a positive integer' };
  }
  return { ok: true, value: Math.min(value, MAX_TIMEOUT_MS) };
}

function parseModel(value: unknown): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: 'communicate: model must be a non-empty string' };
  }
  return { ok: true, value };
}

export const communicateTool: StreamingTool = {
  name: 'communicate',
  description:
    "Send a message to another participant. Streams the recipient's response as it is generated. Pass replyTo for fire-and-forget (returns immediately, response routed elsewhere). detail is a presentation hint for connectors; model overrides the recipient's model for this call; timeoutMs bounds a synchronous call.",
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target participant id' },
      message: { type: 'string' },
      conversationId: { type: 'string', description: 'Join an existing thread' },
      replyTo: {
        type: 'string',
        description: 'Route the response to this participant (fire-and-forget)',
      },
      detail: {
        type: 'string',
        enum: ['minimal', 'standard', 'full'],
        description: 'Presentation detail requested from connectors (default standard)',
      },
      model: { type: 'string', description: 'Override the recipient model for this call' },
      timeoutMs: {
        type: 'integer',
        description: 'Deadline in milliseconds for a synchronous call (max 24h)',
      },
    },
    required: ['to', 'message'],
  },

  async *stream(args: unknown, context: ToolContext): AsyncGenerator<LLMChunk, ToolResult> {
    const { to, message, conversationId, replyTo } = args as {
      to: string;
      message: string;
      conversationId?: string;
      replyTo?: string;
    };
    const raw = args as Record<string, unknown>;

    const detail = parseDetail(raw.detail);
    if (!detail.ok) return { status: 'error', error: detail.error };
    const timeoutMs = parseTimeout(raw.timeoutMs);
    if (!timeoutMs.ok) return { status: 'error', error: timeoutMs.error };
    const model = parseModel(raw.model);
    if (!model.ok) return { status: 'error', error: model.error };

    if (!context.messageRouter) {
      return { status: 'error', error: 'communicate: messageRouter not available in context' };
    }

    let result: MessageRouterResult;
    try {
      result = yield* context.messageRouter.sendStream({
        senderId: context.participant.id,
        recipientId: to,
        message,
        conversationId,
        replyTo,
        detail: detail.value,
        model: model.value,
        timeoutMs: timeoutMs.value,
        context: {
          ...context,
          communicationDepth: (context.communicationDepth ?? 0) + 1,
        },
      });
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    if (result.status === 'error') {
      return {
        status: 'error',
        error: result.error,
        data: { conversationId: result.conversationId },
      };
    }
    if (result.status === 'pending_approval') {
      return {
        status: 'pending_approval',
        data: { conversationId: result.conversationId, approvalRequests: result.approvalRequests },
      };
    }
    if (result.status === 'timeout') {
      return {
        status: 'error',
        error: 'deadline exceeded',
        data: {
          conversationId: result.conversationId,
          response: result.response,
          partial: true,
        },
      };
    }
    const data: Record<string, unknown> = {
      conversationId: result.conversationId,
      response: result.response,
      status: result.status,
    };
    if (detail.value === 'full' && result.meta !== undefined) data.meta = result.meta;
    return { status: 'success', data };
  },
};
```

Note the `parseModel` sentinel is awkward; keep it simple by returning `{ ok: false }` shapes instead if the compiler complains. The intent is: any validation failure returns a tool error before routing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/tools/communicate-tool.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/streaming.ts packages/core/src/tools/Tool.ts packages/core/src/runtime/Runtime.ts packages/core/src/tools/communicate-tool.ts packages/core/src/tools/communicate-tool.test.ts
git commit -m "feat(communicate): add detail, model and timeout parameters"
```

---

### Task 2: Router deadline, metadata and timeout chunk

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.ts`
- Test: `packages/core/src/runtime/MessageRouter.test.ts`

**Interfaces:**

- Consumes: `SendOptions.timeoutMs`, `SendOptions.detail`, `MessageRouterResult.meta`, `LLMChunk` `call_timeout`.
- Produces: `sendStream` returns `{ status: 'timeout', partial: true, response }` after the deadline and yields `{ type: 'call_timeout', timeoutMs }`; every `sendStream` result carries `meta`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('MessageRouter', ...)` block in `packages/core/src/runtime/MessageRouter.test.ts`:

```ts
  it('returns a partial timeout result and emits a call_timeout chunk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legion-timeout-'));
    try {
      const base = await setup(dir);
      const registry = new RuntimeRegistry();
      registry.registerFactory('mock', () => ({
        async handle() {
          return { kind: 'response', content: 'unused' } as const;
        },
        async *handleStream() {
          yield { type: 'iteration_start', iteration: 0 } as const;
          yield { type: 'text_delta', delta: 'partial answer' } as const;
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield { type: 'text_delta', delta: ' more' } as const;
          return { kind: 'response', content: 'partial answer more' } as const;
        },
      }));
      const router = new MessageRouter(base.store, registry, base.collective, base.eventBus);

      const stream = router.sendStream({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'hi',
        timeoutMs: 10,
        context: base.baseContext,
      });
      const chunks: LLMChunk[] = [];
      let next = await stream.next();
      while (!next.done) {
        chunks.push(next.value);
        next = await stream.next();
      }

      expect(next.value).toMatchObject({
        status: 'timeout',
        partial: true,
        response: 'partial answer',
      });
      expect(chunks).toContainEqual({ type: 'call_timeout', timeoutMs: 10 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('attaches run metadata to stream results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legion-meta-'));
    try {
      const base = await setupReasoningRouter(dir);
      const stream = base.router.sendStream({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'hi',
        context: base.baseContext,
      });
      let next = await stream.next();
      while (!next.done) next = await stream.next();
      expect(next.value.meta).toMatchObject({ iterations: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "timeout"`
Expected: FAIL — `timeoutMs` is ignored and no `call_timeout` chunk is emitted.

- [ ] **Step 3: Implement the deadline and metadata**

Replace the existing `sendStream` method (currently an object-literal generator wrapper) with:

```ts
  async *sendStream(opts: SendOptions): AsyncGenerator<LLMChunk, MessageRouterResult> {
    const controller = new AbortController();
    const signal = opts.context.signal
      ? AbortSignal.any([opts.context.signal, controller.signal])
      : controller.signal;
    let timedOut = false;
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, opts.timeoutMs);

    const inner = this.sendStreamWithController({
      ...opts,
      context: { ...opts.context, signal },
    });
    let iterations = 0;
    let completed = false;
    try {
      let next = await inner.next();
      while (!next.done) {
        if (next.value.type === 'iteration_start') iterations += 1;
        yield next.value;
        next = await inner.next();
      }
      const recipient = this.collective.get(opts.recipientId);
      const model =
        opts.model ?? (recipient?.type === 'agent' ? recipient.model.model : undefined);
      const meta: MessageRouterResult['meta'] = {
        ...(model === undefined ? {} : { model }),
        ...(iterations === 0 ? {} : { iterations }),
      };
      const result: MessageRouterResult = { ...next.value, meta };
      completed = true;
      if (!timedOut) return result;
      yield { type: 'call_timeout', timeoutMs: opts.timeoutMs! };
      return { ...result, status: 'timeout', partial: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!completed) {
        controller.abort();
        void inner.return(undefined as never).catch(() => undefined);
      }
    }
  }
```

`sendStreamWithController` already accepts `SendOptions` and applies `opts.context.signal`; no signature change is needed. The `AbortController` in `sendStreamWithController` remains the cancellation path for early consumer returns.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: PASS (including existing stream tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat(router): enforce communicate deadlines and attach run metadata"
```

---

### Task 3: Model override plumbing

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.ts`
- Modify: `packages/core/src/runtime/AgentRuntime.ts`
- Test: `packages/core/src/runtime/AgentRuntime.test.ts`

**Interfaces:**

- Consumes: `SendOptions.model`, `RuntimeContext.modelOverride`.
- Produces: the recipient runtime resolves and uses `modelOverride`; unresolvable overrides return `{ kind: 'middleware_abort', error: 'model override unavailable: <model>' }`.

- [ ] **Step 1: Write failing AgentRuntime tests**

Append to `packages/core/src/runtime/AgentRuntime.test.ts` inside `describe('AgentRuntime', ...)`:

```ts
  it('uses a model override for provider resolution and streaming', async () => {
    const { context, inbound } = await makeSetup([]);
    const defaultProvider: Provider = {
      async *stream() {
        yield { type: 'text_delta', delta: 'default' };
        yield { type: 'done', stopReason: 'stop' };
      },
    };
    const overrideProvider: Provider = {
      async *stream() {
        yield { type: 'text_delta', delta: 'override' };
        yield { type: 'done', stopReason: 'stop' };
      },
    };
    const router = new MockModelRouter(
      new Map([
        ['test-model', defaultProvider],
        ['override-model', overrideProvider],
      ]),
    ) as ModelRouter;
    const runtime = new AgentRuntime(
      'agent-1',
      router,
      new UsageCalculator(new MockPricingSource({}), new Map()),
    );

    const result = await runtime.handle(inbound, { ...context, modelOverride: 'override-model' });
    expect(result).toMatchObject({ kind: 'response', content: 'override' });
  });

  it('fails closed when a model override cannot be resolved', async () => {
    const { context, inbound, router } = await makeSetup([]);
    const runtime = new AgentRuntime(
      'agent-1',
      router,
      new UsageCalculator(new MockPricingSource({}), new Map()),
    );
    const result = await runtime.handle(inbound, { ...context, modelOverride: 'missing-model' });
    expect(result).toEqual({
      kind: 'middleware_abort',
      error: 'model override unavailable: missing-model',
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts -t "model override"`
Expected: FAIL — the override is ignored.

- [ ] **Step 3: Forward the override through the router**

In `packages/core/src/runtime/MessageRouter.ts`, both `sendInner` and `sendStreamInner` call `buildRuntimeContext`. Add the override to the context object passed in:

```ts
    const runtimeContext = this.buildRuntimeContext(
      thread,
      recipient.id,
      { ...opts.context, communicationDepth: depth, modelOverride: opts.model },
      depth,
      /* existing middleware argument unchanged */
    );
```

Apply the same change at the second call site (the `sendInner` path around line 945). `buildRuntimeContext` spreads `toolContext`, so `modelOverride` flows into `RuntimeContext`.

- [ ] **Step 4: Honour the override in AgentRuntime**

In `packages/core/src/runtime/AgentRuntime.ts`, inside `runLoop`, replace the provider-resolution block:

```ts
    const modelId = context.modelOverride ?? agent.model.model;
    const effectiveModel: ModelConfig =
      context.modelOverride === undefined
        ? agent.model
        : { ...agent.model, model: context.modelOverride };
    let provider: Provider | null;
    let providerId: string | undefined;
    try {
      const resolved = await this.router.resolveWithId(modelId);
      provider = resolved?.provider ?? null;
      providerId = resolved?.providerId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (context.modelOverride !== undefined) {
        return this.withActions(
          { kind: 'middleware_abort', error: `model override unavailable: ${modelId}` },
          actions,
        );
      }
      return this.withActions({ kind: 'response', content: `[AgentRuntime error: ${msg}]` }, actions);
    }
    if (!provider) {
      if (context.modelOverride !== undefined) {
        return this.withActions(
          { kind: 'middleware_abort', error: `model override unavailable: ${modelId}` },
          actions,
        );
      }
      return this.withActions(
        { kind: 'response', content: `[AgentRuntime error: no provider available for model '${modelId}']` },
        actions,
      );
    }
```

Import `ModelConfig` from `@legion-collective/types` if it is not already imported.

Change the provider call to pass `effectiveModel`:

```ts
        for await (const chunk of provider.stream(messages, providerTools, effectiveModel, {
          signal: context.signal,
        })) {
```

Update `computeUsage` to accept the effective model id:

```ts
  private async computeUsage(
    providerId: string | undefined,
    agent: AgentConfig,
    response: {
      content: string | null;
      stopReason: ProviderStopReason;
      usage?: ProviderUsage;
      cost?: number;
    },
    modelId: string = agent.model.model,
  ): Promise<MessageUsage | undefined> {
    if (!response.usage || !this.usageCalculator) return undefined;
    return this.usageCalculator.compute(providerId ?? 'unknown', modelId, response.usage, response.cost);
  }
```

Pass `modelId` at both call sites: `this.computeUsage(providerId, agent, response, modelId)`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts packages/core/src/runtime/MessageRouter.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/AgentRuntime.ts packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "feat(runtime): honour per-call model overrides"
```

---

### Task 4: Web tool-call timeline

**Files:**

- Create: `packages/web/src/chat/ToolTimeline.vue`
- Test: `packages/web/src/chat/ToolTimeline.test.ts`
- Modify: `packages/web/src/chat/Thread.vue`
- Test: `packages/web/src/chat/Thread.test.ts`

**Interfaces:**

- Consumes: `LLMChunk` variants `tool_call_start`, `tool_call_args_delta`, `call_timeout`; `DetailLevel`.
- Produces: a timeline component that renders tool names at `standard`/`full` and argument summaries at `full`.

- [ ] **Step 1: Write the failing component test**

Create `packages/web/src/chat/ToolTimeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ToolTimeline from './ToolTimeline.vue';

const calls = [
  { index: 0, name: 'search_notes', args: '{"query":"legion"}' },
  { index: 1, name: 'write_file', args: '{"path":"a.md"}' },
];

describe('ToolTimeline', () => {
  it('renders nothing at minimal detail', () => {
    const wrapper = mount(ToolTimeline, { props: { calls, detail: 'minimal' } });
    expect(wrapper.find('[data-test="tool-timeline"]').exists()).toBe(false);
  });

  it('renders tool names without arguments at standard detail', () => {
    const wrapper = mount(ToolTimeline, { props: { calls, detail: 'standard' } });
    expect(wrapper.findAll('[data-test="tool-call"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="tool-args"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('search_notes');
  });

  it('renders truncated arguments at full detail', () => {
    const wrapper = mount(ToolTimeline, { props: { calls, detail: 'full' } });
    expect(wrapper.find('[data-test="tool-args"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('legion');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace=packages/web -- ToolTimeline`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `packages/web/src/chat/ToolTimeline.vue`:

```vue
<script setup lang="ts">
import type { DetailLevel } from '@legion-collective/types';

interface ToolCallView {
  index: number;
  name: string;
  args: string;
}

const props = defineProps<{ calls: ToolCallView[]; detail: DetailLevel }>();

function summary(args: string): string {
  const trimmed = args.trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 80)}…`;
}
</script>

<template>
  <div
    v-if="props.detail !== 'minimal' && props.calls.length > 0"
    data-test="tool-timeline"
    class="flex flex-col gap-1 text-xs text-muted"
  >
    <div v-for="call in props.calls" :key="call.index" data-test="tool-call">
      <span class="font-mono">🔧 {{ call.name }}</span>
      <span
        v-if="props.detail === 'full' && summary(call.args)"
        data-test="tool-args"
        class="ml-2 font-mono text-faint"
      >
        {{ summary(call.args) }}
      </span>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Wire it into Thread.vue**

In `packages/web/src/chat/Thread.vue`:

Add imports:

```ts
import ToolTimeline from './ToolTimeline.vue';
import type { DetailLevel, MessageData, StreamChunk } from '@legion-collective/types';
```

Add state:

```ts
const toolCalls = ref<Array<{ index: number; name: string; args: string }>>([]);
const streamTimedOut = ref<number | null>(null);
```

Extend `pendingArgs`:

```ts
let pendingArgs: {
  to: string;
  message: string;
  conversationId?: string;
  detail: DetailLevel;
} = {
  to: '',
  message: '',
  detail: 'full',
};
```

In the `communicate` `onChunk` handler, add branches:

```ts
    } else if (chunk.type === 'tool_call_start') {
      toolCalls.value.push({ index: chunk.index, name: chunk.name, args: '' });
    } else if (chunk.type === 'tool_call_args_delta') {
      const call = toolCalls.value.find((entry) => entry.index === chunk.index);
      if (call) call.args += chunk.delta;
    } else if (chunk.type === 'call_timeout') {
      streamTimedOut.value = chunk.timeoutMs;
    }
```

Reset at send start:

```ts
  send: async (to: string, message: string): Promise<void> => {
    toolCalls.value = [];
    streamTimedOut.value = null;
    pendingArgs = { to, message, conversationId: props.conversationId ?? undefined, detail: 'full' };
    await stream.start();
  },
```

In the streaming block template, before the streaming `MessagePart`, add:

```vue
          <ToolTimeline :calls="toolCalls" :detail="pendingArgs.detail" />
          <div
            v-if="streamTimedOut !== null"
            data-test="stream-timeout"
            class="px-1 text-xs text-danger"
          >
            Stopped after {{ Math.round(streamTimedOut / 1000) }}s
          </div>
```

Also hide reasoning at `minimal` by changing the streaming message's `reasoning` field:

```vue
              :reasoning="pendingArgs.detail === 'minimal' ? undefined : streamingReasoning || undefined"
```

- [ ] **Step 5: Update the existing send test and add a timeline test**

In the existing `send() issues the streaming communicate POST…` test, update the expected request body to include the new detail hint:

```ts
    expect(JSON.parse(String(init.body))).toEqual({
      tool: 'communicate',
      args: {
        to: 'agent-a',
        message: 'do the thing',
        conversationId: 'c1',
        detail: 'full',
      },
    });
```

Append a new test modelled on that test:

```ts
  it('renders the tool-call timeline during a streamed communicate call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: CHAIN } } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ streamId: 's1', conversationId: 'c1' }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: CHAIN } } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));

    await (
      wrapper.vm as unknown as { send: (to: string, message: string) => Promise<void> }
    ).send('agent-a', 'do the thing');

    mocks.streamChunkHandler?.({ type: 'iteration_start', iteration: 0 });
    mocks.streamChunkHandler?.({ type: 'tool_call_start', index: 0, id: 'c1', name: 'search_notes' });
    mocks.streamChunkHandler?.({
      type: 'tool_call_args_delta',
      index: 0,
      delta: '{"query":"legion"}',
    });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="tool-timeline"]').exists()).toBe(true),
    );
    expect(wrapper.text()).toContain('search_notes');
    expect(wrapper.find('[data-test="tool-args"]').text()).toContain('legion');

    mocks.streamChunkHandler?.({ type: 'stream:done', result: null });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="tool-timeline"]').exists()).toBe(false),
    );
  });
```

The existing `beforeEach` already sets `mocks.connectionId = 'conn-1'` and `mocks.token = 'tok'`, so no extra setup is needed.

- [ ] **Step 6: Build types and run web tests**

```bash
npm run build --workspace=packages/types
npm run test --workspace=packages/web
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/chat/ToolTimeline.vue packages/web/src/chat/ToolTimeline.test.ts packages/web/src/chat/Thread.vue packages/web/src/chat/Thread.test.ts
git commit -m "feat(web): render the communicate tool-call timeline"
```

---

### Task 5: Telegram streaming path and detail rendering

**Files (in `/home/chris/workspace/repos/legion-connector-telegram-v2`):**

- Create: `src/communicate.ts`
- Test: `src/communicate.test.ts`
- Modify: `src/inbound.ts`
- Modify: `src/connector.ts`
- Test: `src/inbound.test.ts`

**Interfaces:**

- Consumes: `ConnectorContext.streamTool`; `StreamChunk`; a locally declared `call_timeout` chunk shape.
- Produces: `streamCommunicate(deps)` consumes the stream, sends rendered messages, and returns `{ conversationId }`; `clampDetail(requested, max)`.

- [ ] **Step 1: Create the branch**

```bash
cd /home/chris/workspace/repos/legion-connector-telegram-v2
git checkout connector-v2
git pull --ff-only 2>/dev/null || true
git checkout -b feat/communicate-detail
```

- [ ] **Step 2: Write the failing tests**

Create `src/communicate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import type { ConnectorContext } from '@legion-collective/core';
import { clampDetail, streamCommunicate } from './communicate.js';

function fakeApi(): Api {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as unknown as Api;
}

function fakeCtx(chunks: unknown[], conversationId = 'conv-1'): ConnectorContext {
  return {
    streamTool: vi.fn(async () => ({
      gen: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
      conversationId,
    })),
  } as unknown as ConnectorContext;
}

const baseArgs = { to: 'agent-b', message: 'hello' };

describe('clampDetail', () => {
  it('never exceeds the connector maximum', () => {
    expect(clampDetail('full', 'standard')).toBe('standard');
    expect(clampDetail('minimal', 'full')).toBe('minimal');
    expect(clampDetail(undefined, 'full')).toBe('standard');
  });
});

describe('streamCommunicate', () => {
  it('sends only the final text at minimal detail', async () => {
    const api = fakeApi();
    const ctx = fakeCtx([
      { type: 'iteration_start', iteration: 0 },
      { type: 'text_delta', delta: 'working' },
      { type: 'tool_call_start', index: 0, id: 'c1', name: 'search' },
      { type: 'iteration_start', iteration: 1 },
      { type: 'text_delta', delta: 'final answer' },
      { type: 'stream:done', result: { status: 'success', data: { response: 'final answer' } } },
    ]);
    await streamCommunicate({
      ctx,
      api,
      chatId: '777',
      userId: 'chris',
      args: { ...baseArgs, detail: 'minimal' },
      maxDetail: 'full',
    });
    const sent = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toContain('final answer');
  });

  it('sends intermediate messages at standard detail but no reasoning', async () => {
    const api = fakeApi();
    const ctx = fakeCtx([
      { type: 'iteration_start', iteration: 0 },
      { type: 'reasoning_delta', delta: 'secret reasoning' },
      { type: 'text_delta', delta: 'working' },
      { type: 'tool_call_start', index: 0, id: 'c1', name: 'search' },
      { type: 'iteration_start', iteration: 1 },
      { type: 'text_delta', delta: 'final answer' },
      { type: 'stream:done', result: { status: 'success', data: { response: 'final answer' } } },
    ]);
    await streamCommunicate({
      ctx,
      api,
      chatId: '777',
      userId: 'chris',
      args: { ...baseArgs, detail: 'standard' },
      maxDetail: 'full',
    });
    const sent = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const text = sent.map((call) => String(call[1])).join('\n');
    expect(text).toContain('working');
    expect(text).toContain('final answer');
    expect(text).not.toContain('secret reasoning');
  });

  it('adds tool calls and reasoning at full detail', async () => {
    const api = fakeApi();
    const ctx = fakeCtx([
      { type: 'iteration_start', iteration: 0 },
      { type: 'reasoning_delta', delta: 'secret reasoning' },
      { type: 'text_delta', delta: 'working' },
      { type: 'tool_call_start', index: 0, id: 'c1', name: 'search' },
      { type: 'iteration_start', iteration: 1 },
      { type: 'text_delta', delta: 'final answer' },
      { type: 'stream:done', result: { status: 'success', data: { response: 'final answer' } } },
    ]);
    await streamCommunicate({
      ctx,
      api,
      chatId: '777',
      userId: 'chris',
      args: { ...baseArgs, detail: 'full' },
      maxDetail: 'full',
    });
    const text = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[1]))
      .join('\n');
    expect(text).toContain('search');
    expect(text).toContain('secret reasoning');
  });

  it('reports a timeout', async () => {
    const api = fakeApi();
    const ctx = fakeCtx([
      { type: 'iteration_start', iteration: 0 },
      { type: 'text_delta', delta: 'partial' },
      { type: 'call_timeout', timeoutMs: 5000 },
      { type: 'stream:done', result: { status: 'error', error: 'deadline exceeded' } },
    ]);
    await streamCommunicate({
      ctx,
      api,
      chatId: '777',
      userId: 'chris',
      args: { ...baseArgs, detail: 'minimal', timeoutMs: 5000 },
      maxDetail: 'standard',
    });
    const text = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[1]))
      .join('\n');
    expect(text).toContain('Stopped after 5s');
  });

  it('passes the clamped detail and timeout through to the tool call', async () => {
    const ctx = fakeCtx([{ type: 'stream:done', result: { status: 'success', data: {} } }]);
    await streamCommunicate({
      ctx,
      api: fakeApi(),
      chatId: '777',
      userId: 'chris',
      args: { ...baseArgs, detail: 'full', timeoutMs: 3000 },
      maxDetail: 'standard',
    });
    const call = (ctx.streamTool as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toMatchObject({ detail: 'standard', timeoutMs: 3000 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- src/communicate.test.ts`
Expected: FAIL — `./communicate.js` does not exist.

- [ ] **Step 4: Implement `src/communicate.ts`**

```ts
import type { Api } from 'grammy';
import type { ConnectorContext } from '@legion-collective/core';
import type { StreamChunk, ToolResult } from '@legion-collective/types';
import { renderApprovalCards, type ApprovalRequestView } from './approvals.js';
import { sendMarkdown } from './render.js';

/** Local mirror of the core DetailLevel until the legion release is merged. */
export type DetailLevel = 'minimal' | 'standard' | 'full';

/** Local mirror of the core call_timeout chunk until the legion release is merged. */
interface CallTimeoutChunk {
  type: 'call_timeout';
  timeoutMs: number;
}

type CommunicateChunk = StreamChunk | CallTimeoutChunk;

const DETAIL_ORDER: readonly DetailLevel[] = ['minimal', 'standard', 'full'];

export function clampDetail(requested: DetailLevel | undefined, max: DetailLevel): DetailLevel {
  const level = requested ?? 'standard';
  return DETAIL_ORDER.indexOf(level) < DETAIL_ORDER.indexOf(max) ? level : max;
}

export interface CommunicateArgs {
  to: string;
  message: string;
  conversationId?: string;
  replyTo?: string;
  detail?: DetailLevel;
  model?: string;
  timeoutMs?: number;
}

export interface StreamCommunicateDeps {
  ctx: ConnectorContext;
  api: Api;
  chatId: string;
  userId: string;
  args: CommunicateArgs;
  maxDetail: DetailLevel;
  signal?: AbortSignal;
}

export async function streamCommunicate(
  deps: StreamCommunicateDeps,
): Promise<{ conversationId: string }> {
  const detail = clampDetail(deps.args.detail, deps.maxDetail);
  const { gen, conversationId } = await deps.ctx.streamTool(
    deps.userId,
    'communicate',
    { ...deps.args, detail },
    {
      conversationId: deps.args.conversationId,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
  );

  const segments: string[] = [];
  let current = '';
  let reasoning = '';
  let timedOutMs: number | undefined;
  let finalResult: ToolResult | undefined;

  for await (const raw of gen) {
    const chunk = raw as CommunicateChunk;
    switch (chunk.type) {
      case 'iteration_start':
        if (current.trim()) segments.push(current);
        current = '';
        break;
      case 'text_delta':
        current += chunk.delta;
        break;
      case 'reasoning_delta':
        if (detail === 'full') reasoning += chunk.delta;
        break;
      case 'tool_call_start':
        if (current.trim()) segments.push(current);
        current = '';
        if (detail === 'full') segments.push(`🔧 ${chunk.name}`);
        break;
      case 'tool_call_args_delta':
        break;
      case 'call_timeout':
        timedOutMs = chunk.timeoutMs;
        break;
      case 'stream:done':
        finalResult = chunk.result;
        break;
      case 'stream:error':
        throw new Error(chunk.error);
      default:
        break;
    }
  }
  if (current.trim()) segments.push(current);

  const data = (finalResult?.data ?? {}) as {
    conversationId?: string;
    response?: unknown;
    approvalRequests?: ApprovalRequestView[];
  };
  const finalText = typeof data.response === 'string' ? data.response : current;

  if (detail === 'minimal') {
    if (finalText.trim()) await sendMarkdown(deps.api, deps.chatId, finalText);
  } else {
    for (const segment of segments) {
      if (segment.trim()) await sendMarkdown(deps.api, deps.chatId, segment);
    }
    if (!segments.length && finalText.trim()) {
      await sendMarkdown(deps.api, deps.chatId, finalText);
    }
    if (detail === 'full' && reasoning.trim()) {
      await sendMarkdown(deps.api, deps.chatId, `💭 ${reasoning}`);
    }
  }

  if (timedOutMs !== undefined) {
    await deps.api.sendMessage(deps.chatId, `⏱ Stopped after ${Math.round(timedOutMs / 1000)}s`);
  }
  if (finalResult?.status === 'pending_approval') {
    await renderApprovalCards(deps.api, deps.chatId, data.approvalRequests ?? []);
  }

  return { conversationId: data.conversationId ?? conversationId };
}
```

- [ ] **Step 5: Run the new tests**

Run: `npm test -- src/communicate.test.ts`
Expected: PASS.

- [ ] **Step 6: Route `communicate` through the streamer**

In `src/inbound.ts`:

Add to `InboundDeps`:

```ts
  /** Maximum detail the connector renders. Default 'standard'. */
  maxDetail?: import('./communicate.js').DetailLevel;
```

Add the import:

```ts
import { streamCommunicate } from './communicate.js';
```

Replace the `communicate` case body:

```ts
      case 'communicate': {
        const botParticipantId = dir.bots.get(botUsername)?.participantId;
        if (!botParticipantId) {
          await tgCtx.reply(`⚠️ Bot '${botUsername}' is not mapped to a participant.`);
          return;
        }
        const conversationId = deps.pairs.conversationFor(botUsername, chatId);
        try {
          const { conversationId: convId } = await withTyping(
            tgCtx,
            chatId,
            deps.typingIntervalMs,
            () =>
              streamCommunicate({
                ctx: deps.ctx,
                api: tgCtx.api,
                chatId,
                userId,
                args: {
                  to: botParticipantId,
                  message: text,
                  detail: deps.maxDetail ?? 'standard',
                  ...(conversationId ? { conversationId } : {}),
                },
                maxDetail: deps.maxDetail ?? 'standard',
              }),
          );
          deps.pairs.remember(botUsername, chatId, convId);
        } catch (err) {
          await tgCtx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
```

- [ ] **Step 7: Add the connector option**

In `src/connector.ts`, add to `TelegramConnectorOptions`:

```ts
  /** Maximum detail rendered for communicate streams. Default 'standard'. */
  maxDetail?: import('./communicate.js').DetailLevel;
```

Pass it through in `buildInbound()`:

```ts
      maxDetail: this.options.maxDetail,
```

- [ ] **Step 8: Update the existing inbound test and add one**

In `src/inbound.test.ts`, add a case:

```ts
  it('streams communicate calls instead of calling the tool once', async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
    };
    const tgCtx = {
      message: { chat: { id: 777 }, text: 'hello' },
      reply: vi.fn().mockResolvedValue(undefined),
      api,
    } as unknown as Context;
    const streamTool = vi.fn(async () => ({
      gen: (async function* () {
        yield { type: 'iteration_start', iteration: 0 };
        yield { type: 'text_delta', delta: 'final answer' };
        yield { type: 'stream:done', result: { status: 'success', data: { response: 'final answer', conversationId: 'conv-1' } } };
      })(),
      conversationId: '',
    }));
    const { deps } = makeDeps();
    (deps.ctx as unknown as { streamTool: typeof streamTool }).streamTool = streamTool;

    await createInboundHandler({ ...deps, typingIntervalMs: 0 })('my_bot', tgCtx);

    expect(streamTool).toHaveBeenCalledWith(
      'chris',
      'communicate',
      expect.objectContaining({ to: 'worker', message: 'hello', detail: 'standard' }),
      expect.anything(),
    );
    expect(api.sendMessage).toHaveBeenCalled();
  });
```

- [ ] **Step 9: Update the existing inbound tests for the streaming path**

Plain-text messages no longer go through `callTool`; every existing assertion that expects
`callTool('chris', 'communicate', …)` must move to `streamTool`. Update the `makeDeps` helper in
`src/inbound.test.ts` to provide a default stream stub:

```ts
function makeDeps(
  overrides: Partial<InboundDeps> = {},
  callTool = vi.fn().mockResolvedValue(successResult('all done', 'conv-1')),
): {
  deps: InboundDeps;
  callTool: ReturnType<typeof vi.fn>;
  streamTool: ReturnType<typeof vi.fn>;
} {
  const streamTool = vi.fn(async () => ({
    gen: (async function* () {
      yield { type: 'iteration_start', iteration: 0 };
      yield { type: 'text_delta', delta: 'all done' };
      yield {
        type: 'stream:done',
        result: { status: 'success', data: { conversationId: 'conv-1', response: 'all done' } },
      };
    })(),
    conversationId: '',
  }));
  const deps: InboundDeps = {
    ctx: { callTool, streamTool, registry: { setActive: vi.fn() } } as unknown as InboundDeps['ctx'],
    pool: {} as InboundDeps['pool'],
    directory: async () => ({
      bots: new Map([['my_bot', { participantId: 'worker' }]]),
      users: new Map([['777', 'chris']]),
      warnings: [],
    }),
    pairs: new PairState(),
    ...overrides,
  };
  return { deps, callTool, streamTool };
}
```

Then change these assertions:

- `routes plain text as communicate…` — assert `streamTool` was called with
  `('chris', 'communicate', { to: 'worker', message: 'do the thing', detail: 'standard' }, expect.anything())`.
- `continues an existing conversation by conversationId` — assert `streamTool` with
  `{ to: 'worker', message: 'second', conversationId: 'conv-1', detail: 'standard' }`.
- `/new clears the conversation…` — assert `streamTool` for both messages.
- `typingIntervalMs: 0 disables…` — assert `streamTool` with `{ to: 'worker', message: 'hello', detail: 'standard' }`.
- `repeats typing on the configured interval…` — replace the `callTool.mockImplementation`
  delay with `streamTool.mockImplementation` returning a promise that resolves later with the
  same `{ gen, conversationId }` shape.
- `rejects unknown senders…` — assert `streamTool` was not called in addition to `callTool`.

- [ ] **Step 10: Run Telegram tests**

```bash
npm install
npm run format:check
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/communicate.ts src/communicate.test.ts src/inbound.ts src/inbound.test.ts src/connector.ts
git commit -m "feat(telegram): stream communicate calls and render detail levels"
```

---

### Task 6: Full gate and documentation

**Files:**

- Modify: `docs/superpowers/plans/012-post-mvp-roadmap.md` (mark #2 in progress/done)
- Modify: `docs/superpowers/specs/2026-11-05-communicate-detail-design.md` (status line)

- [ ] **Step 1: Run the full legion gate**

```bash
cd /home/chris/workspace/threads/2026-11-02-legion-v2/legion-integration
npm run format:check
npm run typecheck
npm test
npm run test --workspace=packages/web
```

Expected: all pass.

- [ ] **Step 2: Run the Telegram gate**

```bash
cd /home/chris/workspace/repos/legion-connector-telegram-v2
npm run format:check
npm run typecheck
npm test
```

Expected: all pass.

- [ ] **Step 3: Update the docs**

In `012-post-mvp-roadmap.md`, change the #2 row's notes to record that the contract, core plumbing, web timeline and Telegram rendering landed on the integration branches, and that phase C (nested chunk forwarding) remains open.

In the spec, change `**Status:** Draft — awaiting review` to `**Status:** Implemented`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/012-post-mvp-roadmap.md docs/superpowers/specs/2026-11-05-communicate-detail-design.md
git commit -m "docs: mark communicate detail work implemented"
```

---

## Self-Review

**Spec coverage:**

- §4 contract and validation → Task 1.
- §5 detail semantics and lean result → Task 1 (tool result) and Tasks 4/5 (rendering).
- §6 model override and fail-closed → Task 3.
- §7 deadline and partial persistence → Task 2.
- §8 `call_timeout` chunk → Tasks 1 and 2.
- §9 web and Telegram rendering → Tasks 4 and 5.
- §10 testing → each task's tests plus Task 6 gate.
- §11 phase C → recorded as deferred, not implemented (by design).
- §13 rollout → matches task order.

**Known limitation:** an agent's `detail` request has no live effect until phase C, because nested tool streams are swallowed by `ToolRegistry.execute()`. This is documented in the spec and in the tool description.

**Type consistency:** `DetailLevel`, `SendOptions.detail/model/timeoutMs`, `MessageRouterResult.status: 'timeout'`, `MessageRouterResult.meta`, `RuntimeContext.modelOverride` are defined once in Task 1 and used unchanged later. The Telegram connector mirrors `DetailLevel` and `call_timeout` locally to avoid depending on an unreleased legion build.
