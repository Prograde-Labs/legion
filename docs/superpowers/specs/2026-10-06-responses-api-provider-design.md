# Design: Responses API support for the OpenAI-compatible provider

**Date:** 2026-10-06
**Status:** Draft for review (answers issue [#8](https://github.com/Prograde-Labs/legion/issues/8))
**Scope:** Design only — no implementation in this change.

---

## Summary

Legion's only real wire-format provider, `OpenAICompatibleProvider`, hardwires the Chat
Completions API (`POST {baseUrl}/chat/completions`). The OpenAI **Responses API**
(`POST {baseUrl}/responses`) is now widely implemented across self-hosted servers and is
where newer OpenAI features surface first. This spec proposes:

1. A **new `ProviderConfig.type` value `'openai-responses'`** (explicit config, not probing),
2. A new `OpenAIResponsesProvider` class that is a **stateless, full-history mapping** of
   Responses SSE onto the existing `ProviderStreamChunk` union — zero consumer changes,
3. **Defer** reasoning-effort controls and encrypted-reasoning replay to follow-ups,
4. A **quirk-tolerant** SSE parser, because real backends already diverge from OpenAI's
   grammar in documented ways,
5. A test strategy reusing the existing fetch-mock fixtures, the e2e mock provider, and a
   new opt-in integration gate.

Each recommendation maps 1:1 to a design question in issue #8 (§Design answers below).

---

## Background: what the Responses API is

One request/response cycle, differently shaped from Chat Completions:

- **Request:** `model`, `input` (an array of typed items, not a `messages` array),
  `instructions` (system/developer prompt), `max_output_tokens`, `temperature`, `store`,
  `tools` (flat shape: `{type:'function', name, description, parameters}` — not nested
  under `function:`), `tool_choice`, `reasoning`, `stream: true`.
- **Response:** an SSE stream of named events (`response.created`,
  `response.output_item.added`, `response.output_text.delta`, …) culminating in exactly
  one terminal event (`response.completed` | `response.incomplete` | `response.failed`),
  each carrying the full `response` object with `usage`.
- **Output items** are typed (`message`, `reasoning`, `function_call`, …). Tool calls are
  `function_call` items with `call_id`/`name`/`arguments` instead of `choices[].delta.tool_calls`.
- **Statefulness:** by default the server stores the response (`store: true`) and a client
  may chain via `previous_response_id` instead of resending history.

Grounded against the OpenAI SDK types (`openai/openai-python`, `main`, 2026-10-06):
event types and payloads in `src/openai/types/responses/response_*.py`; request params in
`response_create_params.py` (`store` "Defaults to true when omitted"; `instructions`;
`max_output_tokens`; `include: ['reasoning.encrypted_content']` documented as the way to
use reasoning items "when using the Responses API statelessly").

## Current state in Legion (verified at `origin/main` `38be405`, 2026-10-06)

Provider files are byte-identical to `1a2a774` where issue #8 was grounded; only Docker /
dependency / docs commits landed since.

- `packages/core/src/providers/OpenAICompatibleProvider.ts` — `stream()` (L146) POSTs
  `${baseUrl}/chat/completions` (L172), parses `data:` / `[DONE]` SSE (L206–218), maps
  `delta.reasoning_content`/`delta.reasoning` → `reasoning_delta` (L235–243),
  `delta.content` → `text_delta`, index-keyed `delta.tool_calls[]` →
  `tool_call_start`/`tool_call_args_delta` (L249–257), `finish_reason` →
  `ProviderStopReason` (L272–277), usage incl. cached/reasoning/Anthropic-proxy fields
  (L35–48, L282–291). `listModels()` (L296) GETs `/models` with a `KNOWN_MODEL_METADATA`
  overlay (L72–118). Constructor `(baseUrl, apiKey?)` (L138–144). `normalizeParameters()`
  (L14) adds `properties: {}` for strict backends.
- `packages/core/src/providers/Provider.ts` — wire-agnostic: `stream(messages, tools,
  model, options?) → AsyncGenerator<ProviderStreamChunk>` (L83–88); chunk union at L63–68
  (`reasoning_delta | text_delta | tool_call_start | tool_call_args_delta | done`).
  `ProviderStopReason = 'stop' | 'tool_calls' | 'max_tokens'` (L33). AgentRuntime and
  ModelRouter consume only these types.
- `packages/core/src/providers/SystemProviderStore.ts` — `construct()` (L33–44): both
  `'openai-compatible'` and `'anthropic'` → `OpenAICompatibleProvider`; `'copilot'` /
  `'codex'` → `NotImplementedError`.
- `packages/types/src/config.ts` — `ProviderConfig.type` closed union
  `'openai-compatible' | 'anthropic' | 'copilot' | 'codex'` (L50); `ModelConfig = { model,
  temperature?, maxTokens? }` (L3–7) — no reasoning surface. Provider configs live as JSON
  at `.legion/providers/<name>.json`; API keys in system config, never workspace config.
- Web: `packages/web/src/components/config/ProviderSlideOver.vue` has a plain `<select>`
  with the four type `<option>`s and a baseUrl field shown only for
  `type === 'openai-compatible'` (L84–90); `ConfigView.vue` maps type → badge color.
- E2E mock provider `packages/e2e/mock-provider/server.ts` serves `GET /v1/models` and
  `POST /v1/chat/completions` only (L167 area); scenario routing is driven by magic
  strings in the request (`E2E_REASONING_SCENARIO`, `E2E_SKILL_SCENARIO`, …) with helpers
  `writeSse` (reusable — takes pre-built chunks) and `textChunks`/`toolChunks`.
- Unit tests: `OpenAICompatibleProvider.test.ts` fetch-mocks global `fetch`
  (`vi.stubGlobal`) and builds SSE bodies via `makeSseBody`/`makeSseOkResponse` helpers.
- No `/responses` reference exists anywhere in the repo. Greenfield surface.

---

## Design answers (issue #8 questions 1–6)

### Q1 — Config surface: **new `ProviderConfig.type` value `'openai-responses'`**

**Recommendation:** extend the closed union to
`'openai-compatible' | 'openai-responses' | 'anthropic' | 'copilot' | 'codex'`.
`SystemProviderStore.construct()` gains a case → `new OpenAIResponsesProvider(config.baseUrl, config.apiKey)`.

Why this over the alternatives:

- **vs. per-provider wire-format option on `openai-compatible`** (e.g. `wire: 'responses'`):
  a type is a *set of behaviors* — wire format, error shapes, capability assumptions,
  pricing quirks, UI copy. Two wire formats behind one type name means every consumer of
  `type === 'openai-compatible'` needs a second check. The existing enum exists precisely
  to discriminate construction; wire format is the primary thing it discriminates. The
  `'anthropic'` type already routes to the OpenAI-wire class today only because Anthropic
  via OpenAI-compatible proxies is a compatibility mode — that precedent says "type names
  the wire contract the user is pointing at," and `/responses` is a different contract.
- **vs. auto-probing the backend** (POST `/responses`, fall back to chat on 404):
  a failed probe costs a full model round-trip of latency and confounds "endpoint missing"
  with "bad request" (some gateways 404 route-not-found, others 400/405, proxies vary).
  It also hides a real user decision — "which API do I want my tokens spent on" — inside
  guesswork, and produces different behavior across restarts if the backend changes.
  Explicit beats implicit; probing can be a diagnostic later if ever needed.
- **UI cost is small and precedented:** the type dropdown is a static `<option>` list;
  adding one option + showing the baseUrl field for the new type is a ~3-line change.
  Web tests for the provider form exist and get updated in the same change.
- `RoutingConfig` keys models → ordered provider *names*; wire format is orthogonal and
  needs no routing changes.

### Q2 — Wire mapping: full table (stateless v1)

New file `packages/core/src/providers/OpenAIResponsesProvider.ts`. Recommended shape:
subclass `OpenAICompatibleProvider` (change its `private baseUrl/apiKey` → `protected`),
reuse `normalizeParameters`, `authHeaders`, `listModels()` + `KNOWN_MODEL_METADATA`
unchanged, and override `stream()` only. (Alternative: extract a shared
`openai-shared.ts` module; subclassing is the smaller diff. Either is acceptable at plan
time — pick one, don't do both.)

#### Request mapping (messages/tools → `POST {baseUrl}/responses` body)

| Legion input | Responses request field |
|---|---|
| `model.model` | `model` |
| `model.temperature` (if set) | `temperature` |
| `model.maxTokens` (if set) | `max_output_tokens` |
| first `role:'system'` `ProviderMessage` | `instructions` (string) |
| any further `role:'system'` messages | input items `{role:'system', content}` |
| `role:'user'` | input item `{role:'user', content}` |
| plain `role:'assistant'` (content non-null) | input item `{role:'assistant', content:[{type:'output_text', text}]}` |
| assistant `toolCalls[]` | one input item per call: `{type:'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments)}` |
| `role:'tool'` | input item `{type:'function_call_output', call_id: msg.toolCallId, output: msg.content ?? ''}` |
| `tools[]` | `tools: [{type:'function', name, description, parameters: normalizeParameters(...)}]` (flat — **not** nested under `function`) + `tool_choice: 'auto'` |
| — (always) | `stream: true`, `store: false` |
| — (never in v1) | `previous_response_id`, `conversation`, `reasoning`, `include`, `prompt` |

`store: false` is sent explicitly: the default is `true` server-side, and Legion never
reads stored state back — silently persisting every agent turn on the backend is a
privacy/surprise footgun. (OpenAI retains stored responses ≥30 days; self-hosted
implementations vary in whether they persist at all.)

Message ordering is preserved: Legion's ProviderMessage[] is a flattened active chain
(one linear sequence), which maps 1:1 onto the `input` array. Branching is resolved
upstream by the conversation model before the provider ever sees it.

#### SSE event mapping (Responses → `ProviderStreamChunk`)

Parse `data:` lines exactly like the chat path. Ignore `[DONE]`-sentinel absence (the
Responses stream terminates with the terminal event, not `[DONE]`; treat EOF without a
terminal event as an error). Every event object carries `type`:

| Responses event | Emitted chunk | Notes |
|---|---|---|
| `response.created` / `response.in_progress` | *(none — recorded)* | capture `response.id` for logs |
| `response.output_item.added` where `item.type === 'function_call'` | `{type:'tool_call_start', index: event.output_index, id: item.call_id, name: item.name}` | `call_id` is the id that tool results echo back |
| `response.output_text.delta` | `{type:'text_delta', delta: event.delta}` | |
| `response.reasoning_text.delta` | `{type:'reasoning_delta', delta: event.delta}` | full CoT text; OpenAI-only in practice |
| `response.reasoning_summary_text.delta` | `{type:'reasoning_delta', delta: event.delta}` | what vLLM / llama.cpp / ollama emit; treat the two as mutually exclusive per stream (first seen wins) |
| `response.function_call_arguments.delta` | `{type:'tool_call_args_delta', index: event.output_index, delta: event.delta}` | `item_id` also present; see keying note |
| `response.output_text.done`, `response.output_item.done`, `response.content_part.*`, `response.reasoning_*_done` | *(ignored)* | deltas already carried the content; `*_done` payloads are replays |
| `response.refusal.delta` | `{type:'text_delta', delta: event.delta}` | refusal is assistant-visible text |
| `response.completed` | `{type:'done', stopReason: 'stop'|'tool_calls', usage?}` | stop rule below |
| `response.incomplete` | `{type:'done', stopReason: 'max_tokens' if incomplete_details.reason === 'max_output_tokens' else 'stop', usage?}` | |
| `response.failed` | **throw `ProviderError`** with `response.error.code` + message | matches chat path's failure mode (throw, no synthetic done) |
| anything else (unknown `type`) | *(ignored — debug log)* | forward compatibility; see quirk tolerance |

**`stopReason` for `response.completed`:** `'tool_calls'` if the stream emitted ≥1
`tool_call_start` (i.e. the response contains function_call items — the fact
AgentRuntime acts on), else `'stop'`. This avoids depending on backend-specific status
strings.

**Tool-call keying:** track calls by `item_id` when present, falling back to
`output_index`. Do not assume `output_index` is unique per call: ollama currently shares
`output_index` across a text block and a following function call (ollama #18798, open
2026-10-05). The `tool_call_start` index and subsequent `args_delta` index must be the
*same* resolved key so AgentRuntime accumulation works.

**Quirk tolerance (parser rules):** ignore unknown event types; tolerate missing
`sequence_number`; don't validate ids that appear both in delta events and in the
terminal `response.output` replay — vLLM regenerates item ids in `response.completed`
(#59834, fixed but a fresh regression of the same class appeared #55284), so **only delta
events drive emitted chunks; `response.output` items in terminal events are never
re-emitted**. These rules are unit-test-mandated (§Q6).

**Usage mapping** (`response.usage`, terminal events only — ground in
`response_usage.py`):

| Responses usage | `ProviderUsage` |
|---|---|
| `input_tokens` | `inputTokens` |
| `output_tokens` | `outputTokens` |
| `output_tokens_details.reasoning_tokens` | `reasoningTokens` |
| `input_tokens_details.cached_tokens` | `cacheReadInputTokens` |
| `input_tokens_details.cache_write_tokens` | `cacheWriteInputTokens` |

Errors: non-OK HTTP → `ProviderError('OpenAI-compatible API error <status>: <body[0:200]>')`
(identical shape to the chat path for log-parsing consistency). EOF before a terminal
event → `ProviderError('Responses stream ended without a terminal event')`. AbortSignal
propagates exactly as the chat path does (reader cancel on abort/incomplete drain).

### Q3 — Statefulness: **stateless v1, explicitly deferred**

**Recommendation:** full history every call; `store: false`; no `previous_response_id`,
no server-side conversation. Reasons, in order of weight:

1. **Legion conversations are branching trees** with edit / re-run / prune / compaction
   (`docs/legion-v2-greenfield-spec.md`). `previous_response_id` models an append-only
   chain rooted at server-stored responses. Re-parenting a branch, editing a past node,
   or pruning invalidates the chain — we'd be fighting the core model.
2. **Provider-agnostic interface:** `Provider.stream(messages, …)` receives full history
   by contract. Stateful Responses mode would need side-channel state (last response id
   per thread) with no home in the current interface — an interface change for one wire
   format.
3. **Portability:** most self-hosted backends either don't persist or make storage
   optional; a design that *requires* server state would work reliably only on OpenAI.

Future path (not v1): LM Studio demonstrates the practical win — resending a
`previous_response_id` let 1276/1293 input tokens come from cache in their docs example.
If Legion later wants this, the clean fit is *prefix-cache validation* (OpenAI also
caches prompts server-side even statelessly) rather than thread state; revisit after v1
sees real usage. If encrypted-reasoning replay (`include: ['reasoning.encrypted_content']`
+ round-tripping `reasoning` items with `store: false`) is ever wanted, it must be a
ProviderMessage extension — flagged as open question for Chris (§Open questions).

### Q4 — Reasoning controls: **defer `reasoning.effort`; not in v1 scope**

**Recommendation:** v1 omits the `reasoning` request field entirely (backend default
effort applies). `ModelConfig` is shared by every provider and every call site; widening
it (`reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'`) touches `packages/types`,
ModelRouter plumbing, runtime, and the web model-UI for a benefit only Responses backends
can use. That is a coherent standalone follow-up *after* the wire format lands and
something uses it — bundling it here would grow the blast radius of the first
Responses-enabled release for no current consumer. The mapping table above stays valid
when it lands (one more conditional field). Deferred work is tracked in the follow-up
proposal, not lost.

### Q5 — Backend reality check (verified 2026-10-06)

| Server | `/v1/responses` today | Evidence | Implication |
|---|---|---|---|
| **OpenAI first-party** | yes, native | API docs; SDK types are the grammar source | reference implementation |
| **LM Studio** | yes | `lmstudio.ai/blog/openresponses`: compatibility endpoint Oct 2025; **Open Responses-spec compliant in 0.3.39** (Jan 2026); docs show tool calling + token caching on `/v1/responses` | first-class local target |
| **llama.cpp server** | yes | feature request #19138 closed as implemented; compliance PR #21174 merged; ongoing compat fixes (#26013, #24295, #27958) | supported, grammar edge cases still being smoothed |
| **Ollama** | yes | Responses-compat issues active (#17673 custom tools, #18798 streaming tool-call ordering bug updated 2026-10-05) | works; parser must tolerate `output_index` sharing |
| **vLLM** | yes (maturing) | 228 open responses-API issues/PRs; dedicated `[Frontend]` workstreams; strict-client breakage #59834 (ids regenerated in `response.completed`) | real usage exists; id-regeneration tolerance is not theoretical |
| **SGLang** | yes (maturing) | 81 open responses-API issues; sgl-router `/v1/responses` support in flight (#42314); hardening bugs weekly | same as vLLM |
| **LiteLLM (proxy)** | yes | unified Responses passthrough across backends; extensive logging/otel fixes in flight | common aggregation path for self-hosted fleets |

**Conclusion:** the ecosystem answer to "is auto-fallback worth it?" is **no** — support
is now broad enough that the user pointing Legion at a base URL knows which API family
the server speaks (and LM Studio / OpenAI / vLLM all serve both side-by-side on the same
port, so a wrong explicit choice fails fast with a 404, which the config owner can fix in
one edit). The same survey *is* the argument for the quirk-tolerant parser in Q2: three
independent backends have current, documented divergences from OpenAI's grammar.

### Q6 — Testing strategy

Three layers, mirroring existing patterns:

1. **Unit (primary grammar coverage):** `packages/core/src/providers/OpenAIResponsesProvider.test.ts`
   — `vi.stubGlobal('fetch')` + SSE-body helpers cloned from
   `OpenAICompatibleProvider.test.ts` (`makeSseBody` pattern). Fixture scenarios, each a
   hand-written event sequence asserted chunk-by-chunk:
   - text-only happy path (`created → output_item.added(message) → output_text.delta×N → completed`)
   - reasoning via `reasoning_text.delta`; separate fixture via `reasoning_summary_text.delta`
   - single tool call: `output_item.added(function_call)` → `tool_call_start`, then
     `function_call_arguments.delta`×N → `tool_call_args_delta`, stop `tool_calls`
   - two interleaved tool calls with distinct `output_index` (accumulation by index)
   - `completed` with full usage incl. `input_tokens_details.cached_tokens` +
     `output_tokens_details.reasoning_tokens` → asserted `ProviderUsage`
   - `incomplete` with `incomplete_details.reason: 'max_output_tokens'` → `max_tokens`
   - `failed` → thrown `ProviderError`
   - unknown event type ignored; missing `sequence_number` tolerated; terminal
     `response.output` replay with *different* ids emits nothing extra (vLLM #59834 class)
   - `function_call_arguments.delta` with shared `output_index` after a message item
     (ollama #18798 class) — call keyed by `item_id`
   - request-shape assertions: URL ends `/responses`; body has `store: false`,
     `stream: true`, flat `tools` entries, `instructions` from first system message,
     `function_call_output` items for tool results, `max_output_tokens` for `model.maxTokens`
   - HTTP 404/500 → `ProviderError`
2. **E2E mock provider:** extend `packages/e2e/mock-provider/server.ts` with a
   `POST /v1/responses` handler mirroring the chat handler's scenario routing
   (`mock-model` listing, text scenario, tool scenario, reasoning scenario) but emitting
   Responses grammar (reusing `writeSse` — it takes pre-built chunks and appends
   `[DONE]`, which is harmless trailing data for a parser that stops at the terminal
   event; alternatively pass chunks without the sentinel). A new e2e spec (or a
   parameterization of the existing provider spec) runs one agent turn against a
   provider config with `type: 'openai-responses'` pointed at the mock.
3. **Integration (opt-in, live backend):** new
   `OpenAIResponsesProvider.integration.test.ts` gated by
   `LEGION_OPENAI_RESPONSES_INTEGRATION=1` (documented in `docs/testing.md` next to
   `LEGION_OPENAI_INTEGRATION=1`). Separate gate rather than overloading the existing
   one: the existing gate's contract is "chat/completions with `gpt-4o-mini`"; keeping
   wire formats in separate gates lets each run against the cheapest compatible endpoint.
   Asserts one streamed text turn end-to-end (tool calls optional/flaky-tolerant).

Gate order unchanged: `npm run format:check` → `npm run typecheck` → `npm test` (+ web
workspace tests, since the provider UI changes; `packages/e2e` stays outside typecheck
project references).

---

## Implementation footprint (for the follow-up PLANNING task)

| File | Change |
|---|---|
| `packages/types/src/config.ts` | extend `ProviderConfig.type` union with `'openai-responses'` |
| `packages/core/src/providers/OpenAIResponsesProvider.ts` | **new** — subclass of `OpenAICompatibleProvider`, overrides `stream()` |
| `packages/core/src/providers/OpenAICompatibleProvider.ts` | `private baseUrl/apiKey` → `protected` (2 lines); no behavior change |
| `packages/core/src/providers/SystemProviderStore.ts` | one `case` in `construct()` |
| `packages/e2e/mock-provider/server.ts` | `/v1/responses` handler |
| `packages/web/src/components/config/ProviderSlideOver.vue` | type `<option>` + baseUrl field condition |
| `packages/web/src/views/ConfigView.vue` | badge color map entry |
| `packages/core/src/providers/OpenAIResponsesProvider.test.ts` | **new** — fixtures per Q6 |
| `docs/testing.md` | `LEGION_OPENAI_RESPONSES_INTEGRATION=1` row |

Untouched by design: `Provider.ts` (chunk union is sufficient), `ModelConfig`
(reasoning deferred), AgentRuntime, ModelRouter, routing config schema. The only
`packages/core` files beyond the provider layer are **none** — `SystemProviderStore` is
provider plumbing by issue #8's own framing. No `ModelConfig` widening → no web model
UI changes beyond the type dropdown.

## Open questions for Chris

1. **Encrypted reasoning replay (store-less reasoning models):** v1 drops reasoning items
   from history. OpenAI's stateless-reasoning path needs
   `include: ['reasoning.encrypted_content']` plus carrying `reasoning` items (with
   `encrypted_content`) back in `input` — that requires a `ProviderMessage` extension.
   Defer to a follow-up, or spec it now? *(Recommendation: defer.)*
2. **Type name:** `'openai-responses'` — or prefer `'responses'` (shorter, but less
   discoverable next to `'openai-compatible'`)? *(Recommendation: `'openai-responses'`.)*
3. **Integration gate:** separate `LEGION_OPENAI_RESPONSES_INTEGRATION=1` (recommended)
   or parameterize the existing `LEGION_OPENAI_INTEGRATION` gate by provider type?

## Self-review notes

- No TBDs: every deferred item has an owner-section (Q3/Q4 deferrals, open questions list).
- Consistency: Q1's config choice, Q2's mapping, and the footprint table all name the
  same files and type string.
- Scope: single implementation plan — one provider class, one union extension, mock +
  tests + UI dropdown. Reasoning-effort and encrypted-reasoning are explicitly separate.
