# Code Review — MR !3 `feat/chat-stop-button` (chat stop + cancellation hardening)

**Reviewer:** Mirak (bot) · **Branch:** `main (2b6dec1) … 8659e54` · **Date:** 2026-09-01

## Verdict: size is justified — this works _with_ the existing architecture, not against it

The concern that a ~1,700-line MR is "ramming changes down the top" is understandable, but on close reading the change is architecturally conservative:

- The in-repo design doc (`docs/superpowers/specs/2026-07-30-cancellation-hardening-design.md`) explicitly constrains itself: _"Keep existing composables and middleware transformer."_ The code honors that.
- The only new **core** API surface is two small, idiomatic methods: `ResponseStreamTransformer.finalizePartial()` and `PendingApprovalRegistry.discardUnpersisted()`. Everything else reuses existing primitives: `AbortSignal`, the existing draft transformer, `eventBus`, the existing `cancel_stream` tool, and the existing `ConnectorContext.callTool`. No new subsystem, no new package, no new wiring.
- **~1,000 of the 1,689 added lines are tests** (+2 docs). Net behavioral code is much smaller than the raw stat.
- Package boundaries respected (`types ← core ← runtime/web`); `Connector.ts` change is a backward-optional extension.

**Why it can't be much smaller:** "Stop" is inherently cross-cutting. A stopped stream must (a) settle client transport/lifecycle state, (b) finalize the _partial_ response **through the policy pipeline** rather than bypass it, and (c) clean up approvals created by a turn that never persisted. That necessarily spans client composables + stream transformer + router + agent runtime + approval registry. The client grew because the stop button _exposed pre-existing gaps_ (unresolved stream promises on socket close, stale-terminal clobbering, no cancellation state) — not new scope. Proportionate, not bloated.

## Findings

### ⚠️ Worth fixing (small, safe) — suggest a follow-up MR

1. **`unlessAborted()` is copy-pasted verbatim** — byte-identical in `packages/core/src/runtime/MessageRouter.ts:144` and `packages/core/src/middleware/MiddlewareLifecycle.ts:556`. Move to one shared helper (e.g. `packages/core/src/util/abort.ts` — no import-direction violation).
2. **`approved` field is dead weight** in `ResponseStreamTransformerImpl`. I traced every write site: `this.approved` equals `this.emitted` at all reachable states, and the only mutation that would diverge them (`retract()`) runs only _after_ `finalizePartial()` has already read it. `finalizePartialInner()` (MiddlewareLifecycle.ts:523) could use `this.emitted` directly. Net: ~8 lines of a second maintained state carrying no distinct information.
3. **Approval events re-implemented by hand** in `AgentRuntime.ts` (~456–475) instead of reusing the `ToolRegistry` emission path used for auto-approved tools. Justified (approval tools bypass `ToolRegistry`), but now a third place emitting `tool:call`/`tool:result`/`approval:requested` — worth a comment or a small shared emitter.

### 💡 Suggestions

- **Split the two pure refactors** (items 1–2) into a small follow-up MR rather than bundling; keeps this MR reviewable as a behavior change.
- **Merge !2 before !3** — independent fast-forwards off main; `!2` first keeps history clean.

### ✅ Verified OK (concerns checked and closed)

- **Partial persistence does NOT bypass the policy pipeline.** `finalizePartialInner()` runs `runResponseDraft` (final hooks: transform/reject/suspend) then `lifecycle.respond()` (persistence + approval logic) with a **fresh signal** — the aborted runtime signal is deliberately not reused so the pipeline isn't auto-cancelled. This is the crux of the MR and it's correct.
- **Approval consistency:** `approval:requested` is correctly deferred until _after_ `conversation.append()` makes the tool-call turn durable (the old code emitted it before persistence — a real latent bug this fixes). `discardUnpersisted()` touches only IDs created in the current iteration and uses atomic `mutate()`.
- **No double-finalization:** `finalizePartial()` is memoized (`partialFinalization ??=`).
- **Success path unchanged:** normal `finish()` → `respond` still sets `streamFinished`; cleanup at MessageRouter.ts:821–824 correct.
- **Test quality is real, not tautological:** new tests assert on _persisted_ conversation content, `finalCalls` counts, `listPending()` emptiness, and generation-scoped terminal isolation — each would fail if its branch were deleted/inverted.

## Evidence (ran on branch `8659e54`)

| Gate                               | Result                                              |
| ---------------------------------- | --------------------------------------------------- |
| `typecheck`                        | ✅ pass                                             |
| `format:check` on MR-touched files | ✅ pass                                             |
| core `npm test`                    | ✅ 1017 passed / 0 (16 skipped = gated integration) |
| web `npm test`                     | ✅ 157 passed / 0                                   |

**Recommendation:** approve (merge !2 first). Open one small follow-up MR for the two refactors.
