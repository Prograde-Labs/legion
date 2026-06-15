# Provider Abstraction & AgentRuntime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `Provider` interface, an OpenAI-compatible fetch-based provider, `ProviderRegistry`, and `AgentRuntime` (the LLM agentic loop). End state: a real `AgentRuntime` that drives an agent's tool-call loop over any OpenAI-compatible endpoint, verified by an env-gated live integration test end-to-end through `MessageRouter`.

**Architecture:** `Provider` is a plain interface — `complete(messages, tools, model)` → `ProviderResponse`. `OpenAICompatibleProvider` implements it with native `fetch` against the OpenAI Chat Completions API (no SDK; covers OpenAI, Ollama, LM Studio, Azure, etc.). `ProviderRegistry` maps provider names to `Provider` instances and is constructor-injected into `AgentRuntime`. `AgentRuntime` reads the agent's conversation history from `context.conversation.activeChain`, builds a `ProviderMessage[]`, calls the provider, executes tool calls (persisting each turn to the conversation), loops until the provider returns a text response or the iteration limit is hit, then returns the final response string for `MessageRouter` to persist. Depends on Plans 1–5.

**Tech Stack:** `@legion/core`, native `fetch` (Node 20+), Vitest (`vi.stubGlobal`).

---

## File Structure

```
packages/core/src/providers/
  Provider.ts                       — Provider interface + ProviderMessage/Tool/Response types
  ProviderRegistry.ts               — name → Provider (constructor-injected into AgentRuntime)
  ProviderRegistry.test.ts
  OpenAICompatibleProvider.ts       — native-fetch implementation of Provider
  OpenAICompatibleProvider.test.ts  — vi.stubGlobal('fetch') unit tests
packages/core/src/runtime/
  AgentRuntime.ts                   — LLM agentic loop
  AgentRuntime.test.ts              — scripted-provider unit tests (no network)
  agent-runtime.integration.test.ts — env-gated live test (LEGION_OPENAI_INTEGRATION=1)
```

All new symbols exported from `packages/core/src/index.ts`.

> **Cross-plan note:** `ConversationThread.data` is already `public` (Plan 2, Task 7) and
> `ConversationThread.activeChain` returns `getActiveChain(this.data)`. No modifications
> to earlier plans required.

---

## Task 1: Provider types + ProviderRegistry

**Files:**
- Create: `packages/core/src/providers/Provider.ts`
- Create: `packages/core/src/providers/ProviderRegistry.ts`
- Test: `packages/core/src/providers/ProviderRegistry.test.ts`

- [ ] **Step 1: Create `Provider.ts`** (types only; stays in core — not shared with web)

```typescript
import type { JSONSchema, ModelConfig } from '@legion/types';

/**
 * A message in the LLM conversation thread.
 * `role: 'tool'` carries the result of a function call; use `toolCallId` to match it.
 */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Set on role:'assistant' messages that contain function calls. */
  toolCalls?: ProviderToolCall[];
  /** Set on role:'tool' messages — matches the originating ProviderToolCall.id. */
  toolCallId?: string;
  /** Set on role:'tool' messages — the tool name (convenience for logging). */
  name?: string;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool definition sent to the LLM so it can choose to call it. */
export interface ProviderTool {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export type ProviderStopReason = 'stop' | 'tool_calls' | 'max_tokens';

export interface ProviderResponse {
  /** Final assistant text, or null if the LLM only produced tool calls. */
  content: string | null;
  /** Non-empty when stopReason === 'tool_calls'. */
  toolCalls: ProviderToolCall[];
  stopReason: ProviderStopReason;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * Custom LLM provider interface. Implementations are constructor-injected
 * into AgentRuntime via ProviderRegistry. `model` carries per-model config
 * (base URL, api key env var name, temperature, etc.) from WorkspaceConfig.
 */
export interface Provider {
  complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Promise<ProviderResponse>;
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/providers/ProviderRegistry.test.ts`:

```typescript
import { ProviderRegistry } from './ProviderRegistry.js';
import type { Provider } from './Provider.js';

const stubProvider: Provider = {
  async complete() {
    return { content: 'ok', toolCalls: [], stopReason: 'stop' };
  },
};

describe('ProviderRegistry', () => {
  it('registers and retrieves a provider by name', () => {
    const reg = new ProviderRegistry();
    reg.register('openai-compatible', stubProvider);
    expect(reg.has('openai-compatible')).toBe(true);
    expect(reg.get('openai-compatible')).toBe(stubProvider);
  });

  it('returns undefined for an unregistered name', () => {
    const reg = new ProviderRegistry();
    expect(reg.get('anthropic')).toBeUndefined();
    expect(reg.has('anthropic')).toBe(false);
  });

  it('rejects duplicate registration', () => {
    const reg = new ProviderRegistry();
    reg.register('openai-compatible', stubProvider);
    expect(() => reg.register('openai-compatible', stubProvider)).toThrow(/already registered/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/providers/ProviderRegistry.test.ts`
Expected: FAIL — `Cannot find module './ProviderRegistry.js'`.

- [ ] **Step 4: Write minimal implementation**

`packages/core/src/providers/ProviderRegistry.ts`:

```typescript
import { ConflictError } from '../errors/LegionError.js';
import type { Provider } from './Provider.js';

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  register(name: string, provider: Provider): void {
    if (this.providers.has(name)) {
      throw new ConflictError(`Provider already registered: ${name}`);
    }
    this.providers.set(name, provider);
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/providers/ProviderRegistry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers/Provider.ts packages/core/src/providers/ProviderRegistry.ts packages/core/src/providers/ProviderRegistry.test.ts
git commit -m "feat(core): add Provider interface and ProviderRegistry"
```

---

## Task 2: OpenAICompatibleProvider

**Files:**
- Create: `packages/core/src/providers/OpenAICompatibleProvider.ts`
- Test: `packages/core/src/providers/OpenAICompatibleProvider.test.ts`

> Spec §11: `ModelConfig.baseUrl` and `ModelConfig.apiKeyEnv` are per-model overrides.
> `WorkspaceConfig.providers[name]` holds provider-level defaults. The provider reads:
> base URL: `model.baseUrl` → `process.env['OPENAI_BASE_URL']` → constructor default.
> API key: `process.env[model.apiKeyEnv ?? defaultApiKeyEnv]`.
>
> Uses native `fetch` (Node 20+) — no SDK dependency in `@legion/core`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/providers/OpenAICompatibleProvider.test.ts`:

```typescript
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion/types';

const MODEL: ModelConfig = { provider: 'openai-compatible', model: 'gpt-4o-mini' };

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function makeErrResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(text),
  };
}

describe('OpenAICompatibleProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a well-formed chat completion request and maps a text response', async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'Hello!', tool_calls: null },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/chat/completions');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o-mini');
    expect((body['messages'] as unknown[]).length).toBe(1);
    expect(body['tools']).toBeUndefined();

    expect(result.content).toBe('Hello!');
    expect(result.stopReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage?.promptTokens).toBe(10);
    expect(result.usage?.completionTokens).toBe(5);
  });

  it('maps a tool_calls response to ProviderToolCall[]', async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'echo', arguments: '{"text":"hello world"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await provider.complete([], [], MODEL);

    expect(result.stopReason).toBe('tool_calls');
    expect(result.content).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'call_abc',
      name: 'echo',
      arguments: { text: 'hello world' },
    });
  });

  it('includes tools and tool_choice in the request when tools are provided', async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse({
        choices: [
          { message: { role: 'assistant', content: 'ok', tool_calls: null }, finish_reason: 'stop' },
        ],
      }),
    );

    const provider = new OpenAICompatibleProvider();
    await provider.complete(
      [],
      [{ name: 'echo', description: 'echoes', parameters: { type: 'object' } }],
      MODEL,
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect((body['tools'] as unknown[]).length).toBe(1);
    expect(
      ((body['tools'] as Record<string, unknown>[])[0]['function'] as Record<string, unknown>)[
        'name'
      ],
    ).toBe('echo');
    expect(body['tool_choice']).toBe('auto');
  });

  it('throws ProviderError on a non-ok HTTP response', async () => {
    fetchMock.mockResolvedValue(makeErrResponse(401, 'Unauthorized'));
    const provider = new OpenAICompatibleProvider();
    await expect(provider.complete([], [], MODEL)).rejects.toThrow(ProviderError);
    await expect(provider.complete([], [], MODEL)).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/providers/OpenAICompatibleProvider.test.ts`
Expected: FAIL — `Cannot find module './OpenAICompatibleProvider.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/providers/OpenAICompatibleProvider.ts`:

```typescript
import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion/types';
import type {
  Provider,
  ProviderMessage,
  ProviderResponse,
  ProviderStopReason,
  ProviderTool,
  ProviderToolCall,
} from './Provider.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';

// ── Internal OpenAI Chat Completions wire types ──────────────────────────────

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIChatResponse {
  choices: Array<{
    message: OAIMessage;
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ────────────────────────────────────────────────────────────────────────────

function toOAIMessage(msg: ProviderMessage): OAIMessage {
  const out: OAIMessage = { role: msg.role, content: msg.content };
  if (msg.toolCalls?.length) {
    out.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  if (msg.toolCallId) out.tool_call_id = msg.toolCallId;
  if (msg.name) out.name = msg.name;
  return out;
}

export class OpenAICompatibleProvider implements Provider {
  constructor(
    private defaultBaseUrl = DEFAULT_BASE_URL,
    private defaultApiKeyEnv = DEFAULT_API_KEY_ENV,
  ) {}

  async complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Promise<ProviderResponse> {
    // Base URL: per-model override → OPENAI_BASE_URL env var → constructor default.
    const baseUrl = (
      model.baseUrl ??
      process.env['OPENAI_BASE_URL'] ??
      this.defaultBaseUrl
    ).replace(/\/$/, '');

    // API key: read the env var named by model.apiKeyEnv (or the constructor default).
    const apiKeyEnv = model.apiKeyEnv ?? this.defaultApiKeyEnv;
    const apiKey = process.env[apiKeyEnv];

    const body: Record<string, unknown> = {
      model: model.model,
      messages: messages.map(toOAIMessage),
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

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `OpenAI-compatible API error ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as OAIChatResponse;
    const choice = data.choices[0];
    if (!choice) {
      throw new ProviderError('No choices returned from OpenAI-compatible API');
    }

    const msg = choice.message;
    const toolCalls: ProviderToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const stopReason: ProviderStopReason =
      choice.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'stop';

    return {
      content: msg.content,
      toolCalls,
      stopReason,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/providers/OpenAICompatibleProvider.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/OpenAICompatibleProvider.ts packages/core/src/providers/OpenAICompatibleProvider.test.ts
git commit -m "feat(core): add OpenAICompatibleProvider with native fetch"
```

---

## Task 3: AgentRuntime

**Files:**
- Create: `packages/core/src/runtime/AgentRuntime.ts`
- Test: `packages/core/src/runtime/AgentRuntime.test.ts`

> Spec §1 `agent` type: LLM agentic loop — call provider, execute tool calls, repeat
> until text response or iteration limit. Spec §12: emits `iteration`, `tool:call`,
> `tool:result` events. Spec §4: `RuntimeContext` is the execution context.
>
> **Tool filter (Plan 6):** Only tools with policy `'auto'` are sent to the LLM. Tools
> with `'requires_approval'` will be included once Plan 7 implements the approval flow.
> This is a documented deviation from the final target.
>
> `AgentRuntime.handle()` returns the final response string. `MessageRouter` (Plan 5)
> persists it as the assistant message. Intermediate tool-call turns are persisted to the
> conversation by `AgentRuntime` via `context.conversation.append()`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/runtime/AgentRuntime.test.ts`:

```typescript
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import { EventBus } from '../events/EventBus.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { AgentRuntime } from './AgentRuntime.js';
import type { Provider, ProviderResponse } from '../providers/Provider.js';
import type { RuntimeContext } from './Runtime.js';
import type { AgentConfig } from '@legion/types';

// ── Test helper ──────────────────────────────────────────────────────────────

async function makeSetup(providerResponses: ProviderResponse[]) {
  const storage = new MemoryStorage();
  const conversationStore = new FileConversationStore(storage);

  const agentConfig: AgentConfig = {
    id: 'agent-1',
    name: 'Test Agent',
    type: 'agent',
    systemPrompt: 'You are a helpful assistant.',
    model: { provider: 'test', model: 'test-model' },
    tools: { echo: 'auto' },
    status: 'active',
  };
  await storage.writeJson('collective/participants/agent-1.json', agentConfig);
  const collective = await Collective.load(storage);

  const conv = await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  const thread = new ConversationThread(conv, conversationStore);
  // Simulate what MessageRouter does: append the inbound message before calling handle().
  const inbound = await thread.append({
    senderId: 'user-1',
    recipientId: 'agent-1',
    role: 'user',
    content: 'Hello, agent!',
  });

  const eventBus = new EventBus();

  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: 'echo',
    description: 'Echoes the input text',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(args) {
      const { text } = args as { text: string };
      return { status: 'success', data: text };
    },
  });

  let responseIndex = 0;
  const mockProvider: Provider = {
    async complete() {
      const resp = providerResponses[responseIndex++];
      return resp ?? { content: '[no more responses]', toolCalls: [], stopReason: 'stop' };
    },
  };
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register('test', mockProvider);

  const context = {
    participant: collective.getOrThrow('agent-1'),
    conversationId: conv.id,
    conversation: thread,
    collective,
    config: { version: '2' },
    eventBus,
    storage,
    workspaceRoot: '/tmp/test',
    communicationDepth: 0,
    toolRegistry,
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
  } as unknown as RuntimeContext;

  return { context, thread, eventBus, inbound, providerRegistry };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRuntime', () => {
  it('returns the provider text response when no tools are called', async () => {
    const { context, inbound, providerRegistry } = await makeSetup([
      { content: 'I am happy to help!', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', providerRegistry);
    const result = await runtime.handle(inbound, context);
    expect(result).toBe('I am happy to help!');
    // No extra messages persisted — only the inbound message
    expect(context.conversation.activeChain).toHaveLength(1);
  });

  it('executes a tool call turn, persists it, and returns the follow-up text', async () => {
    const { context, inbound, providerRegistry } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello world' } }],
        stopReason: 'tool_calls',
      },
      { content: 'Done echoing!', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', providerRegistry);
    const result = await runtime.handle(inbound, context);

    expect(result).toBe('Done echoing!');

    // Tool-call turn persisted as a second message in the conversation
    const chain = context.conversation.activeChain;
    expect(chain).toHaveLength(2); // inbound + tool-call turn
    const toolTurn = chain[1];
    expect(toolTurn.toolCalls).toHaveLength(1);
    expect(toolTurn.toolCalls![0].name).toBe('echo');
    expect(toolTurn.toolResults).toHaveLength(1);
    expect(toolTurn.toolResults![0].result.status).toBe('success');
    expect(toolTurn.toolResults![0].result.data).toBe('hello world');
  });

  it('emits iteration, tool:call, and tool:result events in the correct order', async () => {
    const { context, inbound, providerRegistry, eventBus } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'x' } }],
        stopReason: 'tool_calls',
      },
      { content: 'Finished.', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', providerRegistry);
    const events: string[] = [];
    eventBus.on('iteration', () => events.push('iteration'));
    eventBus.on('tool:call', () => events.push('tool:call'));
    eventBus.on('tool:result', () => events.push('tool:result'));

    await runtime.handle(inbound, context);

    // iteration 0 fires before provider call; tool:call + tool:result for the one tool;
    // iteration 1 fires before the second provider call which returns text.
    expect(events).toEqual(['iteration', 'tool:call', 'tool:result', 'iteration']);
  });

  it('stops at maxIterations and returns a limit message', async () => {
    const storage = new MemoryStorage();
    const conversationStore = new FileConversationStore(storage);
    // Agent with maxIterations: 2
    await storage.writeJson('collective/participants/agent-1.json', {
      id: 'agent-1',
      name: 'Limited',
      type: 'agent',
      systemPrompt: 'You are helpful.',
      model: { provider: 'test', model: 'm' },
      tools: { echo: 'auto' },
      runtimeConfig: { maxIterations: 2, communicationDepthLimit: 10 },
      status: 'active',
    } as AgentConfig);
    const collective = await Collective.load(storage);
    const conv = await conversationStore.create({
      schemaVersion: '2.0', activeBranchHead: '', messages: {},
    });
    const thread = new ConversationThread(conv, conversationStore);
    const inbound = await thread.append({
      senderId: 'u', recipientId: 'agent-1', role: 'user', content: 'hi',
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'echo', description: 'echo', parameters: { type: 'object' },
      async execute(args) { return { status: 'success', data: (args as { text: string }).text }; },
    });
    let tcId = 0;
    const loopingProvider: Provider = {
      async complete() {
        return {
          content: null,
          toolCalls: [{ id: `tc-${tcId++}`, name: 'echo', arguments: { text: 'hi' } }],
          stopReason: 'tool_calls',
        };
      },
    };
    const reg = new ProviderRegistry();
    reg.register('test', loopingProvider);
    const context = {
      participant: collective.getOrThrow('agent-1'),
      conversationId: conv.id,
      conversation: thread,
      collective,
      config: { version: '2' },
      eventBus: new EventBus(),
      storage,
      workspaceRoot: '/tmp',
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as RuntimeContext;

    const runtime = new AgentRuntime('agent-1', reg);
    const result = await runtime.handle(inbound, context);
    expect(result).toMatch(/maximum iteration limit/i);
    expect(result).toContain('2');
  });

  it('returns an error message when no provider is registered for the agent model', async () => {
    const emptyReg = new ProviderRegistry();
    const { context, inbound } = await makeSetup([]);
    const runtime = new AgentRuntime('agent-1', emptyReg);
    const result = await runtime.handle(inbound, context);
    expect(result).toMatch(/no provider/i);
    expect(result).toMatch(/test/); // provider name from model config
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`
Expected: FAIL — `Cannot find module './AgentRuntime.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/runtime/AgentRuntime.ts`:

```typescript
import type { AgentConfig, MessageData, ToolCallData, ToolCallResult } from '@legion/types';
import type { Runtime, RuntimeContext } from './Runtime.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { ProviderMessage, ProviderTool } from '../providers/Provider.js';

const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Build the provider message list from the conversation chain + system prompt.
 * Tool-call turns (messages with toolCalls) are expanded into an assistant message
 * followed by one tool-result message per call, matching the OpenAI message format.
 */
function buildProviderMessages(chain: MessageData[], systemPrompt: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of chain) {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      // Expand the tool-call turn into assistant message + tool result messages.
      messages.push({
        role: 'assistant',
        content: msg.content || null,
        toolCalls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      });
      for (const tr of msg.toolResults ?? []) {
        messages.push({
          role: 'tool',
          content: JSON.stringify(tr.result),
          toolCallId: tr.id,
          name: tr.name,
        });
      }
    } else {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  return messages;
}

export class AgentRuntime implements Runtime {
  constructor(
    private participantId: string,
    private providerRegistry: ProviderRegistry,
  ) {}

  async handle(incoming: MessageData, context: RuntimeContext): Promise<string | void> {
    const participant = context.collective.getOrThrow(this.participantId);
    if (participant.type !== 'agent') return;
    const agent = participant as AgentConfig;

    const provider = this.providerRegistry.get(agent.model.provider);
    if (!provider) {
      return `[AgentRuntime error: no provider registered for '${agent.model.provider}']`;
    }

    const maxIterations = agent.runtimeConfig?.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    // Build initial message list from the full conversation chain (includes the inbound
    // message that MessageRouter appended before calling handle()).
    const messages: ProviderMessage[] = buildProviderMessages(
      context.conversation.activeChain,
      agent.systemPrompt,
    );

    // Build the tool list: only 'auto'-policy tools are presented to the LLM in this
    // plan. 'requires_approval' tools will be added in Plan 7 (approval bubbling).
    const providerTools: ProviderTool[] = context.toolRegistry
      .list()
      .filter((tool) => agent.tools[tool.name] === 'auto')
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

    for (let i = 0; i < maxIterations; i++) {
      context.eventBus.emit('iteration', {
        conversationId: context.conversationId,
        participantId: this.participantId,
        iteration: i,
      });

      const response = await provider.complete(messages, providerTools, agent.model);

      // Text response (or no tool calls): return it; MessageRouter persists it.
      if (response.stopReason !== 'tool_calls' || response.toolCalls.length === 0) {
        return response.content ?? '';
      }

      // Execute tool calls and collect results.
      const toolCallData: ToolCallData[] = response.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }));

      const toolResults: ToolCallResult[] = [];
      for (const tc of response.toolCalls) {
        context.eventBus.emit('tool:call', {
          conversationId: context.conversationId,
          participantId: this.participantId,
          tool: tc.name,
          callId: tc.id,
        });
        const result = await context.toolRegistry.execute(tc.name, tc.arguments, context);
        context.eventBus.emit('tool:result', {
          conversationId: context.conversationId,
          participantId: this.participantId,
          tool: tc.name,
          callId: tc.id,
          status: result.status,
        });
        toolResults.push({ id: tc.id, name: tc.name, result });
      }

      // Persist the tool-call turn to the conversation for audit + context replay.
      await context.conversation.append({
        senderId: this.participantId,
        recipientId: this.participantId,
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: toolCallData,
        toolResults,
      });

      // Advance the local message history so the next iteration has full context.
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

    return `[Agent reached maximum iteration limit of ${maxIterations}]`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/AgentRuntime.ts packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "feat(core): add AgentRuntime LLM agentic loop"
```

---

## Task 4: Env-gated live integration test

**Files:**
- Create: `packages/core/src/runtime/agent-runtime.integration.test.ts`

> This test gates the first runnable milestone. It exercises the complete path:
> operator → MessageRouter → AgentRuntime → real OpenAI-compatible API → response.
>
> **To run:**
> ```
> LEGION_OPENAI_INTEGRATION=1 OPENAI_API_KEY=<key> npx vitest run \
>   packages/core/src/runtime/agent-runtime.integration.test.ts
> ```
> Optionally override the endpoint and model:
> ```
> OPENAI_BASE_URL=http://localhost:11434/v1 \
> OPENAI_MODEL=llama3.2 \
> LEGION_OPENAI_INTEGRATION=1 \
> npx vitest run packages/core/src/runtime/agent-runtime.integration.test.ts
> ```

- [ ] **Step 1: Write the integration test**

`packages/core/src/runtime/agent-runtime.integration.test.ts`:

```typescript
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { EventBus } from '../events/EventBus.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { OpenAICompatibleProvider } from '../providers/OpenAICompatibleProvider.js';
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { AgentRuntime } from './AgentRuntime.js';
import { UserDeliveryRuntime } from './UserDeliveryRuntime.js';
import { MessageRouter } from './MessageRouter.js';
import type { ToolContext } from '../tools/Tool.js';

const LIVE = !!process.env['LEGION_OPENAI_INTEGRATION'];

describe.skipIf(!LIVE)('AgentRuntime: live end-to-end via MessageRouter', () => {
  it(
    'connects to the OpenAI-compatible endpoint and returns a text response',
    async () => {
      const model = process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
      const storage = new MemoryStorage();

      // Participants: a user (operator) and an agent.
      await storage.writeJson('collective/participants/operator.json', {
        id: 'operator',
        name: 'Operator',
        type: 'user',
        tools: {},
        status: 'active',
      });
      await storage.writeJson('collective/participants/assistant.json', {
        id: 'assistant',
        name: 'Assistant',
        type: 'agent',
        systemPrompt:
          'You are a helpful assistant. Always respond in exactly one short sentence.',
        model: { provider: 'openai-compatible', model },
        tools: {},
        status: 'active',
      });

      const collective = await Collective.load(storage);
      const conversationStore = new FileConversationStore(storage);
      const eventBus = new EventBus();
      const toolRegistry = new ToolRegistry();

      const providerRegistry = new ProviderRegistry();
      providerRegistry.register('openai-compatible', new OpenAICompatibleProvider());

      const runtimeRegistry = new RuntimeRegistry();
      runtimeRegistry.registerFactory('user', (id) => new UserDeliveryRuntime(id));
      runtimeRegistry.registerFactory('agent', (id) => new AgentRuntime(id, providerRegistry));

      const router = new MessageRouter(conversationStore, runtimeRegistry, collective, eventBus);

      const baseContext = {
        collective,
        config: { version: '2' },
        eventBus,
        storage,
        workspaceRoot: '/tmp/legion-live-test',
        communicationDepth: 0,
        toolRegistry,
        authEngine: new AuthEngine(),
        pendingApprovalRegistry: new PendingApprovalRegistry(),
      } as unknown as ToolContext;

      const result = await router.send({
        senderId: 'operator',
        recipientId: 'assistant',
        message: 'What is the capital of France?',
        context: baseContext,
      });

      expect(result.status).toBe('success');
      expect(typeof result.response).toBe('string');
      expect(result.response!.length).toBeGreaterThan(0);
      // Should contain "Paris" somewhere in the response.
      expect(result.response!.toLowerCase()).toContain('paris');
    },
    30_000, // 30-second timeout for live API call
  );

  it(
    'executes a tool call when the agent is configured with an echo tool',
    async () => {
      const model = process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
      const storage = new MemoryStorage();

      await storage.writeJson('collective/participants/operator.json', {
        id: 'operator', name: 'Op', type: 'user', tools: {}, status: 'active',
      });
      await storage.writeJson('collective/participants/agent.json', {
        id: 'agent',
        name: 'Echo Agent',
        type: 'agent',
        systemPrompt:
          'You are a test agent. When asked to echo something, call the echo tool with ' +
          'that text, then report the result.',
        model: { provider: 'openai-compatible', model },
        tools: { echo: 'auto' },
        status: 'active',
      });

      const collective = await Collective.load(storage);
      const conversationStore = new FileConversationStore(storage);
      const eventBus = new EventBus();

      const toolRegistry = new ToolRegistry();
      toolRegistry.register({
        name: 'echo',
        description: 'Echoes the provided text back',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Text to echo' } },
          required: ['text'],
        },
        async execute(args) {
          const { text } = args as { text: string };
          return { status: 'success', data: text };
        },
      });

      const providerRegistry = new ProviderRegistry();
      providerRegistry.register('openai-compatible', new OpenAICompatibleProvider());

      const runtimeRegistry = new RuntimeRegistry();
      runtimeRegistry.registerFactory('user', (id) => new UserDeliveryRuntime(id));
      runtimeRegistry.registerFactory('agent', (id) => new AgentRuntime(id, providerRegistry));

      const router = new MessageRouter(conversationStore, runtimeRegistry, collective, eventBus);

      const baseContext = {
        collective,
        config: { version: '2' },
        eventBus,
        storage,
        workspaceRoot: '/tmp/legion-live-test',
        communicationDepth: 0,
        toolRegistry,
        authEngine: new AuthEngine(),
        pendingApprovalRegistry: new PendingApprovalRegistry(),
      } as unknown as ToolContext;

      const toolEvents: string[] = [];
      eventBus.on('tool:call', (p) => toolEvents.push(p.tool));

      const result = await router.send({
        senderId: 'operator',
        recipientId: 'agent',
        message: 'Please echo the text "hello legion".',
        context: baseContext,
      });

      expect(result.status).toBe('success');
      expect(result.response).toBeTruthy();
      // The agent should have called the echo tool at least once.
      expect(toolEvents).toContain('echo');
    },
    45_000, // longer timeout — two round trips to the LLM
  );
});
```

- [ ] **Step 2: Verify the test is skipped without the env flag**

Run: `npx vitest run packages/core/src/runtime/agent-runtime.integration.test.ts`
Expected: SKIP (2 tests skipped, 0 failed). The full suite still passes.

- [ ] **Step 3: (Optional) Run the live test if you have an API key**

```bash
LEGION_OPENAI_INTEGRATION=1 OPENAI_API_KEY=<your-key> \
  npx vitest run packages/core/src/runtime/agent-runtime.integration.test.ts
```
Expected: PASS (2 tests, 30-45s).

For a local Ollama server:
```bash
LEGION_OPENAI_INTEGRATION=1 OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=llama3.2 \
  npx vitest run packages/core/src/runtime/agent-runtime.integration.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runtime/agent-runtime.integration.test.ts
git commit -m "test(core): add env-gated AgentRuntime live integration test"
```

---

## Task 5: Barrel exports + full build + test gate

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Export provider + AgentRuntime from the core barrel**

Append to `packages/core/src/index.ts`:

```typescript
export * from './providers/Provider.js';
export * from './providers/ProviderRegistry.js';
export * from './providers/OpenAICompatibleProvider.js';
export * from './runtime/AgentRuntime.js';
```

- [ ] **Step 2: Typecheck the whole workspace**

Run: `npm run typecheck`
Expected: PASS — no type errors in any package.

- [ ] **Step 3: Run the full test suite (excluding the live integration test)**

Run: `npm test`
Expected: PASS — all Plans 1–6 unit + integration tests green.
The `agent-runtime.integration.test.ts` should be skipped (not failed) because
`LEGION_OPENAI_INTEGRATION` is not set.

- [ ] **Step 4: Format + commit**

```bash
npm run format
git add packages/core/src/index.ts
git add -A
git commit -m "feat(core): export Provider, ProviderRegistry, OpenAICompatibleProvider, AgentRuntime"
```

> If format produces no changes, the `git add -A` is a no-op (nothing unstaged).

- [ ] **Step 5: Update the roadmap**

In `docs/superpowers/plans/000-roadmap.md`, update the plan sequence table row for Plan 6
and the generation progress checklist:

```markdown
| 6 | Provider abstraction & AgentRuntime | 1, 4 | Plan written | `006-provider-agent-runtime.md` |
```

```markdown
- [x] Plan 6 written
```

```bash
git add docs/superpowers/plans/000-roadmap.md
git commit -m "docs: mark Plan 6 written in roadmap"
```

---

## Self-Review Checklist

- **Spec §1 `agent` type — LLM agentic loop (calls tools, receives results, repeats):** Task 3 (`AgentRuntime`). ✅
- **Spec §1 `AgentConfig.systemPrompt` + `model: ModelConfig` + `runtimeConfig.maxIterations`:** Used in `AgentRuntime.handle()`. ✅
- **Spec §4 `RuntimeContext` — `conversation`, `toolRegistry`, `collective`, `eventBus` accessed:** All accessed in `AgentRuntime`. ✅
- **Spec §11 provider config hierarchy (model override → env var → default):** `OpenAICompatibleProvider.complete()` resolution order for `baseUrl` and `apiKeyEnv`. ✅
- **Spec §12 `iteration`, `tool:call`, `tool:result` events:** Emitted in `AgentRuntime.handle()`. ✅
- **First runnable deliverable (end of Plan 6) — mock loop + real AgentRuntime on OpenAI-compatible behind env-gated integration test:** Task 4. ✅
- **Tool filter deviation (Plan 6 only presents `'auto'` tools; `'requires_approval'` deferred to Plan 7):** Documented in Task 3 task header and inline comment. ✅
- **Native `fetch` — no SDK dependency in `@legion/core`:** `OpenAICompatibleProvider` uses `fetch` directly. ✅
- **`ProviderRegistry` constructor-injected into `AgentRuntime` (not in `RuntimeContext`):** Task 1/3. ✅ Plan 10 wires the factory registration via `LegionProcess.start()`.
- **`verbatimModuleSyntax` compliance:** All provider/runtime imports that carry only types use `import type`. ✅
- **Test gate for `agent-runtime.integration.test.ts`:** `describe.skipIf(!LIVE)` — the test is skipped (not failed) when the env flag is absent, so `npm test` stays green. ✅
- **Placeholder scan:** All steps contain full code and exact commands. ✅
- **Type consistency:**
  - `ProviderMessage.toolCalls` ↔ `ToolCallData` (`id`/`name`/`arguments` match); conversion is explicit in `AgentRuntime`. ✅
  - `ProviderToolCall` ↔ `ToolCallData`: both have `{ id, name, arguments: Record<string, unknown> }`. ✅
  - `ToolCallResult` (`@legion/types`): `{ id, name, result: ToolResult }` — correctly populated in the loop. ✅
  - `RuntimeContext` is from Plan 5 (`packages/core/src/runtime/Runtime.ts`); `AgentRuntime.handle()` signature matches `Runtime.handle(incoming: MessageData, context: RuntimeContext): Promise<string | void>`. ✅
  - `ConversationThread.activeChain` (Plan 2) returns `MessageData[]` via `getActiveChain(this.data)`. ✅
  - `ConversationThread.append()` accepts `NewMessageInput` which includes optional `toolCalls?: ToolCallData[]` and `toolResults?: ToolCallResult[]` (Plan 2, Task 1). ✅
