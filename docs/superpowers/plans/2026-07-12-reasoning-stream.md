# Reasoning Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream provider-supplied reasoning, persist it per assistant turn, and render it in an inline disclosure without leaking it back into model context.

**Architecture:** Provider adapters normalize protocol-specific reasoning into `reasoning_delta`. `AgentRuntime` emits explicit `iteration_start` boundaries, accumulates reasoning independently per iteration, and passes completed reasoning into existing message persistence. Existing stream transports forward both chunk types unchanged; Vue keeps temporary reasoning separate from answer text and reuses a disclosure component for live and persisted states.

**Tech Stack:** TypeScript strict/NodeNext, Vitest, Vue 3, Vue Test Utils, Fastify/WebSocket streaming, Playwright.

**Design:** `docs/superpowers/specs/2026-07-12-reasoning-stream-design.md`

---

## File Map

### New Files

| File                                                                    | Responsibility                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/web/src/components/conversations/ReasoningDisclosure.vue`     | Shared live/persisted inline reasoning disclosure |
| `packages/web/src/components/conversations/ReasoningDisclosure.test.ts` | Disclosure behavior and Markdown delegation       |
| `packages/web/src/components/conversations/ConversationThread.test.ts`  | Live and read-only reasoning rendering            |
| `packages/e2e/tests/conversations/reasoning.spec.ts`                    | Two-iteration browser regression                  |

### Modified Files

| File                                                               | Change                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `packages/types/src/streaming.ts`                                  | Add `iteration_start` and `reasoning_delta` public chunks      |
| `packages/types/src/conversation.ts`                               | Add optional persisted `reasoning`                             |
| `packages/core/src/providers/Provider.ts`                          | Add provider-internal `reasoning_delta`                        |
| `packages/core/src/providers/OpenAICompatibleProvider.ts`          | Normalize compatible reasoning fields                          |
| `packages/core/src/providers/OpenAICompatibleProvider.test.ts`     | Provider parsing, ordering, malformed-field tests              |
| `packages/core/src/conversation/conversation-ops.ts`               | Propagate reasoning into new messages                          |
| `packages/core/src/conversation/conversation-ops.test.ts`          | Persistence/edit/prune/compaction semantics                    |
| `packages/core/src/conversation/FileConversationStore.test.ts`     | Round-trip and legacy JSON compatibility                       |
| `packages/core/src/runtime/Runtime.ts`                             | Add optional reasoning to response result                      |
| `packages/core/src/runtime/AgentRuntime.ts`                        | Emit boundaries and accumulate/persist reasoning per iteration |
| `packages/core/src/runtime/AgentRuntime.test.ts`                   | Runtime ordering, reset, persistence, and no-resend tests      |
| `packages/core/src/runtime/MessageRouter.ts`                       | Persist final reasoning on streamed, buffered, and async paths |
| `packages/core/src/runtime/MessageRouter.test.ts`                  | Final persistence and chunk forwarding tests                   |
| `packages/core/src/tools/communicate-tool.test.ts`                 | End-to-end core forwarding contract                            |
| `packages/core/src/tools/ToolRegistry.test.ts`                     | Streaming pass-through and buffered-drain regressions          |
| `packages/web/src/composables/useConversation.ts`                  | Separate live reasoning state and iteration resets             |
| `packages/web/src/composables/useConversation.test.ts`             | Reactive chunk handling tests                                  |
| `packages/web/src/components/conversations/MessageBubble.vue`      | Persisted inline disclosure                                    |
| `packages/web/src/components/conversations/MessageBubble.test.ts`  | Persisted disclosure tests                                     |
| `packages/web/src/components/conversations/ConversationThread.vue` | Live inline disclosure                                         |
| `packages/e2e/mock-provider/server.ts`                             | Deterministic SSE reasoning/tool/final scenario                |

No changes are expected in WebSocket/SSE transport code because both transports serialize arbitrary `StreamChunk` values. Regression tests below prove forwarding and buffered draining.

---

### Task 1: Canonical Chunks And OpenAI-Compatible Normalization

**Files:**

- Modify: `packages/core/src/providers/OpenAICompatibleProvider.test.ts`
- Modify: `packages/core/src/providers/Provider.ts`
- Modify: `packages/types/src/streaming.ts`
- Modify: `packages/core/src/providers/OpenAICompatibleProvider.ts`

- [ ] **Step 1: Add failing provider reasoning tests**

Add these tests inside `describe('OpenAICompatibleProvider.stream()')`:

```ts
it.each([
  ['reasoning_content', 'first thought'],
  ['reasoning', 'fallback thought'],
] as const)('maps %s to reasoning_delta', async (field, value) => {
  const reasoningChunk = JSON.stringify({
    choices: [{ delta: { [field]: value }, finish_reason: null }],
  });
  const textChunk = JSON.stringify({
    choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      body: makeSseBody([`data: ${reasoningChunk}`, `data: ${textChunk}`, 'data: [DONE]']),
    }),
  );

  const chunks: ProviderStreamChunk[] = [];
  const provider = new OpenAICompatibleProvider();
  for await (const chunk of provider.stream([], [], MODEL)) chunks.push(chunk);
  vi.unstubAllGlobals();

  expect(chunks.slice(0, 2)).toEqual([
    { type: 'reasoning_delta', delta: value },
    { type: 'text_delta', delta: 'answer' },
  ]);
});

it('prefers reasoning_content and ignores malformed reasoning without suppressing output', async () => {
  const lines = [
    JSON.stringify({
      choices: [
        {
          delta: {
            reasoning_content: 'canonical',
            reasoning: 'duplicate',
            content: 'A',
          },
          finish_reason: null,
        },
      ],
    }),
    JSON.stringify({
      choices: [
        { delta: { reasoning_content: { bad: true }, content: 'B' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      body: makeSseBody(lines.map((line) => `data: ${line}`).concat('data: [DONE]')),
    }),
  );

  const chunks: ProviderStreamChunk[] = [];
  const provider = new OpenAICompatibleProvider();
  for await (const chunk of provider.stream([], [], MODEL)) chunks.push(chunk);
  vi.unstubAllGlobals();

  expect(chunks.filter((chunk) => chunk.type !== 'done')).toEqual([
    { type: 'reasoning_delta', delta: 'canonical' },
    { type: 'text_delta', delta: 'A' },
    { type: 'text_delta', delta: 'B' },
  ]);
  expect(chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' });
});
```

- [ ] **Step 2: Run provider tests and verify failure**

Run: `npx vitest run packages/core/src/providers/OpenAICompatibleProvider.test.ts`

Expected: FAIL because no `reasoning_delta` chunks are emitted.

- [ ] **Step 3: Add canonical chunk types**

Update `ProviderStreamChunk` in `packages/core/src/providers/Provider.ts`:

```ts
export type ProviderStreamChunk =
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string }
  | { type: 'done'; stopReason: ProviderStopReason; usage?: ProviderUsage; cost?: number };
```

Update `LLMChunk` in `packages/types/src/streaming.ts`:

```ts
export type LLMChunk =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string };
```

- [ ] **Step 4: Normalize compatible provider fields**

Extend `OAIStreamChunk.choices[].delta`:

```ts
delta?: {
  content?: string | null;
  reasoning_content?: unknown;
  reasoning?: unknown;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
};
```

Immediately before `delta.content` handling, add:

```ts
const reasoning =
  typeof delta.reasoning_content === 'string'
    ? delta.reasoning_content
    : typeof delta.reasoning === 'string'
      ? delta.reasoning
      : undefined;
if (reasoning) {
  yield { type: 'reasoning_delta', delta: reasoning };
}
```

This precedence prevents duplicate emission when a proxy returns both fields.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run packages/core/src/providers/OpenAICompatibleProvider.test.ts && npm run typecheck`

Expected: provider tests and typecheck PASS. `AgentRuntime` selectively handles known chunks, and public `LLMChunk` already includes `reasoning_delta`, so no broken intermediate commit is permitted.

- [ ] **Step 6: Commit provider normalization**

```bash
git add packages/core/src/providers/Provider.ts packages/types/src/streaming.ts packages/core/src/providers/OpenAICompatibleProvider.ts packages/core/src/providers/OpenAICompatibleProvider.test.ts
git commit -m "feat(core): normalize provider reasoning chunks"
```

---

### Task 2: Message Reasoning Persistence Model

**Files:**

- Modify: `packages/types/src/conversation.ts`
- Modify: `packages/core/src/conversation/conversation-ops.ts`
- Modify: `packages/core/src/conversation/conversation-ops.test.ts`
- Modify: `packages/core/src/conversation/FileConversationStore.test.ts`

- [ ] **Step 1: Add failing conversation-operation tests**

Extend `conversation-ops.test.ts`:

```ts
it('persists reasoning on appended assistant messages', () => {
  let conv = createConversation();
  conv = appendMessage(conv, {
    senderId: 'a',
    recipientId: 'u',
    role: 'assistant',
    content: 'answer',
    reasoning: 'analysis',
  });
  expect(conv.messages[conv.activeBranchHead].reasoning).toBe('analysis');
});

it('drops stale reasoning from an edited message', () => {
  let conv = createConversation();
  conv = appendMessage(conv, {
    senderId: 'a',
    recipientId: 'u',
    role: 'assistant',
    content: 'original',
    reasoning: 'original reasoning',
  });
  const originalId = conv.activeBranchHead;

  conv = editMessage(conv, originalId, 'edited');

  expect(conv.messages[originalId].reasoning).toBe('original reasoning');
  expect(conv.messages[conv.activeBranchHead].reasoning).toBeUndefined();
});

it('keeps reasoning on pruned and compacted source nodes but not summaries', () => {
  let conv = createConversation();
  conv = appendMessage(conv, {
    senderId: 'a',
    recipientId: 'u',
    role: 'assistant',
    content: 'source',
    reasoning: 'source reasoning',
  });
  const sourceId = conv.activeBranchHead;
  conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'next' });
  const nextId = conv.activeBranchHead;

  const compacted = compactRange(conv, [sourceId], 'summary');
  const summary = Object.values(compacted.messages).find((message) => message.type === 'summary');
  expect(compacted.messages[sourceId].reasoning).toBe('source reasoning');
  expect(summary?.reasoning).toBeUndefined();

  const pruned = pruneMessage(conv, nextId, 'operator');
  expect(pruned.messages[nextId].reasoning).toBeUndefined();
  expect(pruned.messages[sourceId].reasoning).toBe('source reasoning');
});
```

- [ ] **Step 2: Add failing store compatibility tests**

Add to `FileConversationStore.test.ts`:

```ts
it('round-trips optional message reasoning', async () => {
  const created = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
  await store.appendMessage(created.id, {
    id: 'm1',
    parentId: null,
    conversationId: created.id,
    senderId: 'a',
    recipientId: 'u',
    role: 'assistant',
    content: 'answer',
    reasoning: 'analysis',
    status: 'active',
    timestamp: new Date().toISOString(),
  });
  expect((await store.load(created.id))?.messages['m1'].reasoning).toBe('analysis');
});

it('loads legacy conversations without reasoning', async () => {
  const storage = new MemoryStorage();
  const legacyStore = new FileConversationStore(storage);
  await storage.writeJson('conversations/conv-old.json', {
    id: 'conv-old',
    schemaVersion: '2.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    activeBranchHead: 'm1',
    messages: {
      m1: {
        id: 'm1',
        parentId: null,
        conversationId: 'conv-old',
        senderId: 'u',
        recipientId: 'a',
        role: 'user',
        content: 'legacy',
        status: 'active',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    },
  });
  expect((await legacyStore.load('conv-old'))?.messages['m1'].reasoning).toBeUndefined();
});
```

- [ ] **Step 3: Run tests and verify type/behavior failure**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts packages/core/src/conversation/FileConversationStore.test.ts`

Expected: FAIL or TypeScript diagnostics because `reasoning` is not in `MessageData`/`NewMessageInput`.

- [ ] **Step 4: Add and propagate optional message reasoning**

Add beside `content` in `MessageData`:

```ts
content: string;
reasoning?: string;
```

Add `reasoning` to `NewMessageInput`'s optional pick:

```ts
Pick<
  MessageData,
  'replyTo' | 'type' | 'toolCalls' | 'toolResults' | 'parentId' | 'id' | 'usage' | 'reasoning'
>;
```

Copy it in `createMessage()`:

```ts
content: input.content,
reasoning: input.reasoning,
type: input.type ?? 'message',
```

Do not modify `editMessage()` or `compactRange()`; their omission of reasoning is intentional.

- [ ] **Step 5: Run persistence tests**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts packages/core/src/conversation/FileConversationStore.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit persistence model**

```bash
git add packages/types/src/conversation.ts packages/core/src/conversation/conversation-ops.ts packages/core/src/conversation/conversation-ops.test.ts packages/core/src/conversation/FileConversationStore.test.ts
git commit -m "feat(core): persist assistant reasoning"
```

---

### Task 3: Runtime Iteration Boundaries And Per-Turn Reasoning

**Files:**

- Modify: `packages/core/src/runtime/Runtime.ts`
- Modify: `packages/core/src/runtime/AgentRuntime.ts`
- Modify: `packages/core/src/runtime/AgentRuntime.test.ts`

- [ ] **Step 1: Extend scripted runtime fixtures with reasoning**

Add `reasoning?: string` to `makeSetup()` response fixtures and emit it before text:

```ts
providerResponses: Array<{
  content: string | null;
  reasoning?: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason: ProviderStopReason;
  usage?: ProviderUsage;
  cost?: number;
  errorAfterChunks?: string;
}>,
```

```ts
if (resp.reasoning) {
  yield { type: 'reasoning_delta', delta: resp.reasoning };
}
if (resp.content) {
  yield { type: 'text_delta', delta: resp.content };
}
if (resp.errorAfterChunks) {
  throw new Error(resp.errorAfterChunks);
}
```

- [ ] **Step 2: Add failing two-iteration runtime test**

Add to `AgentRuntime.test.ts`:

```ts
it('emits boundaries and keeps reasoning separate per iteration', async () => {
  const { context, inbound, router } = await makeSetup([
    {
      content: 'calling tool',
      reasoning: 'tool reasoning',
      toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
      stopReason: 'tool_calls',
    },
    {
      content: 'final answer',
      reasoning: 'final reasoning',
      toolCalls: [],
      stopReason: 'stop',
    },
  ]);
  const runtime = new AgentRuntime('agent-1', router);
  const gen = runtime.handleStream(inbound, context);
  const chunks: LLMChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }

  expect(chunks).toEqual([
    { type: 'iteration_start', iteration: 0 },
    { type: 'reasoning_delta', delta: 'tool reasoning' },
    { type: 'text_delta', delta: 'calling tool' },
    { type: 'tool_call_start', index: 0, id: 'tc-1', name: 'echo' },
    { type: 'tool_call_args_delta', index: 0, delta: '{"text":"hello"}' },
    { type: 'iteration_start', iteration: 1 },
    { type: 'reasoning_delta', delta: 'final reasoning' },
    { type: 'text_delta', delta: 'final answer' },
  ]);
  expect(next.value).toEqual({
    kind: 'response',
    content: 'final answer',
    reasoning: 'final reasoning',
  });
  expect(context.conversation.activeChain[1]).toMatchObject({
    content: 'calling tool',
    reasoning: 'tool reasoning',
  });
});
```

- [ ] **Step 3: Add failing no-resend and buffered regressions**

Import `ProviderMessage`, capture provider requests in `makeSetup()`, and return them from the helper:

```ts
import type {
  Provider,
  ProviderMessage,
  ProviderStopReason,
  ProviderUsage,
} from '../providers/Provider.js';
```

```ts
const providerRequests: ProviderMessage[][] = [];
let responseIndex = 0;
const mockProvider: Provider = {
  async *stream(messages) {
    providerRequests.push(
      messages.map((message) => ({
        ...message,
        toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
      })),
    );
    const resp: (typeof providerResponses)[number] = providerResponses[responseIndex++] ?? {
      content: '[no more responses]',
      toolCalls: [],
      stopReason: 'stop',
    };
    if (resp.reasoning) yield { type: 'reasoning_delta', delta: resp.reasoning };
    if (resp.content) yield { type: 'text_delta', delta: resp.content };
    for (let i = 0; i < resp.toolCalls.length; i++) {
      const toolCall = resp.toolCalls[i];
      yield {
        type: 'tool_call_start',
        index: i,
        id: toolCall.id,
        name: toolCall.name,
      };
      yield {
        type: 'tool_call_args_delta',
        index: i,
        delta: JSON.stringify(toolCall.arguments),
      };
    }
    if (resp.errorAfterChunks) throw new Error(resp.errorAfterChunks);
    yield { type: 'done', stopReason: resp.stopReason, usage: resp.usage };
  },
};
```

Return `providerRequests` with the existing setup values. Add this test:

```ts
it('does not send reasoning back to the provider on later iterations', async () => {
  const { context, inbound, router, providerRequests } = await makeSetup([
    {
      content: null,
      reasoning: 'private reasoning',
      toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
      stopReason: 'tool_calls',
    },
    { content: 'done', toolCalls: [], stopReason: 'stop' },
  ]);

  await new AgentRuntime('agent-1', router).handle(inbound, context);

  expect(providerRequests).toHaveLength(2);
  expect(providerRequests[1].some((message) => 'reasoning' in message)).toBe(false);
  expect(providerRequests[1].map((message) => message.content)).not.toContain('private reasoning');
});
```

Also extend the existing no-tools test with reasoning and assert buffered `handle()` returns:

```ts
expect(result).toEqual({
  kind: 'response',
  content: 'I am happy to help!',
  reasoning: 'brief analysis',
});
```

Keep one no-reasoning assertion proving the optional field is omitted:

```ts
expect(result).toEqual({ kind: 'response', content: 'plain answer' });
```

Add a failed-turn regression:

```ts
it('does not return or persist partial reasoning from a failed iteration', async () => {
  const { context, inbound, router } = await makeSetup([
    {
      content: null,
      reasoning: 'incomplete reasoning',
      toolCalls: [],
      stopReason: 'stop',
      errorAfterChunks: 'stream interrupted',
    },
  ]);

  const result = await new AgentRuntime('agent-1', router).handle(inbound, context);

  expect(result).toEqual({
    kind: 'response',
    content: '[AgentRuntime error: stream interrupted]',
  });
  expect(context.conversation.activeChain).toHaveLength(1);
});
```

- [ ] **Step 4: Run runtime tests and verify failure**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`

Expected: FAIL because no boundaries/reasoning accumulation exist.

- [ ] **Step 5: Implement runtime result and accumulator changes**

Update `RuntimeResult`:

```ts
export type RuntimeResult =
  | { kind: 'response'; content: string; reasoning?: string; usage?: MessageUsage }
  | { kind: 'pending_approval'; approvalRequests: PendingApproval[] }
  | { kind: 'void' };
```

Update accumulator construction and handling:

```ts
interface TurnAccumulator {
  content: string;
  reasoning: string;
  toolCalls: Map<number, { id: string; name: string; argsBuffer: string }>;
  stopReason?: ProviderStopReason;
  usage?: ProviderUsage;
  cost?: number;
}

function freshAccumulator(): TurnAccumulator {
  return { content: '', reasoning: '', toolCalls: new Map() };
}
```

```ts
if (chunk.type === 'reasoning_delta') {
  acc.reasoning += chunk.delta;
} else if (chunk.type === 'text_delta') {
  acc.content += chunk.delta;
}
```

Return `reasoning` from `accumulatorToResponse()`:

```ts
function accumulatorToResponse(acc: TurnAccumulator): {
  content: string | null;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason: ProviderStopReason;
  usage?: ProviderUsage;
  cost?: number;
} {
  const toolCalls = [...acc.toolCalls.values()].map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    arguments: (() => {
      try {
        return JSON.parse(toolCall.argsBuffer || '{}') as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })(),
  }));
  return {
    content: acc.content || null,
    reasoning: acc.reasoning,
    toolCalls,
    stopReason: acc.stopReason ?? 'stop',
    usage: acc.usage,
    cost: acc.cost,
  };
}
```

Emit the boundary before provider streaming:

```ts
yield { type: 'iteration_start', iteration: i };
const acc = freshAccumulator();
for await (const chunk of provider.stream(messages, providerTools, agent.model)) {
  accumulateChunk(acc, chunk);
  if (chunk.type !== 'done') yield chunk;
}
```

Propagate final reasoning:

```ts
return {
  kind: 'response',
  content: response.content ?? '',
  ...(response.reasoning ? { reasoning: response.reasoning } : {}),
  usage,
};
```

Persist intermediate reasoning in the existing `conversation.append()`:

```ts
content: response.content ?? '',
reasoning: response.reasoning || undefined,
toolCalls: toolCallData,
```

Do not add reasoning to either `messages.push()` block or `ProviderMessage`.

- [ ] **Step 6: Run runtime and type tests**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts packages/types/src/types.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit runtime behavior**

```bash
git add packages/core/src/runtime/Runtime.ts packages/core/src/runtime/AgentRuntime.ts packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "feat(core): stream reasoning by agent iteration"
```

---

### Task 4: Router Persistence And Stream Forwarding Regressions

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.ts`
- Modify: `packages/core/src/runtime/MessageRouter.test.ts`
- Modify: `packages/core/src/tools/communicate-tool.test.ts`
- Modify: `packages/core/src/tools/ToolRegistry.test.ts`

- [ ] **Step 1: Add failing router persistence tests**

Add a focused helper that reuses `setup()` storage and context but replaces its runtime registry:

```ts
async function setupReasoningRouter(dir: string) {
  const base = await setup(dir);
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', () => ({
    async handle() {
      return { kind: 'response', content: 'answer', reasoning: 'analysis' } as const;
    },
    async *handleStream() {
      yield { type: 'iteration_start', iteration: 0 } as const;
      yield { type: 'reasoning_delta', delta: 'analysis' } as const;
      yield { type: 'text_delta', delta: 'answer' } as const;
      return { kind: 'response', content: 'answer', reasoning: 'analysis' } as const;
    },
  }));
  return {
    ...base,
    router: new MessageRouter(base.store, registry, base.collective, base.eventBus),
  };
}
```

Use this helper for runtime output:

```ts
async handle() {
  return { kind: 'response', content: 'answer', reasoning: 'analysis' } as const;
},
async *handleStream() {
  yield { type: 'iteration_start', iteration: 0 } as const;
  yield { type: 'reasoning_delta', delta: 'analysis' } as const;
  yield { type: 'text_delta', delta: 'answer' } as const;
  return { kind: 'response', content: 'answer', reasoning: 'analysis' } as const;
},
```

Cover three paths:

```ts
it('forwards stream chunks and persists reasoning', async () => {
  const { router, baseContext, store } = await setupReasoningRouter(dir);
  const gen = router.sendStream({
    senderId: 'op',
    recipientId: 'mock-1',
    message: 'hello',
    context: baseContext,
  });
  const streamedChunks: LLMChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    streamedChunks.push(next.value);
    next = await gen.next();
  }
  expect(streamedChunks).toEqual([
    { type: 'iteration_start', iteration: 0 },
    { type: 'reasoning_delta', delta: 'analysis' },
    { type: 'text_delta', delta: 'answer' },
  ]);
  const conversation = await store.load(next.value.conversationId);
  const persistedAssistant = Object.values(conversation!.messages).find(
    (message) => message.role === 'assistant',
  );
  expect(persistedAssistant).toMatchObject({ content: 'answer', reasoning: 'analysis' });
});
```

- `router.send()` persists reasoning.
- `router.sendStream()` forwards all chunks and persists reasoning.
- `router.send({ replyTo: 'op' })`, followed by `await router.drain()`, persists reasoning.

- [ ] **Step 2: Add forwarding/draining regression tests**

Update the streaming tool in `ToolRegistry.test.ts` to yield:

```ts
yield { type: 'iteration_start', iteration: 0 } satisfies StreamChunk;
yield { type: 'reasoning_delta', delta: 'why' } satisfies StreamChunk;
yield { type: 'text_delta', delta: 'answer' } satisfies StreamChunk;
```

Assert `stream()` preserves exact order before `stream:done`, while `execute()` still returns only:

```ts
expect(result).toEqual({ status: 'success' });
```

Update `communicate-tool.test.ts`'s streaming setup so its router yields the same three chunks. Assert the chunks are unchanged and terminal `ToolResult.data.response` remains `B replies`.

- [ ] **Step 3: Run focused tests and verify persistence failure**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts packages/core/src/tools/communicate-tool.test.ts packages/core/src/tools/ToolRegistry.test.ts`

Expected: forwarding tests may pass, but router persistence assertions FAIL because reasoning is not appended.

- [ ] **Step 4: Persist reasoning in every router result path**

Change `persistResponse()` to avoid ambiguous positional optionals:

```ts
private async persistResponse(
  thread: ConversationThread,
  senderId: string,
  recipientId: string,
  response: { content: string; reasoning?: string; usage?: MessageUsage },
): Promise<void> {
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
}
```

Update streamed and buffered callers:

```ts
await this.persistResponse(thread, senderId, defaultRecipientId, {
  content: result.content,
  reasoning: result.reasoning,
  usage: result.usage,
});
```

Update `dispatchAsync()`'s direct append:

```ts
await thread.append({
  senderId: opts.recipientId,
  recipientId: opts.replyTo ?? opts.senderId,
  role: 'assistant',
  content: result.content,
  reasoning: result.reasoning,
  usage: result.usage,
});
```

- [ ] **Step 5: Run focused and full core tests**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts packages/core/src/tools/communicate-tool.test.ts packages/core/src/tools/ToolRegistry.test.ts && npm test`

Expected: 0 failures. Buffered tool result shapes remain unchanged.

- [ ] **Step 6: Commit router and forwarding behavior**

```bash
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts packages/core/src/tools/communicate-tool.test.ts packages/core/src/tools/ToolRegistry.test.ts
git commit -m "feat(core): persist and forward reasoning streams"
```

---

### Task 5: Frontend Iteration-Aware Stream State

**Files:**

- Modify: `packages/web/src/composables/useConversation.ts`
- Modify: `packages/web/src/composables/useConversation.test.ts`

- [ ] **Step 1: Make the stream mock reactive and capture chunk handlers**

Replace the static `useToolStream` mock with module-level reactive fixtures:

```ts
import { nextTick, ref } from 'vue';
import type { StreamChunk } from '@legion/types';

let communicateOnChunk: ((chunk: StreamChunk) => void) | undefined;
const streamDone = ref(false);
const streamResult = ref<unknown>(null);

vi.mock('./useToolStream.js', () => ({
  useToolStream: vi.fn(
    (name: string, _args: unknown, options?: { onChunk?: (chunk: StreamChunk) => void }) => {
      if (name === 'communicate') communicateOnChunk = options?.onChunk;
      return {
        start: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
        chunks: ref([]),
        done: streamDone,
        error: ref(null),
        conversationId: ref(null),
        result: streamResult,
      };
    },
  ),
}));
```

Reset refs and handler in `beforeEach()`.

- [ ] **Step 2: Add failing iteration and reasoning state tests**

```ts
it('tracks reasoning separately and resets both buffers at iteration boundaries', async () => {
  const { useConversation } = await import('./useConversation.js');
  const { streamingReasoning, streamingText } = useConversation(null);

  communicateOnChunk?.({ type: 'iteration_start', iteration: 0 });
  communicateOnChunk?.({ type: 'reasoning_delta', delta: 'tool thought' });
  communicateOnChunk?.({ type: 'text_delta', delta: 'tool preface' });
  expect(streamingReasoning.value).toBe('tool thought');
  expect(streamingText.value).toBe('tool preface');

  communicateOnChunk?.({ type: 'iteration_start', iteration: 1 });
  communicateOnChunk?.({ type: 'reasoning_delta', delta: 'final thought' });
  communicateOnChunk?.({ type: 'text_delta', delta: 'final answer' });
  expect(streamingReasoning.value).toBe('final thought');
  expect(streamingText.value).toBe('final answer');
});

it('clears temporary reasoning and text when stream completes', async () => {
  const { useConversation } = await import('./useConversation.js');
  const { streamingReasoning, streamingText } = useConversation(null);
  communicateOnChunk?.({ type: 'reasoning_delta', delta: 'thought' });
  communicateOnChunk?.({ type: 'text_delta', delta: 'answer' });

  streamDone.value = true;
  await nextTick();

  expect(streamingReasoning.value).toBe('');
  expect(streamingText.value).toBe('');
});
```

- [ ] **Step 3: Run web composable tests and verify failure**

Run: `npm run test --workspace=packages/web -- src/composables/useConversation.test.ts`

Expected: FAIL because `streamingReasoning` is absent and boundaries are ignored.

- [ ] **Step 4: Implement separate temporary state**

Add state:

```ts
const streamingText = ref('');
const streamingReasoning = ref('');
```

Replace communicate chunk handling:

```ts
onChunk: (chunk: StreamChunk) => {
  if (chunk.type === 'iteration_start') {
    streamingText.value = '';
    streamingReasoning.value = '';
  } else if (chunk.type === 'reasoning_delta') {
    streamingReasoning.value += chunk.delta;
  } else if (chunk.type === 'text_delta') {
    streamingText.value += chunk.delta;
  }
},
```

Clear `streamingReasoning` everywhere `streamingText` is reset: before `send()`, on `communicateStream.done`, and on `message:delivered`. Return it from the composable.

- [ ] **Step 5: Run all web composable tests**

Run: `npm run test --workspace=packages/web -- src/composables/useConversation.test.ts src/composables/useToolStream.test.ts src/composables/useWebSocket.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit frontend stream state**

```bash
git add packages/web/src/composables/useConversation.ts packages/web/src/composables/useConversation.test.ts
git commit -m "feat(web): track reasoning by stream iteration"
```

---

### Task 6: Inline Reasoning Disclosure

**Files:**

- Create: `packages/web/src/components/conversations/ReasoningDisclosure.vue`
- Create: `packages/web/src/components/conversations/ReasoningDisclosure.test.ts`
- Modify: `packages/web/src/components/conversations/MessageBubble.vue`
- Modify: `packages/web/src/components/conversations/MessageBubble.test.ts`
- Modify: `packages/web/src/components/conversations/ConversationThread.vue`
- Create: `packages/web/src/components/conversations/ConversationThread.test.ts`

- [ ] **Step 1: Write failing disclosure component tests**

Create `ReasoningDisclosure.test.ts`:

```ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ReasoningDisclosure from './ReasoningDisclosure.vue';

describe('ReasoningDisclosure', () => {
  it('renders persisted reasoning collapsed by default', () => {
    const wrapper = mount(ReasoningDisclosure, {
      props: { content: '**analysis**', streaming: false },
    });
    expect(wrapper.get('details').attributes('open')).toBeUndefined();
    expect(wrapper.text()).toContain('Reasoning');
    expect(wrapper.findComponent({ name: 'MarkdownContent' }).props('content')).toBe(
      '**analysis**',
    );
  });

  it('renders streaming reasoning in a forced-open container', () => {
    const wrapper = mount(ReasoningDisclosure, {
      props: { content: 'live thought', streaming: true },
    });
    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.get('[data-streaming-reasoning]').text()).toContain('live thought');
  });
});
```

- [ ] **Step 2: Add failing persisted-message tests**

Extend `MessageBubble.test.ts`:

```ts
it('renders assistant reasoning collapsed before answer content', () => {
  const wrapper = mount(MessageBubble, {
    props: {
      message: { ...agentMessage, reasoning: '**because**' },
      isOwn: false,
      senderName: 'Atlas',
    },
  });
  const disclosure = wrapper.get('[data-reasoning]');
  expect(disclosure.element.tagName).toBe('DETAILS');
  expect(disclosure.attributes('open')).toBeUndefined();
  expect(disclosure.element.compareDocumentPosition(wrapper.get('[data-answer]').element)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

it('hides whitespace reasoning and still renders reasoning when answer is empty', () => {
  const hidden = mount(MessageBubble, {
    props: { message: { ...agentMessage, reasoning: '   ' }, isOwn: false, senderName: 'Atlas' },
  });
  expect(hidden.find('[data-reasoning]').exists()).toBe(false);

  const reasoningOnly = mount(MessageBubble, {
    props: {
      message: { ...agentMessage, content: '', reasoning: 'analysis' },
      isOwn: false,
      senderName: 'Atlas',
    },
  });
  expect(reasoningOnly.find('[data-reasoning]').exists()).toBe(true);
});
```

- [ ] **Step 3: Run component tests and verify failure**

Run: `npm run test --workspace=packages/web -- src/components/conversations/ReasoningDisclosure.test.ts src/components/conversations/MessageBubble.test.ts`

Expected: FAIL because component/selectors do not exist.

- [ ] **Step 4: Implement reusable disclosure**

Create `ReasoningDisclosure.vue`:

```vue
<script setup lang="ts">
import MarkdownContent from '../MarkdownContent.vue';

defineOptions({ name: 'ReasoningDisclosure' });
defineProps<{ content: string; streaming: boolean }>();
</script>

<template>
  <div
    v-if="streaming"
    data-reasoning
    data-streaming-reasoning
    class="mb-2 rounded border border-navy-600 bg-navy-900/60 px-2.5 py-2 text-slate-400"
  >
    <div class="mb-1 text-xs font-medium text-cyan-500">Reasoning</div>
    <MarkdownContent :content="content" class="text-xs leading-relaxed" />
  </div>
  <details
    v-else
    data-reasoning
    class="mb-2 rounded border border-navy-600 bg-navy-900/60 px-2.5 py-2 text-slate-400"
  >
    <summary class="cursor-pointer select-none text-xs font-medium text-cyan-500">
      Reasoning
    </summary>
    <MarkdownContent :content="content" class="mt-2 text-xs leading-relaxed" />
  </details>
</template>
```

- [ ] **Step 5: Integrate persisted reasoning into `MessageBubble`**

Import `ReasoningDisclosure`, then replace the standalone answer component with one shared bubble container:

```vue
<div
  v-else-if="message.content?.trim() || message.reasoning?.trim()"
  class="max-w-[72%] px-3 py-2 text-sm leading-relaxed break-words"
  :class="
    message.type === 'summary'
      ? 'border-l-2 border-cyan-500 bg-navy-700 text-slate-200 rounded-[12px]'
      : isOwn
        ? 'bg-cyan-700 text-white rounded-[12px_12px_3px_12px]'
        : 'bg-navy-800 text-slate-200 rounded-[12px_12px_12px_3px]'
  "
>
  <ReasoningDisclosure
    v-if="message.role === 'assistant' && message.reasoning?.trim()"
    :content="message.reasoning.trim()"
    :streaming="false"
  />
  <MarkdownContent
    v-if="message.content?.trim()"
    data-answer
    :content="message.content.trim()"
  />
</div>
```

Reasoning renders only for assistant messages, including an authorized participant viewing their own assistant message. Existing summaries and user bubbles keep their current classes.

- [ ] **Step 6: Integrate live reasoning into `ConversationThread`**

Import `ReasoningDisclosure`, destructure `streamingReasoning`, and add:

```ts
const trimmedStreamingText = computed(() => streamingText.value.trim());
const trimmedStreamingReasoning = computed(() => streamingReasoning.value.trim());
const hasStreamingResponse = computed(
  () => !!trimmedStreamingText.value || !!trimmedStreamingReasoning.value,
);
```

Replace the current streaming text bubble:

```vue
<div v-if="hasStreamingResponse" data-streaming-message class="flex flex-col gap-1">
  <span class="ml-1 text-xs text-slate-500">{{ recipientName ?? 'Assistant' }}</span>
  <div
    class="max-w-[80%] rounded-[12px_12px_3px_12px] bg-navy-800 px-3 py-2 text-sm text-slate-200"
  >
    <ReasoningDisclosure
      v-if="trimmedStreamingReasoning"
      :content="trimmedStreamingReasoning"
      :streaming="true"
    />
    <p v-if="trimmedStreamingText" data-streaming-answer class="whitespace-pre-wrap">
      {{ trimmedStreamingText }}<span class="animate-pulse">▋</span>
    </p>
  </div>
</div>
```

Change thinking indicator condition to `isThinking && !hasStreamingResponse`.

- [ ] **Step 7: Render reasoning for authorized read-only viewers**

Replace read-only message rendering with:

```vue
<template v-else>
  <div v-for="msg in messages" :key="msg.id" class="text-sm text-slate-300">
    <span class="text-xs text-slate-500">{{ msg.senderId }}</span>
    <div class="mt-0.5 max-w-[80%] rounded bg-navy-800 px-3 py-2">
      <ReasoningDisclosure
        v-if="msg.role === 'assistant' && msg.reasoning?.trim()"
        :content="msg.reasoning.trim()"
        :streaming="false"
      />
      <p v-if="msg.content?.trim()">{{ msg.content }}</p>
    </div>
  </div>
</template>
```

Create `ConversationThread.test.ts`:

```ts
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import ConversationThread from './ConversationThread.vue';

const messages = ref([
  {
    id: 'm1',
    parentId: null,
    conversationId: 'c1',
    senderId: 'agent-1',
    recipientId: 'viewer',
    role: 'assistant' as const,
    content: 'answer',
    reasoning: 'visible reasoning',
    status: 'active' as const,
    timestamp: '2026-01-01T00:00:00.000Z',
  },
]);

vi.mock('../../composables/useExecute.js', () => ({
  useExecute: () => ({ execute: vi.fn() }),
}));
vi.mock('../../composables/useConversation.js', () => ({
  useConversation: () => ({
    messages,
    subThreads: ref({}),
    loading: ref(false),
    isThinking: ref(false),
    streamingText: ref(''),
    streamingReasoning: ref(''),
    sentConversationId: ref(null),
    markSent: vi.fn(),
    send: vi.fn(),
    editMessage: vi.fn(),
    generate: vi.fn(),
    pruneMessage: vi.fn(),
    compactConversation: vi.fn(),
    switchBranch: vi.fn(),
  }),
}));

describe('ConversationThread', () => {
  it('shows persisted reasoning to read-only conversation viewers', () => {
    const wrapper = mount(ConversationThread, {
      props: { conversationId: 'c1', mode: 'read', myParticipantId: 'viewer' },
    });
    expect(wrapper.get('details[data-reasoning]').text()).toContain('visible reasoning');
    expect(wrapper.text()).toContain('answer');
  });
});
```

- [ ] **Step 8: Run web tests**

Run: `npm run test --workspace=packages/web`

Expected: all web tests PASS.

- [ ] **Step 9: Commit disclosure UI**

```bash
git add packages/web/src/components/conversations/ReasoningDisclosure.vue packages/web/src/components/conversations/ReasoningDisclosure.test.ts packages/web/src/components/conversations/MessageBubble.vue packages/web/src/components/conversations/MessageBubble.test.ts packages/web/src/components/conversations/ConversationThread.vue packages/web/src/components/conversations/ConversationThread.test.ts
git commit -m "feat(web): show inline reasoning disclosures"
```

---

### Task 7: Deterministic Two-Iteration E2E Coverage

**Files:**

- Modify: `packages/e2e/mock-provider/server.ts`
- Create: `packages/e2e/tests/conversations/reasoning.spec.ts`

- [ ] **Step 1: Convert mock chat responses to SSE without changing default content**

Add helpers in `server.ts`:

```ts
type ChatMessage = { role?: string; content?: string | null };
type ChatRequest = { messages?: ChatMessage[] };

async function writeSse(
  res: import('node:http').ServerResponse,
  chunks: unknown[],
  delayMs = 0,
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.writeHead(200);
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  res.end('data: [DONE]\n\n');
}

function defaultChunks(): unknown[] {
  return [
    { choices: [{ delta: { content: 'mock response' }, finish_reason: null }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    },
  ];
}
```

Make the `req.on('end')` callback async. In the chat route, parse `_body` as `ChatRequest`. Keep `/v1/models` JSON, but `await writeSse(res, defaultChunks())` for ordinary chat requests. This preserves existing E2E answer text while matching production streaming protocol.

- [ ] **Step 2: Add a deterministic reasoning scenario to the mock**

Detect scenario and iteration from request messages:

```ts
const body = JSON.parse(_body || '{}') as ChatRequest;
const messages = body.messages ?? [];
const isReasoningScenario = messages.some(
  (message) => message.role === 'user' && message.content?.includes('E2E_REASONING_SCENARIO'),
);
const hasToolResult = messages.some((message) => message.role === 'tool');
```

If scenario has no tool-role message, emit:

```ts
await writeSse(
  res,
  [
    { choices: [{ delta: { reasoning_content: '**tool reasoning**' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'temporary preface' }, finish_reason: null }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'reasoning-tool-call',
                type: 'function',
                function: { name: 'list_participants', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ],
  300,
);
```

If a tool-role message exists, emit:

```ts
await writeSse(
  res,
  [
    { choices: [{ delta: { reasoning: '*final reasoning*' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'final reasoning answer' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } },
  ],
  300,
);
```

Use request contents, not global request count, to select iteration. The 300 ms scenario-only delay makes both live states observable without slowing ordinary E2E calls.

Route with explicit branches:

```ts
if (isReasoningScenario && !hasToolResult) {
  await writeSse(res, firstReasoningChunks, 300);
  return;
}
if (isReasoningScenario && hasToolResult) {
  await writeSse(res, finalReasoningChunks, 300);
  return;
}
await writeSse(res, defaultChunks());
```

Name the two arrays `firstReasoningChunks` and `finalReasoningChunks` from the exact chunk lists above.

- [ ] **Step 3: Write the browser test**

Create `reasoning.spec.ts`. Its `beforeAll` logs in, configures `reasoning-mock-provider` with `connInfo.mockProviderUrl`, and creates a dedicated agent:

```ts
import { test, expect } from '../../fixtures/index.js';

test.describe('reasoning stream', () => {
  let agentName: string;

  test.beforeAll(async ({ api, connInfo }) => {
    const { token } = await api.login('operator', connInfo.password);
    await api.execute(token, 'set_credential_with_meta', {
      key: 'reasoning-test-cred',
      value: 'sk-mock',
      usedBy: [],
    });
    await api.execute(token, 'configure_provider', {
      name: 'reasoning-mock-provider',
      type: 'openai-compatible',
      baseUrl: connInfo.mockProviderUrl,
      defaultModel: 'mock-model',
      credentialKey: 'reasoning-test-cred',
    });
    agentName = `reasoning-agent-${Date.now()}`;
    const created = await api.execute<{ id: string }>(token, 'create_agent', {
      id: agentName,
      name: agentName,
      systemPrompt: 'Use available tools when requested.',
      model: { provider: 'reasoning-mock-provider', model: 'mock-model' },
      tools: { list_participants: 'auto' },
    });
    expect(created.result.status).toBe('success');
  });
```

Start the test through exact draft-conversation selectors:

```ts
test('streams and persists reasoning per iteration', async ({ authPage }) => {
  const { page } = authPage;
  await page.goto('/#/conversations/new');
  await page.getByPlaceholder('Select agent...').click();
  await page.locator('[data-option]').filter({ hasText: agentName }).click();
  const composer = page.getByPlaceholder(`Message ${agentName}...`);
  await composer.fill('E2E_REASONING_SCENARIO');
  await composer.press('Enter');
```

Navigate to `/#/conversations/new`, select the agent, send `E2E_REASONING_SCENARIO`, then assert:

```ts
const live = page.locator('[data-streaming-message]');
await expect(live.locator('[data-streaming-reasoning]')).toContainText('tool reasoning');
await expect(live.locator('[data-streaming-reasoning]')).toContainText('final reasoning');
await expect(live).not.toContainText('temporary preface');
await expect(live.locator('[data-streaming-answer]')).toContainText('final reasoning answer');

await expect(page.getByText('final reasoning answer')).toBeVisible();
const disclosures = page.locator('details[data-reasoning]');
await expect(disclosures).toHaveCount(2);
await expect(disclosures.nth(0)).not.toHaveAttribute('open', '');
await expect(disclosures.nth(1)).not.toHaveAttribute('open', '');

await disclosures.nth(0).locator('summary').click();
await expect(disclosures.nth(0)).toHaveAttribute('open', '');
await expect(disclosures.nth(1)).not.toHaveAttribute('open', '');
await expect(disclosures.nth(0)).toContainText('tool reasoning');

await page.reload();
await expect(page.locator('details[data-reasoning]')).toHaveCount(2);
await expect(page.locator('details[data-reasoning]').nth(0)).not.toHaveAttribute('open', '');
});
});
```

Avoid arbitrary sleeps in the test; provider delay supplies observable state and Playwright assertions auto-wait.

- [ ] **Step 4: Build and run focused E2E test**

Run: `npm run build && npm run test:e2e -- tests/conversations/reasoning.spec.ts`

Expected: PASS.

- [ ] **Step 5: Run existing conversation E2E tests**

Run: `npm run test:e2e -- tests/conversations/conversations.spec.ts tests/conversations/markdown.spec.ts`

Expected: PASS with default mock response still equal to `mock response`.

- [ ] **Step 6: Commit E2E coverage**

```bash
git add packages/e2e/mock-provider/server.ts packages/e2e/tests/conversations/reasoning.spec.ts
git commit -m "test(e2e): cover multi-iteration reasoning stream"
```

---

### Task 8: Final Regression Verification

**Files:**

- No source changes expected

- [ ] **Step 1: Audit every new public chunk consumer**

Run:

```bash
rg "LLMChunk|ProviderStreamChunk|text_delta|tool_call_start" packages --glob '*.{ts,vue}'
```

Confirm:

- `AgentRuntime` explicitly handles provider `reasoning_delta`.
- `useConversation` explicitly handles `iteration_start` and `reasoning_delta`.
- Router, tools, registry, WebSocket, and SSE paths forward arbitrary chunks.
- Buffered `AgentRuntime.handle()` and `ToolRegistry.execute()` drain new chunks.
- No `ProviderMessage` or outbound OpenAI message contains persisted reasoning.

- [ ] **Step 2: Run required formatting check**

Run: `npm run format:check`

Expected: PASS. If unrelated local `.legion` or untracked files fail this workspace-wide command, run Prettier on every file changed by this plan and report unrelated blockers explicitly; do not modify unrelated workspace data.

- [ ] **Step 3: Run required typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Run required root tests**

Run: `npm test`

Expected: PASS with no new skipped tests.

- [ ] **Step 5: Run required web tests**

Run: `npm run test --workspace=packages/web`

Expected: PASS.

- [ ] **Step 6: Run reasoning E2E test after production build**

Run: `npm run build && npm run test:e2e -- tests/conversations/reasoning.spec.ts`

Expected: PASS.

- [ ] **Step 7: Inspect final diff and commit any verification-only fixes**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

If verification required a code fix, commit only plan-related files with a focused message. Otherwise, do not create an empty commit.
