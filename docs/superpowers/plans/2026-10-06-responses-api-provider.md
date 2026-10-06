# Responses API Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI Responses API support as a new wire-format provider (`'openai-responses'`), mapped statelessly onto Legion's existing `ProviderStreamChunk` union with a quirk-tolerant SSE parser.

**Architecture:** New `OpenAIResponsesProvider` subclasses `OpenAICompatibleProvider` (reusing `authHeaders`, `normalizeParameters`, `listModels`, `KNOWN_MODEL_METADATA`) and overrides `stream()` only: requests go to `POST {baseUrl}/responses` with `input` items instead of `messages`, `store: false`, flat `tools`; SSE `response.*` events map 1:1 onto the existing chunk union, so AgentRuntime/ModelRouter/web need zero consumer changes. A `SystemProviderStore` case, a web dropdown entry, an e2e mock `/v1/responses` handler, unit fixtures, and an opt-in integration gate complete the surface.

**Tech Stack:** TypeScript (strict, NodeNext, ESM), npm workspaces, Vitest (globals enabled, fetch-mocked SSE bodies), Vue 3 SFC + happy-dom tests, Playwright e2e, plain `node:http` mock provider.

**Spec:** `docs/superpowers/specs/2026-10-06-responses-api-provider-design.md` (PR #9, issue #8). The plan argues from the spec; executors read both. Verified against repo HEAD `1d8f5b0` — no drift between spec's "Current state" and the code.

## Resolved decisions (Chris, 2026-10-06 — spec open questions answered)

1. **Encrypted reasoning replay:** defer to a follow-up (spec recommendation confirmed). v1 drops reasoning items from history; no `ProviderMessage` extension.
2. **Type name:** `'openai-responses'` (spec recommendation confirmed).
3. **Integration gate:** separate `LEGION_OPENAI_RESPONSES_INTEGRATION=1` (spec recommendation confirmed). Do not touch the existing `LEGION_OPENAI_INTEGRATION` gate.

## Global Constraints

- Node >= 20, npm workspaces, pure ESM, `NodeNext` resolution. Every relative import in `.ts` source ends in `.js` — including imports of sibling `.ts` files.
- `verbatimModuleSyntax`: use `import type { ... }` for type-only imports. `noUnusedLocals`/`noUnusedParameters` are on — no dead vars.
- Prettier: single quotes, semicolons, trailing commas, 100 cols, 2-space. Run `npm run format` if check fails.
- Gate order (required before claiming any task done): `npm run format:check` → `npm run typecheck` → `npm test` (+ `npm run test --workspace=packages/web` whenever `packages/web` is touched).
- New provider type string is exactly `'openai-responses'`.
- v1 request always sends `stream: true` and `store: false`; never sends `previous_response_id`, `conversation`, `reasoning`, `include`, or `prompt`.
- Error strings: non-OK HTTP → `OpenAI-compatible API error <status>: <body[0:200]>` (identical to the chat path); EOF before a terminal event → `Responses stream ended without a terminal event`.
- Only delta events drive emitted chunks; `response.output` items inside terminal events are never re-emitted.
- Tool calls are keyed by `item_id` when present, falling back to `output_index` (ollama #18798 shares `output_index` across items).
- Commits use conventional style (`feat:`, `test:`, `docs:`, `chore:`) and go out as the pre-configured identity (Mirak). Never change git config. Never print or commit the web token.
- `packages/e2e` is NOT part of `tsconfig.json` project references — typecheck does not cover it; the mock provider is plain `node:http` JavaScript-typed TS run by tsx.
- Vitest globals are enabled, but existing test files import `describe/it/expect/vi` from `'vitest'` explicitly — match that style.
- Do not parameterize the existing e2e `packages/e2e/tests/config/providers.spec.ts` — it is stale (references a removed "Default model" field from the pre-overhaul form). The new e2e coverage is a separate spec file.

## File Structure

| File                                                                      | Change            | Responsibility                                                                       |
| ------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `packages/types/src/config.ts`                                            | Modify (1 line)   | Extend `ProviderConfig.type` union                                                   |
| `packages/core/src/providers/OpenAICompatibleProvider.ts`                 | Modify (~4 lines) | `private baseUrl/apiKey` → `protected`; export `authHeaders` + `normalizeParameters` |
| `packages/core/src/providers/OpenAIResponsesProvider.ts`                  | Create            | Responses wire format: request mapping + SSE parsing                                 |
| `packages/core/src/providers/OpenAIResponsesProvider.test.ts`             | Create            | Unit grammar coverage (fetch-mocked SSE fixtures)                                    |
| `packages/core/src/providers/OpenAIResponsesProvider.integration.test.ts` | Create            | Opt-in live-backend gate                                                             |
| `packages/core/src/providers/SystemProviderStore.ts`                      | Modify (1 case)   | Construct the new provider from config                                               |
| `packages/core/src/providers/SystemProviderStore.test.ts`                 | Modify            | New construction test                                                                |
| `packages/core/src/index.ts`                                              | Modify (1 line)   | Barrel export                                                                        |
| `packages/web/src/components/config/ProviderSlideOver.vue`                | Modify (2 lines)  | Type `<option>` + baseUrl field condition                                            |
| `packages/web/src/views/ConfigView.vue`                                   | Modify (1 line)   | Badge color map entry                                                                |
| `packages/web/src/components/config/ProviderSlideOver.test.ts`            | Create            | Web form unit test                                                                   |
| `packages/e2e/mock-provider/server.ts`                                    | Modify            | `POST /v1/responses` handler                                                         |
| `packages/e2e/tests/providers/responses-provider.spec.ts`                 | Create            | One agent turn over the Responses wire                                               |
| `docs/testing.md`                                                         | Modify (1 row)    | Document the integration gate                                                        |

---

## Task skeleton (9 tasks)

1. Config surface: type union + web provider form + badge
2. Provider skeleton: request mapping + text-only stream + completed usage
3. Reasoning + refusal deltas
4. Tool calls: flat tools, function_call items, keyed accumulation
5. Terminal + error hardening: incomplete/failed/HTTP/EOF/quirk tolerance
6. SystemProviderStore case + barrel export
7. E2E mock `/v1/responses` handler + provider e2e spec
8. Integration gate test + docs/testing.md row
9. Full gates + PR polish

### Task 1: Config surface — `'openai-responses'` type, web form entry, badge

**Files:**

- Modify: `packages/types/src/config.ts:50`
- Modify: `packages/web/src/components/config/ProviderSlideOver.vue` (type `<select>` + baseUrl `v-if`)
- Modify: `packages/web/src/views/ConfigView.vue:41-46` (`typeBadge` map)
- Test: `packages/web/src/components/config/ProviderSlideOver.test.ts` (new)

**Interfaces:**

- Consumes: nothing new.
- Produces: `ProviderConfig['type']` accepts `'openai-responses'`. All later tasks rely on this union member existing (Task 6's switch case, Task 7's e2e provider config, Task 8's integration config).

- [ ] **Step 1: Write the failing web test**

Create `packages/web/src/components/config/ProviderSlideOver.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderSlideOver from './ProviderSlideOver.vue';

const execute = vi.fn();
vi.mock('../../composables/useExecute.js', () => ({ useExecute: () => ({ execute }) }));

async function openForm() {
  const wrapper = mount(ProviderSlideOver, {
    global: { stubs: { teleport: true } },
    props: { open: false, provider: null },
  });
  await wrapper.setProps({ open: true });
  return wrapper;
}

describe('ProviderSlideOver provider types', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers openai-responses in the type dropdown', async () => {
    const wrapper = await openForm();
    const options = wrapper.findAll('select option').map((o) => o.text());
    expect(options).toContain('openai-responses');
  });

  it('shows the base URL field for openai-responses', async () => {
    const wrapper = await openForm();
    const select = wrapper.get('select');
    await select.setValue('openai-responses');
    expect(wrapper.text()).toContain('Base URL');
  });

  it('hides the base URL field for anthropic (existing behavior)', async () => {
    const wrapper = await openForm();
    const select = wrapper.get('select');
    await select.setValue('anthropic');
    expect(wrapper.text()).not.toContain('Base URL');
  });
});
```

- [ ] **Step 2: Run the web test to verify it fails**

Run: `npm run test --workspace=packages/web -- ProviderSlideOver`
Expected: FAIL — `openai-responses` option missing, Base URL never shown for it. (The third test passes already.)

- [ ] **Step 3: Extend the type union**

`packages/types/src/config.ts` line 50:

```typescript
type: 'openai-compatible' | 'openai-responses' | 'anthropic' | 'copilot' | 'codex';
```

- [ ] **Step 4: Add the dropdown option and baseUrl condition**

`packages/web/src/components/config/ProviderSlideOver.vue` — in the `<select>` (after the `openai-compatible` option, keeping alphabetical-ish group order: OpenAI family first):

```html
<option>openai-compatible</option>
<option>openai-responses</option>
<option>anthropic</option>
<option>copilot</option>
<option>codex</option>
```

And change the Base URL field condition (currently `v-if="type === 'openai-compatible'"`) to:

```html
<div v-if="type === 'openai-compatible' || type === 'openai-responses'"></div>
```

- [ ] **Step 5: Add the badge color map entry**

`packages/web/src/views/ConfigView.vue` — add to `typeBadge` (line 41-46), keeping the map aligned with the union order:

```typescript
const typeBadge: Record<string, string> = {
  'openai-compatible': 'bg-green-400/10 text-green-400 border-green-400/20',
  'openai-responses': 'bg-green-400/10 text-green-400 border-green-400/20',
  anthropic: 'bg-amber-400/10 text-amber-400 border-amber-400/20',
  copilot: 'bg-cyan-400/10 text-cyan-400 border-cyan-400/20',
  codex: 'bg-violet-400/10 text-violet-400 border-violet-400/20',
};
```

- [ ] **Step 6: Run the web tests to verify they pass**

Run: `npm run test --workspace=packages/web -- ProviderSlideOver`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/config.ts packages/web/src/components/config/ProviderSlideOver.vue packages/web/src/views/ConfigView.vue packages/web/src/components/config/ProviderSlideOver.test.ts
git commit -m "feat(types,web): add 'openai-responses' provider type to config surface and UI"
```

---

### Task 2: Provider skeleton — base class prep, request mapping, text-only stream, usage

**Files:**

- Modify: `packages/core/src/providers/OpenAICompatibleProvider.ts` (`private` → `protected`, export helpers)
- Create: `packages/core/src/providers/OpenAIResponsesProvider.ts`
- Test: `packages/core/src/providers/OpenAIResponsesProvider.test.ts` (new)

**Interfaces:**

- Consumes: `ProviderMessage`/`ProviderTool`/`ProviderStreamChunk`/`ProviderStopReason` from `./Provider.js`, `ModelConfig` from `@legion-collective/types`, `ProviderError` from `../errors/LegionError.js`.
- Produces: `class OpenAIResponsesProvider extends OpenAICompatibleProvider` with constructor `(baseUrl?: string, apiKey?: string)`, inherited `listModels()`. Tasks 3-5 extend `handleEvent()` and `stream()` in this file — their exact replacement code is given there.

- [ ] **Step 1: Prepare the base class (no behavior change)**

In `packages/core/src/providers/OpenAICompatibleProvider.ts`:

1. Change the constructor field visibility (lines 139-144):

```typescript
export class OpenAICompatibleProvider implements Provider {
  constructor(
    protected baseUrl = DEFAULT_BASE_URL,
    protected apiKey?: string,
  ) {
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }
```

2. Export the two helpers the subclass reuses — change `function normalizeParameters(` to `export function normalizeParameters(` and `function authHeaders(` to `export function authHeaders(`.

Run `npm run typecheck` after this step: expected PASS (no consumers break; both helpers are still used internally).

- [ ] **Step 2: Write the failing tests for the request shape and text-only stream**

Create `packages/core/src/providers/OpenAIResponsesProvider.test.ts`. The helper block below is complete for the whole plan — write all of it now; Tasks 3-5 only add new `it(...)` cases:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIResponsesProvider } from './OpenAIResponsesProvider.js';
import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion-collective/types';
import type { ProviderMessage, ProviderStreamChunk, ProviderTool } from './Provider.js';

const MODEL: ModelConfig = { model: 'mock-model' };

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

type SseEvent = Record<string, unknown>;

function sse(
  events: SseEvent[],
  opts: { withDoneSentinel?: boolean } = {},
): { ok: true; status: number; body: ReadableStream<Uint8Array> } {
  const lines = events.map((e) => `data: ${JSON.stringify(e)}`);
  if (opts.withDoneSentinel) lines.push('data: [DONE]');
  return { ok: true, status: 200, body: makeSseBody(lines) };
}

function errResponse(status: number, text: string) {
  return { ok: false, status, text: () => Promise.resolve(text) };
}

function ev(type: string, extra: Record<string, unknown> = {}): SseEvent {
  return { type, ...extra };
}

function textCompleted(text: string, usage?: Record<string, unknown>): SseEvent[] {
  const events: SseEvent[] = [
    ev('response.created', { response: { id: 'resp_1' } }),
    ev('response.output_item.added', {
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: 'msg_0' },
    }),
    ev('response.output_text.delta', { item_id: 'msg_0', output_index: 0, delta: text }),
    ev('response.output_text.done', { item_id: 'msg_0', output_index: 0, text }),
    ev('response.output_item.done', {
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: 'msg_0' },
    }),
  ];
  const response: Record<string, unknown> = { id: 'resp_1' };
  if (usage) response['usage'] = usage;
  events.push(ev('response.completed', { response }));
  return events;
}

function completedOnly(usage?: Record<string, unknown>): SseEvent {
  const response: Record<string, unknown> = { id: 'resp_1' };
  if (usage) response['usage'] = usage;
  return ev('response.completed', { response });
}

interface Collected {
  reasoning: string[];
  text: string[];
  toolStarts: Array<{ index: number; id: string; name: string }>;
  toolArgs: Array<{ index: number; delta: string }>;
  done: Extract<ProviderStreamChunk, { type: 'done' }> | null;
}

async function drain(
  provider: OpenAIResponsesProvider,
  messages: ProviderMessage[],
  tools: ProviderTool[] = [],
  model: ModelConfig = MODEL,
): Promise<Collected> {
  const out: Collected = { reasoning: [], text: [], toolStarts: [], toolArgs: [], done: null };
  for await (const chunk of provider.stream(messages, tools, model)) {
    if (chunk.type === 'reasoning_delta') out.reasoning.push(chunk.delta);
    else if (chunk.type === 'text_delta') out.text.push(chunk.delta);
    else if (chunk.type === 'tool_call_start')
      out.toolStarts.push({ index: chunk.index, id: chunk.id, name: chunk.name });
    else if (chunk.type === 'tool_call_args_delta')
      out.toolArgs.push({ index: chunk.index, delta: chunk.delta });
    else if (chunk.type === 'done') out.done = chunk;
  }
  return out;
}

describe('OpenAIResponsesProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to {baseUrl}/responses with instructions, input items, store:false, stream:true', async () => {
    fetchMock.mockResolvedValue(sse(textCompleted('Hello!'), { withDoneSentinel: true }));

    const provider = new OpenAIResponsesProvider('https://example.test/v1/', 'sk-key');
    const result = await drain(provider, [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/responses');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-key',
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('mock-model');
    expect(body['instructions']).toBe('Be terse.');
    expect(body['input']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(true);
    expect(body['tools']).toBeUndefined();
    expect(body['tool_choice']).toBeUndefined();
    expect(body['previous_response_id']).toBeUndefined();
    expect(body['reasoning']).toBeUndefined();

    expect(result.text).toEqual(['Hello!']);
    expect(result.done?.stopReason).toBe('stop');
    expect(result.done?.usage).toBeUndefined();
  });

  it('maps temperature and maxTokens to temperature and max_output_tokens', async () => {
    fetchMock.mockResolvedValue(sse([completedOnly()]));

    const provider = new OpenAIResponsesProvider('https://example.test/v1');
    await drain(provider, [{ role: 'user', content: 'hi' }], [], {
      model: 'mock-model',
      temperature: 0.3,
      maxTokens: 256,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['temperature']).toBe(0.3);
    expect(body['max_output_tokens']).toBe(256);
  });

  it('maps assistant text and tool history to typed input items', async () => {
    fetchMock.mockResolvedValue(sse([completedOnly()]));

    const provider = new OpenAIResponsesProvider('https://example.test/v1');
    await drain(provider, [
      { role: 'system', content: 'sys one' },
      { role: 'system', content: 'sys two' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'x' } }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'echo', content: '{"ok":true}' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['instructions']).toBe('sys one');
    expect(body['input']).toEqual([
      { role: 'system', content: 'sys two' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"text":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ]);
  });

  it('maps terminal usage fields to ProviderUsage', async () => {
    fetchMock.mockResolvedValue(
      sse([
        ev('response.output_item.added', {
          output_index: 0,
          item: { type: 'message', id: 'msg_0' },
        }),
        ev('response.output_text.delta', { delta: 'hi' }),
        completedOnly({
          input_tokens: 100,
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 7 },
          input_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
        }),
      ]),
    );

    const provider = new OpenAIResponsesProvider('https://example.test/v1');
    const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

    expect(result.done?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 7,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 3,
    });
  });

  it('throws ProviderError on non-OK HTTP', async () => {
    fetchMock.mockResolvedValue(errResponse(404, '{"error":{"message":"no route"}}'));

    const provider = new OpenAIResponsesProvider('https://example.test/v1');
    await expect(drain(provider, [{ role: 'user', content: 'hi' }])).rejects.toThrow(ProviderError);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts`
Expected: FAIL — cannot import `./OpenAIResponsesProvider.js` (module not found).

- [ ] **Step 4: Implement the provider**

Create `packages/core/src/providers/OpenAIResponsesProvider.ts` (this is the Task-2 skeleton; Tasks 3-5 extend it in place):

```typescript
import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion-collective/types';
import {
  authHeaders,
  normalizeParameters,
  OpenAICompatibleProvider,
} from './OpenAICompatibleProvider.js';
import type {
  ProviderMessage,
  ProviderStopReason,
  ProviderStreamChunk,
  ProviderTool,
} from './Provider.js';

/** Input item shapes we emit; backends tolerate extra fields, so parsing stays loose. */
type ResponsesInputItem =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: ProviderTool['parameters'];
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

interface ResponsesObject {
  usage?: ResponsesUsage;
}

interface ResponsesEvent {
  type?: unknown;
  response?: ResponsesObject;
  delta?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function mapUsage(usage: ResponsesUsage | undefined) {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    cacheReadInputTokens: usage.input_tokens_details?.cached_tokens,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens,
  };
}

/**
 * OpenAI Responses API wire format, mapped statelessly onto the shared
 * ProviderStreamChunk union. See docs/superpowers/specs/2026-10-06-responses-api-provider-design.md
 * (§Q2) for the full mapping and quirk-tolerance rules: only delta events emit
 * chunks; `response.output` replays inside terminal events never do; unknown
 * event types are ignored; missing sequence_number is tolerated.
 */
export class OpenAIResponsesProvider extends OpenAICompatibleProvider {
  async *stream(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ProviderStreamChunk> {
    const body = this.buildRequestBody(messages, tools, model);

    const res = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(this.apiKey),
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`OpenAI-compatible API error ${res.status}: ${text.slice(0, 200)}`);
    }

    if (!res.body) {
      throw new ProviderError('OpenAI-compatible API returned no response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawTerminal = false;
    let stopReason: ProviderStopReason = 'stop';
    let usage = undefined as ReturnType<typeof mapUsage>;
    let completed = false;

    try {
      while (!sawTerminal) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === ':') continue;
          if (!trimmed.startsWith('data:')) continue;

          const raw = trimmed.slice(5).trim();
          if (raw === '[DONE]') continue; // no sentinel in Responses; tolerate a trailing one

          let event: ResponsesEvent;
          try {
            event = JSON.parse(raw) as ResponsesEvent;
          } catch {
            continue; // quirk tolerance: skip non-JSON data lines
          }

          for (const chunk of this.handleEvent(event)) {
            if (chunk.type === 'done') {
              // Exactly one done is yielded, after the loop — never inside it.
              sawTerminal = true;
              stopReason = chunk.stopReason;
              if (chunk.usage) usage = chunk.usage;
            } else {
              yield chunk;
            }
          }
          if (sawTerminal) break;
        }
      }
      completed = true;
    } finally {
      if (!completed || options?.signal?.aborted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    if (!sawTerminal) {
      throw new ProviderError('Responses stream ended without a terminal event');
    }

    yield { type: 'done', stopReason, usage, cost: undefined };
  }

  private buildRequestBody(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Record<string, unknown> {
    const { instructions, input } = this.mapInput(messages);
    const body: Record<string, unknown> = {
      model: model.model,
      input,
      stream: true,
      store: false,
    };
    if (instructions !== undefined) body['instructions'] = instructions;
    if (model.temperature !== undefined) body['temperature'] = model.temperature;
    if (model.maxTokens !== undefined) body['max_output_tokens'] = model.maxTokens;
    if (tools.length > 0) {
      const mapped: ResponsesFunctionTool[] = tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: normalizeParameters(t.parameters),
      }));
      body['tools'] = mapped;
      body['tool_choice'] = 'auto';
    }
    return body;
  }

  private mapInput(messages: ProviderMessage[]): {
    instructions?: string;
    input: ResponsesInputItem[];
  } {
    const input: ResponsesInputItem[] = [];
    let instructions: string | undefined;
    for (const msg of messages) {
      if (msg.role === 'system') {
        if (instructions === undefined && msg.content !== null) {
          instructions = msg.content;
          continue;
        }
        input.push({ role: 'system', content: msg.content ?? '' });
        continue;
      }
      if (msg.role === 'user') {
        input.push({ role: 'user', content: msg.content ?? '' });
        continue;
      }
      if (msg.role === 'assistant') {
        if (msg.content !== null) {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: msg.content }] });
        }
        for (const tc of msg.toolCalls ?? []) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
        continue;
      }
      // role === 'tool'
      input.push({
        type: 'function_call_output',
        call_id: msg.toolCallId ?? '',
        output: msg.content ?? '',
      });
    }
    return { instructions, input };
  }

  private handleEvent(event: ResponsesEvent): ProviderStreamChunk[] {
    const type = asString(event.type);
    if (!type) return []; // quirk tolerance: event without a type is ignored

    if (type === 'response.output_text.delta') {
      const delta = asString(event.delta);
      if (delta) return [{ type: 'text_delta', delta }];
      return [];
    }

    if (type === 'response.completed') {
      const response = event.response ?? {};
      return [
        { type: 'done', stopReason: 'stop', usage: mapUsage(response.usage), cost: undefined },
      ];
    }

    // Everything else — response.created, *_done replays, unknown types — is ignored.
    // Reasoning deltas (Task 3), tool calls (Task 4), and the other terminal
    // events (Task 5) are added by extending this method.
    return [];
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers/OpenAICompatibleProvider.ts packages/core/src/providers/OpenAIResponsesProvider.ts packages/core/src/providers/OpenAIResponsesProvider.test.ts
git commit -m "feat(core): OpenAIResponsesProvider skeleton — request mapping and text-only stream"
```

---

### Task 3: Reasoning and refusal deltas

**Files:**

- Modify: `packages/core/src/providers/OpenAIResponsesProvider.ts` (`handleEvent`)
- Test: `packages/core/src/providers/OpenAIResponsesProvider.test.ts` (extend)

**Interfaces:**

- Consumes: Task 2's `OpenAIResponsesProvider`, `handleEvent(event)`, test helpers (`ev`, `sse`, `drain`).
- Produces: `reasoning_delta` chunks from `response.reasoning_text.delta` and `response.reasoning_summary_text.delta` (mutually exclusive per stream — first seen wins), and `text_delta` from `response.refusal.delta`.

- [ ] **Step 1: Write the failing tests**

Add inside the top-level `describe('OpenAIResponsesProvider', ...)`:

```typescript
it('emits reasoning_delta from response.reasoning_text.delta', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }),
      ev('response.reasoning_text.delta', { delta: 'thinking ' }),
      ev('response.reasoning_text.delta', { delta: 'hard' }),
      ev('response.output_text.delta', { delta: 'answer' }),
      ev('response.completed', { response: { id: 'resp_1' } }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.reasoning).toEqual(['thinking ', 'hard']);
  expect(result.text).toEqual(['answer']);
});

it('emits reasoning_delta from reasoning_summary_text.delta (vLLM/llama.cpp/ollama shape)', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }),
      ev('response.reasoning_summary_text.delta', { delta: 'summary thought' }),
      ev('response.output_text.delta', { delta: 'answer' }),
      ev('response.completed', { response: { id: 'resp_1' } }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.reasoning).toEqual(['summary thought']);
});

it('treats reasoning_text and reasoning_summary_text as mutually exclusive per stream', async () => {
  // First seen wins: a backend that sends both shapes must not double-emit.
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }),
      ev('response.reasoning_text.delta', { delta: 'full cot' }),
      ev('response.reasoning_summary_text.delta', { delta: 'summary' }),
      ev('response.completed', { response: { id: 'resp_1' } }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.reasoning).toEqual(['full cot']);
});

it('maps refusal deltas to text_delta', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }),
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'message', role: 'assistant', id: 'msg_0' },
      }),
      ev('response.refusal.delta', { delta: 'I cannot help with that.' }),
      ev('response.completed', { response: { id: 'resp_1' } }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.text).toEqual(['I cannot help with that.']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts`
Expected: FAIL — the two reasoning fixtures yield no `reasoning_delta` (unknown events ignored); refusal test fails (event ignored).

- [ ] **Step 3: Implement — per-stream state + extended `handleEvent`**

Two edits in `packages/core/src/providers/OpenAIResponsesProvider.ts`. State must be per-stream, not per-instance: `SystemProviderStore` hands the same provider instance to every turn, so instance fields would leak the first-seen-wins choice into later streams.

**3a.** In `stream()`, create state above the `try {` and pass it at the call site:

```typescript
const state: StreamState = { reasoningMode: undefined, emittedToolCall: false };
```

Change the call inside the line loop from `this.handleEvent(event)` to `this.handleEvent(event, state)`.

**3b.** Add this interface above the class (next to the other internal types):

```typescript
/** Per-stream parser state — a provider instance may serve many streams. */
interface StreamState {
  /** First reasoning shape seen on this stream; the other shape is then ignored. */
  reasoningMode: 'full' | 'summary' | undefined;
  /** Set once this stream has emitted any tool_call_start (drives stopReason in Task 4/5). */
  emittedToolCall: boolean;
}
```

Then replace the whole `private handleEvent(...)` method from Task 2 with:

```typescript
  private handleEvent(event: ResponsesEvent, state: StreamState): ProviderStreamChunk[] {
    const type = asString(event.type);
    if (!type) return []; // quirk tolerance: event without a type is ignored

    if (type === 'response.output_text.delta') {
      const delta = asString(event.delta);
      if (delta) return [{ type: 'text_delta', delta }];
      return [];
    }

    if (type === 'response.reasoning_text.delta') {
      if (state.reasoningMode === 'summary') return []; // first shape seen wins for this stream
      state.reasoningMode = 'full';
      const delta = asString(event.delta);
      if (delta) return [{ type: 'reasoning_delta', delta }];
      return [];
    }

    if (type === 'response.reasoning_summary_text.delta') {
      if (state.reasoningMode === 'full') return [];
      state.reasoningMode = 'summary';
      const delta = asString(event.delta);
      if (delta) return [{ type: 'reasoning_delta', delta }];
      return [];
    }

    if (type === 'response.refusal.delta') {
      const delta = asString(event.delta);
      if (delta) return [{ type: 'text_delta', delta }];
      return [];
    }

    if (type === 'response.completed') {
      const response = event.response ?? {};
      return [
        { type: 'done', stopReason: 'stop', usage: mapUsage(response.usage), cost: undefined },
      ];
    }

    // Everything else — response.created, *_done replays, unknown types — is ignored.
    // Tool calls (Task 4) and the other terminal events (Task 5) extend this method;
    // both use state.emittedToolCall, which stream() now threads through.
    return [];
  }
```

`stream()` already swallows the `done` chunk until after the loop; Task 4 makes the `response.completed` branch honor `state.emittedToolCall`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/OpenAIResponsesProvider.ts packages/core/src/providers/OpenAIResponsesProvider.test.ts
git commit -m "feat(core): map reasoning and refusal deltas in OpenAIResponsesProvider"
```

---

### Task 4: Tool calls — flat tool definitions, function_call items, keyed accumulation

**Files:**

- Modify: `packages/core/src/providers/OpenAIResponsesProvider.ts` (`ResponsesEvent`, `handleEvent`, plus an `indexFor` helper)
- Test: `packages/core/src/providers/OpenAIResponsesProvider.test.ts` (extend)

**Interfaces:**

- Consumes: Task 3's `StreamState` and `handleEvent(event, state)`.
- Produces: `tool_call_start` / `tool_call_args_delta` chunks; `stopReason: 'tool_calls'` on `response.completed` when any tool call was emitted; tool definitions sent flat (`{type:'function', name, description, parameters}`) with `tool_choice: 'auto'`.

- [ ] **Step 1: Write the failing tests**

Add inside the top-level `describe`:

```typescript
it('includes flat tools and tool_choice when tools are provided', async () => {
  fetchMock.mockResolvedValue(sse([completedOnly()]));

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  await drain(
    provider,
    [{ role: 'user', content: 'hi' }],
    [{ name: 'echo', description: 'echoes', parameters: { type: 'object' } }],
  );

  const body = JSON.parse(
    (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
  ) as Record<string, unknown>;
  expect(body['tools']).toEqual([
    {
      type: 'function',
      name: 'echo',
      description: 'echoes',
      parameters: { type: 'object', properties: {} },
    },
  ]);
  expect(body['tool_choice']).toBe('auto');
});

it('maps function_call events to tool_call_start and tool_call_args_delta', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }),
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'echo' },
      }),
      ev('response.function_call_arguments.delta', {
        item_id: 'fc_1',
        output_index: 0,
        delta: '{"text":',
      }),
      ev('response.function_call_arguments.delta', {
        item_id: 'fc_1',
        output_index: 0,
        delta: '"hello"}',
      }),
      ev('response.function_call_arguments.done', { item_id: 'fc_1', output_index: 0 }),
      ev('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_abc',
          name: 'echo',
          arguments: '{"text":"hello"}',
        },
      }),
      ev('response.completed', { response: { id: 'resp_1' } }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.toolStarts).toEqual([{ index: 0, id: 'call_abc', name: 'echo' }]);
  expect(result.toolArgs).toEqual([
    { index: 0, delta: '{"text":' },
    { index: 0, delta: '"hello"}' },
  ]);
  expect(result.done?.stopReason).toBe('tool_calls');
});

it('interleaves two tool calls with distinct output_index', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }),
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'function_call', id: 'fc_0', call_id: 'call_a', name: 'get_time' },
      }),
      ev('response.output_item.added', {
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_b', name: 'get_date' },
      }),
      ev('response.function_call_arguments.delta', {
        item_id: 'fc_1',
        output_index: 1,
        delta: '"2026"',
      }),
      ev('response.function_call_arguments.delta', {
        item_id: 'fc_0',
        output_index: 0,
        delta: '"12:00"',
      }),
      ev('response.completed', { response: { id: 'resp_1' } }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.toolStarts).toEqual([
    { index: 0, id: 'call_a', name: 'get_time' },
    { index: 1, id: 'call_b', name: 'get_date' },
  ]);
  expect(result.toolArgs).toEqual([
    { index: 1, delta: '"2026"' },
    { index: 0, delta: '"12:00"' },
  ]);
});

it('keys calls by item_id when ollama-style backends share output_index across items', async () => {
  // ollama #18798: a function_call after a message item reuses output_index 0.
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }),
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'message', id: 'msg_0' },
      }),
      ev('response.output_text.delta', {
        item_id: 'msg_0',
        output_index: 0,
        delta: 'let me check',
      }),
      ev('response.output_item.added', {
        output_index: 0, // shared with the message item above
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'lookup' },
      }),
      ev('response.function_call_arguments.delta', {
        item_id: 'fc_1',
        output_index: 0, // shared
        delta: '{"q":"x"}',
      }),
      ev('response.completed', { response: { id: 'resp_1' } }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.toolStarts).toEqual([{ index: 0, id: 'call_x', name: 'lookup' }]);
  expect(result.toolArgs).toEqual([{ index: 0, delta: '{"q":"x"}' }]);
  expect(result.text).toEqual(['let me check']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts`
Expected: FAIL — tool fixtures emit no chunks (events ignored), stopReason stays `'stop'`, flat-tools request assertion fails.

- [ ] **Step 3: Implement**

Three edits in `packages/core/src/providers/OpenAIResponsesProvider.ts`:

**3a.** Extend `ResponsesEvent` (replace the interface from Task 2):

```typescript
interface ResponsesEvent {
  type?: unknown;
  response?: ResponsesObject;
  delta?: unknown;
  item?: { type?: unknown; call_id?: unknown; name?: unknown; id?: unknown };
  output_index?: unknown;
  item_id?: unknown;
}
```

**3b.** Add keying state and a resolver. Add to `StreamState` (replace the interface from Task 3):

```typescript
/** Per-stream parser state — a provider instance may serve many streams. */
interface StreamState {
  reasoningMode: 'full' | 'summary' | undefined;
  emittedToolCall: boolean;
  /** Resolved chunk index per tool-call key (item_id when present, else output_index). */
  toolKeyToIndex: Map<string, number>;
  /** Fallback counter for args deltas whose key was never started. */
  nextSyntheticIndex: number;
}
```

Update the `const state: StreamState = ...` line in `stream()` to:

```typescript
const state: StreamState = {
  reasoningMode: undefined,
  emittedToolCall: false,
  toolKeyToIndex: new Map(),
  nextSyntheticIndex: 0,
};
```

Add this private method to the class (after `handleEvent`):

```typescript
  /**
   * Resolve a delta event's tool-call key to the stable chunk index AgentRuntime
   * accumulates by. Keys on item_id when present, falling back to output_index
   * (ollama shares output_index across a text item and a following function call).
   */
  private indexFor(
    key: string,
    state: StreamState,
    startIndex: number | undefined,
  ): number {
    const existing = state.toolKeyToIndex.get(key);
    if (existing !== undefined) return existing;
    const index = startIndex ?? state.nextSyntheticIndex++;
    state.toolKeyToIndex.set(key, index);
    return index;
  }
```

**3c.** Replace `handleEvent` with this version (Task 3's branches unchanged; two new branches and the `completed` stop rule). The call site already passes `state` (Task 3); keep it as is.

```typescript
  private handleEvent(event: ResponsesEvent, state: StreamState): ProviderStreamChunk[] {
    const type = asString(event.type);
    if (!type) return []; // quirk tolerance: event without a type is ignored

    if (type === 'response.output_text.delta') {
      const delta = asString(event.delta);
      if (delta) return [{ type: 'text_delta', delta }];
      return [];
    }

    if (type === 'response.reasoning_text.delta') {
      if (state.reasoningMode === 'summary') return []; // first shape seen wins for this stream
      state.reasoningMode = 'full';
      const delta = asString(event.delta);
      if (delta) return [{ type: 'reasoning_delta', delta }];
      return [];
    }

    if (type === 'response.reasoning_summary_text.delta') {
      if (state.reasoningMode === 'full') return [];
      state.reasoningMode = 'summary';
      const delta = asString(event.delta);
      if (delta) return [{ type: 'reasoning_delta', delta }];
      return [];
    }

    if (type === 'response.refusal.delta') {
      const delta = asString(event.delta);
      if (delta) return [{ type: 'text_delta', delta }];
      return [];
    }

    if (type === 'response.output_item.added') {
      const item = event.item ?? {};
      if (asString(item.type) !== 'function_call') return [];
      state.emittedToolCall = true;
      const callId = asString(item.call_id) ?? '';
      const name = asString(item.name) ?? '';
      const rawIndex = typeof event.output_index === 'number' ? event.output_index : undefined;
      const itemId = asString(item.id) ?? asString(event.item_id) ?? `idx:${rawIndex ?? '?'}`;
      const index = this.indexFor(itemId, state, rawIndex);
      state.toolKeyToIndex.set(`start:${itemId}`, index);
      return [{ type: 'tool_call_start', index, id: callId, name }];
    }

    if (type === 'response.function_call_arguments.delta') {
      const delta = asString(event.delta);
      if (!delta) return [];
      const rawIndex = typeof event.output_index === 'number' ? event.output_index : undefined;
      const key = asString(event.item_id) ?? `idx:${rawIndex ?? '?'}`;
      // Reuse the index assigned at tool_call_start for the same item when known.
      const started = state.toolKeyToIndex.get(`start:${key}`);
      const index = started ?? this.indexFor(key, state, rawIndex);
      return [{ type: 'tool_call_args_delta', index, delta }];
    }

    if (type === 'response.completed') {
      const response = event.response ?? {};
      const stopReason: ProviderStopReason = state.emittedToolCall ? 'tool_calls' : 'stop';
      return [{ type: 'done', stopReason, usage: mapUsage(response.usage), cost: undefined }];
    }

    // Everything else — response.created, *_done replays (including
    // response.function_call_arguments.done and output_item.done), unknown
    // types — is ignored. The other terminal events arrive in Task 5.
    return [];
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/OpenAIResponsesProvider.ts packages/core/src/providers/OpenAIResponsesProvider.test.ts
git commit -m "feat(core): tool calls and keyed accumulation in OpenAIResponsesProvider"
```

---

### Task 5: Terminal events, error paths, quirk tolerance

**Files:**

- Modify: `packages/core/src/providers/OpenAIResponsesProvider.ts` (`ResponsesObject`, `handleEvent`)
- Test: `packages/core/src/providers/OpenAIResponsesProvider.test.ts` (extend)

**Interfaces:**

- Consumes: Task 4's `handleEvent(event, state)`.
- Produces: `response.incomplete` → `max_tokens` stop reason; `response.failed` → thrown `ProviderError`; EOF-without-terminal → thrown `ProviderError`; unknown events / replayed `response.output` items / missing `sequence_number` tolerated (no extra chunks, no throw).

- [ ] **Step 1: Write the failing tests**

Add inside the top-level `describe`:

```typescript
it('maps response.incomplete with max_output_tokens to stopReason max_tokens', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.output_text.delta', { delta: 'partial' }),
      ev('response.incomplete', {
        response: {
          id: 'resp_1',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.text).toEqual(['partial']);
  expect(result.done?.stopReason).toBe('max_tokens');
  expect(result.done?.usage?.outputTokens).toBe(4);
});

it('maps response.incomplete with another reason to stopReason stop', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.incomplete', {
        response: { id: 'resp_1', incomplete_details: { reason: 'content_filter' } },
      }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.done?.stopReason).toBe('stop');
});

it('throws ProviderError on response.failed with code and message', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }),
      ev('response.failed', {
        response: { id: 'resp_1', error: { code: 'server_error', message: 'boom' } },
      }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  await expect(drain(provider, [{ role: 'user', content: 'hi' }])).rejects.toThrow(ProviderError);
  await expect(drain(provider, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
    'Responses API error server_error: boom',
  );
});

it('throws ProviderError when the stream ends without a terminal event', async () => {
  fetchMock.mockResolvedValue(sse([ev('response.created', { response: { id: 'resp_1' } })]));

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  await expect(drain(provider, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
    'Responses stream ended without a terminal event',
  );
});

it('ignores unknown event types and tolerates missing sequence_number', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }), // no sequence_number anywhere
      { type: 'response.brand_new_event.future', exotic_field: { nested: true } },
      ev('response.output_text.delta', { delta: 'ok' }),
      ev('response.completed', { response: { id: 'resp_1' } }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.text).toEqual(['ok']);
  expect(result.done?.stopReason).toBe('stop');
});

it('never re-emits response.output items replayed in the terminal event (vLLM #59834 class)', async () => {
  fetchMock.mockResolvedValue(
    sse([
      ev('response.created', { response: { id: 'resp_1' } }),
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'function_call', id: 'fc_live', call_id: 'call_live', name: 'lookup' },
      }),
      ev('response.function_call_arguments.delta', {
        item_id: 'fc_live',
        output_index: 0,
        delta: '{"q":"x"}',
      }),
      // vLLM regenerates item ids in the terminal replay — different id, same content.
      ev('response.completed', {
        response: {
          id: 'resp_1',
          output: [
            {
              type: 'function_call',
              id: 'fc_REGENERATED',
              call_id: 'call_live',
              name: 'lookup',
              arguments: '{"q":"x"}',
            },
          ],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      }),
    ]),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.toolStarts).toEqual([{ index: 0, id: 'call_live', name: 'lookup' }]);
  expect(result.toolArgs).toEqual([{ index: 0, delta: '{"q":"x"}' }]);
  expect(result.done?.stopReason).toBe('tool_calls');
});

it('forwards abort signal to fetch and cancels reader on generator return', async () => {
  const controller = new AbortController();
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const reader = {
    read: vi.fn(async () => ({
      done: false,
      value: new TextEncoder().encode(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n`,
      ),
    })),
    cancel,
    releaseLock,
  };
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    body: { getReader: () => reader },
  });
  vi.stubGlobal('fetch', fetchMock);

  const provider = new OpenAIResponsesProvider();
  const stream = provider.stream([], [], MODEL, { signal: controller.signal });
  await expect(stream.next()).resolves.toEqual({
    done: false,
    value: { type: 'text_delta', delta: 'partial' },
  });
  await stream.return(undefined as never);
  vi.unstubAllGlobals();

  expect(fetchMock).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ signal: controller.signal }),
  );
  expect(cancel).toHaveBeenCalledOnce();
  expect(releaseLock).toHaveBeenCalledOnce();
});

it('stops parsing at the terminal event and ignores trailing data ([DONE] sentinel)', async () => {
  fetchMock.mockResolvedValue(
    sse(
      [
        ev('response.output_text.delta', { delta: 'final' }),
        ev('response.completed', { response: { id: 'resp_1' } }),
        ev('response.output_text.delta', { delta: 'GHOST' }), // after terminal
      ],
      { withDoneSentinel: true },
    ),
  );

  const provider = new OpenAIResponsesProvider('https://example.test/v1');
  const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

  expect(result.text).toEqual(['final']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts`
Expected: FAIL — `response.incomplete` and `response.failed` currently fall through the ignore branch (incomplete yields no done; failed yields a dangling done-less stream), so the incomplete/failed/EOF tests fail; the quirk-tolerance and abort tests may already pass (the reader logic is copied from the chat path).

- [ ] **Step 3: Implement**

Two edits in `packages/core/src/providers/OpenAIResponsesProvider.ts`:

**3a.** Replace `ResponsesObject` with the version carrying terminal metadata:

```typescript
interface ResponsesObject {
  usage?: ResponsesUsage;
  error?: { code?: unknown; message?: unknown };
  incomplete_details?: { reason?: unknown };
}
```

**3b.** In `handleEvent`, add two terminal branches immediately **before** the `response.completed` branch (which stays unchanged from Task 4):

```typescript
if (type === 'response.incomplete') {
  const response = event.response ?? {};
  const reason = asString(response.incomplete_details?.reason);
  const stopReason: ProviderStopReason = reason === 'max_output_tokens' ? 'max_tokens' : 'stop';
  return [{ type: 'done', stopReason, usage: mapUsage(response.usage), cost: undefined }];
}

if (type === 'response.failed') {
  const error = event.response?.error ?? {};
  const code = asString(error.code) ?? 'unknown_error';
  const message = asString(error.message) ?? 'Responses stream failed';
  throw new ProviderError(`Responses API error ${code}: ${message}`);
}
```

Also update the end-of-method comment block to read: `// Everything else — response.created, *_done replays, unknown types — is ignored.` (the Task-4 comment mentioning "Task 5" is now stale).

Note on ordering: the terminal-replay test passes without extra work because `handleEvent` only reads `event.type`, `event.item`, `event.delta`, and `event.response.{usage,incomplete_details,error}` — the `response.output` array inside the terminal event is never walked. Keep it that way; it is the spec's quirk-tolerance rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts`
Expected: PASS (21 tests).

- [ ] **Step 5: Run the whole core suite**

Run: `npx vitest run packages/core`
Expected: PASS — no regressions in existing provider/store tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers/OpenAIResponsesProvider.ts packages/core/src/providers/OpenAIResponsesProvider.test.ts
git commit -m "feat(core): terminal events, error paths, and quirk tolerance in OpenAIResponsesProvider"
```

---

### Task 6: SystemProviderStore case + barrel export

**Files:**

- Modify: `packages/core/src/providers/SystemProviderStore.ts:33-44` (`construct`)
- Modify: `packages/core/src/index.ts` (barrel export)
- Test: `packages/core/src/providers/SystemProviderStore.test.ts` (extend)

**Interfaces:**

- Consumes: `OpenAIResponsesProvider` from Task 2, `'openai-responses'` type from Task 1.
- Produces: `SystemProviderStore.construct()` maps `type: 'openai-responses'` → `new OpenAIResponsesProvider(config.baseUrl, config.apiKey)`. E2E (Task 7) and integration (Task 8) configs rely on this wiring.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/providers/SystemProviderStore.test.ts`, add inside `describe('SystemProviderStore', ...)` (after the codex test):

```typescript
it('get() returns Provider with stream for openai-responses', async () => {
  const storage = new MemoryStorage();
  await storage.writeJson(
    'providers/responses.json',
    providerConfig({ name: 'responses', type: 'openai-responses' }),
  );
  const store = new SystemProviderStore(storage);

  const provider = await store.get('responses');

  expect(provider).not.toBeNull();
  expect(typeof provider!.stream).toBe('function');
  expect(typeof provider!.listModels).toBe('function');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/providers/SystemProviderStore.test.ts`
Expected: FAIL — TypeScript reports the type `'openai-responses'` is fine (union extended in Task 1) but `construct()` has no case for it. Note: because `construct()`'s switch is exhaustive over the union, `tsc` fails with "not all code paths return a value" / non-exhaustive switch — this is the compile-level failure; if vitest reports a type-check error instead of a runtime one, that is the expected failure mode here.

- [ ] **Step 3: Add the case and the barrel export**

`packages/core/src/providers/SystemProviderStore.ts` — add the import and the case:

```typescript
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { OpenAIResponsesProvider } from './OpenAIResponsesProvider.js';
```

```typescript
  private construct(config: ProviderConfig): Provider {
    switch (config.type) {
      case 'openai-compatible':
      case 'anthropic':
        return new OpenAICompatibleProvider(config.baseUrl, config.apiKey);
      case 'openai-responses':
        return new OpenAIResponsesProvider(config.baseUrl, config.apiKey);
      case 'copilot':
      case 'codex':
        throw new NotImplementedError(
          `Provider type '${config.type}' is not yet implemented. OAuth support coming soon.`,
        );
    }
  }
```

`packages/core/src/index.ts` — add next to the `OpenAICompatibleProvider` export (line 32):

```typescript
export * from './providers/OpenAIResponsesProvider.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/SystemProviderStore.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/SystemProviderStore.ts packages/core/src/providers/SystemProviderStore.test.ts packages/core/src/index.ts
git commit -m "feat(core): construct OpenAIResponsesProvider from 'openai-responses' provider configs"
```

---

### Task 7: E2E mock `/v1/responses` handler + provider e2e spec

**Files:**

- Modify: `packages/e2e/mock-provider/server.ts` (new route + Responses chunk builders)
- Create: `packages/e2e/tests/providers/responses-provider.spec.ts`

**Interfaces:**

- Consumes: Task 6's store wiring; e2e fixtures `connInfo.mockProviderUrl`, `api.execute(token, tool, args)` (see `packages/e2e/fixtures/index.ts`, `packages/e2e/helpers/api.ts`); mock scenario markers (`E2E_REASONING_SCENARIO`, tool scenario via `list_participants`) matching the chat handler's routing.
- Produces: `POST /v1/responses` on the mock provider, speaking Responses grammar with scenario routing parallel to the chat handler; an e2e spec proving one agent turn end-to-end over the Responses wire. `startMockProvider`'s signature is unchanged.

- [ ] **Step 1: Add the `/v1/responses` handler to the mock provider**

In `packages/e2e/mock-provider/server.ts`:

**1a.** Add request/event types next to the existing chat types (top of file):

```typescript
type ResponsesInputItem = {
  role?: string;
  content?: unknown;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
};
type ResponsesRequest = {
  model?: string;
  input?: ResponsesInputItem[];
  instructions?: string;
  tools?: Array<{ name?: string }>;
};
```

**1b.** Add an `isResponsesRequest` guard mirroring `isChatRequest`'s tolerance (extra fields allowed):

```typescript
function isResponsesRequest(value: unknown): value is ResponsesRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const input = (value as Record<string, unknown>)['input'];
  if (input === undefined) return true;
  if (!Array.isArray(input)) return false;
  return input.every((item) => typeof item === 'object' && item !== null);
}
```

**1c.** Add Responses-grammar chunk builders next to the existing `textChunks`/`toolChunks` helpers. The final event carries the full response object with usage, exactly as real backends do:

```typescript
function responsesTextEvents(text: string): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_e2e' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: 'msg_0' },
    },
    { type: 'response.output_text.delta', item_id: 'msg_0', output_index: 0, delta: text },
    {
      type: 'response.completed',
      response: {
        id: 'resp_e2e',
        usage: { input_tokens: 20, output_tokens: 5 },
      },
    },
  ];
}

function responsesToolCallEvents(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_e2e' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_0', call_id: callId, name },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_0',
      output_index: 0,
      delta: JSON.stringify(args),
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_0',
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
      },
    },
    {
      type: 'response.completed',
      response: { id: 'resp_e2e', usage: { input_tokens: 20, output_tokens: 5 } },
    },
  ];
}

function responsesReasoningEvents(): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_e2e' } },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rsn_0',
      output_index: 0,
      delta: '**tool reasoning**',
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_0',
        call_id: 'reasoning-tool-call',
        name: 'list_participants',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_0',
      output_index: 1,
      delta: '{}',
    },
    {
      type: 'response.completed',
      response: { id: 'resp_e2e', usage: { input_tokens: 20, output_tokens: 5 } },
    },
  ];
}
```

**1d.** Add the route inside the `req.on('end', ...)` async block, directly after the `/v1/chat/completions` handler block (so scenario routing reads the same way). Note `writeSse`'s trailing `data: [DONE]` is harmless — the Responses parser stops at the terminal event (Task 5 test proves it):

```typescript
if (req.method === 'POST' && req.url === '/v1/responses') {
  let parsed: unknown;
  try {
    parsed = JSON.parse(_body) as unknown;
  } catch {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(
      JSON.stringify({
        error: { message: 'invalid JSON', type: 'invalid_request_error' },
      }),
    );
    return;
  }
  if (!isResponsesRequest(parsed)) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(
      JSON.stringify({
        error: { message: 'invalid request', type: 'invalid_request_error' },
      }),
    );
    return;
  }

  const { input = [], instructions } = parsed;
  const isReasoningScenario = input.some(
    (item) =>
      item.role === 'user' &&
      typeof item.content === 'string' &&
      item.content.includes('E2E_REASONING_SCENARIO'),
  );
  const hasToolResult = input.some((item) => item.type === 'function_call_output');

  if (isReasoningScenario && !hasToolResult) {
    await writeSse(res, responsesReasoningEvents(), 300);
    return;
  }
  if (isReasoningScenario && hasToolResult) {
    await writeSse(res, responsesTextEvents('final reasoning answer'), 300);
    return;
  }

  const flatInput = input.some(
    (item) => typeof item.content === 'string' && item.content.includes('E2E_SKILL_SCENARIO'),
  );

  if (flatInput) {
    const callLoaded = input.some(
      (item) => item.type === 'function_call' && item.name === 'load_skills',
    );
    if (!callLoaded) {
      await writeSse(
        res,
        responsesToolCallEvents('skill-load', 'load_skills', { names: ['e2e-proof-skill'] }),
      );
    } else {
      await writeSse(res, responsesTextEvents('SKILL_LOADED_OK'));
    }
    return;
  }

  if (hasToolResult) {
    await writeSse(res, responsesTextEvents('tool result acknowledged'));
    return;
  }

  await writeSse(res, responsesTextEvents('mock response'));
  return;
}
```

- [ ] **Step 2: Write the e2e spec**

Create `packages/e2e/tests/providers/responses-provider.spec.ts` (buffered-execute pattern from `packages/e2e/tests/conversations/reasoning.spec.ts`):

```typescript
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures/index.js';
import type { ExecuteResult } from '../../helpers/api.js';

async function executeBuffered<T = unknown>(
  request: APIRequestContext,
  serverUrl: string,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ExecuteResult<T>> {
  const response = await request.post(`${serverUrl}/api/execute?stream=false`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { tool, args },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<ExecuteResult<T>>;
}

test.describe('Responses API provider end-to-end', () => {
  let agentName: string;
  let operatorToken: string;

  test.beforeAll(async ({ api, connInfo, request }) => {
    const { token } = await api.login('operator', connInfo.password);
    operatorToken = token;

    const providerResult = await executeBuffered(
      request,
      connInfo.serverUrl,
      token,
      'save_provider',
      {
        name: 'responses-mock-provider',
        type: 'openai-responses',
        baseUrl: `${connInfo.mockProviderUrl}/v1`,
        apiKey: 'sk-e2e-responses',
        priority: 10,
      },
    );
    expect(providerResult.result.status).toBe('success');

    agentName = `responses-test-agent-${Date.now()}`;
    const createResult = await executeBuffered<{ id: string }>(
      request,
      connInfo.serverUrl,
      token,
      'create_agent',
      {
        id: agentName,
        name: agentName,
        systemPrompt: 'You are a terse mock-backed assistant.',
        model: { provider: 'responses-mock-provider', model: 'mock-model' },
        tools: { list_participants: 'auto' },
      },
    );
    expect(createResult.result.status).toBe('success');
  });

  test.afterAll(async ({ connInfo, request }) => {
    const retireResult = await executeBuffered(
      request,
      connInfo.serverUrl,
      operatorToken,
      'retire_agent',
      { id: agentName },
    );
    expect(retireResult.result.status).toBe('success');

    const deleteResult = await executeBuffered(
      request,
      connInfo.serverUrl,
      operatorToken,
      'delete_provider',
      {
        name: 'responses-mock-provider',
      },
    );
    expect(deleteResult.result.status).toBe('success');
  });

  test('one agent turn streams text over the Responses wire', async ({
    api,
    connInfo,
    request,
  }) => {
    const { token } = await api.login('operator', connInfo.password);

    const commResult = await executeBuffered<{ conversationId: string }>(
      request,
      connInfo.serverUrl,
      token,
      'communicate',
      { to: agentName, message: 'hello over responses' },
    );
    expect(commResult.result.status).toBe('success');
    const conversationId = commResult.result.data!.conversationId;

    const convResult = await executeBuffered<{
      messages: Array<{ role: string; content: string | null }>;
    }>(request, connInfo.serverUrl, token, 'get_conversation', { conversationId });
    expect(convResult.result.status).toBe('success');

    const contents = convResult.result.data!.messages.map((m) => m.content ?? '');
    expect(contents.join('\n')).toContain('mock response');
  });
});
```

- [ ] **Step 3: Run the spec**

Prerequisites from `docs/testing.md`/AGENTS.md (skip any already done): `npm install`, `npm run build`, `npx playwright install chromium`.

Run: `npm run test:e2e -- tests/providers/responses-provider.spec.ts`
Expected: PASS — the agent turn completes; the conversation contains the mock's Responses-wire reply. If the agent turn times out, check the server log for provider construction errors first (Task 6 case), then the mock's request log.

- [ ] **Step 4: Run the chat-wire e2e specs to verify the mock change is regression-free**

Run: `npm run test:e2e -- tests/conversations/reasoning.spec.ts tests/api/execute.spec.ts`
Expected: PASS — the new `/v1/responses` route does not disturb `/v1/chat/completions` routing.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e/mock-provider/server.ts packages/e2e/tests/providers/responses-provider.spec.ts
git commit -m "test(e2e): /v1/responses mock handler and Responses-provider agent-turn spec"
```

---

### Task 8: Integration gate test + docs/testing.md row

**Files:**

- Create: `packages/core/src/providers/OpenAIResponsesProvider.integration.test.ts`
- Modify: `docs/testing.md` (environment variable table)

**Interfaces:**

- Consumes: `OpenAIResponsesProvider` (Task 2), gate pattern from `packages/core/src/runtime/agent-runtime.integration.test.ts` (`describe.skipIf(!LIVE)`).
- Produces: opt-in live-backend coverage behind `LEGION_OPENAI_RESPONSES_INTEGRATION=1` (Chris's Task-39 answer #3: separate gate, existing `LEGION_OPENAI_INTEGRATION` untouched). Skipped by default — CI and local runs are unaffected.

- [ ] **Step 1: Write the integration test**

Create `packages/core/src/providers/OpenAIResponsesProvider.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { OpenAIResponsesProvider } from './OpenAIResponsesProvider.js';

const LIVE = !!process.env['LEGION_OPENAI_RESPONSES_INTEGRATION'];
const BASE_URL = process.env['OPENAI_RESPONSES_BASE_URL'] ?? 'https://api.openai.com/v1';
const MODEL_ID = process.env['OPENAI_RESPONSES_MODEL'] ?? 'gpt-4o-mini';

describe.skipIf(!LIVE)('OpenAIResponsesProvider: live backend', () => {
  it('streams one text turn end-to-end', async () => {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when the integration gate is on');

    const provider = new OpenAIResponsesProvider(BASE_URL, apiKey);
    const chunks = [];
    for await (const chunk of provider.stream(
      [
        { role: 'system', content: 'Always respond in exactly one short sentence.' },
        { role: 'user', content: 'Say hello.' },
      ],
      [],
      { model: MODEL_ID },
    )) {
      chunks.push(chunk);
    }

    const done = chunks.at(-1);
    expect(done?.type).toBe('done');
    const text = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => c.delta)
      .join('');
    expect(text.length).toBeGreaterThan(0);
    if (done?.type === 'done') {
      expect(done.stopReason).toBe('stop');
    }
  });
});
```

Note the tool-call case is deliberately absent — the spec marks live tool calls optional/flaky-tolerant; the unit suite owns that grammar.

- [ ] **Step 2: Verify it skips by default**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.integration.test.ts`
Expected: 1 skipped (not failed). No network call.

- [ ] **Step 3: Document the gate**

In `docs/testing.md`, extend the environment-variable table (after the `LEGION_OPENAI_INTEGRATION` row):

```markdown
| `LEGION_OPENAI_RESPONSES_INTEGRATION=1` | `OpenAIResponsesProvider.integration.test.ts` | Requires a live OpenAI API key; exercises the Responses wire (`/responses`); model `gpt-4o-mini` by default (override with `OPENAI_RESPONSES_MODEL`, base URL with `OPENAI_RESPONSES_BASE_URL`) |
```

- [ ] **Step 4: Run the gates**

Run: `npm run format:check && npm run typecheck && npm test`
Expected: PASS — the new integration file is skipped in `npm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/OpenAIResponsesProvider.integration.test.ts docs/testing.md
git commit -m "test(core): opt-in Responses live integration gate + docs"
```

---

### Task 9: Full gates, self-review, PR

**Files:**

- No source changes expected; fix-ups if gates surface them.

**Interfaces:**

- Consumes: everything above.
- Produces: green gates + open PR linking issue #8.

- [ ] **Step 1: Run the full gate order**

```bash
npm run format:check
npm run typecheck
npm test
npm run test --workspace=packages/web
```

Expected: all PASS. If `format:check` fails, run `npm run format` and re-run the gate (include formatting-only fixes in the commit that introduced them or a final `chore: format` commit).

- [ ] **Step 2: Re-run the e2e provider suite against the built app**

Run: `npm run test:e2e -- tests/providers/responses-provider.spec.ts tests/conversations/reasoning.spec.ts`
Expected: PASS (both wires work against the final build).

- [ ] **Step 3: Plan self-review against the spec**

Walk the spec with fresh eyes and check:

1. **Spec coverage:** every footprint-table row → its task (types: T1, provider: T2-T5, store: T6, mock: T7, slide-over: T1, ConfigView: T1, unit tests: T2-T5, testing.md: T8); every Q6 fixture list item → a named test in T2-T5; both deferred items (Q3 statefulness, Q4 reasoning-effort) appear nowhere in the code tasks.
2. **Placeholder scan:** no TBDs, no "similar to Task N", every code step has full code.
3. **Type consistency:** `handleEvent(event, state)` signature identical in Tasks 3/4/5; `StreamState` fields grown additively (T3 → T4) with every field written by some task; `'openai-responses'` spelled identically everywhere.

- [ ] **Step 4: Push and update the PR**

The plan ships on the same branch as the spec — `docs/responses-api-provider-design` (PR #9) — so spec and plan are reviewed together and the plan's spec reference resolves on the branch:

```bash
git push origin docs/responses-api-provider-design
```

Then update PR #9's title/body to cover both artifacts:

```bash
gh pr edit 9 --title "Design spec + implementation plan: Responses API provider (issue #8)" --body "Design spec: docs/superpowers/specs/2026-10-06-responses-api-provider-design.md. Implementation plan: docs/superpowers/plans/2026-10-06-responses-api-provider.md. Open questions resolved by Chris 2026-10-06: defer encrypted-reasoning replay; type name openai-responses; separate LEGION_OPENAI_RESPONSES_INTEGRATION gate. Links issue #8. No runtime code in this PR - implementation follows on a separate branch after merge."
```

- [ ] **Step 5: Link issue #8**

Verify the PR body's `Links issue #8` reference made PR #9 appear in issue #8's timeline; if not, comment on issue #8 with the PR link.

---
