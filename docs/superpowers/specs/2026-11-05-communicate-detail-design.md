# `communicate` Detail, Model Override and Deadline — Design

**Date:** 2026-11-05
**Status:** Draft — awaiting review
**Roadmap item:** #2 (post-MVP wishlist, `012-post-mvp-roadmap.md`)
**Thread:** `2026-11-02-legion-v2` / branch `integration/telegram-v2-and-web-ui`
**Phase:** A (nested-chunk forwarding is explicitly deferred — see §11)

---

## 1. Problem

`communicate` today accepts only `to`, `message`, `conversationId` and `replyTo`. Two gaps:

1. **Humans cannot see what a participant is doing.** Connectors render only the final string.
   The web chat streams text and reasoning but ignores `tool_call_start` / `tool_call_args_delta`;
   Telegram v2 uses `callTool` and never sees intermediate chunks at all.
2. **Callers cannot tune a call.** There is no per-call model override and no deadline for a
   synchronous call, so a slow recipient blocks the caller indefinitely.

The primary goal is **human visibility**; richer detail in the calling agent's tool result is a
rare, token-expensive option.

## 2. Goals

- Add `detail`, `model` and `timeoutMs` parameters to `communicate`.
- Let connectors render detail according to their own configuration, clamped by the caller's
  request.
- Allow a per-call model override for the recipient, failing closed when it cannot be resolved.
- Bound synchronous calls with a deadline that returns the partial response.
- Render the tool-call timeline in the web chat and switch Telegram's `communicate` path to
  streaming.

## 3. Non-goals

- Authorization of parameters. `AuthEngine` stays the policy layer; the tool does no auth logic.
  Today that means all-or-nothing for `communicate` until roadmap item #6 adds argument scoping.
- Forwarding nested tool streams from `AgentRuntime` (phase C). An agent's `detail` request is
  accepted and documented as a connector hint, but has no live rendering effect until phase C.
- New detail sources beyond what the runtime already emits (tool calls, reasoning, text).
- Changing the default behaviour of calls that omit the new parameters.

## 4. Tool contract

```ts
{
  name: 'communicate',
  parameters: {
    to: string,
    message: string,
    conversationId?: string,
    replyTo?: string,
    detail?: 'minimal' | 'standard' | 'full',  // default 'standard'
    model?: string,                             // per-call model override for the recipient
    timeoutMs?: number,                         // positive integer, capped at 24h
  }
}
```

Validation:

- `detail` must be one of the three literals; anything else returns a tool error.
- `timeoutMs` must be a positive integer; values above 24h are clamped to 24h. `0`, negatives and
  non-integers are rejected.
- `model` must be a non-empty string when present.
- All parameters are optional; omitting them preserves today's behaviour exactly.

## 5. Detail semantics

| Level      | What a connector may render                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `minimal`  | Final response text only. No progress, no tool activity, no reasoning.                                                                           |
| `standard` | Final text + progress/status + messages the participant posts between tool calls. No reasoning, no tool arguments.                               |
| `full`     | Everything: tool calls, argument summaries, results, reasoning, and run metadata (model actually used, usage, iterations).                       |

**Clamp rule:** effective level = `min(requested, connector.maxDetail)`. The connector is the only
component that decides rendering. Core carries the requested level; it never enforces presentation.

Defaults:

- Web connector: `maxDetail: 'full'`.
- Telegram connector: `maxDetail: 'standard'`, configurable via connector options.
- Tool default when `detail` is omitted: `'standard'`.

**Tool result to the LLM stays lean.** `{ conversationId, response, status }` as today. At `full`,
the result additionally carries `meta: { model, usage?, iterations? }`. `minimal` and `standard`
add nothing to the caller's context.

## 6. Model override

- `communicate` passes `model` into `SendOptions`; `MessageRouter` carries it to the recipient's
  `RuntimeContext` as `modelOverride`.
- `AgentRuntime` calls `provider.stream(..., context.modelOverride ?? agent.model, ...)`.
- Resolution continues to go through `ModelRouter`, so provider routing and credentials apply.
- If the override cannot be resolved (unknown model, no provider, missing credentials), the call
  returns `{ status: 'error', error: 'model override unavailable: <model>' }`. No silent fallback.
- The model actually used is reported in `meta` at `full` detail and in stream metadata for
  connectors.

## 7. Deadline

- `timeoutMs` flows into `SendOptions`; `MessageRouter` owns the timer and aborts its internal
  controller on expiry.
- On expiry the existing partial-response path persists the streamed text/reasoning as the reply,
  and the call returns `{ status: 'timeout', partial: true, response: <partial> }`.
- `communicate` maps that to a tool result of `status: 'error'`, `error: 'deadline exceeded'`, and
  `data: { conversationId, response, partial: true }`.
- A new terminal chunk `{ type: 'call_timeout'; timeoutMs: number }` is emitted before the result
  so renderers can show "stopped after Ns" instead of a clean finish.
- No default deadline. A call without `timeoutMs` behaves as today.

## 8. Chunk protocol change

Add to `LLMChunk` (`packages/types/src/streaming.ts`):

```ts
| { type: 'call_timeout'; timeoutMs: number }
```

Only LLM-backed streaming tools emit it; `communicate` is the first producer. Existing consumers
must ignore unknown chunk types defensively (they already fall through their switches).

## 9. Connector changes

### Web (`packages/web`)

- Render a tool-call timeline from `tool_call_start` and `tool_call_args_delta` chunks in
  `chat/Thread.vue` (currently ignored). Group consecutive tool calls per iteration; show tool name
  and a truncated argument summary. The live timeline is transient; after the stream ends the
  thread reloads and the persisted message's `toolCalls`/`toolResults` provide the durable view.
- Keep the existing reasoning display. At `minimal`, hide reasoning and the timeline; at
  `standard`, show text + progress but not tool arguments or reasoning; at `full`, show everything.
- Web connector sets `maxDetail: 'full'` and passes `detail: 'full'` when it initiates `communicate`
  from the chat composer.
- Render `call_timeout` as a "stopped after Ns" notice.

### Telegram (`repos/legion-connector-telegram-v2`)

- Switch the `communicate` path in `inbound.ts` from `callTool` to `streamTool`.
- Add `maxDetail` to `TelegramConnectorOptions` (default `'standard'`), clamped against the
  requested level.
- Rendering per level: `minimal` = final text only; `standard` = final text plus messages posted
  between tool calls; `full` = adds tool calls and reasoning.
- Render `call_timeout` as a "stopped after Ns" notice.

### Core (`packages/core`)

- `communicate-tool.ts` — new parameters, validation, passthrough, result mapping, `call_timeout`.
- `tools/Tool.ts` — `SendOptions` gains `detail?`, `model?`, `timeoutMs?`; `MessageRouterPort`
  send/sendStream signatures updated; `MessageRouterResult` gains `meta?: { model, usage?, iterations? }`
  and `status` gains `'timeout'`; `RuntimeContext` gains `modelOverride?`.
- `runtime/MessageRouter.ts` — deadline timer, partial persistence on timeout, `status: 'timeout'`,
  model forwarding.
- `runtime/AgentRuntime.ts` — honour `modelOverride`.
- `packages/types/src/streaming.ts` — `DetailLevel`, `call_timeout` chunk.

## 10. Testing

**Core unit**

- Invalid `detail` rejected; invalid `timeoutMs` rejected/clamped; valid values passed through.
- Deadline aborts the stream, persists the partial reply, returns `timeout` + `partial`.
- `call_timeout` chunk emitted before the terminal result.
- `modelOverride` honoured by `AgentRuntime`; unresolvable override fails closed.
- `meta` present only at `full`; absent for `minimal`/`standard`.

**Core integration** (env-gated, `LEGION_INTEGRATION=1`)

- Mock runtime that echoes the requested model, verifying end-to-end override.
- Deadline case over a slow mock runtime.

**Web** (happy-dom)

- Timeline rendering at each detail level; reasoning hidden at `minimal`; timeout notice.

**Telegram**

- `streamTool` path used for `communicate`; level clamping; per-level rendering; timeout notice.

**Gate**

`npm run format:check` → `npm run typecheck` → `npm test` (plus web tests and telegram tests).

## 11. Deferred — phase C

Forwarding nested tool streams so a human watching agent A can see B's activity during A's
`communicate` call:

- `AgentRuntime` would use `ToolRegistry.stream()` instead of `execute()` and forward nested chunks.
- Chunks would need attribution (e.g. `toolCallId`) so transports can group them.
- `detail` requests on agent-initiated calls become live.

Tracked as a follow-on in the roadmap, not part of this design.

## 12. Risks

- **Chunk consumers**: `call_timeout` is a new `LLMChunk`; every consumer must tolerate it. The
  web renderer, Telegram renderer and tests are updated in this phase.
- **Partial persistence on timeout**: the conversation will contain a truncated reply. This mirrors
  the existing cancellation behaviour and is intentional; the tool result makes the truncation
  explicit.
- **Model override credentials**: a caller can request a model the recipient cannot access. Failing
  closed surfaces this as an error rather than silently using the participant's model.
- **Detail is advisory**: a connector with `maxDetail: 'minimal'` renders nothing extra regardless
  of the caller's request. This is by design.

## 13. Rollout

1. Types + core contract + validation + deadline + model override.
2. Core tests (unit + integration).
3. Web timeline rendering + detail clamping.
4. Telegram streaming path + level rendering.
5. Format, typecheck, full test run; review.

Legion work lands on `integration/telegram-v2-and-web-ui`. Telegram work lands on a same-named
branch, `integration/telegram-v2-and-web-ui`, created in `legion-connector-telegram-v2` from its
home branch `connector-v2` (the repo's stable trunk). That gives both repositories an identically
named integration branch that can be reviewed and merged together, rather than merging the
connector work separately.
