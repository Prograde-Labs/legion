# Token Usage & Cost Tracking Design

**Date:** 2026-07-05
**Status:** Approved for implementation
**Scope:** `packages/types`, `packages/core` (providers, runtime, tools). No `packages/web` or `packages/runtime` changes required — frontend consumes usage via existing tool-call surface.

---

## Overview

Legion currently discards token usage data returned by LLM providers. `ProviderResponse.usage` exists but `AgentRuntime` never reads it, and `MessageData` has no fields to store it. This spec adds per-message token usage and cost tracking to the conversation tree, with a pluggable pricing source (default: models.dev) and two tools (`query_usage`, `list_models`) that expose aggregates and pricing to operators, agents, and the web frontend.

Design principle: usage lives **in the conversation tree** as part of `MessageData`, not in a side store. This fits Legion's "everything is part of the branching message tree" philosophy — usage is forkable, recoverable, and exportable alongside the messages that produced it. Aggregates are derived on demand by walking the tree.

### Consumers

1. **Operators** — query spend via `query_usage` tool (called from web SPA through `POST /api/execute` like every other tool). No new REST endpoint.
2. **Agents** — same `query_usage` tool, gated by `ToolPolicy`. An agent reasoning about its own budget needs it; a restricted agent doesn't.
3. **Web frontend** — gets usage for free since Legion routes everything through tools. A cost column in the conversation list is one `query_usage({ groupBy: 'conversation' })` call on mount.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Granularity | Per-message usage on `MessageData` | One assistant message = one LLM API call in Legion's model. Aggregates derived by walking tree. No new store. |
| Pricing source | models.dev (default), `PricingSource` interface | No lock-in. Providers can override via `pricingSource?()` hook. Same source as OpenCode. |
| Token buckets | input, output, reasoning, cache.read, cache.write | Matches OpenCode's proven schema. Reasoning split out because pricing for it is unsettled. |
| Cost math | `decimal.js`, per-million-token rates | Avoids floating-point drift on sums. Same approach as OpenCode. |
| Tool surface | `query_usage` + `list_models` | `query_usage` covers all aggregate needs via `groupBy`. No `get_message_usage` — usage already on messages returned by `get_conversation`. |
| Aggregates | Derived on demand, not stored | Consistent with "stored in the structure of the conversation." If slow later, add projection index without changing tool API. |
| Migration | Non-breaking, optional fields | `MessageData.usage?` optional. Old conversations load fine. `ProviderResponse.usage` shape change is internal, one consumer. |

---

## Data Model

### `MessageUsage` (new — `packages/types/src/usage.ts`)

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

Five token buckets matching OpenCode's schema. `modelId`/`providerId` carried per-message so a conversation that switched models mid-stream still has attribution.

### `MessageData` extension (`packages/types/src/conversation.ts`)

```typescript
export interface MessageData {
  // ...existing fields...
  usage?: MessageUsage;
}
```

Optional — only set on `role: 'assistant'` messages that came from an LLM call. User messages, summary messages, pruned messages have none. Absent on legacy messages (treated as zero-cost in aggregates).

### `ProviderUsage` and `ProviderResponse` (`packages/core/src/providers/Provider.ts`)

Replace the 2-field `usage` shape with `ProviderUsage` that the provider fills from the raw API response:

```typescript
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface ProviderResponse {
  // ...existing fields...
  usage?: ProviderUsage;
  /**
   * Provider may override cost calculation (e.g. Copilot nano-AIU).
   * If absent, UsageCalculator computes it via PricingSource.
   */
  cost?: number;
}
```

`ProviderUsage` is the raw shape from the provider. `MessageUsage` is the normalized shape stored on the message. `UsageCalculator` does the transformation (subtract cache from input, subtract reasoning from output, compute cost).

### Why two shapes

- `ProviderUsage` (raw) mirrors what APIs return — `inputTokens` includes cached tokens on OpenAI (and AI SDK v6 normalizes this across all providers).
- `MessageUsage` (normalized) has cache already subtracted from input, reasoning already subtracted from output. Consumers don't need to know provider quirks.
- The normalization happens once at the boundary (`UsageCalculator`), not scattered across consumers.

---

## Pricing Source

### `PricingSource` interface (new — `packages/core/src/providers/PricingSource.ts`)

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

Interface-only. Providers and `UsageCalculator` depend on this, not on any specific implementation.

### `ModelsDevPricingSource` (default implementation)

```typescript
export class ModelsDevPricingSource implements PricingSource {
  // fetches https://models.dev/api/v1/models.json
  // caches to <workspace>/.legion/cache/models-dev.json with 24h TTL
  // hardcoded fallback map for top 20 models (Claude/GPT/Gemini) if fetch fails
}
```

- Single fetch of the full models.json index on first use, cached to disk under `.legion/cache/`.
- 24h TTL — same as OpenCode and CodeBurn's LiteLLM cache.
- Hardcoded fallback for ~20 top models so offline/fetch-failure doesn't zero out costs.
- `resolve()` does case-insensitive model ID matching, strips provider prefixes (`us.`, `eu.`, `global.`) like OpenCode does.

### Provider override hook

```typescript
export interface Provider {
  // ...existing...
  /**
   * Optional: return a PricingSource for models this provider serves.
   * If absent, the system-wide ModelsDevPricingSource is used.
   * Providers with bespoke billing (e.g. Copilot AIU, self-hosted) implement this.
   */
  pricingSource?(): PricingSource;
}
```

- Default: every provider uses `ModelsDevPricingSource`.
- Override: a provider returns its own `PricingSource` impl (e.g. `CopilotPricingSource` that converts nano-AIU → USD, or a self-hosted provider with flat-rate billing).
- `UsageCalculator` asks the provider first, falls back to the system default.

### No lock-in

The interface is small enough that a future `LiteLLMPricingSource` could be added as a second impl and selected via config, without touching consumers. models.dev is one implementation, not a hardcoded dependency.

---

## Provider Integration & Usage Capture

### OpenAI usage shape (verified against API docs)

OpenAI's `usage` object on chat completion responses:

```json
"usage": {
  "prompt_tokens": 2006,
  "completion_tokens": 300,
  "total_tokens": 2306,
  "prompt_tokens_details": {
    "cached_tokens": 1920
  },
  "completion_tokens_details": {
    "reasoning_tokens": 0,
    "accepted_prediction_tokens": 0,
    "rejected_prediction_tokens": 0
  }
}
```

Key facts verified from OpenAI's prompt caching guide:
- `prompt_tokens_details.cached_tokens` is **always present** (may be 0). It is a breakdown of `prompt_tokens` — `prompt_tokens` **includes** cached tokens.
- `completion_tokens_details.reasoning_tokens` is a breakdown of `completion_tokens` — reasoning tokens are **included** in `completion_tokens`.
- OpenAI has **no cache-write field** — caching is automatic and free to write.
- `cache_creation_input_tokens` / `cache_read_input_tokens` are **Anthropic-native** fields, surfaced by some OpenAI-compatible proxies (LiteLLM and similar) but not by OpenAI's API directly.

### `OpenAICompatibleProvider` changes (`packages/core/src/providers/OpenAICompatibleProvider.ts`)

Expand the `OAIUsage` type and extraction:

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
  // Anthropic-via-proxy fields (LiteLLM and similar surface these). NOT OpenAI-native.
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
```

Extraction into `ProviderUsage`:

```typescript
usage: data.usage ? {
  inputTokens: data.usage.prompt_tokens,
  outputTokens: data.usage.completion_tokens,
  reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
  cacheReadInputTokens:
    data.usage.prompt_tokens_details?.cached_tokens ??
    data.usage.cache_read_input_tokens,
  cacheWriteInputTokens: data.usage.cache_creation_input_tokens,
} : undefined,
```

Prefer `prompt_tokens_details.cached_tokens` (OpenAI-native). Fall back to `cache_read_input_tokens` only if the former is absent (proxy that surfaces Anthropic fields but not OpenAI's detail object). `cache_creation_input_tokens` only present on Anthropic-via-proxy — `undefined` on native OpenAI, treated as 0.

No cost calculation in the provider — that's `UsageCalculator`'s job. Provider may set `cost` directly if it has bespoke billing (Copilot pattern); otherwise leaves it undefined.

### `UsageCalculator` (new — `packages/core/src/providers/UsageCalculator.ts`)

Single normalization + costing point. Pure function, no I/O except pricing fetch:

```typescript
export class UsageCalculator {
  constructor(
    private defaultPricingSource: PricingSource,
    private providers: ProviderLookup,  // providerId -> Provider (for pricingSource override)
  ) {}

  // ProviderLookup = Map<string, Provider> | (providerId: string) => Provider | undefined


  async compute(
    providerId: string,
    modelId: string,
    raw: ProviderUsage,
    providerCostOverride?: number,
  ): Promise<MessageUsage> {
    // 1. Normalize (the input-includes-cache footgun)
    const cacheRead = raw.cacheReadInputTokens ?? 0;
    const cacheWrite = raw.cacheWriteInputTokens ?? 0;
    const input = Math.max(0, raw.inputTokens - cacheRead - cacheWrite);
    const reasoning = raw.reasoningTokens ?? 0;
    const output = Math.max(0, raw.outputTokens - reasoning);

    // 2. Cost: provider override wins, else pricing source
    const cost = providerCostOverride ?? await this.computeFromPricing(
      providerId, modelId, { input, output, reasoning, cacheRead, cacheWrite },
    );

    return { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite }, cost, modelId, providerId };
  }
}
```

Costing math (when no override):
- Tiered-pricing lookup by context size (`inputTokens` pre-adjustment, before cache subtraction).
- `decimal.js` arithmetic: `sum(bucket.tokens * rate / 1_000_000)`.
- Reasoning charged at output rate (TODO marker — models.dev lacks reasoning-specific pricing, same approach as OpenCode).

### `AgentRuntime` capture point (`packages/core/src/runtime/AgentRuntime.ts`)

One insertion after the provider call:

```typescript
const response = await provider.complete(...);
const usage = response.usage
  ? await this.usageCalculator.compute(
      model.providerId, model.modelId, response.usage, response.cost,
    )
  : undefined;
// ...build MessageData...
const message: MessageData = { /* ... */ usage };
```

If `ProviderResponse.usage` is absent (provider didn't report, error path), `usage` is `undefined` — message stored without usage, treated as zero-cost in aggregates.

### Why this shape

- Provider reports raw API tokens only — no costing logic leaks into provider impls.
- `UsageCalculator` is the single place that knows about input-includes-cache normalization and the costing formula. Testable in isolation.
- `AgentRuntime` has one capture point — no scattered usage writes.
- Provider cost override (Copilot, bespoke billing) is a clean escape hatch.

---

## Tool Surface & Aggregates

Usage lives on `MessageData`, so existing tools that return messages (`get_conversation`) already carry per-message usage. Two new tools in `management-tools.ts`:

### `query_usage` — aggregate query

```typescript
{
  name: 'query_usage',
  description: 'Query token usage and cost across conversations. Returns aggregated totals.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'Scope to one conversation.' },
      participantId: { type: 'string', description: 'Scope to conversations involving this participant.' },
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
  },
}
```

**Returns:**
```typescript
{
  totals: MessageUsageTotals,
  groups?: Array<{
    key: string;               // modelId | participantId | conversationId | ISO date (UTC, YYYY-MM-DD)
    totals: MessageUsageTotals;
    messageCount: number;
  }>;
}
```

Where:
```typescript
interface MessageUsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
  cost: number;
  messageCount: number;
}
```

### `list_models` — pricing transparency

```typescript
{
  name: 'list_models',
  description: 'List available models with their current pricing rates.',
  parameters: { type: 'object', properties: {} },
}
```

Returns each model's `ModelPricing` (input/output/cache per-million rates) alongside provider ID and model ID. Operators and agents can see what things cost before choosing a model. Uses existing `Provider.listModels()` + `PricingSource.resolve()`.

### Aggregate computation — `UsageQuery`

Internal helper (not a tool itself, used by `query_usage`):

```typescript
class UsageQuery {
  constructor(private conversationStore: ConversationStore) {}

  async query(filter: UsageFilter, groupBy?: GroupBy): Promise<UsageReport> {
    // 1. list conversations matching filter (participantId, since)
    // 2. for each, load + walk messages from activeBranchHead to root
    // 3. filter messages by modelId, providerId, since, until, role==='assistant', usage present
    // 4. sum into totals, accumulate groups
  }
}
```

Walks the conversation tree — same `parentId` chain `ConversationThread` already reconstructs. Skips `status: 'superseded' | 'pruned'` messages (historical, not re-billed). Includes `'compacted'` messages (they were real API calls).

### Why this shape

- **Two tools, not five.** `query_usage` covers all aggregate needs via `groupBy`. `list_models` covers pricing. No `get_message_usage` — it's already on the message.
- **No stored aggregates.** Derived on demand from the conversation tree. Consistent with "stored in the structure of the conversation." If slow later, add a projection index — doesn't change the tool API.
- **Filters mirror `list_conversations`.** Same `participantId`/`since` semantics, plus model/provider/time narrowing.
- **Gated by ToolPolicy.** Operators get `query_usage` by default. Agents may or may not, per their policy.
- **Frontend gets it for free.** Web SPA calls `query_usage` via `POST /api/execute` like every other tool. No new REST endpoint, no special UI backend.

### Conversation list cost column

`list_conversations` stays as-is (metadata only, no usage). The frontend that wants a cost column calls `query_usage({ groupBy: 'conversation' })` once on mount — one round trip, returns per-conversation totals. Keeps `list_conversations` fast and decouples listing from usage computation.

---

## Wiring, Migration & Testing

### Package layout

```
packages/types/src/
  usage.ts                           # NEW: MessageUsage type

packages/core/src/
  providers/
    PricingSource.ts                 # NEW: interface + ModelPricing type
    ModelsDevPricingSource.ts        # NEW: default impl (fetch + 24h cache + fallback)
    UsageCalculator.ts               # NEW: ProviderUsage → MessageUsage normalization + cost
    OpenAICompatibleProvider.ts      # MODIFIED: extract expanded usage fields
    Provider.ts                      # MODIFIED: ProviderUsage type, pricingSource?() hook
  usage/
    UsageQuery.ts                    # NEW: aggregate query (walks conversation tree)
    usage-types.ts                   # NEW: MessageUsageTotals, UsageFilter, UsageReport, GroupBy
  tools/
    management-tools.ts              # MODIFIED: add query_usage + list_models tools
  runtime/
    AgentRuntime.ts                  # MODIFIED: inject UsageCalculator, capture usage on messages
```

### Construction graph

```
WorkspaceConfig loaded
  → ModelsDevPricingSource constructed (system-wide default)
  → UsageCalculator constructed (pricingSource + provider lookup)
  → UsageCalculator injected into AgentRuntime
  → UsageQuery constructed (conversationStore)
  → query_usage / list_models tools registered in ToolRegistry
```

`OpenAICompatibleProvider` unchanged in construction — it only reports raw tokens; the calculator does the rest.

### Migration — non-breaking

Three changes, all backward-compatible:

1. **`MessageData.usage?: MessageUsage`** — optional field. Existing conversations load fine; messages without `usage` are treated as zero-cost in aggregates. No migration script needed.

2. **`ProviderResponse.usage` shape change** — `promptTokens`/`completionTokens` → `ProviderUsage` with `inputTokens`/`outputTokens`/`reasoningTokens`/`cacheReadInputTokens`/`cacheWriteInputTokens`. Internal interface, only one consumer (`AgentRuntime`). Single call site to update.

3. **`FileConversationStore`** — no schema change. The `usage` field serializes as part of `MessageData` JSON. Old files without it deserialize fine (field absent → `undefined`).

### Dependency additions

- `decimal.js` — for cost arithmetic, avoids float drift on sums. Small (~30KB), zero deps, well-maintained. Already used by OpenCode for the same purpose. Add to `packages/core/package.json`.

None otherwise — models.dev is just HTTPS fetch, no SDK needed.

### Testing

**Unit tests:**
- `ModelsDevPricingSource` — mock fetch, verify caching (24h TTL), fallback map, prefix stripping (`us.`, `eu.`), case-insensitive match, returns `undefined` for unknown model.
- `UsageCalculator` — given `ProviderUsage` + `ModelPricing`, verify:
  - Cache subtraction from input (the footgun)
  - Reasoning subtraction from output
  - Cost math: each bucket × rate / 1M, summed
  - Tiered pricing (>200K context picks higher tier)
  - Provider cost override (Copilot pattern) bypasses pricing
  - `undefined`/missing fields treated as 0
- `UsageQuery` — fixture conversations with known usage on messages, verify:
  - Totals sum correctly
  - `groupBy: 'model'` / `'participant'` / `'conversation'` / `'day'`
  - Filters (since/until/participantId/modelId/providerId)
  - Skips superseded/pruned messages, includes compacted
  - Empty conversation → zero totals
- `query_usage` tool — thin wrapper, verify it calls `UsageQuery` and returns shape
- `list_models` tool — verify it calls `provider.listModels()` + `pricingSource.resolve()`
- `OpenAICompatibleProvider` — mock API response with `prompt_tokens_details.cached_tokens` + `completion_tokens_details.reasoning_tokens`, verify extracted `ProviderUsage`

**Integration test (`LEGION_INTEGRATION=1`):**
- `query_usage` end-to-end via `POST /api/execute` against mock provider (existing `mock-provider` already returns `usage: { prompt_tokens, completion_tokens }` — expand to include cache/reasoning fields).
- Verify usage appears on assistant message in `get_conversation` response.
- Verify `query_usage` aggregates match the messages.

**E2E (`packages/e2e`):**
- Existing mock provider returns richer usage. Add assertion that `query_usage` returns non-zero cost after a conversation.

---

## Out of Scope

- **Per-call records in a separate store** (Approach B from brainstorm). Can be layered on later without changing `MessageData` or tool API if per-step granularity is needed.
- **Time-series projection index** for fast dashboard queries (Approach C). YAGNI until walking proves slow. Tool API stays the same if added.
- **Reasoning-token pricing** beyond charging as output. models.dev lacks the data; revisit when pricing models settle.
- **Web UI components** (cost column, usage dashboard). Frontend consumes `query_usage` like any other tool — separate spec if needed.
- **CodeBurn provider file.** Legion's per-message usage on `MessageData` is the stable format external tools can read. A CodeBurn provider adapter is a follow-up if desired.
