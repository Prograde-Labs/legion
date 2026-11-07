# Legion — Post-MVP Roadmap

**Date:** 2026-11-05
**Status:** Draft (triage only — not an implementation plan)
**Source:** `docs/notes/legion-wishlist.md` (workspace notes, 2026-11-05)
**Scope:** Post-MVP wishlist. The v2 build sequence (Plans 1–11) is tracked in
[`000-roadmap.md`](./000-roadmap.md); this document covers what comes after.

---

## Purpose

This is a priority/triage document, not a plan. It maps each wishlist item to the current
code, records the dependencies between items, and proposes an order. Each item gets its own
brainstorm → spec → plan cycle when it is picked up.

---

## Current-state snapshot

What exists today, relevant to the wishlist:

- **`communicate`** (`packages/core/src/tools/communicate-tool.ts`) accepts only `to`,
  `message`, `conversationId?`, `replyTo?`. Model selection is per-participant via
  `ModelRouter`; there is no per-call override, no response-detail mode, and no
  tool-selection hint.
- **EventBus** (`packages/core/src/events/EventBus.ts`) is a typed synchronous pub/sub
  threaded through `ToolContext`, `RuntimeContext`, `MessageRouter`, `Collective`,
  `AgentRuntime`, `ToolRegistry`, `UserDeliveryRuntime` and `LegionProcess`. Its only
  subscribers are the `watch_*` streaming tools. Telegram v2 does not use it; `WebConnector`
  holds a reference but never subscribes.
- **Streams** — `AsyncQueue` (`packages/core/src/streaming/AsyncQueue.ts`) is a push→pull
  bridge used only by `watch_*`; `StreamRegistry` tracks one `AbortController` per transport
  stream. There is no general owned-stream abstraction.
- **AuthEngine** (`packages/core/src/auth/AuthEngine.ts`) — `authorize(participantId, tool,
args, policies)` and `hasAuthority(...)` both accept and ignore `args` and
  `participantId`. Policies are per-tool only; visibility is the participant's `tools` map.
- **Connectors** — core contract is `start/deliver/stop` over
  `submit/callTool/streamTool`. Telegram v2 is implemented
  (`repos/legion-connector-telegram-v2`). No Teams or Slack code exists. `LegionProcess`
  registers only `WebConnector` and has no external connector loader, despite
  `ConnectorConfig` existing.
- **Web UI** (`packages/web`) — Vue 3 + Vite + Tailwind. Module-level singleton WebSocket;
  pending stream chunks capped at 100 and dropped on disconnect (no replay); design spec
  (`docs/superpowers/specs/2026-06-14-plan11-web-spa-design.md`) is stale about chat and
  approval scope.

---

## Items, priority and dependencies

| #   | Item                               | Priority | Depends on                   | Size         | Notes                                                       |
| --- | ---------------------------------- | -------- | ---------------------------- | ------------ | ----------------------------------------------------------- |
| 2   | `communicate` flexibility          | **P0**   | —                            | Medium       | Unblocks 1, 4, 5. Interface change others consume.          |
| 6   | AuthEngine: argument scope control | **P1**   | —                            | Medium       | Design jointly with 7; same policy layer.                   |
| 7   | Participant contact/group control  | **P1**   | 6 (shared mechanism)         | Medium       | Reuse "hidden = absent from map" pattern for the directory. |
| 3   | EventBus removal / owned streams   | **P1**   | 2 (stable surface)           | Large        | Wide refactor; only `watch_*` subscribe today.              |
| 4   | Teams connector                    | **P2**   | 2, external connector loader | Medium-Large | Telegram v2 is the template. Loader is a prerequisite.      |
| 5   | Web UI polish                      | **P2**   | 2 (richer response detail)   | Medium       | Replay-on-reconnect, responsive layout, customization.      |
| 1   | CLI agent participants             | **P3**   | 2                            | Large        | Most open-ended; new participant driver surface.            |

### Why this order

1. **#2 first.** It changes the `communicate` contract that connectors, the web UI, and any
   future participant driver consume. Doing it first avoids retrofitting renderers twice.
2. **#6 + #7 as one policy-layer design.** Both need policy evaluation to see more than the
   tool name. Splitting them means building the same evaluation context twice.
3. **#3 after #2.** Owned streams should be designed against a stable tool-result/chunk
   shape. Removing the bus is wide but shallow: the only real subscribers are `watch_*`, so
   the work is defining the abstraction and rethreading contexts, not untangling logic.
4. **#4 and #5.** Both are consumers of #2's richer call/response metadata. #4 additionally
   needs the external connector loader wired into `LegionProcess`.
5. **#1 last or parallel.** No existing flow to extend; it needs its own design pass on how
   CLI agents map to participants (process lifecycle, tool bridging, auth identity).

---

## Item detail

### #2 — `communicate` tool flexibility

Wishlist asks: additional parameters (response detail, model override, etc.), and response
detail surfaced through connectors for better visibility into what a participant is doing.

Current gaps:

- No `detail` / verbosity control on the response returned to the caller.
- No per-call model override (only the participant's configured model).
- No way to ask the recipient for a specific shape of answer.
- Connectors render only the final string; intermediate tool calls and reasoning are
  available in chunks but not structured for display.

Open design questions (for the brainstorm):

- Which parameters are core semantics vs connector presentation hints?
- Does a model override belong on `communicate`, or on the participant/tool policy?
- Should "detail" control what the LLM sees in the tool result, or only what connectors
  render (or both)?
- How do these parameters compose with `replyTo` (fire-and-forget) and approval flows?

**Landed** (2026-11-05, `integration/telegram-v2-and-web-ui` in legion and
`feat/communicate-detail` in `legion-connector-telegram-v2`):

- Contract: `communicate` accepts `detail` (`'minimal' | 'standard' | 'full'`), `model` and
  `timeoutMs`; the tool result stays lean (`conversationId`, `response`, `status`) at every
  level and only adds `meta` at `full` — `detail` is a presentation hint, not a result trimmer.
- Core plumbing: per-call deadline with partial-result persistence, a `call_timeout` stream
  chunk, run metadata on `MessageRouterResult`, and a per-call model override
  (`RuntimeContext.modelOverride`).
- Rendering: the web UI shows a per-iteration tool-call timeline gated by `detail`, and the
  Telegram connector streams calls and renders each detail level.

Phase C (nested tool-stream forwarding, so an agent-initiated `detail` request has a live
effect on the caller's stream) remains open — see
`docs/superpowers/specs/2026-11-05-communicate-detail-design.md` §11.

### #6 — AuthEngine argument scope control

`authorize()` and `hasAuthority()` already take `args` but ignore them. Needed:

- A policy schema for argument constraints (allowed values, path prefixes, size caps, etc.).
- An enforcement point in `ToolRegistry`/`AgentRuntime` before execution.
- Approval semantics when args fail scope: deny, or escalate?

**Landed** (2026-11-06, `feat/auth-argument-scope`):

- `ToolPolicy` accepts an object form `{ policy, scope? }`; legacy string policies still
  work.
- Scope constraints: `required`, `enum`, `pattern`, `minLength`/`maxLength`, `min`/`max`,
  and `pathPrefix` with resolved containment under the workspace root.
- Enforcement at every `AuthEngine.authorize` site, including a re-check on approval
  resume; a violation is a structured error and is never approvable.
- `set_tool_policy` accepts a `scope`; agent and user create/modify tools validate the
  object form; `list_tools` returns normalized policies and tool parameter schemas.
- The web `ToolPolicyEditor` can add, edit, and clear scopes.

Deferred: scoped approval authority, nested argument paths, multiple allowed roots, and
re-validating stored configs at boot.

### #7 — Participant contact/group control

- Grouping system for participants.
- Directory visibility filtered per participant, reusing the "hidden = absent" pattern.
- Enforcement on `communicate` targets, not just UI filtering.

### #3 — EventBus removal, owned streams

- Define a general owned-stream abstraction (beyond `AsyncQueue`).
- Migrate `watch_*` tools onto it.
- Remove `eventBus` from `ToolContext`, `RuntimeContext`, `MessageRouter` ctor, etc.
- Decide whether web UI activity/topology views read streams instead of bus events.
- Safety/recovery requirement: streams must be recoverable across reconnects, unlike today's
  100-chunk cap with no replay.

### #4 — Teams connector

- Reuse Telegram v2 structure: `Connector` implementation, inbound command handling,
  outbound rendering, approval cards.
- Prerequisite: external connector loader in `LegionProcess`.
- Open question: Microsoft Graph API directly vs Agents SDK (bot hosting/ergonomics vs
  lock-in).

### #5 — Web UI polish

- WebSocket replay on reconnect; drop the 100-chunk cap or make it a durable buffer.
- Responsive layout across devices.
- Customization options; richer rendering of tool activity (ties to #2).
- Update the stale Plan 11 spec.

### #1 — CLI agent participants

- Support CLI-driven agents (OpenCode, Claude, Codex, Copilot, Pi, etc.) as participants.
- Needs design for process lifecycle, tool bridging, streaming output parsing, and auth
  identity.
- `ProcessManager` is the likely seam, but participant semantics are not defined yet.

---

## Decisions to make before work starts

1. Confirm the priority order above, especially whether #3 should precede #4/#5.
2. Confirm #6 and #7 are one design effort.
3. Decide the first item to design (recommended: #2, started on the integration thread).
