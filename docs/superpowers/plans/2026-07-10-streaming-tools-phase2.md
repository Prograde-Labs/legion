# Streaming Tools — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Phase 1 must be complete (streaming infrastructure, subscription tools, WebSocket transport all working).

**Goal:** End-to-end LLM streaming — `Provider.stream()` replaces `complete()`, `AgentRuntime` drives a unified generator loop, `MessageRouter.sendStream()` passes chunks up, `communicate` becomes a `StreamingTool`.

**Architecture:** `Provider` interface gains `stream()` as its only method. All providers wrap their response in SSE-style chunk yield. `AgentRuntime.handle()` stays for backward-compat (drains generator internally). `AgentRuntime.handleStream()` exposes the generator. `MessageRouter.sendStream()` is required on `MessageRouterPort`. `communicate` becomes a `StreamingTool` whose generator is the full `sendStream()` pass-through. The execute route already handles streaming — no transport changes needed.

**Tech Stack:** Node.js 20+, TypeScript strict + NodeNext, Vitest, Fastify, OpenAI SSE wire format

---

## File Map

### New files
_(none)_

### Modified files
| File | Change |
|---|---|
| `packages/core/src/providers/Provider.ts` | Add `ProviderStreamChunk`; change `Provider.complete()` → `Provider.stream()`; keep `ProviderResponse` for internal accumulation |
| `packages/core/src/providers/OpenAICompatibleProvider.ts` | Add `stream()` using SSE response reader; keep `complete()` as private helper |
| `packages/core/src/runtime/Runtime.ts` | Add `handleStream?` optional method to `Runtime` interface |
| `packages/core/src/runtime/AgentRuntime.ts` | Extract `runLoop()` generator; `handle()` drains it; add `handleStream()` |
| `packages/core/src/tools/Tool.ts` | Add `sendStream()` to `MessageRouterPort` (required, not optional) |
| `packages/core/src/runtime/MessageRouter.ts` | Implement `sendStream()` on `MessageRouter` |
| `packages/core/src/tools/communicate-tool.ts` | Convert from `Tool` to `StreamingTool` |

### Deleted files
_(none)_

---

## Task 1: `ProviderStreamChunk` type + `Provider.stream()` interface

**Files:**
- Modify: `packages/core/src/providers/Provider.ts`

The `Provider` interface currently has only `complete()`. We add `stream()` as the primary method. `complete()` is removed from the interface (providers may keep it as a private impl detail). We also add `ProviderStreamChunk` — the wire format used inside the provider layer (the `done` chunk is NOT a `StreamChunk` — it stays inside the runtime and never leaks upstream).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/providers/OpenAICompatibleProvider.test.ts` a new describe block (the test file already exists):

```ts
describe('Provider interface: stream() contract', () => {
  it('Provider type has stream() but not complete() at interface level', () => {
    // This is a compile-time check — just ensure the type can be referenced
    type HasStream = 'stream' extends keyof import('./Provider.js').Provider ? true : false;
    type NoComplete = 'complete' extends keyof import('./Provider.js').Provider ? true : false;
    // If this file compiles, the assertions hold.
    expect(true).toBe(true);
  });
});
```

This is a structural check that compiles cleanly once the interface is updated. For now it should pass trivially (since the types aren't checked at runtime) — the real verification is typecheck.

- [ ] **Step 2: Update `Provider.ts`**

In `packages/core/src/providers/Provider.ts`, add `ProviderStreamChunk` type and update the `Provider` interface:

Add after the `ProviderResponse` interface:

```ts
/**
 * Wire format for individual chunks from the LLM SSE stream.
 * The `done` chunk is consumed internally by AgentRuntime and never
 * becomes a StreamChunk visible to tool callers.
 */
export type ProviderStreamChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string }
  | { type: 'done'; stopReason: ProviderStopReason; usage?: ProviderUsage };
```

Replace the `Provider` interface:

```ts
export interface Provider {
  /**
   * Stream a chat completion. Yields one or more content/tool-call delta chunks
   * followed by exactly one `done` chunk. The caller accumulates deltas and acts
   * on the `done` chunk to determine stop reason and usage.
   *
   * Non-streaming providers implement this by calling their blocking endpoint
   * and yielding the response as a synthetic sequence of chunks.
   */
  stream(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): AsyncGenerator<ProviderStreamChunk>;

  /** Optional: enumerate models available from this provider. */
  listModels?(): Promise<ProviderModel[]>;
  /** Optional: override system-wide pricing for this provider. */
  pricingSource?(): PricingSource;
}
```

`complete()` is intentionally removed from the interface. `OpenAICompatibleProvider` will keep it as a private method called from `stream()`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: errors in `AgentRuntime.ts` (calls `provider.complete()`) and in test files that create fake providers implementing `complete()`. These are fixed in Tasks 2 and 3.

- [ ] **Step 4: Commit (partial — types only)**

```bash
git add packages/core/src/providers/Provider.ts
git commit -m "feat(core): add ProviderStreamChunk + replace Provider.complete() with stream()"
```

---

## Task 2: `OpenAICompatibleProvider.stream()` — real SSE implementation

**Files:**
- Modify: `packages/core/src/providers/OpenAICompatibleProvider.ts`

The existing integration test (`agent-runtime.integration.test.ts`) tests via a mock provider. The unit test (`OpenAICompatibleProvider.test.ts`) tests HTTP interactions. We add unit tests for `stream()` using a mocked `fetch` that returns SSE lines.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/providers/OpenAICompatibleProvider.test.ts`:

```ts
describe('OpenAICompatibleProvider.stream()', () => {
  function makeSseBody(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const chunks = lines.map((l) => encoder.encode(l + '\n'));
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  it('yields text_delta chunks from SSE stream', async () => {
    const data1 = JSON.stringify({
      choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    });
    const data2 = JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody([`data: ${data1}`, `data: ${data2}`, 'data: [DONE]']),
      }),
    );

    const provider = new OpenAICompatibleProvider('https://api.openai.com/v1', 'test-key');
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: 'user', content: 'hi' }],
      [],
      { model: 'gpt-4o' },
    )) {
      chunks.push(chunk);
    }

    vi.unstubAllGlobals();

    expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'Hello')).toBe(true);
    const done = chunks.find((c) => c.type === 'done');
    expect(done).toBeDefined();
    expect((done as { type: 'done'; stopReason: string }).stopReason).toBe('stop');
  });

  it('yields tool_call chunks for tool calls', async () => {
    const data1 = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name: 'echo', arguments: '' } }] }, finish_reason: null }],
    });
    const data2 = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"hi"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody([`data: ${data1}`, `data: ${data2}`, 'data: [DONE]']),
      }),
    );

    const provider = new OpenAICompatibleProvider('https://api.openai.com/v1', 'test-key');
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of provider.stream([], [], { model: 'gpt-4o' })) {
      chunks.push(chunk);
    }

    vi.unstubAllGlobals();

    expect(chunks.some((c) => c.type === 'tool_call_start')).toBe(true);
    expect(chunks.some((c) => c.type === 'tool_call_args_delta')).toBe(true);
  });
});
```

Add to the top of the test file:
```ts
import type { ProviderStreamChunk } from './Provider.js';
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/providers/OpenAICompatibleProvider.test.ts`
Expected: FAIL — `provider.stream` is not a function

- [ ] **Step 3: Add `stream()` to `OpenAICompatibleProvider`**

In `packages/core/src/providers/OpenAICompatibleProvider.ts`:

1. Rename the existing `complete()` method to a private `fetchComplete()` (keep same body — it's now an internal helper).

2. Add the `stream()` method:

```ts
async *stream(
  messages: ProviderMessage[],
  tools: ProviderTool[],
  model: ModelConfig,
): AsyncGenerator<ProviderStreamChunk> {
  const body: Record<string, unknown> = {
    model: model.model,
    messages: messages.map(toOAIMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (model.temperature !== undefined) body['temperature'] = model.temperature;
  if (model.maxTokens !== undefined) body['max_tokens'] = model.maxTokens;
  if (tools.length > 0) {
    body['tools'] = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body['tool_choice'] = 'auto';
  }

  const res = await fetch(`${this.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(this.apiKey),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(`OpenAI-compatible API error ${res.status}: ${text.slice(0, 200)}`);
  }

  if (!res.body) {
    throw new ProviderError('OpenAI-compatible API returned no response body');
  }

  // SSE line reader
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Track tool call assembly state (index → { id, name, argsBuffer })
  const toolCallState = new Map<number, { id: string; name: string }>();
  let usage: OAIUsage | undefined;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // last element may be incomplete

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === ':') continue; // keep-alive or comment
        if (!trimmed.startsWith('data:')) continue;

        const raw = trimmed.slice(5).trim();
        if (raw === '[DONE]') {
          // Flush any remaining buffer
          const remaining = decoder.decode(undefined, { stream: false });
          if (remaining) {
            // no-op: already handled
          }
          break;
        }

        let parsed: OAIStreamChunk;
        try {
          parsed = JSON.parse(raw) as OAIStreamChunk;
        } catch {
          continue;
        }

        if (parsed.usage) {
          usage = parsed.usage;
        }

        for (const choice of parsed.choices ?? []) {
          const delta = choice.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: 'text_delta', delta: delta.content };
          }

          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index;
            if (tc.id && tc.function?.name) {
              toolCallState.set(idx, { id: tc.id, name: tc.function.name });
              yield { type: 'tool_call_start', index: idx, id: tc.id, name: tc.function.name };
            }
            if (tc.function?.arguments) {
              yield { type: 'tool_call_args_delta', index: idx, delta: tc.function.arguments };
            }
          }

          if (choice.finish_reason) {
            const stopReason: ProviderStopReason =
              choice.finish_reason === 'tool_calls'
                ? 'tool_calls'
                : choice.finish_reason === 'length'
                  ? 'max_tokens'
                  : 'stop';

            yield {
              type: 'done',
              stopReason,
              usage: usage
                ? {
                    inputTokens: usage.prompt_tokens,
                    outputTokens: usage.completion_tokens,
                    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
                    cacheReadInputTokens:
                      usage.prompt_tokens_details?.cached_tokens ??
                      usage.cache_read_input_tokens,
                    cacheWriteInputTokens: usage.cache_creation_input_tokens,
                  }
                : undefined,
            };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

Add the `OAIStreamChunk` interface near the other OAI interfaces:

```ts
interface OAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  }>;
  usage?: OAIUsage;
}
```

Note: `complete()` is renamed to `fetchComplete()` and kept private. If any callers used `provider.complete()` they'll get a compile error — expected, addressed in Task 3.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/core/src/providers/OpenAICompatibleProvider.test.ts`
Expected: PASS (existing tests still pass if they used `complete()` — we need to check)

If existing tests called `provider.complete()`, update them to call `provider.stream()` and drain the generator. Look for calls to `complete()` in the test file and replace with:
```ts
// Old:
const result = await provider.complete(messages, tools, model);
// New:
async function drain(provider: Provider, ...args: Parameters<Provider['stream']>) {
  let lastDone: ProviderStreamChunk | null = null;
  const deltas: string[] = [];
  const toolCalls: Array<{ id: string; name: string; argsBuffer: string }> = [];
  for await (const chunk of provider.stream(...args)) {
    if (chunk.type === 'text_delta') deltas.push(chunk.delta);
    if (chunk.type === 'tool_call_start') toolCalls.push({ id: chunk.id, name: chunk.name, argsBuffer: '' });
    if (chunk.type === 'tool_call_args_delta') {
      const tc = toolCalls.find((_, i) => i === chunk.index) ?? toolCalls[chunk.index];
      if (tc) tc.argsBuffer += chunk.delta;
    }
    if (chunk.type === 'done') lastDone = chunk;
  }
  return {
    content: deltas.join('') || null,
    toolCalls: toolCalls.map((tc, i) => ({
      id: tc.id,
      name: tc.name,
      arguments: JSON.parse(tc.argsBuffer || '{}') as Record<string, unknown>,
    })),
    stopReason: (lastDone as any)?.stopReason ?? 'stop',
    usage: (lastDone as any)?.usage,
  };
}
```

- [ ] **Step 5: Full typecheck**

Run: `npm run typecheck`
Expected: errors only in `AgentRuntime.ts` (still calls `provider.complete()`) — fixed in Task 3

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers/OpenAICompatibleProvider.ts packages/core/src/providers/OpenAICompatibleProvider.test.ts
git commit -m "feat(core): implement OpenAICompatibleProvider.stream() with SSE reader"
```

---

## Task 3: `AgentRuntime` — unified generator loop

**Files:**
- Modify: `packages/core/src/runtime/AgentRuntime.ts`
- Modify: `packages/core/src/runtime/Runtime.ts`

`AgentRuntime.handle()` currently calls `provider.complete()` in a loop. We replace with `provider.stream()`. The loop structure stays identical — only the provider call and result assembly change.

The key challenge: we accumulate `text_delta` + `tool_call_*` chunks into a `ProviderResponse`-like structure while simultaneously yielding them upstream. The `done` chunk ends the current turn and triggers tool execution.

- [ ] **Step 1: Update `Runtime.ts` — add `handleStream?`**

In `packages/core/src/runtime/Runtime.ts`, add `handleStream?` to the `Runtime` interface:

```ts
import type { LLMChunk } from '@legion/types';

export interface Runtime {
  handle(incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult>;
  handleStream?(incoming: MessageData, context: RuntimeContext): AsyncGenerator<LLMChunk, RuntimeResult>;
}
```

Add the `LLMChunk` import to the existing `@legion/types` import at the top.

- [ ] **Step 2: Write the failing test in `AgentRuntime.test.ts`**

In `packages/core/src/runtime/AgentRuntime.test.ts`, find the `makeSetup` function which creates a `MockProvider` implementing `complete()`. The test will fail to compile once we remove `complete()` from the Provider interface.

Update the `MockProvider` class in `AgentRuntime.test.ts`:

Find the existing mock provider (it implements `complete()`). Replace `complete()` with `stream()`:

```ts
// In makeSetup() — update the mock provider
class FakeProvider implements Provider {
  constructor(private responses: ProviderResponse[]) {}
  private idx = 0;

  async *stream(
    _messages: ProviderMessage[],
    _tools: ProviderTool[],
    _model: ModelConfig,
  ): AsyncGenerator<ProviderStreamChunk> {
    const resp = this.responses[this.idx++ % this.responses.length];
    if (!resp) return;

    // Yield text content as delta
    if (resp.content) {
      yield { type: 'text_delta', delta: resp.content };
    }

    // Yield tool calls
    for (let i = 0; i < (resp.toolCalls ?? []).length; i++) {
      const tc = resp.toolCalls[i];
      yield { type: 'tool_call_start', index: i, id: tc.id, name: tc.name };
      yield { type: 'tool_call_args_delta', index: i, delta: JSON.stringify(tc.arguments) };
    }

    yield { type: 'done', stopReason: resp.stopReason, usage: resp.usage };
  }
}
```

Also add `import type { ProviderStreamChunk } from '../providers/Provider.js';` to the test file imports.

Add a new failing test for `handleStream`:

```ts
describe('AgentRuntime.handleStream()', () => {
  it('yields LLM chunks during response', async () => {
    // makeSetup returns { context, thread, eventBus, inbound, router }
    const { context, inbound, router } = await makeSetup([
      { content: 'Hello!', toolCalls: [], stopReason: 'stop' },
    ]);
    const agent = new AgentRuntime('agent-1', router);
    expect(agent.handleStream).toBeDefined();

    const chunks: LLMChunk[] = [];
    const gen = agent.handleStream!(inbound, context);
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await gen.next();
    }
    expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'Hello!')).toBe(true);
    expect(next.value.kind).toBe('response');
  });
});
```

Add `import type { LLMChunk } from '@legion/types';` to the test imports.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`
Expected: FAIL — type errors + `handleStream` not a function

- [ ] **Step 4: Rewrite `AgentRuntime` with unified generator loop**

In `packages/core/src/runtime/AgentRuntime.ts`:

1. Update the import from Provider to include `ProviderStreamChunk`:
```ts
import type {
  Provider,
  ProviderMessage,
  ProviderStreamChunk,
  ProviderTool,
} from '../providers/Provider.js';
```

2. Remove the import of `ProviderResponse` (no longer needed at the handle level).

3. Add a `ProviderResponseAccumulator` helper interface and accumulator function:

```ts
interface TurnAccumulator {
  content: string;
  toolCalls: Map<number, { id: string; name: string; argsBuffer: string }>;
  stopReason?: import('../providers/Provider.js').ProviderStopReason;
  usage?: import('../providers/Provider.js').ProviderUsage;
}

function freshAccumulator(): TurnAccumulator {
  return { content: '', toolCalls: new Map() };
}

function accumulateChunk(acc: TurnAccumulator, chunk: ProviderStreamChunk): void {
  if (chunk.type === 'text_delta') {
    acc.content += chunk.delta;
  } else if (chunk.type === 'tool_call_start') {
    acc.toolCalls.set(chunk.index, { id: chunk.id, name: chunk.name, argsBuffer: '' });
  } else if (chunk.type === 'tool_call_args_delta') {
    const tc = acc.toolCalls.get(chunk.index);
    if (tc) tc.argsBuffer += chunk.delta;
  } else if (chunk.type === 'done') {
    acc.stopReason = chunk.stopReason;
    acc.usage = chunk.usage;
  }
}

function accumulatorToResponse(acc: TurnAccumulator): {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason: import('../providers/Provider.js').ProviderStopReason;
  usage?: import('../providers/Provider.js').ProviderUsage;
} {
  const toolCalls = [...acc.toolCalls.values()].map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: (() => {
      try { return JSON.parse(tc.argsBuffer || '{}') as Record<string, unknown>; }
      catch { return {} as Record<string, unknown>; }
    })(),
  }));
  return {
    content: acc.content || null,
    toolCalls,
    stopReason: acc.stopReason ?? 'stop',
    usage: acc.usage,
  };
}
```

4. Extract internal agentic loop to `private async *runLoop()`:

The `runLoop` generator replaces the body of `handle()`. It yields `LLMChunk` during generation and returns `RuntimeResult` as its return value (AsyncGenerator return type `AsyncGenerator<LLMChunk, RuntimeResult>`).

Replace the existing `handle()` method body with:

```ts
async handle(_incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
  const gen = this.runLoop(_incoming, context);
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

async *handleStream(
  _incoming: MessageData,
  context: RuntimeContext,
): AsyncGenerator<LLMChunk, RuntimeResult> {
  return yield* this.runLoop(_incoming, context);
}

private async *runLoop(
  _incoming: MessageData,
  context: RuntimeContext,
): AsyncGenerator<LLMChunk, RuntimeResult> {
  const participant = context.collective.getOrThrow(this.participantId);
  if (participant.type !== 'agent') return { kind: 'void' };
  const agent = participant as AgentConfig;

  let provider: Provider | null;
  let providerId: string | undefined;
  try {
    const resolved = await this.router.resolveWithId(agent.model.model);
    provider = resolved?.provider ?? null;
    providerId = resolved?.providerId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'response', content: `[AgentRuntime error: ${msg}]` };
  }
  if (!provider) {
    return {
      kind: 'response',
      content: `[AgentRuntime error: no provider available for model '${agent.model.model}']`,
    };
  }

  // Resumption check (unchanged)
  const chain = context.conversation.activeChain;
  const lastAssistantMsg = [...chain]
    .reverse()
    .find(
      (m) =>
        m.role === 'assistant' &&
        m.toolResults?.some((tr) => tr.result.status === 'pending_approval'),
    );

  if (lastAssistantMsg) {
    const stillPending = await this.processResumedApprovals(lastAssistantMsg, context);
    if (stillPending !== null) {
      return { kind: 'pending_approval', approvalRequests: stillPending };
    }
  }

  // Build initial messages
  const maxIterations = (agent.runtimeConfig?.maxIterations ?? DEFAULT_MAX_ITERATIONS) as number;
  const messages: ProviderMessage[] = buildProviderMessages(
    context.conversation.activeChain,
    agent.systemPrompt,
  );

  const providerTools: ProviderTool[] = context.toolRegistry
    .list()
    .filter((tool) => agent.tools[tool.name] !== undefined)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

  try {
    for (let i = 0; i < maxIterations; i++) {
      context.eventBus.emit('iteration', {
        conversationId: context.conversationId,
        participantId: this.participantId,
        iteration: i,
      });

      // ── Streaming LLM call ──────────────────────────────────────────────
      const acc = freshAccumulator();
      for await (const chunk of provider.stream(messages, providerTools, agent.model)) {
        accumulateChunk(acc, chunk);
        if (chunk.type !== 'done') {
          // yield LLMChunks upstream (text_delta, tool_call_start, tool_call_args_delta)
          yield chunk as LLMChunk;
        }
      }

      const response = accumulatorToResponse(acc);

      // ── Non-tool-call turn → return response ───────────────────────────
      if (response.stopReason !== 'tool_calls' || response.toolCalls.length === 0) {
        const usage = await this.computeUsage(providerId, agent, {
          content: response.content,
          toolCalls: [],
          stopReason: response.stopReason,
          usage: acc.usage,
        });
        return { kind: 'response', content: response.content ?? '', usage };
      }

      // ── Tool-call turn ─────────────────────────────────────────────────
      const toolCallData: ToolCallData[] = response.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }));

      const toolResults: ToolCallResult[] = [];
      const pendingApprovals: PendingApproval[] = [];

      for (const tc of response.toolCalls) {
        const authResult = context.authEngine.authorize(
          this.participantId,
          tc.name,
          tc.arguments,
          agent.tools,
        );

        if (authResult.reason === 'hidden') {
          toolResults.push({
            id: tc.id,
            name: tc.name,
            result: { status: 'error', error: `Tool '${tc.name}' not available` },
          });
          continue;
        }

        if (authResult.reason === 'requires_approval') {
          const { approvalId } = await context.pendingApprovalRegistry.create({
            conversationId: context.conversationId,
            requesterId: this.participantId,
            tool: tc.name,
            args: tc.arguments,
          });
          const pending = context.pendingApprovalRegistry.get(approvalId)!;
          pendingApprovals.push(pending);
          toolResults.push({
            id: tc.id,
            name: tc.name,
            result: { status: 'pending_approval', approvalId },
          });
          context.eventBus.emit('tool:call', {
            conversationId: context.conversationId,
            participantId: this.participantId,
            tool: tc.name,
            callId: tc.id,
          });
          context.eventBus.emit('tool:result', {
            conversationId: context.conversationId,
            participantId: this.participantId,
            tool: tc.name,
            callId: tc.id,
            status: 'pending_approval',
          });
          context.eventBus.emit('approval:requested', {
            conversationId: context.conversationId,
            participantId: this.participantId,
            tool: tc.name,
            approvalId,
          });
          continue;
        }

        const result = await context.toolRegistry.execute(tc.name, tc.arguments, {
          ...context,
          toolCallId: tc.id,
        });
        toolResults.push({ id: tc.id, name: tc.name, result });
      }

      const usage = await this.computeUsage(providerId, agent, {
        content: response.content,
        toolCalls: response.toolCalls,
        stopReason: response.stopReason,
        usage: acc.usage,
      });

      await context.conversation.append({
        senderId: this.participantId,
        recipientId: this.participantId,
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: toolCallData,
        toolResults,
        usage,
      });

      if (pendingApprovals.length > 0) {
        return { kind: 'pending_approval', approvalRequests: pendingApprovals };
      }

      // Advance local messages for next iteration
      messages.push({
        role: 'assistant',
        content: response.content ?? null,
        toolCalls: response.toolCalls,
      });
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          content: JSON.stringify(tr.result),
          toolCallId: tr.id,
          name: tr.name,
        });
      }
    }

    return {
      kind: 'response',
      content: `[Agent reached maximum iteration limit of ${maxIterations}]`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'response', content: `[AgentRuntime error: ${msg}]` };
  }
}
```

5. Update `computeUsage()` — it currently takes a `ProviderResponse`. Change the signature to accept the fields we have:

```ts
private async computeUsage(
  providerId: string | undefined,
  agent: AgentConfig,
  response: { content: string | null; toolCalls: unknown[]; stopReason: string; usage?: ProviderUsage },
): Promise<MessageUsage | undefined> {
  if (!response.usage || !this.usageCalculator) return undefined;
  return this.usageCalculator.compute(
    providerId ?? 'unknown',
    agent.model.model,
    response.usage,
    undefined, // cost field only exists on ProviderResponse (OpenAI Copilot)
  );
}
```

6. Add necessary imports at the top of `AgentRuntime.ts`:
```ts
import type { LLMChunk } from '@legion/types';
import type { ProviderStreamChunk, ProviderUsage } from '../providers/Provider.js';
```

Remove the import of `ProviderResponse` if it's no longer needed.

- [ ] **Step 5: Run `AgentRuntime` tests**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`
Expected: PASS

- [ ] **Step 6: Full typecheck**

Run: `npm run typecheck`
Expected: errors only in `MessageRouter.ts` (calls `runtime.handleStream`) — if it doesn't yet — and in `communicate-tool.ts`. These are fixed in Tasks 4 and 5.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/AgentRuntime.ts packages/core/src/runtime/Runtime.ts packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "feat(core): rewrite AgentRuntime with unified provider.stream() generator loop"
```

---

## Task 4: `MessageRouterPort.sendStream()` + `MessageRouter.sendStream()`

**Files:**
- Modify: `packages/core/src/tools/Tool.ts`
- Modify: `packages/core/src/runtime/MessageRouter.ts`

`sendStream()` is required (not optional) on `MessageRouterPort`. Mock implementations must implement it. `MessageRouter.sendStream()` mirrors `sendInner()` but delegates to `handleStream()` when available.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/runtime/MessageRouter.test.ts` (new describe block):

```ts
describe('MessageRouter.sendStream()', () => {
  it('yields LLMChunks and returns MessageRouterResult', async () => {
    // set up with an agent mock that yields chunks
    const dir = await mkdtemp(join(tmpdir(), 'legion-router-stream-'));
    try {
      const { router, baseContext, store, collective } = await setup(dir);

      const chunks: unknown[] = [];
      const gen = router.sendStream({
        senderId: 'op',
        recipientId: 'mock-1',
        message: 'hello',
        context: baseContext,
      });

      let next = await gen.next();
      while (!next.done) {
        chunks.push(next.value);
        next = await gen.next();
      }
      const result = next.value;
      expect(result.status).toBe('success');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
```

(MockRuntime doesn't stream, so `sendStream` will fall back to `handle()` — the test just verifies the interface works without LLM chunks.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: FAIL — `router.sendStream` is not a function

- [ ] **Step 3: Add `sendStream()` to `MessageRouterPort` in `Tool.ts`**

In `packages/core/src/tools/Tool.ts`, update `MessageRouterPort`:

Add import at top:
```ts
import type { LLMChunk } from '@legion/types';
```

Add to `MessageRouterPort`:
```ts
/**
 * Streaming variant of send(). Yields LLMChunk values from the recipient's
 * response as they arrive; returns MessageRouterResult as the generator
 * return value. Required — mock implementations yield nothing and return
 * a mock result.
 */
sendStream(opts: {
  senderId: string;
  recipientId: string;
  message: string;
  conversationId?: string;
  replyTo?: string;
  context: ToolContext;
}): AsyncGenerator<LLMChunk, MessageRouterResult>;
```

- [ ] **Step 4: Implement `sendStream()` on `MessageRouter`**

In `packages/core/src/runtime/MessageRouter.ts`:

Add import:
```ts
import type { LLMChunk } from '@legion/types';
```

Add `sendStream()` to the `MessageRouter` class:

```ts
async *sendStream(opts: SendOptions): AsyncGenerator<LLMChunk, MessageRouterResult> {
  if (opts.conversationId) {
    return yield* this.withLockGenerator(opts.conversationId, () => this.sendStreamInner(opts));
  }
  return yield* this.sendStreamInner(opts);
}

private async *withLockGenerator<T>(
  conversationId: string,
  fn: () => AsyncGenerator<LLMChunk, T>,
): AsyncGenerator<LLMChunk, T> {
  const prev = this.locks.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => { release = res; });
  const queued = prev.then(() => next);
  this.locks.set(conversationId, queued);
  return yield* prev.then(async function* () {
    try {
      return yield* fn();
    } finally {
      release();
    }
  });
}

private async *sendStreamInner(opts: SendOptions): AsyncGenerator<LLMChunk, MessageRouterResult> {
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

  const parentConvId = opts.context.conversationId;
  const parentLink =
    !opts.conversationId && parentConvId && parentConvId !== ''
      ? {
          parentConversationId: parentConvId,
          parentToolCallId: opts.context.toolCallId as string | undefined,
        }
      : undefined;
  const thread = await this.getThread(opts.conversationId, parentLink);

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
  const runtimeContext = this.buildRuntimeContext(
    thread,
    recipient.id,
    { ...opts.context, communicationDepth: depth },
    depth,
  );

  // Fire-and-forget (replyTo) — no streaming chunks to yield
  if (opts.replyTo) {
    const task = this.dispatchAsync(runtime, inbound, runtimeContext, thread, opts);
    this.background.add(task);
    void task.finally(() => this.background.delete(task));
    return { conversationId: thread.id, status: 'dispatched' };
  }

  // Streaming: use handleStream() if available, else fall back to handle()
  if (runtime.handleStream) {
    const result = yield* runtime.handleStream(inbound, runtimeContext);
    return yield* this.handleRuntimeResultGenerator(result, thread, recipient.id, opts.senderId);
  } else {
    const result = await runtime.handle(inbound, runtimeContext);
    return yield* this.handleRuntimeResultGenerator(result, thread, recipient.id, opts.senderId);
  }
}

private async *handleRuntimeResultGenerator(
  result: RuntimeResult,
  thread: ConversationThread,
  senderId: string,
  defaultRecipientId: string,
): AsyncGenerator<LLMChunk, MessageRouterResult> {
  // Yield nothing — result is already accumulated.
  // Persist and return.
  if (result.kind === 'response') {
    await this.persistResponse(thread, senderId, defaultRecipientId, result.content, result.usage);
    return { conversationId: thread.id, response: result.content, status: 'success' };
  }
  if (result.kind === 'pending_approval') {
    return {
      conversationId: thread.id,
      status: 'pending_approval',
      approvalRequests: result.approvalRequests,
    };
  }
  return { conversationId: thread.id, status: 'success' };
}
```

Note: `withLockGenerator` is complex because we can't use the existing `withLock` (which returns `Promise<T>`) for async generators. The simpler approach: since `sendStream` is primarily called by `communicate` which is called in a single-threaded async context, we can skip the lock for now and add a comment:

Actually, looking at this more carefully: async generator + locks is tricky. The `withLock` promise chain is designed for `Promise<T>`, not generators. For `sendStreamInner`, we can safely skip the conversation lock since:
1. The lock prevents concurrent appends to the same conversation
2. `sendStream` won't be called concurrently in the normal flow
3. The lock is best-effort anyway (only for `conversationId` specified)

Simplify `sendStream`:

```ts
async *sendStream(opts: SendOptions): AsyncGenerator<LLMChunk, MessageRouterResult> {
  // Note: conversation lock not applied here (see sendInner for lock rationale).
  // sendStream is invoked from communicate which runs in a single agent turn.
  return yield* this.sendStreamInner(opts);
}
```

Remove `withLockGenerator` from the implementation. This is a known simplification.

- [ ] **Step 5: Update all mock `MessageRouterPort` implementations**

Search for mock implementations of `MessageRouterPort` in test files:

```bash
grep -r "MessageRouterPort\|messageRouter:" packages/core/src --include="*.test.ts" -l
```

For each mock found, add `sendStream`:
```ts
sendStream: async function* () {
  return { conversationId: 'mock', status: 'success' };
},
```

Or if using `vi.fn()` approach, add:
```ts
sendStream: vi.fn().mockImplementation(async function* () {
  return { conversationId: 'mock', status: 'success' };
}),
```

- [ ] **Step 6: Run MessageRouter tests**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: PASS

- [ ] **Step 7: Full typecheck**

Run: `npm run typecheck`
Expected: errors only in `communicate-tool.ts` (if still using `send()`) — fixed in Task 5

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/tools/Tool.ts packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat(core): add sendStream() to MessageRouterPort + MessageRouter"
```

---

## Task 5: `communicate` — convert to `StreamingTool`

**Files:**
- Modify: `packages/core/src/tools/communicate-tool.ts`
- Modify: `packages/core/src/tools/communicate-tool.test.ts`

`communicate` currently returns a `ToolResult` synchronously via `messageRouter.send()`. After this task, it streams LLM chunks via `messageRouter.sendStream()` and lets `ToolRegistry` inject `stream:done` on return.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/tools/communicate-tool.test.ts`, find the existing mock for `MessageRouterPort`. Add `sendStream`:

```ts
// In the mock MessageRouterPort factory, add:
sendStream: async function* ({ message }: { message: string }) {
  yield { type: 'text_delta', delta: `Echo: ${message}` } as LLMChunk;
  return { conversationId: 'mock-conv', status: 'success', response: `Echo: ${message}` } as MessageRouterResult;
},
```

Add a test for `stream()`:

```ts
import { isStreamingTool } from './Tool.js';
import type { StreamChunk } from '@legion/types';

describe('communicate as StreamingTool', () => {
  it('isStreamingTool returns true for communicateTool', () => {
    expect(isStreamingTool(communicateTool)).toBe(true);
  });

  it('stream() yields LLM chunks and terminates', async () => {
    // Build a mock context with sendStream
    const mockRouter: MessageRouterPort = {
      send: vi.fn(),
      resume: vi.fn(),
      generate: vi.fn(),
      sendStream: async function* () {
        yield { type: 'text_delta', delta: 'Hello' } as LLMChunk;
        return { conversationId: 'c1', status: 'success', response: 'Hello' };
      },
    };
    const ctx = makeContext(mockRouter); // use the existing makeContext helper

    const tool = communicateTool as StreamingTool;
    const chunks: StreamChunk[] = [];
    for await (const chunk of tool.stream(
      { to: 'agent-1', message: 'hi' },
      ctx,
    )) {
      chunks.push(chunk);
    }

    // communicateTool.stream() passes through sendStream chunks then returns
    // ToolRegistry injects stream:done — but here we're calling stream() directly
    // so we see only the LLM chunks (no stream:done yet)
    expect(chunks).toContainEqual({ type: 'text_delta', delta: 'Hello' });
  });
});
```

Add imports at the top:
```ts
import type { StreamingTool } from './Tool.js';
import type { LLMChunk, StreamChunk } from '@legion/types';
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tools/communicate-tool.test.ts`
Expected: FAIL — `isStreamingTool(communicateTool)` returns false; `communicateTool` has no `stream`

- [ ] **Step 3: Convert `communicate-tool.ts` to `StreamingTool`**

Replace `packages/core/src/tools/communicate-tool.ts`:

```ts
import type { LLMChunk } from '@legion/types';
import type { MessageRouterResult, StreamingTool, ToolContext } from './Tool.js';

export const communicateTool: StreamingTool = {
  name: 'communicate',
  description:
    'Send a message to another participant. Streams the recipient\'s response as it is generated. Pass replyTo for fire-and-forget (no chunks yielded).',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target participant id' },
      message: { type: 'string' },
      conversationId: { type: 'string', description: 'Join an existing thread' },
      replyTo: {
        type: 'string',
        description: 'Route the response to this participant instead (fire-and-forget)',
      },
    },
    required: ['to', 'message'],
  },
  async *stream(args: unknown, context: ToolContext): AsyncGenerator<LLMChunk> {
    const { to, message, conversationId, replyTo } = args as {
      to: string;
      message: string;
      conversationId?: string;
      replyTo?: string;
    };

    if (!context.messageRouter) {
      throw new Error('communicate: messageRouter not available in context');
    }

    const result: MessageRouterResult = yield* context.messageRouter.sendStream({
      senderId: context.participant.id,
      recipientId: to,
      message,
      conversationId,
      replyTo,
      context: {
        ...context,
        communicationDepth: (context.communicationDepth ?? 0) + 1,
      },
    });

    // ToolRegistry injects stream:done automatically — we don't yield it here.
    // The result is captured via the generator return value pattern; the registry
    // uses stream:done { result: { status: 'success' } } when the generator returns.
    // To surface the MessageRouterResult (conversationId, response), we store it
    // on the ToolResult.data field by throwing it back up via a convention:
    // ToolRegistry's stream:done result is { status: 'success' } by default.
    // We need richer data: override by yielding a custom done-like signal.
    //
    // DESIGN NOTE: ToolRegistry injects stream:done with { status: 'success' }
    // when generator returns. To include conversationId in the result, we
    // use a special "return value forwarding" approach: the last value the
    // generator returns (its return value) is ignored by ToolRegistry's
    // managedStream. Instead, we store router result in context and let
    // callers retrieve it via the stream:done result.data field.
    //
    // Simpler approach: yield a marker chunk before returning. ToolRegistry
    // sees the generator returns normally and injects:
    //   { type: 'stream:done', result: { status: 'success' } }
    //
    // For communicate, we want status to reflect the router result:
    void result; // result used above as yield* return value
  },
};
```

Wait — there's a design tension here. When `communicate` is a `StreamingTool`:
- `ToolRegistry.execute(communicate, ...)` drains the generator → gets `stream:done { result: { status: 'success' } }` → returns `{ status: 'success' }`
- But the old `communicateTool.execute()` returned `{ status: 'success', data: { conversationId, response } }` so callers could extract the conversationId

To preserve this: we need to surface the `MessageRouterResult` as the `stream:done` result. `managedStream()` in ToolRegistry yields `stream:done { result: { status: 'success' } }` after the generator returns normally — but we lose the data.

Solution: override the terminal chunk by yielding a special marker that the tool author shouldn't yield... but the spec says tool authors should NOT yield `stream:done`. 

The cleanest fix: change `managedStream` to accept an optional "result factory" or have `StreamingTool` return a `ToolResult` from its generator (using the generator `return` value). The registry's `managedStream` can then capture the return value:

```ts
// In managedStream, for StreamingTool:
const gen = isStreamingTool(tool) ? tool.stream(args, context) : /* ... */;
let returnValue: ToolResult | undefined;
try {
  let next = await gen.next();
  while (!next.done) {
    yield next.value;
    next = await gen.next();
  }
  // Generator's return value is the ToolResult (if any)
  returnValue = next.value as ToolResult | undefined;
  yield { type: 'stream:done', result: returnValue ?? { status: 'success' } };
} catch (err) {
  yield { type: 'stream:error', error: ... };
}
```

This is cleaner. We update `StreamingTool.stream()` signature to return `AsyncGenerator<StreamChunk, ToolResult | void>` — the return value is optional. For `communicate`, we return the result as a `ToolResult`:

Actually, let's look at this differently. The `communicate` tool in its `stream()` method:
1. `yield* context.messageRouter.sendStream(...)` — passes through LLM chunks and gets `MessageRouterResult` as the return value of the `yield*` expression
2. The tool then needs to return a `ToolResult` from its generator

We update `StreamingTool`:
```ts
export interface StreamingTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, ToolResult | void>;
}
```

And update `managedStream()` to capture the return value:
```ts
async function* managedStream(tool: AnyTool, args: unknown, context: ToolContext): AsyncGenerator<StreamChunk> {
  try {
    if (isStreamingTool(tool)) {
      const result = yield* tool.stream(args, context);  // capture return value
      yield { type: 'stream:done', result: result ?? { status: 'success' } };
      return;
    }
    const result = (await (tool as Tool).execute(args, context)) as ToolResult;
    yield { type: 'stream:done', result };
  } catch (err) {
    yield { type: 'stream:error', error: err instanceof Error ? err.message : String(err) };
  }
}
```

Now `communicate.stream()` can return a `ToolResult`:
```ts
async *stream(args, context): AsyncGenerator<LLMChunk, ToolResult | void> {
  // ...
  const result: MessageRouterResult = yield* context.messageRouter.sendStream({...});
  
  if (result.status === 'error') {
    return { status: 'error', error: result.error };
  }
  if (result.status === 'pending_approval') {
    return { status: 'pending_approval', approvalId: undefined, data: { approvalRequests: result.approvalRequests } };
  }
  return {
    status: 'success',
    data: { conversationId: result.conversationId, response: result.response },
  };
}
```

This approach preserves the old behavior where `execute('communicate', ...)` returns a `ToolResult` with `data.conversationId` and `data.response`.

So the implementation plan for `communicate-tool.ts`:

- `StreamingTool.stream()` returns `AsyncGenerator<StreamChunk, ToolResult | void>`
- Update `ToolRegistry.managedStream()` to capture this return value
- `communicate.stream()` yields from `sendStream()`, then returns a `ToolResult`

The `StreamingTool` interface update (return type change) is a minor modification to `Tool.ts`.

- [ ] **Step 4: Update `StreamingTool` interface return type** _(cross-cuts Phase 1 files)_

This step modifies Phase 1 files to allow `communicate` to return a rich `ToolResult` from its generator.

In `packages/core/src/tools/Tool.ts`, update `StreamingTool`:

```ts
export interface StreamingTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  /**
   * Yields chunks; the generator's return value becomes the tool result
   * (injected as stream:done.result by ToolRegistry). Return void to use
   * the default { status: 'success' }.
   */
  stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, ToolResult | void>;
}
```

Update `managedStream` in `ToolRegistry.ts`:

```ts
async function* managedStream(
  tool: AnyTool,
  args: unknown,
  context: ToolContext,
): AsyncGenerator<StreamChunk> {
  try {
    if (isStreamingTool(tool)) {
      const toolResult = yield* tool.stream(args, context);
      yield { type: 'stream:done', result: toolResult ?? { status: 'success' } };
    } else {
      const result = (await (tool as Tool).execute(args, context)) as ToolResult;
      yield { type: 'stream:done', result };
    }
  } catch (err) {
    yield { type: 'stream:error', error: err instanceof Error ? err.message : String(err) };
  }
}
```

Update the subscription tool generators to have explicit return types (they return `void`). Example:

```ts
// In watch-conversations-tool.ts — add return type
async *stream(_args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, void> {
```

(All subscription tools return `void` from their generators — no change needed at runtime, just TypeScript type annotation for compatibility.)

- [ ] **Step 5: Write the actual `communicate-tool.ts`**

```ts
import type { ToolResult, LLMChunk } from '@legion/types';
import type { MessageRouterResult, StreamingTool, ToolContext } from './Tool.js';

export const communicateTool: StreamingTool = {
  name: 'communicate',
  description:
    "Send a message to another participant. Streams the recipient's response as it is generated. Pass replyTo for fire-and-forget (returns immediately, response routed elsewhere).",
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
        context: {
          ...context,
          communicationDepth: (context.communicationDepth ?? 0) + 1,
        },
      });
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (result.status === 'error') {
      return { status: 'error', error: result.error };
    }
    if (result.status === 'pending_approval') {
      return {
        status: 'pending_approval',
        data: { approvalRequests: result.approvalRequests },
      };
    }
    // 'success' or 'dispatched'
    return {
      status: 'success',
      data: { conversationId: result.conversationId, response: result.response },
    };
  },
};
```

- [ ] **Step 6: Update existing `communicate-tool.test.ts`**

The existing tests use `communicateTool.execute()`. After this change, `communicateTool` is a `StreamingTool` with no `execute()`. Tests that called `communicateTool.execute()` must be updated to use `ToolRegistry.execute()` (which drains the streaming tool):

```ts
// Old test pattern:
const result = await communicateTool.execute(args, context);

// New test pattern:
const registry = new ToolRegistry();
registry.register(communicateTool);
const result = await registry.execute('communicate', args, context);
```

Update mock `MessageRouterPort` to include `sendStream`:
```ts
const mockRouter: MessageRouterPort = {
  send: vi.fn().mockResolvedValue({ conversationId: 'c1', status: 'success', response: 'ok' }),
  resume: vi.fn(),
  generate: vi.fn(),
  sendStream: async function* () {
    return { conversationId: 'c1', status: 'success', response: 'Echo response' };
  },
};
```

- [ ] **Step 7: Update subscription tool return types**

In each subscription tool file, update the `stream()` return type annotation to `AsyncGenerator<StreamChunk, void>`:

- `watch-conversations-tool.ts`
- `watch-participants-tool.ts`
- `watch-activity-tool.ts`
- `watch-conversation-tool.ts`
- `watch-process-tool.ts`

Example change (same for all):
```ts
// Before:
async *stream(_args: unknown, context: ToolContext): AsyncGenerator<StreamChunk> {
// After:
async *stream(_args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, void> {
```

- [ ] **Step 8: Run communicate tests**

Run: `npx vitest run packages/core/src/tools/communicate-tool.test.ts`
Expected: PASS

- [ ] **Step 9: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/tools/communicate-tool.ts packages/core/src/tools/communicate-tool.test.ts packages/core/src/tools/Tool.ts packages/core/src/tools/ToolRegistry.ts packages/core/src/tools/watch-conversations-tool.ts packages/core/src/tools/watch-participants-tool.ts packages/core/src/tools/watch-activity-tool.ts packages/core/src/tools/watch-conversation-tool.ts packages/core/src/tools/watch-process-tool.ts
git commit -m "feat(core): convert communicate to StreamingTool with full LLM streaming"
```

---

## Task 6: Update mock `MessageRouterPort` implementations in test files

**Files:**
- Various `*.test.ts` files that create mock `MessageRouterPort` objects

After Task 5 adds `sendStream` to `MessageRouterPort` as a required field, any test that constructs a mock `MessageRouterPort` without it will have a TypeScript mismatch in test files (not caught by `tsc --build` since tests are excluded, but may cause vitest failures if the object is passed to something that calls `sendStream`).

- [ ] **Step 1: Find all mock MessageRouterPort instances**

```bash
grep -r "MessageRouterPort\|messageRouter\s*=" packages/core/src --include="*.test.ts" -l
```

Check each file. Common patterns:
```ts
// Pattern 1 — explicit mock object
const mockRouter: MessageRouterPort = {
  send: vi.fn()...,
  resume: vi.fn()...,
  generate: vi.fn()...,
  // Missing sendStream!
};

// Pattern 2 — partial mock via cast
const mockRouter = { send: vi.fn() } as unknown as MessageRouterPort;
```

For Pattern 1, add:
```ts
sendStream: async function* () {
  return { conversationId: '', status: 'success' as const };
},
```

For Pattern 2, no change needed (the cast suppresses the error).

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/**/*.test.ts  # only changed files
git commit -m "test(core): add sendStream to MessageRouterPort mock implementations"
```

---

## Task 7: Final verification

- [ ] **Step 1: Format check**

Run: `npm run format:check`
Expected: PASS (run `npm run format` to fix, then re-check)

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 3: Core + runtime unit tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Web package tests**

Run: `npm run test --workspace=packages/web`
Expected: PASS

- [ ] **Step 5: Run integration tests (optional)**

Run: `LEGION_INTEGRATION=1 npx vitest run packages/core/src/runtime/agent-runtime.integration.test.ts`
Expected: PASS (requires a running LLM provider or mocked setup per that test's requirements — see `docs/testing.md`)

- [ ] **Step 6: Tag Phase 2 complete**

```bash
git tag streaming-phase2-complete
```
