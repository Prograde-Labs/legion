---
status: draft
rigor:
  tests: tdd
  review: spec+code
  review_at: per-task
  execution: inline
  rereview: always
  triggers_fired: [concurrency]
---

# Post-merge cleanup: de-duplicate `unlessAborted`, drop redundant `approved` field

Follow-up to review of MR !3 (`feat/chat-stop-button`, merged as `39ab15a`).
Two small refactors flagged as non-blocking findings; extracted here so the
stop-button MR stays a pure behavior change.

## Intent

- **Problem:** MR !3 left (a) a byte-identical `unlessAborted` private method in
  two files and (b) a second maintained `approved` draft state in
  `MiddlewareLifecycle` that is always equal to `emitted` at every read site.
- **Behavior change:** none. Pure refactor — same observable behavior, same
  public API (except: `approved` is internal-only and goes away).
- **Out of scope:** the third flagged finding (shared approval-event emitter
  in `AgentRuntime`) — deliberately deferred to its own future task; see Open
  Questions.
- **Done when:**
  - `grep -rn "private async unlessAborted" packages/core/src` returns 0 hits;
    both call sites import the shared helper from `packages/core/src/util/abort.ts`.
  - `grep -n "this.approved" packages/core/src/middleware/MiddlewareLifecycle.ts`
    returns 0 hits; `finalizePartialInner()` reads `this.emitted`.
  - Full suite green on all three gates: `npm run typecheck`, `npm test`
    (core ≥ 1018/0), `npm run test --workspace=packages/web` (157/0).
  - No diff in emitted chunk sequences for the covered stop/partial paths
    (existing tests assert persisted content + `finalCalls` counts; any
    behavior drift fails the suite).

## Open Questions

- [ ] Should the third review finding (shared approval-event emitter in
      `AgentRuntime.ts`) be a task in this work file or its own future file?
      Proposed: its own future file — it touches event-payload shape and is a
      behavior-adjacent change, not a pure refactor.
- [ ] Branch name suggestion: `refactor/cancellation-cleanup-followup`. OK?

## Unknowns

- [x] Where do the two `unlessAborted` copies live, and are they identical?
      → `packages/core/src/runtime/MessageRouter.ts:144` and
      `packages/core/src/middleware/MiddlewareLifecycle.ts:556`; verified
      byte-identical (same signature, same 20-line body).
- [x] Is a shared location import-legal for both callers?
      → Yes. `packages/core/src/util/` already exists (`ids.ts`), exported via
      `packages/core/src/index.ts:7` (`export * from './util/ids.js'`). Both
      `runtime/` and `middleware/` live inside `core`, so a `core/util`
      import from either is no import-direction violation.
- [x] Is `approved` truly redundant?
      → Verified by tracing every write/read site in
      `packages/core/src/middleware/MiddlewareLifecycle.ts`: writes at 384, 415,
      440, 499, 542 all assign a value equal to the corresponding `emitted`
      state; the only mutation that could diverge them (`retract()`, line 588)
      executes only after `finalizePartialInner()` (line 523) has read
      `approved`. No test references the field
      (grep `\.approved` in `*.test.ts` hits are `ApprovalDecision.approved`,
      a different type).
- [x] Does anything outside `MiddlewareLifecycle` read the `approved` field?
      → No. It is `private`; no test or other file references it.

## Tasks

- [ ] 1. Extract shared `unlessAborted` helper
      Create `packages/core/src/util/abort.ts` exporting
      `unlessAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | undefined>`
      (body = the current byte-identical copy). Add a new `abort.test.ts`
      covering: already-aborted signal returns undefined without awaiting the
      operation; abort during operation resolves to undefined and removes the
      listener; non-aborted completes the operation. Export from
      `packages/core/src/index.ts`. Delete both private copies and import the
      helper in both files.
      files: packages/core/src/util/abort.ts, packages/core/src/util/abort.test.ts,
      packages/core/src/index.ts, packages/core/src/runtime/MessageRouter.ts,
      packages/core/src/middleware/MiddlewareLifecycle.ts
- [ ] 2. Drop the redundant `approved` draft state
      In `packages/core/src/middleware/MiddlewareLifecycle.ts`: delete the
      `private approved` field (line 369) and its five write sites (384, 415,
      440, 499, 542); change `finalizePartialInner()` (line 523) to
      `structuredClone(this.emitted)`. Update/extend
      `MiddlewareLifecycle.test.ts` so the partial-finalization assertions pin
      the emitted-draft semantics explicitly (the existing assertions already
      pin behavior; add a case asserting `finalizePartial` output equals the
      last-approved draft when content and reasoning both flowed).
      files: packages/core/src/middleware/MiddlewareLifecycle.ts,
      packages/core/src/middleware/MiddlewareLifecycle.test.ts

## Log

- 2026-09-01: Work file created from MR !3 review findings
  (`docs/reviews/2026-09-01-mr3-chat-stop-button.md`). All unknowns resolved
  during review with file:line evidence above. Awaiting Chris's approval.
