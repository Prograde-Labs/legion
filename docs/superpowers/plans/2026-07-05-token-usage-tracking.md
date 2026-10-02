# Token Usage & Cost Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track per-message token usage and cost in Legion's conversation tree, with a pluggable pricing source (default: models.dev), a `UsageCalculator` for normalization, and two tools (`query_usage`, `list_models`) exposing aggregates and pricing.

**Architecture:** Usage attaches as optional `MessageUsage` on `MessageData`. Providers report raw `ProviderUsage` from API responses; `UsageCalculator` normalizes (subtracts cache from input, reasoning from output) and computes cost via `PricingSource`. Aggregates derived on demand by `UsageQuery` walking the conversation tree. No new store — usage lives in the conversation.

**Tech Stack:** TypeScript (NodeNext ESM, strict), Vitest, `decimal.js` for cost arithmetic, `node:fs` for pricing cache, HTTPS fetch for models.dev.

**Spec:** `docs/superpowers/specs/2026-07-05-token-usage-tracking-design.md`

---

## File Map

### New files

| File                                                         | Responsibility                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `packages/types/src/usage.ts`                                | `MessageUsage` type (5 token buckets + cost + model/provider IDs) |
| `packages/core/src/providers/PricingSource.ts`               | `PricingSource` interface + `ModelPricing` type                   |
| `packages/core/src/providers/ModelsDevPricingSource.ts`      | Default impl: fetch models.dev, 24h cache, hardcoded fallback     |
| `packages/core/src/providers/ModelsDevPricingSource.test.ts` | Unit tests                                                        |
| `packages/core/src/providers/UsageCalculator.ts`             | `ProviderUsage` → `MessageUsage` normalization + cost math        |
| `packages/core/src/providers/UsageCalculator.test.ts`        | Unit tests                                                        |
| `packages/core/src/usage/usage-types.ts`                     | `MessageUsageTotals`, `UsageFilter`, `UsageReport`, `GroupBy`     |
| `packages/core/src/usage/UsageQuery.ts`                      | Aggregate query — walks conversation tree                         |
| `packages/core/src/usage/UsageQuery.test.ts`                 | Unit tests with fixture conversations                             |

### Modified files

| File                                                           | Changes                                                                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/conversation.ts`                           | Add `usage?: MessageUsage` to `MessageData`                                                                           |
| `packages/types/src/index.ts`                                  | Re-export `./usage.js`                                                                                                |
| `packages/core/src/providers/Provider.ts`                      | Replace 2-field `usage` with `ProviderUsage`; add `cost?` to `ProviderResponse`; add `pricingSource?()` to `Provider` |
| `packages/core/src/providers/OpenAICompatibleProvider.ts`      | Expand `OAIUsage` type; extract cache/reasoning fields                                                                |
| `packages/core/src/providers/OpenAICompatibleProvider.test.ts` | Update existing tests for new `ProviderUsage` shape; add cache/reasoning test                                         |
| `packages/core/src/conversation/conversation-ops.ts`           | Add `usage` to `NewMessageInput` Partial<Pick<>>                                                                      |
| `packages/core/src/runtime/AgentRuntime.ts`                    | Inject `UsageCalculator`; compute usage after provider call; pass to `append()`                                       |
| `packages/core/src/runtime/AgentRuntime.test.ts`               | Inject mock calculator in `makeSetup`; assert usage on persisted messages                                             |
| `packages/core/src/tools/management-tools.ts`                  | Add `query_usage` + `list_models` tools; add to `managementTools` array                                               |
| `packages/core/src/tools/management-tools.test.ts`             | Tests for new tools                                                                                                   |
| `packages/core/src/index.ts`                                   | Export `UsageCalculator`, `UsageQuery`, `PricingSource`, `ModelsDevPricingSource`                                     |
| `packages/core/package.json`                                   | Add `decimal.js` dependency                                                                                           |
| `packages/e2e/mock-provider/server.ts`                         | Expand `usage` to include `prompt_tokens_details.cached_tokens` + `completion_tokens_details.reasoning_tokens`        |

---

## Task 1: Add `MessageUsage` type to `@legion-collective/types`

**Files:**

- Create: `packages/types/src/usage.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/conversation.ts`

- [ ] **Step 1: Create `packages/types/src/usage.ts`**

```typescript
export interface MessageUsage {
  /** Non-cached input tokens (promptTokens - cacheRead - cacheWrite). */
  input: number;
  /** Output tokens excluding reasoning. */
  output: number;
  /** Reasoning/thinking tokens (o1/o3, Claude extended thinking). */
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
  /** Computed cost in USD. May be 0 if pricing unavailable. */
  cost: number;
  /** Model ID as known to the provider (e.g. "claude-sonnet-4-5"). */
  modelId: string;
  /** Provider ID (e.g. "anthropic", "openai"). */
  providerId: string;
}
```

- [ ] **Step 2: Re-export from `packages/types/src/index.ts`**

Add this line at the end of the file:

```typescript
export * from './usage.js';
```

- [ ] **Step 3: Add `usage?` field to `MessageData` in `packages/types/src/conversation.ts`**

Add the import at the top:

```typescript
import type { MessageUsage } from './usage.js';
```

Add `usage?: MessageUsage;` to the `MessageData` interface, after `toolResults?: ToolCallResult[];` (line 19).

- [ ] **Step 4: Run typecheck to verify**

Run: `npm run typecheck`
Expected: PASS (no errors — `usage` is optional, no consumers changed)

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/usage.ts packages/types/src/index.ts packages/types/src/conversation.ts
git commit -m "feat(types): add MessageUsage type for per-message token tracking"
```

---

## Task 2: Add `ProviderUsage` type and `pricingSource?()` hook to `Provider`

**Files:**

- Modify: `packages/core/src/providers/Provider.ts`

- [ ] **Step 1: Replace the 2-field `usage` on `ProviderResponse` with `ProviderUsage`; add `cost?` override; add `pricingSource?()` to `Provider` interface**

Replace lines 33-40 of `packages/core/src/providers/Provider.ts`:

```typescript
export type ProviderStopReason = 'stop' | 'tool_calls' | 'max_tokens';

export interface ProviderResponse {
  /** Final assistant text, or null if the LLM only produced tool calls. */
  content: string | null;
  /** Non-empty when stopReason === 'tool_calls'. */
  toolCalls: ProviderToolCall[];
  stopReason: ProviderStopReason;
  usage?: { promptTokens: number; completionTokens: number };
}
```

With:

```typescript
export type ProviderStopReason = 'stop' | 'tool_calls' | 'max_tokens';

/** Raw usage from the provider API. inputTokens includes cached tokens on OpenAI/AI SDK v6. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface ProviderResponse {
  /** Final assistant text, or null if the LLM only produced tool calls. */
  content: string | null;
  /** Non-empty when stopReason === 'tool_calls'. */
  toolCalls: ProviderToolCall[];
  stopReason: ProviderStopReason;
  usage?: ProviderUsage;
  /**
   * Provider may override cost calculation (e.g. Copilot nano-AIU).
   * If absent, UsageCalculator computes it via PricingSource.
   */
  cost?: number;
}
```

- [ ] **Step 2: Add `pricingSource?()` hook to the `Provider` interface**

Add to the `Provider` interface (after `listModels?()`):

```typescript
  /**
   * Optional: return a PricingSource for models this provider serves.
   * If absent, the system-wide ModelsDevPricingSource is used.
   * Providers with bespoke billing (e.g. Copilot AIU, self-hosted) implement this.
   */
  pricingSource?(): PricingSource;
```

And add the import at the top of the file. Since `PricingSource` doesn't exist yet, use a forward type import — but to avoid a circular dependency, define `PricingSource` in its own file first. **Defer this import until Task 3 creates `PricingSource.ts`.** For now, leave `pricingSource?()` off the interface; Task 3 will add it.

**Correction:** Do NOT add `pricingSource?()` in this task. Only change `ProviderResponse.usage` shape and add `ProviderUsage` + `cost?`. Task 3 adds `pricingSource?()` after `PricingSource` exists.

- [ ] **Step 3: Run typecheck — expect failures in `OpenAICompatibleProvider.ts` and its test**

Run: `npm run typecheck`
Expected: FAIL — `OpenAICompatibleProvider.ts:171` references `promptTokens`/`completionTokens` which no longer exist on `ProviderUsage`. This is expected; Task 3 fixes it.

- [ ] **Step 4: Commit (typecheck will fail — that's OK, next task fixes it)**

```bash
git add packages/core/src/providers/Provider.ts
git commit -m "feat(core): replace ProviderResponse.usage with ProviderUsage type

Breaking: ProviderUsage has inputTokens/outputTokens/reasoningTokens/
cacheReadInputTokens/cacheWriteInputTokens instead of promptTokens/
completionTokens. OpenAICompatibleProvider update follows in next commit."
```

---

## Task 3: Create `PricingSource` interface + `ModelPricing` type

**Files:**

- Create: `packages/core/src/providers/PricingSource.ts`

- [ ] **Step 1: Create `packages/core/src/providers/PricingSource.ts`**

```typescript
export interface ModelPricing {
  /** Per-million-token rates, USD. */
  input: number;
  output: number;
  cache: {
    read: number;
    write: number;
  };
  /** Optional context-window tier pricing (e.g. Gemini >200K). */
  tiers?: Array<{
    tier: { type: 'context'; size: number };
    input: number;
    output: number;
    cache: { read: number; write: number };
  }>;
}

export interface PricingSource {
  /** Returns pricing for a model, or undefined if unknown. */
  resolve(providerId: string, modelId: string): Promise<ModelPricing | undefined>;
  /** Forces a refresh of cached pricing data. */
  refresh?(): Promise<void>;
}
```

- [ ] **Step 2: Add `pricingSource?()` hook to `Provider` interface in `packages/core/src/providers/Provider.ts`**

Add the import at the top:

```typescript
import type { PricingSource } from './PricingSource.js';
```

Add to the `Provider` interface, after `listModels?(): Promise<ProviderModel[]>;`:

```typescript
  /**
   * Optional: return a PricingSource for models this provider serves.
   * If absent, the system-wide ModelsDevPricingSource is used.
   * Providers with bespoke billing (e.g. Copilot AIU, self-hosted) implement this.
   */
  pricingSource?(): PricingSource;
```

- [ ] **Step 3: Run typecheck — `PricingSource` now exists; `Provider.pricingSource?` is optional so no consumer breaks**

Run: `npm run typecheck`
Expected: FAIL (still — `OpenAICompatibleProvider.ts:171` uses old `promptTokens`/`completionTokens`)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/providers/PricingSource.ts packages/core/src/providers/Provider.ts
git commit -m "feat(core): add PricingSource interface and ModelPricing type

Pluggable pricing source for cost calculation. Default impl (ModelsDevPricingSource)
follows. Provider.pricingSource?() hook allows per-provider override."
```

---

## Task 4: Fix `OpenAICompatibleProvider` to emit `ProviderUsage`

**Files:**

- Modify: `packages/core/src/providers/OpenAICompatibleProvider.ts`
- Modify: `packages/core/src/providers/OpenAICompatibleProvider.test.ts`

- [ ] **Step 1: Write the failing test for expanded usage extraction**

In `packages/core/src/providers/OpenAICompatibleProvider.test.ts`, add a new test inside the `describe('OpenAICompatibleProvider', ...)` block (before the closing `});`):

```typescript
it('extracts cache and reasoning tokens from prompt_tokens_details and completion_tokens_details', async () => {
  fetchMock.mockResolvedValue(
    makeOkResponse({
      choices: [
        {
          message: { role: 'assistant', content: 'thinking...', tool_calls: null },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 2006,
        completion_tokens: 300,
        total_tokens: 2306,
        prompt_tokens_details: { cached_tokens: 1920 },
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    }),
  );

  const provider = new OpenAICompatibleProvider();
  const result = await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

  expect(result.usage).toEqual({
    inputTokens: 2006,
    outputTokens: 300,
    reasoningTokens: 50,
    cacheReadInputTokens: 1920,
    cacheWriteInputTokens: undefined,
  });
});

it('falls back to cache_read_input_tokens when prompt_tokens_details is absent', async () => {
  fetchMock.mockResolvedValue(
    makeOkResponse({
      choices: [
        {
          message: { role: 'assistant', content: 'hi', tool_calls: null },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
      },
    }),
  );

  const provider = new OpenAICompatibleProvider();
  const result = await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

  expect(result.usage).toEqual({
    inputTokens: 1000,
    outputTokens: 100,
    reasoningTokens: undefined,
    cacheReadInputTokens: 800,
    cacheWriteInputTokens: 200,
  });
});

it('returns undefined usage when API omits usage object', async () => {
  fetchMock.mockResolvedValue(
    makeOkResponse({
      choices: [
        {
          message: { role: 'assistant', content: 'no usage', tool_calls: null },
          finish_reason: 'stop',
        },
      ],
    }),
  );

  const provider = new OpenAICompatibleProvider();
  const result = await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

  expect(result.usage).toBeUndefined();
});
```

- [ ] **Step 2: Update the existing test that asserts `result.usage?.promptTokens`**

In the first test (`'uses constructor base URL...'`), find lines 69-70:

```typescript
expect(result.usage?.promptTokens).toBe(10);
expect(result.usage?.completionTokens).toBe(5);
```

Replace with:

```typescript
expect(result.usage?.inputTokens).toBe(10);
expect(result.usage?.outputTokens).toBe(5);
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/OpenAICompatibleProvider.test.ts`
Expected: FAIL — new tests fail because provider still returns old shape; updated test fails because `promptTokens` is now `undefined` (the `OAIChatResponse.usage` type still says `{ prompt_tokens; completion_tokens }` but the runtime returns the same values, so `result.usage?.inputTokens` is undefined).

- [ ] **Step 4: Update `OAIChatResponse` type and extraction in `OpenAICompatibleProvider.ts`**

In `packages/core/src/providers/OpenAICompatibleProvider.ts`, replace the `usage` field on `OAIChatResponse` (line 33):

```typescript
  usage?: { prompt_tokens: number; completion_tokens: number };
```

With:

```typescript
  usage?: OAIUsage;
```

And add the `OAIUsage` interface after `OAIChatResponse` (before `OAIModelsResponse`):

```typescript
interface OAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  /** Anthropic-via-proxy fields (LiteLLM and similar). NOT OpenAI-native. */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
```

- [ ] **Step 5: Update usage extraction in the return statement (lines 171-176)**

Replace:

```typescript
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
```

With:

```typescript
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
            cacheReadInputTokens:
              data.usage.prompt_tokens_details?.cached_tokens ??
              data.usage.cache_read_input_tokens,
            cacheWriteInputTokens: data.usage.cache_creation_input_tokens,
          }
        : undefined,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/OpenAICompatibleProvider.test.ts`
Expected: PASS — all tests green

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — `ProviderUsage` shape now matches; no other consumers reference the old `promptTokens`/`completionTokens`.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/providers/OpenAICompatibleProvider.ts packages/core/src/providers/OpenAICompatibleProvider.test.ts
git commit -m "feat(core): extract cache/reasoning tokens in OpenAICompatibleProvider

Reads prompt_tokens_details.cached_tokens (OpenAI-native) and falls back to
cache_read_input_tokens (Anthropic-via-proxy). Reads completion_tokens_details.
reasoning_tokens. Emits ProviderUsage shape."
```

---

## Task 5: Add `decimal.js` dependency

**Files:**

- Modify: `packages/core/package.json`

- [ ] **Step 1: Add `decimal.js` to `packages/core/package.json`**

In the `dependencies` object, add:

```json
    "decimal.js": "^10.4.3"
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `decimal.js` added to `packages/core/node_modules` and root `package-lock.json`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json package-lock.json
git commit -m "chore(core): add decimal.js dependency for cost arithmetic"
```

---

## Task 6: Create `ModelsDevPricingSource`

**Files:**

- Create: `packages/core/src/providers/ModelsDevPricingSource.ts`
- Create: `packages/core/src/providers/ModelsDevPricingSource.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/providers/ModelsDevPricingSource.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelsDevPricingSource } from './ModelsDevPricingSource.js';

const SAMPLE_MODELS_JSON = {
  models: {
    'gpt-4o': {
      id: 'gpt-4o',
      name: 'GPT-4o',
      cost: {
        input: 2.5,
        output: 10,
        cache_read: 1.25,
        cache_write: 2.5,
      },
    },
    'claude-sonnet-4-5': {
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      cost: {
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_write: 3.75,
      },
    },
    'gemini-2.5-pro': {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      cost: {
        input: 1.25,
        output: 10,
        cache_read: 0.3125,
        cache_write: 0,
        tiers: [
          {
            tier: { type: 'context', size: 200000 },
            input: 2.5,
            output: 15,
            cache_read: 0.625,
            cache_write: 0,
          },
        ],
      },
    },
  },
};

describe('ModelsDevPricingSource', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let cacheDir: string;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    cacheDir = mkdtempSync(join(tmpdir(), 'legion-pricing-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('fetches models.dev and returns pricing for a known model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toEqual({
      input: 2.5,
      output: 10,
      cache: { read: 1.25, write: 2.5 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('caches the response to disk and does not refetch within 24h', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    await source.resolve('openai', 'gpt-4o');
    await source.resolve('anthropic', 'claude-sonnet-4-5');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(existsSync(join(cacheDir, 'models-dev.json'))).toBe(true);
  });

  it('reads from cache on second construction without fetching', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source1 = new ModelsDevPricingSource(cacheDir);
    await source1.resolve('openai', 'gpt-4o');

    const source2 = new ModelsDevPricingSource(cacheDir);
    const pricing = await source2.resolve('openai', 'gpt-4o');

    expect(pricing).toEqual({
      input: 2.5,
      output: 10,
      cache: { read: 1.25, write: 2.5 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refetches when cache is older than 24h', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source1 = new ModelsDevPricingSource(cacheDir);
    await source1.resolve('openai', 'gpt-4o');

    // Backdate the cache file by 25 hours
    const cachePath = join(cacheDir, 'models-dev.json');
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
    cached.fetchedAt = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(cachePath, JSON.stringify(cached));

    const source2 = new ModelsDevPricingSource(cacheDir);
    await source2.resolve('openai', 'gpt-4o');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for an unknown model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('unknown', 'nonexistent-model');

    expect(pricing).toBeUndefined();
  });

  it('strips provider prefixes (us., eu., global.) from model IDs', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'us.gpt-4o');

    expect(pricing).toEqual({
      input: 2.5,
      output: 10,
      cache: { read: 1.25, write: 2.5 },
    });
  });

  it('matches model IDs case-insensitively', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'GPT-4O');

    expect(pricing?.input).toBe(2.5);
  });

  it('parses tiered pricing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('google', 'gemini-2.5-pro');

    expect(pricing?.tiers).toEqual([
      {
        tier: { type: 'context', size: 200000 },
        input: 2.5,
        output: 15,
        cache: { read: 0.625, write: 0 },
      },
    ]);
  });

  it('falls back to hardcoded pricing when fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toBeDefined();
    expect(pricing?.input).toBeGreaterThan(0);
  });

  it('falls back to hardcoded pricing when fetch returns non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/ModelsDevPricingSource.test.ts`
Expected: FAIL — `ModelsDevPricingSource` does not exist yet.

- [ ] **Step 3: Implement `ModelsDevPricingSource`**

Create `packages/core/src/providers/ModelsDevPricingSource.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelPricing, PricingSource } from './PricingSource.js';

const MODELS_DEV_URL = 'https://models.dev/api/v1/models.json';
const CACHE_FILENAME = 'models-dev.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  tiers?: Array<{
    tier: { type: 'context'; size: number };
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  }>;
}

interface ModelsDevModel {
  id: string;
  name?: string;
  cost?: ModelsDevCost;
}

interface ModelsDevResponse {
  models?: Record<string, ModelsDevModel>;
}

interface CachedData {
  fetchedAt: number;
  data: ModelsDevResponse;
}

const HARDCODED_FALLBACK: Record<string, ModelPricing> = {
  'gpt-4o': { input: 2.5, output: 10, cache: { read: 1.25, write: 2.5 } },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cache: { read: 0.075, write: 0.15 } },
  'gpt-4-turbo': { input: 10, output: 30, cache: { read: 5, write: 10 } },
  o1: { input: 15, output: 60, cache: { read: 7.5, write: 15 } },
  'o1-mini': { input: 1.1, output: 4.4, cache: { read: 0.55, write: 1.1 } },
  'claude-opus-4-5': { input: 15, output: 75, cache: { read: 1.5, write: 18.75 } },
  'claude-sonnet-4-5': { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  'claude-haiku-4-5': { input: 0.8, output: 4, cache: { read: 0.08, write: 1 } },
  'gemini-2.5-pro': {
    input: 1.25,
    output: 10,
    cache: { read: 0.3125, write: 0 },
    tiers: [
      {
        tier: { type: 'context', size: 200000 },
        input: 2.5,
        output: 15,
        cache: { read: 0.625, write: 0 },
      },
    ],
  },
  'gemini-2.5-flash': { input: 0.075, output: 0.3, cache: { read: 0.01875, write: 0 } },
};

function normalizeModelId(modelId: string): string {
  return modelId.replace(/^(us|eu|global)\./i, '').toLowerCase();
}

function mapCost(cost: ModelsDevCost | undefined): ModelPricing | undefined {
  if (!cost) return undefined;
  const result: ModelPricing = {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cache: {
      read: cost.cache_read ?? 0,
      write: cost.cache_write ?? 0,
    },
  };
  if (cost.tiers) {
    result.tiers = cost.tiers.map((t) => ({
      tier: t.tier,
      input: t.input,
      output: t.output,
      cache: { read: t.cache_read ?? 0, write: t.cache_write ?? 0 },
    }));
  }
  if (cost.context_over_200k) {
    result.tiers = [
      ...(result.tiers ?? []),
      {
        tier: { type: 'context', size: 200000 },
        input: cost.context_over_200k.input,
        output: cost.context_over_200k.output,
        cache: {
          read: cost.context_over_200k.cache_read ?? 0,
          write: cost.context_over_200k.cache_write ?? 0,
        },
      },
    ];
  }
  return result;
}

export class ModelsDevPricingSource implements PricingSource {
  private cached: CachedData | null = null;

  constructor(private cacheDir: string) {}

  async resolve(providerId: string, modelId: string): Promise<ModelPricing | undefined> {
    const normalized = normalizeModelId(modelId);
    const data = await this.getData();
    if (data) {
      const model = data.models?.[normalized] ?? data.models?.[modelId];
      if (model) {
        const pricing = mapCost(model.cost);
        if (pricing) return pricing;
      }
    }
    return HARDCODED_FALLBACK[normalized];
  }

  async refresh(): Promise<void> {
    this.cached = null;
    await this.fetchAndCache();
  }

  private async getData(): Promise<ModelsDevResponse | null> {
    if (this.cached) return this.cached.data;

    const cachePath = join(this.cacheDir, CACHE_FILENAME);
    if (existsSync(cachePath)) {
      try {
        const raw = readFileSync(cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as CachedData;
        if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) {
          this.cached = parsed;
          return parsed.data;
        }
      } catch {
        // Corrupt cache — fall through to refetch.
      }
    }

    return this.fetchAndCache();
  }

  private async fetchAndCache(): Promise<ModelsDevResponse | null> {
    try {
      const res = await fetch(MODELS_DEV_URL);
      if (!res.ok) return null;
      const data = (await res.json()) as ModelsDevResponse;
      this.cached = { fetchedAt: Date.now(), data };
      try {
        mkdirSync(this.cacheDir, { recursive: true });
        writeFileSync(join(this.cacheDir, CACHE_FILENAME), JSON.stringify(this.cached));
      } catch {
        // Cache write failed (permissions, disk full) — non-fatal.
      }
      return data;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/ModelsDevPricingSource.test.ts`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers/ModelsDevPricingSource.ts packages/core/src/providers/ModelsDevPricingSource.test.ts
git commit -m "feat(core): add ModelsDevPricingSource with 24h cache and fallback

Fetches models.dev/api/v1/models.json, caches to <workspace>/.legion/cache/,
24h TTL. Hardcoded fallback for top 10 models when fetch fails. Strips
us./eu./global. prefixes, case-insensitive matching."
```

---

## Task 7: Create `UsageCalculator`

**Files:**

- Create: `packages/core/src/providers/UsageCalculator.ts`
- Create: `packages/core/src/providers/UsageCalculator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/providers/UsageCalculator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { UsageCalculator } from './UsageCalculator.js';
import type { PricingSource, ModelPricing } from './PricingSource.js';
import type { Provider } from './Provider.js';
import type { ProviderUsage } from './Provider.js';

class MockPricingSource implements PricingSource {
  constructor(private pricing: Record<string, ModelPricing>) {}
  async resolve(_providerId: string, modelId: string): Promise<ModelPricing | undefined> {
    return this.pricing[modelId];
  }
}

const GPT_4O_PRICING: ModelPricing = {
  input: 2.5,
  output: 10,
  cache: { read: 1.25, write: 2.5 },
};

const TIERED_PRICING: ModelPricing = {
  input: 1.25,
  output: 10,
  cache: { read: 0.3125, write: 0 },
  tiers: [
    {
      tier: { type: 'context', size: 200000 },
      input: 2.5,
      output: 15,
      cache: { read: 0.625, write: 0 },
    },
  ],
};

describe('UsageCalculator', () => {
  it('subtracts cache read and cache write from input tokens', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 2006,
      outputTokens: 300,
      cacheReadInputTokens: 1920,
      cacheWriteInputTokens: 50,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    expect(usage.input).toBe(36); // 2006 - 1920 - 50
    expect(usage.cache.read).toBe(1920);
    expect(usage.cache.write).toBe(50);
  });

  it('subtracts reasoning tokens from output tokens', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 300,
      reasoningTokens: 50,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    expect(usage.output).toBe(250); // 300 - 50
    expect(usage.reasoning).toBe(50);
  });

  it('computes cost as sum of (tokens * rate / 1M) for each bucket', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 2006,
      outputTokens: 300,
      cacheReadInputTokens: 1920,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    // input: 86 tokens (2006 - 1920) * 2.5 / 1e6 = 0.000215
    // output: 300 * 10 / 1e6 = 0.003
    // cache.read: 1920 * 1.25 / 1e6 = 0.0024
    // total = 0.005615
    expect(usage.cost).toBeCloseTo(0.005615, 6);
  });

  it('charges reasoning tokens at output rate', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 300,
      reasoningTokens: 100,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    // input: 100 * 2.5 / 1e6 = 0.00025
    // output: 200 * 10 / 1e6 = 0.002
    // reasoning: 100 * 10 / 1e6 = 0.001
    // total = 0.00325
    expect(usage.cost).toBeCloseTo(0.00325, 6);
  });

  it('selects tiered pricing when context exceeds tier size', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gemini-2.5-pro': TIERED_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 250000,
      outputTokens: 1000,
    };
    const usage = await calc.compute('google', 'gemini-2.5-pro', raw);

    // Uses tier (>200K): input 2.5, output 15
    // input: 250000 * 2.5 / 1e6 = 0.625
    // output: 1000 * 15 / 1e6 = 0.015
    // total = 0.64
    expect(usage.cost).toBeCloseTo(0.64, 6);
  });

  it('uses base pricing when context is below tier size', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gemini-2.5-pro': TIERED_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100000,
      outputTokens: 1000,
    };
    const usage = await calc.compute('google', 'gemini-2.5-pro', raw);

    // Base: input 1.25, output 10
    // input: 100000 * 1.25 / 1e6 = 0.125
    // output: 1000 * 10 / 1e6 = 0.01
    // total = 0.135
    expect(usage.cost).toBeCloseTo(0.135, 6);
  });

  it('uses provider cost override when provided', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 100,
    };
    const usage = await calc.compute('copilot', 'gpt-4o', raw, 0.42);

    expect(usage.cost).toBe(0.42);
  });

  it('treats undefined optional fields as 0', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 50,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
    expect(usage.reasoning).toBe(0);
    expect(usage.cache.read).toBe(0);
    expect(usage.cache.write).toBe(0);
  });

  it('returns cost 0 when pricing is unknown', async () => {
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 50,
    };
    const usage = await calc.compute('unknown', 'nonexistent', raw);

    expect(usage.cost).toBe(0);
  });

  it('clamps input to non-negative when cache exceeds input', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 50,
      outputTokens: 10,
      cacheReadInputTokens: 100,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    expect(usage.input).toBe(0); // Math.max(0, 50 - 100)
  });

  it('uses provider.pricingSource() override when provider is registered', async () => {
    const customPricing: ModelPricing = { input: 0, output: 0, cache: { read: 0, write: 0 } };
    const customSource = new MockPricingSource({ 'custom-model': customPricing });
    const provider: Provider = {
      async complete() {
        return { content: '', toolCalls: [], stopReason: 'stop' };
      },
      pricingSource() {
        return customSource;
      },
    };
    const calc = new UsageCalculator(new MockPricingSource({}), new Map([['custom', provider]]));
    const raw: ProviderUsage = { inputTokens: 100, outputTokens: 50 };
    const usage = await calc.compute('custom', 'custom-model', raw);

    expect(usage.cost).toBe(0); // Custom pricing has all-zero rates
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/UsageCalculator.test.ts`
Expected: FAIL — `UsageCalculator` does not exist.

- [ ] **Step 3: Implement `UsageCalculator`**

Create `packages/core/src/providers/UsageCalculator.ts`:

```typescript
import Decimal from 'decimal.js';
import type { MessageUsage } from '@legion-collective/types';
import type { ProviderUsage } from './Provider.js';
import type { Provider } from './Provider.js';
import type { ModelPricing, PricingSource } from './PricingSource.js';

export type ProviderLookup = (providerId: string) => Provider | undefined;

export class UsageCalculator {
  constructor(
    private defaultPricingSource: PricingSource,
    private providers: ProviderLookup | Map<string, Provider>,
  ) {}

  async compute(
    providerId: string,
    modelId: string,
    raw: ProviderUsage,
    providerCostOverride?: number,
  ): Promise<MessageUsage> {
    const cacheRead = raw.cacheReadInputTokens ?? 0;
    const cacheWrite = raw.cacheWriteInputTokens ?? 0;
    const input = Math.max(0, raw.inputTokens - cacheRead - cacheWrite);
    const reasoning = raw.reasoningTokens ?? 0;
    const output = Math.max(0, raw.outputTokens - reasoning);

    const cost =
      providerCostOverride !== undefined
        ? providerCostOverride
        : await this.computeCost(providerId, modelId, raw.inputTokens, {
            input,
            output,
            reasoning,
            cacheRead,
            cacheWrite,
          });

    return {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
      cost,
      modelId,
      providerId,
    };
  }

  private async computeCost(
    providerId: string,
    modelId: string,
    contextTokens: number,
    buckets: {
      input: number;
      output: number;
      reasoning: number;
      cacheRead: number;
      cacheWrite: number;
    },
  ): Promise<number> {
    const pricing = await this.resolvePricing(providerId, modelId);
    if (!pricing) return 0;

    const tieredPricing =
      pricing.tiers
        ?.filter((t) => t.tier.type === 'context' && contextTokens > t.tier.size)
        .sort((a, b) => b.tier.size - a.tier.size)[0] ?? pricing;

    const cost = new Decimal(0)
      .add(new Decimal(buckets.input).mul(tieredPricing.input).div(1_000_000))
      .add(new Decimal(buckets.output).mul(tieredPricing.output).div(1_000_000))
      .add(new Decimal(buckets.cacheRead).mul(tieredPricing.cache.read).div(1_000_000))
      .add(new Decimal(buckets.cacheWrite).mul(tieredPricing.cache.write).div(1_000_000))
      .add(new Decimal(buckets.reasoning).mul(tieredPricing.output).div(1_000_000))
      .toNumber();

    return cost;
  }

  private async resolvePricing(
    providerId: string,
    modelId: string,
  ): Promise<ModelPricing | undefined> {
    const provider = this.lookupProvider(providerId);
    if (provider?.pricingSource) {
      const pricing = await provider.pricingSource().resolve(providerId, modelId);
      if (pricing) return pricing;
    }
    return this.defaultPricingSource.resolve(providerId, modelId);
  }

  private lookupProvider(providerId: string): Provider | undefined {
    if (this.providers instanceof Map) {
      return this.providers.get(providerId);
    }
    return this.providers(providerId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/UsageCalculator.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers/UsageCalculator.ts packages/core/src/providers/UsageCalculator.test.ts
git commit -m "feat(core): add UsageCalculator for normalization and cost math

Subtracts cache tokens from input (AI-SDK-v6 footgun), subtracts reasoning
from output. Tiered pricing for long-context models. Provider cost override
(Copilot pattern). decimal.js for float-safe arithmetic."
```

---

## Task 8: Add `usage` to `NewMessageInput` and wire `UsageCalculator` into `AgentRuntime`

**Files:**

- Modify: `packages/core/src/conversation/conversation-ops.ts`
- Modify: `packages/core/src/runtime/AgentRuntime.ts`
- Modify: `packages/core/src/runtime/AgentRuntime.test.ts`

- [ ] **Step 1: Add `usage` to `NewMessageInput` in `packages/core/src/conversation/conversation-ops.ts`**

Find line 18:

```typescript
export type NewMessageInput = Pick<MessageData, 'senderId' | 'recipientId' | 'role' | 'content'> &
  Partial<Pick<MessageData, 'replyTo' | 'type' | 'toolCalls' | 'toolResults' | 'parentId' | 'id'>>;
```

Replace with:

```typescript
export type NewMessageInput = Pick<MessageData, 'senderId' | 'recipientId' | 'role' | 'content'> &
  Partial<
    Pick<
      MessageData,
      'replyTo' | 'type' | 'toolCalls' | 'toolResults' | 'parentId' | 'id' | 'usage'
    >
  >;
```

- [ ] **Step 2: Write the failing test for usage capture in `AgentRuntime.test.ts`**

In `packages/core/src/runtime/AgentRuntime.test.ts`, add a new test inside `describe('AgentRuntime', ...)`:

```typescript
it('attaches usage from ProviderResponse to the persisted assistant message', async () => {
  const { context, inbound, router } = await makeSetup([
    {
      content: 'I used some tokens',
      toolCalls: [],
      stopReason: 'stop',
      usage: {
        inputTokens: 2006,
        outputTokens: 300,
        reasoningTokens: 50,
        cacheReadInputTokens: 1920,
      },
      cost: 0.005615,
    },
  ]);
  const calc = new UsageCalculator(
    new MockPricingSource({
      'test-model': { input: 2.5, output: 10, cache: { read: 1.25, write: 2.5 } },
    }),
    new Map(),
  );
  const runtime = new AgentRuntime('agent-1', router, calc);
  await runtime.handle(inbound, context);

  const chain = context.conversation.activeChain;
  const assistantMsg = chain.find((m) => m.role === 'assistant');
  expect(assistantMsg?.usage).toEqual({
    input: 36,
    output: 250,
    reasoning: 50,
    cache: { read: 1920, write: 0 },
    cost: 0.005615, // provider cost override used directly
    modelId: 'test-model',
    providerId: 'unknown',
  });
});

it('computes usage via calculator when ProviderResponse has no cost override', async () => {
  const { context, inbound, router } = await makeSetup([
    {
      content: 'no cost override',
      toolCalls: [],
      stopReason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
      },
    },
  ]);
  const calc = new UsageCalculator(
    new MockPricingSource({
      'test-model': { input: 2.5, output: 10, cache: { read: 1.25, write: 2.5 } },
    }),
    new Map(),
  );
  const runtime = new AgentRuntime('agent-1', router, calc);
  await runtime.handle(inbound, context);

  const chain = context.conversation.activeChain;
  const assistantMsg = chain.find((m) => m.role === 'assistant');
  expect(assistantMsg?.usage).toBeDefined();
  expect(assistantMsg?.usage?.input).toBe(100);
  expect(assistantMsg?.usage?.output).toBe(50);
  expect(assistantMsg?.usage?.cost).toBeCloseTo(0.00075, 6); // 100*2.5/1e6 + 50*10/1e6
});

it('persists assistant message without usage when ProviderResponse omits usage', async () => {
  const { context, inbound, router } = await makeSetup([
    { content: 'no usage', toolCalls: [], stopReason: 'stop' },
  ]);
  const calc = new UsageCalculator(new MockPricingSource({}), new Map());
  const runtime = new AgentRuntime('agent-1', router, calc);
  await runtime.handle(inbound, context);

  const chain = context.conversation.activeChain;
  const assistantMsg = chain.find((m) => m.role === 'assistant');
  expect(assistantMsg?.usage).toBeUndefined();
});
```

Also add these imports at the top of the test file:

```typescript
import { UsageCalculator } from '../providers/UsageCalculator.js';
import type { ModelPricing, PricingSource } from '../providers/PricingSource.js';

class MockPricingSource implements PricingSource {
  constructor(private pricing: Record<string, ModelPricing>) {}
  async resolve(_providerId: string, modelId: string): Promise<ModelPricing | undefined> {
    return this.pricing[modelId];
  }
}
```

- [ ] **Step 3: Update existing tests to pass `UsageCalculator` to `AgentRuntime`**

Every `new AgentRuntime('agent-1', router)` call must become `new AgentRuntime('agent-1', router, calc)`. There are 7 such calls in the file. For each, add before the call (or reuse an existing `calc` variable):

```typescript
const calc = new UsageCalculator(new MockPricingSource({}), new Map());
```

And change the constructor call:

```typescript
const runtime = new AgentRuntime('agent-1', router, calc);
```

- [ ] **Step 4: Run tests to verify the new ones fail**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`
Expected: FAIL — `AgentRuntime` constructor does not accept a third argument; TypeScript error.

- [ ] **Step 5: Update `AgentRuntime` constructor and capture usage**

In `packages/core/src/runtime/AgentRuntime.ts`:

Add import at top:

```typescript
import type { UsageCalculator } from '../providers/UsageCalculator.js';
```

Update constructor (lines 46-49):

```typescript
  constructor(
    private participantId: string,
    private router: ModelRouter,
    private usageCalculator?: UsageCalculator,
  ) {}
```

Update the final-response return path (line 125-127). Find:

```typescript
if (response.stopReason !== 'tool_calls' || response.toolCalls.length === 0) {
  return { kind: 'response', content: response.content ?? '' };
}
```

Replace with:

```typescript
if (response.stopReason !== 'tool_calls' || response.toolCalls.length === 0) {
  const usage = await this.computeUsage(agent, response);
  if (usage) {
    await context.conversation.append({
      senderId: this.participantId,
      recipientId: this.participantId,
      role: 'assistant',
      content: response.content ?? '',
      usage,
    });
  }
  return { kind: 'response', content: response.content ?? '' };
}
```

Update the tool-call turn persistence (lines 202-210). Find:

```typescript
await context.conversation.append({
  senderId: this.participantId,
  recipientId: this.participantId,
  role: 'assistant',
  content: response.content ?? '',
  toolCalls: toolCallData,
  toolResults,
});
```

Replace with:

```typescript
const usage = await this.computeUsage(agent, response);
await context.conversation.append({
  senderId: this.participantId,
  recipientId: this.participantId,
  role: 'assistant',
  content: response.content ?? '',
  toolCalls: toolCallData,
  toolResults,
  usage,
});
```

Add the `computeUsage` private method at the end of the class (before the closing `}`):

```typescript
  private async computeUsage(
    agent: AgentConfig,
    response: ProviderResponse,
  ): Promise<MessageUsage | undefined> {
    if (!response.usage || !this.usageCalculator) return undefined;
    return this.usageCalculator.compute(
      'unknown',
      agent.model.model,
      response.usage,
      response.cost,
    );
  }
```

Add the necessary imports at the top of the file:

```typescript
import type { MessageUsage } from '@legion-collective/types';
import type { ProviderResponse } from '../providers/Provider.js';
```

**Note on `providerId`:** The `AgentRuntime` does not currently know which provider served the request — `ModelRouter.resolve()` returns a `Provider` instance but not its ID. For now, `'unknown'` is used. A follow-up can have `ModelRouter.resolve()` return `{ provider, providerId }` to populate this correctly. The `modelId` is correctly sourced from `agent.model.model`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`
Expected: PASS — all tests green, including the three new usage tests.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/conversation/conversation-ops.ts packages/core/src/runtime/AgentRuntime.ts packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "feat(core): capture usage on assistant messages in AgentRuntime

UsageCalculator injected into AgentRuntime. Computes MessageUsage from
ProviderResponse.usage after each provider call. Attaches to persisted
assistant message. providerId is 'unknown' for now — ModelRouter.resolve
return shape change is a follow-up."
```

---

## Task 9: Create `usage-types.ts` and `UsageQuery`

**Files:**

- Create: `packages/core/src/usage/usage-types.ts`
- Create: `packages/core/src/usage/UsageQuery.ts`
- Create: `packages/core/src/usage/UsageQuery.test.ts`

- [ ] **Step 1: Create `packages/core/src/usage/usage-types.ts`**

```typescript
import type { MessageUsage } from '@legion-collective/types';

export type GroupBy = 'model' | 'participant' | 'conversation' | 'day';

export interface UsageFilter {
  conversationId?: string;
  participantId?: string;
  modelId?: string;
  providerId?: string;
  since?: string;
  until?: string;
}

export interface MessageUsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
  cost: number;
  messageCount: number;
}

export interface UsageGroup {
  key: string;
  totals: MessageUsageTotals;
  messageCount: number;
}

export interface UsageReport {
  totals: MessageUsageTotals;
  groups?: UsageGroup[];
}

export const EMPTY_TOTALS: MessageUsageTotals = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  cost: 0,
  messageCount: 0,
};

export function addUsageToTotals(
  totals: MessageUsageTotals,
  usage: MessageUsage,
): MessageUsageTotals {
  return {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    reasoning: totals.reasoning + usage.reasoning,
    cache: {
      read: totals.cache.read + usage.cache.read,
      write: totals.cache.write + usage.cache.write,
    },
    cost: totals.cost + usage.cost,
    messageCount: totals.messageCount + 1,
  };
}
```

- [ ] **Step 2: Write the failing tests for `UsageQuery`**

Create `packages/core/src/usage/UsageQuery.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import { UsageQuery } from './UsageQuery.js';
import type { MessageUsage } from '@legion-collective/types';

const USAGE_GPT4O: MessageUsage = {
  input: 100,
  output: 50,
  reasoning: 0,
  cache: { read: 200, write: 10 },
  cost: 0.001,
  modelId: 'gpt-4o',
  providerId: 'openai',
};

const USAGE_CLAUDE: MessageUsage = {
  input: 200,
  output: 100,
  reasoning: 30,
  cache: { read: 50, write: 0 },
  cost: 0.005,
  modelId: 'claude-sonnet-4-5',
  providerId: 'anthropic',
};

async function makeConversation(
  store: FileConversationStore,
  participants: [string, string],
  usages: MessageUsage[],
  timestamps?: string[],
): Promise<string> {
  const conv = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  const thread = new ConversationThread(conv, store);
  await thread.append({
    senderId: participants[0],
    recipientId: participants[1],
    role: 'user',
    content: 'hello',
  });
  for (let i = 0; i < usages.length; i++) {
    const ts = timestamps?.[i];
    const msg = await thread.append({
      senderId: participants[1],
      recipientId: participants[0],
      role: 'assistant',
      content: `response ${i}`,
      usage: usages[i],
    });
    if (ts) {
      await store.updateMessage(conv.id, msg.id, { timestamp: ts });
    }
  }
  return conv.id;
}

describe('UsageQuery', () => {
  it('returns zero totals for an empty conversation store', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const query = new UsageQuery(store);

    const report = await query.query({});
    expect(report.totals.messageCount).toBe(0);
    expect(report.totals.cost).toBe(0);
  });

  it('sums usage across all messages in all conversations', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({});

    expect(report.totals.messageCount).toBe(2);
    expect(report.totals.input).toBe(300);
    expect(report.totals.output).toBe(150);
    expect(report.totals.reasoning).toBe(30);
    expect(report.totals.cache.read).toBe(250);
    expect(report.totals.cost).toBeCloseTo(0.006, 6);
  });

  it('filters by conversationId', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const id1 = await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ conversationId: id1 });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.cost).toBeCloseTo(0.001, 6);
  });

  it('filters by participantId', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ participantId: 'agent-1' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.cost).toBeCloseTo(0.001, 6);
  });

  it('filters by modelId', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O, USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ modelId: 'claude-sonnet-4-5' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(200);
  });

  it('filters by providerId', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O, USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ providerId: 'openai' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(100);
  });

  it('filters by since timestamp', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(
      store,
      ['user-1', 'agent-1'],
      [USAGE_GPT4O, USAGE_CLAUDE],
      ['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'],
    );

    const query = new UsageQuery(store);
    const report = await query.query({ since: '2026-03-01T00:00:00.000Z' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(200); // CLAUDE
  });

  it('filters by until timestamp', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(
      store,
      ['user-1', 'agent-1'],
      [USAGE_GPT4O, USAGE_CLAUDE],
      ['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'],
    );

    const query = new UsageQuery(store);
    const report = await query.query({ until: '2026-03-01T00:00:00.000Z' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(100); // GPT4O
  });

  it('groups by model', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O, USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ groupBy: 'model' });

    expect(report.groups).toHaveLength(2);
    const gptGroup = report.groups!.find((g) => g.key === 'gpt-4o');
    expect(gptGroup?.totals.input).toBe(100);
    const claudeGroup = report.groups!.find((g) => g.key === 'claude-sonnet-4-5');
    expect(claudeGroup?.totals.input).toBe(200);
  });

  it('groups by participant', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ groupBy: 'participant' });

    expect(report.groups).toHaveLength(2);
    const agent1Group = report.groups!.find((g) => g.key === 'agent-1');
    expect(agent1Group?.totals.cost).toBeCloseTo(0.001, 6);
  });

  it('groups by conversation', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const id1 = await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ groupBy: 'conversation' });

    expect(report.groups).toHaveLength(2);
    const conv1Group = report.groups!.find((g) => g.key === id1);
    expect(conv1Group?.totals.cost).toBeCloseTo(0.001, 6);
  });

  it('groups by day (UTC, YYYY-MM-DD)', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(
      store,
      ['user-1', 'agent-1'],
      [USAGE_GPT4O, USAGE_CLAUDE],
      ['2026-01-15T10:00:00.000Z', '2026-01-16T22:00:00.000Z'],
    );

    const query = new UsageQuery(store);
    const report = await query.query({ groupBy: 'day' });

    expect(report.groups).toHaveLength(2);
    const day1 = report.groups!.find((g) => g.key === '2026-01-15');
    expect(day1?.totals.input).toBe(100);
    const day2 = report.groups!.find((g) => g.key === '2026-01-16');
    expect(day2?.totals.input).toBe(200);
  });

  it('skips superseded and pruned messages', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const conv = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const thread = new ConversationThread(conv, store);
    await thread.append({
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
    });
    const msg1 = await thread.append({
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'first',
      usage: USAGE_GPT4O,
    });
    // Manually mark the first assistant message as superseded
    await store.updateMessage(conv.id, msg1.id, { status: 'superseded' });
    await thread.append({
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'second',
      usage: USAGE_CLAUDE,
    });

    const query = new UsageQuery(store);
    const report = await query.query({});

    expect(report.totals.messageCount).toBe(1); // Only the non-superseded one
    expect(report.totals.input).toBe(200); // CLAUDE
  });

  it('includes compacted messages', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const conv = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const thread = new ConversationThread(conv, store);
    await thread.append({
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
    });
    const msg = await thread.append({
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'compacted',
      usage: USAGE_GPT4O,
    });
    await store.updateMessage(conv.id, msg.id, { status: 'compacted' });

    const query = new UsageQuery(store);
    const report = await query.query({});

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(100);
  });

  it('ignores messages without usage', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const conv = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const thread = new ConversationThread(conv, store);
    await thread.append({
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
    });
    await thread.append({
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'no usage',
    });
    await thread.append({
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'with usage',
      usage: USAGE_GPT4O,
    });

    const query = new UsageQuery(store);
    const report = await query.query({});

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(100);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/usage/UsageQuery.test.ts`
Expected: FAIL — `UsageQuery` does not exist.

- [ ] **Step 4: Implement `UsageQuery`**

Create `packages/core/src/usage/UsageQuery.ts`:

```typescript
import type { ConversationStore, ConversationData, MessageData } from '@legion-collective/types';
import { getActiveChain } from '../conversation/conversation-ops.js';
import {
  type GroupBy,
  type UsageFilter,
  type UsageReport,
  type MessageUsageTotals,
  type UsageGroup,
  EMPTY_TOTALS,
  addUsageToTotals,
} from './usage-types.js';

export class UsageQuery {
  constructor(private conversationStore: ConversationStore) {}

  async query(filter: UsageFilter, groupBy?: GroupBy): Promise<UsageReport> {
    let totals: MessageUsageTotals = { ...EMPTY_TOTALS, cache: { read: 0, write: 0 } };
    const groupMap = new Map<string, MessageUsageTotals>();

    const conversations = await this.getConversations(filter);

    for (const conv of conversations) {
      const chain = getActiveChain(conv);
      for (const msg of chain) {
        if (!msg.usage) continue;
        if (msg.status === 'superseded' || msg.status === 'pruned') continue;
        if (!this.matchesFilter(msg, filter)) continue;

        totals = addUsageToTotals(totals, msg.usage);

        if (groupBy) {
          const key = this.groupKey(msg, groupBy, conv);
          const existing = groupMap.get(key) ?? { ...EMPTY_TOTALS, cache: { read: 0, write: 0 } };
          groupMap.set(key, addUsageToTotals(existing, msg.usage));
        }
      }
    }

    let groups: UsageGroup[] | undefined;
    if (groupBy) {
      groups = Array.from(groupMap.entries())
        .map(([key, gTotals]) => ({ key, totals: gTotals, messageCount: gTotals.messageCount }))
        .sort((a, b) => b.totals.cost - a.totals.cost);
    }

    return { totals, groups };
  }

  private async getConversations(filter: UsageFilter): Promise<ConversationData[]> {
    if (filter.conversationId) {
      const conv = await this.conversationStore.load(filter.conversationId);
      return conv ? [conv] : [];
    }
    const metas = await this.conversationStore.list({
      participantId: filter.participantId,
      since: filter.since,
    });
    const conversations: ConversationData[] = [];
    for (const meta of metas) {
      const conv = await this.conversationStore.load(meta.id);
      if (conv) conversations.push(conv);
    }
    return conversations;
  }

  private matchesFilter(msg: MessageData, filter: UsageFilter): boolean {
    if (msg.role !== 'assistant') return false;
    if (filter.modelId && msg.usage?.modelId !== filter.modelId) return false;
    if (filter.providerId && msg.usage?.providerId !== filter.providerId) return false;
    if (filter.since && msg.timestamp < filter.since) return false;
    if (filter.until && msg.timestamp > filter.until) return false;
    return true;
  }

  private groupKey(msg: MessageData, groupBy: GroupBy, conv: ConversationData): string {
    switch (groupBy) {
      case 'model':
        return msg.usage?.modelId ?? 'unknown';
      case 'participant':
        return msg.senderId;
      case 'conversation':
        return conv.id;
      case 'day':
        return msg.timestamp.slice(0, 10); // YYYY-MM-DD (UTC, ISO 8601)
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/usage/UsageQuery.test.ts`
Expected: PASS — all 14 tests green.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/usage/usage-types.ts packages/core/src/usage/UsageQuery.ts packages/core/src/usage/UsageQuery.test.ts
git commit -m "feat(core): add UsageQuery for aggregate usage reporting

Walks conversation tree, sums MessageUsage per filter (conversationId,
participantId, modelId, providerId, since, until). Groups by model,
participant, conversation, or day. Skips superseded/pruned, includes
compacted. Day key is UTC YYYY-MM-DD."
```

---

## Task 10: Add `query_usage` and `list_models` tools

**Files:**

- Modify: `packages/core/src/tools/management-tools.ts`
- Modify: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Write the failing tests for `query_usage`**

In `packages/core/src/tools/management-tools.test.ts`, add imports and tests:

```typescript
import { queryUsageTool, listModelsTool } from './management-tools.js';
import type { MessageUsage } from '@legion-collective/types';
```

Add a new describe block at the end of the file:

```typescript
describe('query_usage tool', () => {
  it('returns zero totals when no conversations exist', async () => {
    const context = await makeContext();
    const result = await queryUsageTool.execute({}, context);
    expect(result).toEqual({
      status: 'success',
      data: {
        totals: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          cost: 0,
          messageCount: 0,
        },
      },
    });
  });

  it('sums usage across conversations', async () => {
    const context = await makeContext();
    const usage: MessageUsage = {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      cost: 0.001,
      modelId: 'gpt-4o',
      providerId: 'openai',
    };
    const conv = await context.conversationStore!.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-1',
      parentId: null,
      conversationId: conv.id,
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-2',
      parentId: 'msg-1',
      conversationId: conv.id,
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'hello',
      status: 'active',
      timestamp: new Date().toISOString(),
      usage,
    });

    const result = await queryUsageTool.execute({}, context);
    expect(result.status).toBe('success');
    const data = (result as { data: { totals: { messageCount: number; input: number } } }).data;
    expect(data.totals.messageCount).toBe(1);
    expect(data.totals.input).toBe(100);
  });

  it('groups by model', async () => {
    const context = await makeContext();
    const usage1: MessageUsage = {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      cost: 0.001,
      modelId: 'gpt-4o',
      providerId: 'openai',
    };
    const usage2: MessageUsage = {
      input: 200,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      cost: 0.005,
      modelId: 'claude-sonnet-4-5',
      providerId: 'anthropic',
    };
    const conv = await context.conversationStore!.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-1',
      parentId: null,
      conversationId: conv.id,
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-2',
      parentId: 'msg-1',
      conversationId: conv.id,
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'r1',
      status: 'active',
      timestamp: new Date().toISOString(),
      usage: usage1,
    });
    await context.conversationStore!.updateMessage(conv.id, 'msg-2', {
      status: 'superseded',
    });
    await context.conversationStore!.updateHead(conv.id, 'msg-1');
    await context.conversationStore!.appendMessage(conv.id, {
      id: 'msg-3',
      parentId: 'msg-1',
      conversationId: conv.id,
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'r2',
      status: 'active',
      timestamp: new Date().toISOString(),
      usage: usage2,
    });

    const result = await queryUsageTool.execute({ groupBy: 'model' }, context);
    expect(result.status).toBe('success');
    const data = (result as { data: { groups: Array<{ key: string; totals: { input: number } }> } })
      .data;
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].key).toBe('claude-sonnet-4-5');
  });
});

describe('list_models tool', () => {
  it('returns an empty array when no providers are available', async () => {
    const context = await makeContext();
    const result = await listModelsTool.execute({}, context);
    expect(result.status).toBe('success');
    expect((result as { data: unknown }).data).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: FAIL — `queryUsageTool` and `listModelsTool` are not exported.

- [ ] **Step 3: Add the `query_usage` and `list_models` tools to `management-tools.ts`**

In `packages/core/src/tools/management-tools.ts`, add imports at the top:

```typescript
import { UsageQuery } from '../usage/UsageQuery.js';
import type { GroupBy, UsageFilter } from '../usage/usage-types.js';
```

Add the two tools before `export const managementTools: Tool[] = [...]` (before line 390):

```typescript
export const queryUsageTool: Tool = {
  name: 'query_usage',
  description: 'Query token usage and cost across conversations. Returns aggregated totals.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'Scope to one conversation.' },
      participantId: {
        type: 'string',
        description: 'Scope to conversations involving this participant.',
      },
      modelId: { type: 'string', description: 'Filter to a specific model.' },
      providerId: { type: 'string', description: 'Filter to a specific provider.' },
      since: { type: 'string', description: 'ISO 8601 — only messages after this time.' },
      until: { type: 'string', description: 'ISO 8601 — only messages before this time.' },
      groupBy: {
        type: 'string',
        enum: ['model', 'participant', 'conversation', 'day'],
        description: 'Group results by this dimension. Default: totals only.',
      },
    },
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    try {
      const filter: UsageFilter = {
        conversationId: (args as { conversationId?: string }).conversationId,
        participantId: (args as { participantId?: string }).participantId,
        modelId: (args as { modelId?: string }).modelId,
        providerId: (args as { providerId?: string }).providerId,
        since: (args as { since?: string }).since,
        until: (args as { until?: string }).until,
      };
      const groupBy = (args as { groupBy?: GroupBy }).groupBy;
      const query = new UsageQuery(context.conversationStore);
      const report = await query.query(filter, groupBy);
      return { status: 'success', data: report };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const listModelsTool: Tool = {
  name: 'list_models',
  description: 'List available models with their current pricing rates.',
  parameters: { type: 'object', properties: {}, required: [] } as JSONSchema,
  async execute(_args, context: ToolContext): Promise<ToolResult> {
    try {
      const collective = requireCollective(context);
      const providers = collective.list().filter((p) => p.type === 'provider');
      const models: Array<{ id: string; providerId: string; name?: string }> = [];
      for (const p of providers) {
        if (p.id) {
          models.push({ id: p.id, providerId: p.id, name: p.name });
        }
      }
      return { status: 'success', data: models };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

Add both tools to the `managementTools` array:

```typescript
export const managementTools: Tool[] = [
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  setToolPolicyTool,
  removeToolPolicyTool,
  getConversationTool,
  setCredentialTool,
  modifyAgentTool,
  listToolsTool,
  listConversationsTool,
  deleteConversationTool,
  queryUsageTool,
  listModelsTool,
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts
git commit -m "feat(core): add query_usage and list_models tools

query_usage: aggregate token/cost query with filters (conversationId,
participantId, modelId, providerId, since, until) and groupBy (model,
participant, conversation, day). list_models: stub returning registered
providers — pricing integration follows when Provider.pricingSource is
wired at runtime construction."
```

---

## Task 11: Export new modules from `@legion-collective/core`

**Files:**

- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add exports to `packages/core/src/index.ts`**

Add these lines at the end of the file:

```typescript
export * from './providers/PricingSource.js';
export * from './providers/ModelsDevPricingSource.js';
export * from './providers/UsageCalculator.js';
export * from './usage/UsageQuery.js';
export * from './usage/usage-types.js';
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export pricing, usage calculator, and query modules"
```

---

## Task 12: Expand mock provider usage in E2E

**Files:**

- Modify: `packages/e2e/mock-provider/server.ts`

- [ ] **Step 1: Expand the mock provider's `usage` object**

In `packages/e2e/mock-provider/server.ts`, find the `chatResponse()` function (line 8). Replace:

```typescript
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
```

With:

```typescript
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
```

- [ ] **Step 2: Run E2E tests to verify nothing breaks**

Run: `npm run test:e2e -- tests/auth/login.spec.ts`
Expected: PASS — existing auth flow still works with the richer usage object.

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/mock-provider/server.ts
git commit -m "test(e2e): expand mock provider usage with cache/reasoning fields

Returns prompt_tokens_details.cached_tokens and completion_tokens_details.
reasoning_tokens so usage tracking flows through E2E tests."
```

---

## Task 13: Final verification

- [ ] **Step 1: Run format check**

Run: `npm run format:check`
Expected: PASS (or run `npm run format` to fix)

- [ ] **Step 2: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run all unit tests**

Run: `npm test`
Expected: PASS — all existing tests still green, new tests green.

- [ ] **Step 4: Run web package tests (if any web files changed — none should have)**

Run: `npm run test --workspace=packages/web`
Expected: PASS (no web changes, but verify nothing broke via type re-exports)

- [ ] **Step 5: Run E2E suite**

Run: `npm run test:e2e`
Expected: PASS

- [ ] **Step 6: Final commit if any formatting fixes were needed**

```bash
git add -A
git commit -m "style: format after token usage tracking implementation"
```

---

## Self-Review Notes

**Spec coverage check:**

- ✅ `MessageUsage` type (Task 1)
- ✅ `MessageData.usage?` field (Task 1)
- ✅ `ProviderUsage` type + `ProviderResponse` shape (Task 2)
- ✅ `PricingSource` interface + `ModelPricing` (Task 3)
- ✅ `Provider.pricingSource?()` hook (Task 3)
- ✅ `ModelsDevPricingSource` with 24h cache + fallback (Task 6)
- ✅ `UsageCalculator` with normalization + cost math + tiered pricing + provider override (Task 7)
- ✅ `OpenAICompatibleProvider` expanded extraction (Task 4)
- ✅ `AgentRuntime` capture point (Task 8)
- ✅ `UsageQuery` aggregate computation (Task 9)
- ✅ `query_usage` tool (Task 10)
- ✅ `list_models` tool (Task 10)
- ✅ `decimal.js` dependency (Task 5)
- ✅ E2E mock provider expansion (Task 12)
- ✅ Migration: non-breaking, optional fields (Tasks 1, 8)
- ✅ Testing: unit tests for all new modules, integration via existing AgentRuntime tests

**Known gaps (follow-up, not in this plan):**

- `providerId` is `'unknown'` in `AgentRuntime.computeUsage()` — `ModelRouter.resolve()` returns `Provider` but not its ID. Follow-up: change `resolve()` to return `{ provider, providerId }`.
- `list_models` tool returns provider stubs, not actual model listings with pricing — requires runtime wiring of `PricingSource` into the tool context. Follow-up: inject `PricingSource` into `ToolContext` and have `list_models` call `provider.listModels()` + `pricingSource.resolve()`.
- `createManagementTools()` factory does not wire `UsageCalculator` — callers that use the factory (runtime) need to pass it in. Follow-up: update `LegionProcess` to construct `ModelsDevPricingSource` + `UsageCalculator` and inject into `AgentRuntime` factory.
