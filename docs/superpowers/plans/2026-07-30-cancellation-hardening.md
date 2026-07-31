# Cancellation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close cancellation audit findings 1-7 without expanding stream ownership scope.

**Architecture:** Keep existing composables and middleware transformer. Add transport terminal delivery and cancellation state on client, finalize transformer's emitted draft through normal lifecycle on server, and remove only approvals created by a cancelled unpersisted turn.

**Tech Stack:** TypeScript, Vue 3, Vitest, Fastify/WebSocket

---

### Task 1: Frontend stream lifecycle

**Files:**

- Modify: `packages/web/src/composables/useWebSocket.ts`
- Modify: `packages/web/src/composables/useToolStream.ts`
- Modify: `packages/web/src/composables/useConversation.ts`
- Modify: `packages/web/src/components/conversations/ConversationThread.vue`
- Test: matching `*.test.ts` files

- [ ] Add failing tests proving unmatched terminal buffering, disconnect settlement, `cancelling` UI state, cancellation HTTP/tool error reporting, stale terminal isolation, and conversation reload after reconnect.
- [ ] Run `npm run test --workspace=packages/web -- useWebSocket.test.ts useToolStream.test.ts useConversation.test.ts ConversationThread.test.ts`; confirm failures match missing lifecycle behavior.
- [ ] Add bounded unmatched-frame storage to `useWebSocket`; drain on registration and send `stream:error` to registered handlers before clearing on close.
- [ ] Add generation-scoped handler cleanup and `cancelling: Ref<boolean>` to `useToolStream`; validate cancellation response `{ status: 'success' }` and keep stream active until terminal settlement.
- [ ] Gate composer with `isStreaming || isCancelling`; reload existing conversation after reconnect before restarting watchers.
- [ ] Re-run focused web tests until green.

### Task 2: Middleware-safe partial finalization

**Files:**

- Modify: `packages/core/src/middleware/MiddlewareLifecycle.ts`
- Modify: `packages/core/src/runtime/MessageRouter.ts`
- Test: `packages/core/src/runtime/MessageRouter.test.ts`

- [ ] Add failing router tests for cancellation between chunks, during `push()`, and during `finish()`, asserting final hooks transform/reject/suspend partial output and empty drafts persist nothing.
- [ ] Run `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`; confirm direct append and aborted-transformer failures.
- [ ] Add transformer cancellation finalization method that snapshots current emitted draft, runs final response hooks with a fresh signal, and calls normal `respond` persistence exactly once.
- [ ] Replace `MessageRouter` raw partial accumulator/direct `thread.append()` path with transformer finalization; retain direct normal lifecycle completion only when no middleware transformer exists.
- [ ] Re-run router tests until green.

### Task 3: Cancelled approval cleanup

**Files:**

- Modify: `packages/core/src/auth/PendingApprovalRegistry.ts`
- Modify: `packages/core/src/runtime/AgentRuntime.ts`
- Test: `packages/core/src/auth/PendingApprovalRegistry.test.ts`
- Test: `packages/core/src/runtime/AgentRuntime.test.ts`

- [ ] Add failing tests for removing a specifically created pending approval and for cancellation after creation but before tool-turn persistence.
- [ ] Run `npx vitest run packages/core/src/auth/PendingApprovalRegistry.test.ts packages/core/src/runtime/AgentRuntime.test.ts`; confirm approvals remain orphaned.
- [ ] Add registry method that atomically deletes only a matching pending record and rejects decided/resuming records.
- [ ] Track current-turn approval IDs in `AgentRuntime`; on pre-persistence cancellation, remove those IDs before returning `middleware_abort`; leave persisted turns unchanged.
- [ ] Re-run focused core tests until green.

### Task 4: Follow-ups and verification

- [ ] Create two GitLab issues: stream cancellation ownership validation; navigation-time stream ownership/leaks.
- [ ] Review diff against `docs/superpowers/specs/2026-07-30-cancellation-hardening-design.md`; remove out-of-scope changes.
- [ ] Run `npm run format:check`, `npm run typecheck`, `npm test`, and `npm run test --workspace=packages/web` in required order.
- [ ] Commit only intended source, tests, docs; push feature branch; update draft MR !3 with behavior and verification results.
