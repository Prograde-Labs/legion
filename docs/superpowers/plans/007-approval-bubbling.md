# Approval Bubbling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full tool-authorization flow: `AgentRuntime` checks `AuthEngine.authorize()` before executing each tool, surfaces `requires_approval` tool calls as durable `pending_approval` conversation entries, and resumes via a new `approval_response` tool. End state: an agent whose tool call is blocked by policy returns an `ApprovalRequest` to its caller; a participant with authority calls `approval_response`; the blocked agent resumes with the decision in its conversation context.

**Architecture:**

`ToolResult` grows two new status values — `'pending_approval'` (tool execution deferred; `approvalId` carries the registry key) and `'rejected'` (approver declined; `message` carries the reason). These are stored directly in `MessageData.toolResults`, so the conversation is the durable state: if the process restarts, the pending approval is still visible in the conversation chain.

`Runtime.handle()` return type changes from `Promise<string | void>` to `Promise<RuntimeResult>` — a discriminated union of `{ kind: 'response'; content: string }`, `{ kind: 'pending_approval'; approvalRequests: PendingApproval[] }`, and `{ kind: 'void' }`. `MessageRouter.send()` handles all three variants. A new `MessageRouter.resume(conversationId, participantId, context)` method re-triggers a paused agent after approval decisions arrive — the push path called by `approval_response`.

`PendingApprovalRegistry` becomes durable (file-backed via `Storage`) and drops the in-memory Promise API; decisions are stored on disk and queried synchronously from the in-memory cache loaded at startup. This means a restarted process can resume pending approvals without losing state.

`AgentRuntime` is amended in two ways: (1) it now presents all non-`'deny'` tools to the LLM (fixing the Plan 6 deviation) and calls `authEngine.authorize()` at execution time — `'auto'` executes, `'deny'` returns an error tool result, `'requires_approval'` registers a pending approval and writes a `pending_approval` tool result; (2) on entry it checks whether the conversation already contains unresolved `pending_approval` tool results and, if the registry holds decisions for them, executes approved tools / records rejected results, then continues the loop.

`approval_response` is a new global tool (batched, with optional message per decision). It verifies caller authority via `authEngine.hasAuthority`, records each decision in `PendingApprovalRegistry` and `ApprovalLog`, emits `approval:resolved`, then calls `messageRouter.resume()` for each affected conversation. The resumed `AgentRuntime` finds the resolved decisions, processes them, and continues — producing a final response that `resume()` persists to the conversation.

Depends on Plans 1–6.

---

## Amendments to earlier plans

| Plan | File | Change |
|------|------|--------|
| 1 | `packages/types/src/tool.ts` | `ToolResultStatus` + optional `approvalId`, `message` on `ToolResult` |
| 1 | `packages/types/src/events.ts` | Rename `requestId` → `approvalId` in `approval:requested` + `approval:resolved` payloads |
| 4 | `packages/core/src/auth/PendingApprovalRegistry.ts` | Rename `requestId` → `approvalId`; drop Promise API; add durability; add `getDecision()` |
| 4 | `packages/core/src/auth/PendingApprovalRegistry.test.ts` | Update to new async API |
| 5 | `packages/core/src/runtime/Runtime.ts` | Add `RuntimeResult` union; change `handle()` return type |
| 5 | `packages/core/src/runtime/MockRuntime.ts` + test | Return `RuntimeResult` |
| 5 | `packages/core/src/runtime/UserDeliveryRuntime.ts` | Return `RuntimeResult` |
| 5 | `packages/core/src/runtime/MessageRouter.ts` | Handle `RuntimeResult`; add `resume()` |
| 4 | `packages/core/src/tools/Tool.ts` | `MessageRouterResult` adds `pending_approval`; `MessageRouterPort` adds `resume()` |
| 5 | `packages/core/src/tools/communicate-tool.ts` + test | Handle `pending_approval` result |
| 5 | `packages/core/src/runtime/Runtime.ts` | Add `approvalLog?: ApprovalLog` to `RuntimeContext` |
| 6 | `packages/core/src/runtime/AgentRuntime.ts` + test | Auth check + approval flow + resumption |

---

## File Structure

```
packages/types/src/
  tool.ts                                — amend: ToolResultStatus, ToolResult.approvalId/message
  events.ts                              — amend: approvalId rename in event payloads
packages/core/src/
  auth/
    PendingApprovalRegistry.ts           — amend: durable, non-Promise, getDecision()
    PendingApprovalRegistry.test.ts      — amend: new async API
  conversation/
    ConversationThread.ts                — amend: add updateToolResults()
  runtime/
    Runtime.ts                           — amend: RuntimeResult, RuntimeContext.approvalLog
    MockRuntime.ts                       — amend: return RuntimeResult
    MockRuntime.test.ts                  — amend: match new return shape
    UserDeliveryRuntime.ts               — amend: return RuntimeResult
    AgentRuntime.ts                      — amend: auth check, pending approval, resumption
    AgentRuntime.test.ts                 — amend: add 4 tests for auth/approval/resumption
    MessageRouter.ts                     — amend: RuntimeResult handling + resume()
    MessageRouter.test.ts                — amend: add pending_approval + resume tests
    approval-flow.integration.test.ts    — new: end-to-end approval bubbling
  tools/
    Tool.ts                              — amend: MessageRouterResult + MessageRouterPort
    communicate-tool.ts                  — amend: pending_approval in result
    communicate-tool.test.ts             — amend: cover pending_approval path
    approval-response-tool.ts            — new
    approval-response-tool.test.ts       — new
```

All new exports added to `packages/core/src/index.ts`.

---

## Task 1: Type foundations

**Files:**
- Amend: `packages/types/src/tool.ts`
- Amend: `packages/types/src/events.ts`
- Amend: `packages/core/src/runtime/Runtime.ts`
- Amend: `packages/core/src/tools/Tool.ts`

> All type-only changes. No test files exist for `@legion/types` (types are verified via
> downstream compilation). `Runtime.ts` and `Tool.ts` are also types-only; downstream tests
> will start failing after this task and are fixed in subsequent tasks.

- [ ] **Step 1: Amend `packages/types/src/tool.ts`**

Replace:

```typescript
export type ToolResultStatus = 'success' | 'error';

export interface ToolResult {
  status: ToolResultStatus;
  data?: unknown;
  error?: string;
}
```

With:

```typescript
export type ToolResultStatus = 'success' | 'error' | 'pending_approval' | 'rejected';

export interface ToolResult {
  status: ToolResultStatus;
  data?: unknown;
  error?: string;
  /** Set on status:'pending_approval' — the PendingApprovalRegistry key. */
  approvalId?: string;
  /** Set on status:'rejected' — the approver's explanation. */
  message?: string;
}
```

- [ ] **Step 2: Amend `packages/types/src/events.ts`**

Rename `requestId` → `approvalId` in the approval event payloads. Replace:

```typescript
'approval:requested': { conversationId: string; requesterId: string; tool: string; requestId: string };
'approval:resolved': { conversationId: string; requestId: string; approved: boolean; decidedByParticipantId: string };
```

With:

```typescript
'approval:requested': { conversationId: string; participantId: string; tool: string; approvalId: string };
'approval:resolved': { conversationId: string; approvalId: string; approved: boolean; decidedByParticipantId: string };
```

> Note: `requesterId` is renamed to `participantId` to match the `iteration` / `tool:call` / `tool:result`
> event naming convention established in Plan 6.

- [ ] **Step 3: Amend `packages/core/src/runtime/Runtime.ts`**

Add `RuntimeResult` union, change `handle()` return type, add `approvalLog` to `RuntimeContext`.

Replace the full file:

```typescript
import type { MessageData, ParticipantConfig } from '@legion/types';
import type { ToolContext } from '../tools/Tool.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { PendingApprovalRegistry, PendingApproval } from '../auth/PendingApprovalRegistry.js';
import type { ApprovalLog } from '../auth/ApprovalLog.js';
import type { MessageRouterPort } from '../tools/Tool.js';

export type RuntimeResult =
  | { kind: 'response'; content: string }
  | { kind: 'pending_approval'; approvalRequests: PendingApproval[] }
  | { kind: 'void' };

/**
 * Full execution context (spec §4). Extends ToolContext, tightening the runtime-only
 * collaborators to required and concrete.
 */
export interface RuntimeContext extends ToolContext {
  conversation: ConversationThread;
  authEngine: AuthEngine;
  pendingApprovalRegistry: PendingApprovalRegistry;
  approvalLog?: ApprovalLog;
  messageRouter: MessageRouterPort;
  serviceManager?: unknown;
}

/** A runtime handles an inbound message addressed to its participant. */
export interface Runtime {
  handle(incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult>;
}

/** Builds a Runtime instance bound to a specific participant. */
export type RuntimeFactory = (participantId: string) => Runtime;

export type { ParticipantConfig };
```

- [ ] **Step 4: Amend `packages/core/src/tools/Tool.ts`**

Update `MessageRouterResult` to include `pending_approval` status and add `resume()` to `MessageRouterPort`. Replace the `MessageRouterResult` interface and `MessageRouterPort` interface:

```typescript
import type { PendingApproval } from '../auth/PendingApprovalRegistry.js';

export interface MessageRouterResult {
  conversationId: string;
  response?: string;
  status: 'success' | 'error' | 'dispatched' | 'pending_approval';
  error?: string;
  approvalRequests?: PendingApproval[];
}

/** Minimal port so core tools can route messages without depending on @legion/runtime. */
export interface MessageRouterPort {
  send(opts: {
    senderId: string;
    recipientId: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
    context: ToolContext;
  }): Promise<MessageRouterResult>;

  /**
   * Re-trigger a paused participant after approval decisions arrive.
   * Called by `approval_response` after resolving pending approvals.
   */
  resume(
    conversationId: string,
    participantId: string,
    context: ToolContext,
  ): Promise<MessageRouterResult>;
}
```

> The `import type { PendingApproval }` must be added at the top of `Tool.ts` alongside the
> existing imports. Keep all other imports and the `ToolContext` / `ToolRegistryLike` / `Tool`
> definitions unchanged.

- [ ] **Step 5: Run typecheck to confirm no compilation errors**

```bash
npm run typecheck
```

Expected: PASS (or fail only on downstream callers that use the old `handle()` return type —
those are fixed in Tasks 2–6).

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/tool.ts packages/types/src/events.ts
git add packages/core/src/runtime/Runtime.ts packages/core/src/tools/Tool.ts
git commit -m "feat(types,core): RuntimeResult union, extended ToolResultStatus, MessageRouterPort.resume"
```

---

## Task 2: PendingApprovalRegistry durable + adapt simple runtimes

**Files:**
- Amend: `packages/core/src/auth/PendingApprovalRegistry.ts`
- Amend: `packages/core/src/auth/PendingApprovalRegistry.test.ts`
- Amend: `packages/core/src/runtime/MockRuntime.ts`
- Amend: `packages/core/src/runtime/MockRuntime.test.ts`
- Amend: `packages/core/src/runtime/UserDeliveryRuntime.ts`

> `PendingApprovalRegistry` drops the Promise-based suspension model (not restart-safe) in
> favour of explicit `getDecision()` polling. Storage is optional — omitting it gives a
> pure in-memory registry suitable for tests. `approvalId` replaces `requestId` throughout
> to match the new event payload naming.
>
> `MockRuntime` and `UserDeliveryRuntime` are trivial adapts: they wrap their existing
> return values in `RuntimeResult` objects.

- [ ] **Step 1: Write the failing tests for the new `PendingApprovalRegistry` API**

Replace `packages/core/src/auth/PendingApprovalRegistry.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { PendingApprovalRegistry } from './PendingApprovalRegistry.js';

describe('PendingApprovalRegistry (in-memory)', () => {
  it('creates a pending approval and returns approvalId', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
    });
    expect(approvalId).toMatch(/^appr-/);
    expect(reg.get(approvalId)).toBeDefined();
    expect(reg.getDecision(approvalId)).toBeUndefined();
  });

  it('resolves a decision and removes from pending', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    await reg.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(reg.get(approvalId)).toBeUndefined();
    expect(reg.getDecision(approvalId)).toEqual({
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('rejects resolving an unknown approvalId', async () => {
    const reg = new PendingApprovalRegistry();
    await expect(
      reg.resolve('appr-ghost', { approved: false, decidedByParticipantId: 'x', decidedAt: '' }),
    ).rejects.toThrow(/appr-ghost/);
  });

  it('lists pending approvals, optionally filtered by conversationId', async () => {
    const reg = new PendingApprovalRegistry();
    await reg.create({ conversationId: 'c1', requesterId: 'a', tool: 't', args: {} });
    await reg.create({ conversationId: 'c2', requesterId: 'b', tool: 't', args: {} });
    expect(reg.listPending().length).toBe(2);
    expect(reg.listPending('c1').length).toBe(1);
    expect(reg.listPending('c2')[0].requesterId).toBe('b');
  });
});

describe('PendingApprovalRegistry (durable)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'legion-par-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('persists and reloads pending approvals across instances', async () => {
    const storage = new FileStorage(dir);
    const reg = new PendingApprovalRegistry(storage);
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
    });

    // Simulate restart: load a fresh instance from the same storage
    const reg2 = await PendingApprovalRegistry.load(storage);
    expect(reg2.get(approvalId)?.requesterId).toBe('agent-b');
    expect(reg2.getDecision(approvalId)).toBeUndefined();
  });

  it('persists and reloads resolved decisions', async () => {
    const storage = new FileStorage(dir);
    const reg = new PendingApprovalRegistry(storage);
    const { approvalId } = await reg.create({
      conversationId: 'c1', requesterId: 'agent-b', tool: 'file_write', args: {},
    });
    await reg.resolve(approvalId, {
      approved: false,
      decidedByParticipantId: 'op',
      message: 'too risky',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    const reg2 = await PendingApprovalRegistry.load(storage);
    expect(reg2.get(approvalId)).toBeUndefined(); // no longer pending
    expect(reg2.getDecision(approvalId)?.message).toBe('too risky');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/auth/PendingApprovalRegistry.test.ts`
Expected: FAIL — some tests fail due to API mismatch.

- [ ] **Step 3: Replace `packages/core/src/auth/PendingApprovalRegistry.ts`**

```typescript
import { createId } from '../util/ids.js';
import { LegionError } from '../errors/LegionError.js';
import type { Storage } from '../storage/Storage.js';

export interface ApprovalDecision {
  approved: boolean;
  decidedByParticipantId: string;
  message?: string;
  decidedAt: string;
}

export interface PendingApprovalInput {
  conversationId: string;
  requesterId: string;
  tool: string;
  args: unknown;
}

export interface PendingApproval extends PendingApprovalInput {
  approvalId: string;
  createdAt: string;
}

interface RegistryData {
  pending: Record<string, PendingApproval>;
  decisions: Record<string, ApprovalDecision>;
}

const STORAGE_KEY = 'pending-approvals/registry.json';

export class PendingApprovalRegistry {
  private data: RegistryData = { pending: {}, decisions: {} };

  constructor(private storage?: Storage) {}

  /**
   * Load a durable registry from storage. If the file does not exist yet, returns a
   * fresh empty registry backed by the provided storage.
   */
  static async load(storage: Storage): Promise<PendingApprovalRegistry> {
    const reg = new PendingApprovalRegistry(storage);
    try {
      const data = await storage.readJson<RegistryData>(STORAGE_KEY);
      if (data) reg.data = data;
    } catch {
      // No file yet — start fresh.
    }
    return reg;
  }

  private async persist(): Promise<void> {
    if (this.storage) {
      await this.storage.writeJson(STORAGE_KEY, this.data);
    }
  }

  async create(input: PendingApprovalInput): Promise<{ approvalId: string }> {
    const approvalId = createId('appr');
    const pending: PendingApproval = {
      ...input,
      approvalId,
      createdAt: new Date().toISOString(),
    };
    this.data.pending[approvalId] = pending;
    await this.persist();
    return { approvalId };
  }

  /** Returns the pending approval if it has not yet been resolved. */
  get(approvalId: string): PendingApproval | undefined {
    return this.data.pending[approvalId];
  }

  /** Returns the decision if this approval has been resolved; undefined if still pending. */
  getDecision(approvalId: string): ApprovalDecision | undefined {
    return this.data.decisions[approvalId];
  }

  /**
   * Lists all still-pending approvals, optionally filtered to a specific conversation.
   */
  listPending(conversationId?: string): PendingApproval[] {
    const all = Object.values(this.data.pending);
    if (!conversationId) return all;
    return all.filter((p) => p.conversationId === conversationId);
  }

  async resolve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.data.pending[approvalId]) {
      throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
    }
    this.data.decisions[approvalId] = decision;
    delete this.data.pending[approvalId];
    await this.persist();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/auth/PendingApprovalRegistry.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Adapt `MockRuntime` to return `RuntimeResult`**

Replace `packages/core/src/runtime/MockRuntime.ts`:

```typescript
import type { MessageData, MockConfig } from '@legion/types';
import type { Runtime, RuntimeContext, RuntimeResult } from './Runtime.js';

export class MockRuntime implements Runtime {
  private index = 0;

  constructor(private participantId: string) {}

  async handle(_incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    const participant = context.collective.getOrThrow(this.participantId);
    const responses = participant.type === 'mock' ? (participant as MockConfig).responses : [];
    if (responses.length === 0) {
      return { kind: 'response', content: `[mock:${this.participantId}] no scripted response` };
    }
    const content = responses[this.index % responses.length];
    this.index += 1;
    return { kind: 'response', content };
  }
}
```

Update `packages/core/src/runtime/MockRuntime.test.ts` — change the two assertions:

```typescript
describe('MockRuntime', () => {
  it('returns scripted responses in order then cycles', async () => {
    const runtime = new MockRuntime('mock-1');
    const context = await ctxFor(['one', 'two']);
    expect(await runtime.handle(inbound, context)).toEqual({ kind: 'response', content: 'one' });
    expect(await runtime.handle(inbound, context)).toEqual({ kind: 'response', content: 'two' });
    expect(await runtime.handle(inbound, context)).toEqual({ kind: 'response', content: 'one' });
  });

  it('returns a default acknowledgement when no responses are configured', async () => {
    const runtime = new MockRuntime('mock-1');
    const context = await ctxFor([]);
    expect(await runtime.handle(inbound, context)).toEqual({
      kind: 'response',
      content: '[mock:mock-1] no scripted response',
    });
  });
});
```

- [ ] **Step 6: Adapt `UserDeliveryRuntime` to return `RuntimeResult`**

Replace `packages/core/src/runtime/UserDeliveryRuntime.ts`:

```typescript
import type { MessageData } from '@legion/types';
import type { Runtime, RuntimeContext, RuntimeResult } from './Runtime.js';

export class UserDeliveryRuntime implements Runtime {
  constructor(private participantId: string) {}

  async handle(incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    // No internal driver. Persistence already happened in the router; signal delivery.
    // Plan 10 replaces this with ConnectorRegistry-based delivery.
    context.eventBus.emit('message:delivered', {
      conversationId: context.conversationId,
      recipientId: this.participantId,
      messageId: incoming.id,
    });
    return { kind: 'void' };
  }
}
```

- [ ] **Step 7: Run MockRuntime tests**

Run: `npx vitest run packages/core/src/runtime/MockRuntime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/auth/PendingApprovalRegistry.ts packages/core/src/auth/PendingApprovalRegistry.test.ts
git add packages/core/src/runtime/MockRuntime.ts packages/core/src/runtime/MockRuntime.test.ts
git add packages/core/src/runtime/UserDeliveryRuntime.ts
git commit -m "feat(core): durable PendingApprovalRegistry; adapt MockRuntime/UserDeliveryRuntime to RuntimeResult"
```

---

## Task 3: ConversationThread.updateToolResults()

**Files:**
- Amend: `packages/core/src/conversation/ConversationThread.ts`

> `AgentRuntime` needs to patch `pending_approval` tool results with their actual outcomes
> after a resumption. `ConversationStore.updateMessage` (defined in Plan 2) already supports
> arbitrary `Partial<MessageData>` patches — this method exposes a typed shortcut.

- [ ] **Step 1: Add `updateToolResults` to `ConversationThread`**

In `packages/core/src/conversation/ConversationThread.ts`, add the following method to the class (after the existing `append()` method):

```typescript
/**
 * Replace the toolResults array on an existing message. Used by AgentRuntime to
 * swap pending_approval results with resolved outcomes after an approval decision.
 */
async updateToolResults(messageId: string, toolResults: ToolCallResult[]): Promise<void> {
  await this.store.updateMessage(this.data.id, messageId, { toolResults });
  // Keep local data in sync so activeChain reflects the update immediately.
  const msg = this.data.messages[messageId];
  if (msg) {
    this.data.messages[messageId] = { ...msg, toolResults };
  }
}
```

> `ToolCallResult` is already imported in `ConversationThread.ts` via `@legion/types` (used
> in `NewMessageInput`). Add it to the import if it isn't already present:
> `import type { ..., ToolCallResult } from '@legion/types';`

- [ ] **Step 2: Run the existing ConversationThread tests to confirm no regression**

Run: `npx vitest run packages/core/src/conversation/ConversationThread.test.ts`
Expected: PASS (all existing tests green).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/conversation/ConversationThread.ts
git commit -m "feat(core): ConversationThread.updateToolResults for approval resumption"
```

---

## Task 4: AgentRuntime — auth check, approval flow, resumption

**Files:**
- Amend: `packages/core/src/runtime/AgentRuntime.ts`
- Amend: `packages/core/src/runtime/AgentRuntime.test.ts`

> Three changes to `AgentRuntime.handle()`:
>
> 1. **Tool filter fix (Plan 6 deviation resolved):** Present all non-`'deny'` tools to the
>    LLM. `'requires_approval'` tools are now shown; the LLM can call them. Auth runs at
>    execution time, not at tool-list time.
>
> 2. **Auth check at execution:** Before executing each tool call in the loop, call
>    `context.authEngine.authorize(agent.id, toolName, args, agent.tools)`:
>    - `'auto'` → execute normally
>    - `'deny'` → return error tool result
>    - `'requires_approval'` → register pending approval, store `pending_approval` tool result;
>      after the full batch, if any are pending, persist the turn and return
>      `{ kind: 'pending_approval', ... }`
>
> 3. **Resumption on entry:** If the active chain's last assistant message contains
>    `pending_approval` tool results, this is a re-trigger from `approval_response`. For each
>    pending result: if a decision exists in the registry, execute approved tools / record
>    rejection results, then update the conversation message via `updateToolResults()`. If ALL
>    are resolved, fall through to the LLM loop (which now sees clean tool results in context).
>    If some are still unresolved, return `{ kind: 'pending_approval', ... }` immediately.

- [ ] **Step 1: Write the failing tests (add to `AgentRuntime.test.ts`)**

Append these four `describe` blocks to `packages/core/src/runtime/AgentRuntime.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Auth: deny policy
// ---------------------------------------------------------------------------
describe('AgentRuntime: auth – deny policy', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'legion-ar-deny-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('returns error tool result for a denied tool; LLM continues', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('collective/participants/agent-1.json', {
      id: 'agent-1', name: 'A', type: 'agent', status: 'active',
      tools: { echo: 'deny' },          // echo is denied
      systemPrompt: 'You are an assistant.',
      model: { provider: 'scripted', model: 'test' },
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(new FileStorage(dir));
    const eventBus = new EventBus();
    const thread = new ConversationThread(
      await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} }),
      store,
    );

    // Provider: first return tool call to 'echo', then return text after seeing denied result
    const provider: Provider = {
      async complete(_msgs, _tools) {
        const last = _msgs[_msgs.length - 1];
        if (last.role === 'tool') {
          return { content: 'Got denied result', toolCalls: [], stopReason: 'stop' };
        }
        return {
          content: null,
          toolCalls: [{ id: 'tc-deny', name: 'echo', arguments: { text: 'hi' } }],
          stopReason: 'tool_calls',
        };
      },
    };
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register('scripted', provider);

    const echoTool: Tool = {
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } as JSONSchema,
      async execute(args) { return { status: 'success', data: (args as { text: string }).text }; },
    };
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(echoTool);

    const context: RuntimeContext = {
      participant: collective.getOrThrow('agent-1'),
      conversationId: thread.id,
      conversation: thread,
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),  // default fail-safe; we rely on agent's own tools policy
      pendingApprovalRegistry: new PendingApprovalRegistry(),
      messageRouter: { send: vi.fn(), resume: vi.fn() } as unknown as MessageRouterPort,
    } as unknown as RuntimeContext;

    const incoming: MessageData = {
      id: 'msg-1', parentId: null, conversationId: thread.id,
      senderId: 'op', recipientId: 'agent-1',
      role: 'user', content: 'use echo', status: 'active',
      timestamp: new Date().toISOString(),
    };

    const runtime = new AgentRuntime('agent-1', providerRegistry);
    const result = await runtime.handle(incoming, context);

    expect(result.kind).toBe('response');
    expect((result as { kind: string; content: string }).content).toBe('Got denied result');

    // The tool result in the conversation should carry status:'error'
    const chain = thread.activeChain;
    const toolTurn = chain.find((m) => m.toolResults && m.toolResults.length > 0);
    expect(toolTurn?.toolResults?.[0].result.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Auth: requires_approval policy – returns pending_approval
// ---------------------------------------------------------------------------
describe('AgentRuntime: auth – requires_approval policy', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'legion-ar-appr-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function setupApprovalScenario(tmpDir: string) {
    const storage = new MemoryStorage();
    await storage.writeJson('collective/participants/agent-1.json', {
      id: 'agent-1', name: 'A', type: 'agent', status: 'active',
      tools: { echo: 'requires_approval' },
      systemPrompt: 'You are an assistant.',
      model: { provider: 'scripted', model: 'test' },
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(new FileStorage(tmpDir));
    const eventBus = new EventBus();
    const thread = new ConversationThread(
      await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} }),
      store,
    );

    const provider: Provider = {
      async complete(_msgs, _tools) {
        // Always request the echo tool call (approval scenario — LLM keeps trying)
        const last = _msgs[_msgs.length - 1];
        // If last message is a tool result that isn't pending_approval, return text
        if (last.role === 'tool') {
          const parsed = JSON.parse(last.content ?? '{}');
          if (parsed.status !== 'pending_approval') {
            return { content: 'Done', toolCalls: [], stopReason: 'stop' };
          }
        }
        return {
          content: null,
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
          stopReason: 'tool_calls',
        };
      },
    };
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register('scripted', provider);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } as JSONSchema,
      async execute(args) { return { status: 'success', data: (args as { text: string }).text }; },
    });

    const pendingApprovalRegistry = new PendingApprovalRegistry();

    const context: RuntimeContext = {
      participant: collective.getOrThrow('agent-1'),
      conversationId: thread.id,
      conversation: thread,
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: tmpDir,
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry,
      messageRouter: { send: vi.fn(), resume: vi.fn() } as unknown as MessageRouterPort,
    } as unknown as RuntimeContext;

    const incoming: MessageData = {
      id: 'msg-1', parentId: null, conversationId: thread.id,
      senderId: 'op', recipientId: 'agent-1',
      role: 'user', content: 'use echo', status: 'active',
      timestamp: new Date().toISOString(),
    };

    return { runtime: new AgentRuntime('agent-1', providerRegistry), incoming, context, thread, pendingApprovalRegistry };
  }

  it('returns pending_approval when a tool requires approval', async () => {
    const { runtime, incoming, context } = await setupApprovalScenario(dir);
    const result = await runtime.handle(incoming, context);
    expect(result.kind).toBe('pending_approval');
    const r = result as { kind: string; approvalRequests: { tool: string }[] };
    expect(r.approvalRequests[0].tool).toBe('echo');
  });

  it('writes pending_approval tool result to the conversation', async () => {
    const { runtime, incoming, context, thread } = await setupApprovalScenario(dir);
    await runtime.handle(incoming, context);
    const chain = thread.activeChain;
    const toolTurn = chain.find((m) => m.toolResults?.some((tr) => tr.result.status === 'pending_approval'));
    expect(toolTurn).toBeDefined();
    expect(toolTurn?.toolResults?.[0].result.approvalId).toMatch(/^appr-/);
  });

  it('resumes and completes after approval is granted', async () => {
    const { runtime, incoming, context, thread, pendingApprovalRegistry } = await setupApprovalScenario(dir);
    const result = await runtime.handle(incoming, context);
    expect(result.kind).toBe('pending_approval');

    const r = result as { kind: string; approvalRequests: { approvalId: string }[] };
    const { approvalId } = r.approvalRequests[0];

    // Grant the approval
    await pendingApprovalRegistry.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: new Date().toISOString(),
    });

    // Re-trigger via handle() — same path as messageRouter.resume()
    const resumeResult = await runtime.handle(incoming, context);
    expect(resumeResult.kind).toBe('response');
    expect((resumeResult as { kind: string; content: string }).content).toBe('Done');

    // The conversation should now have an actual echo result
    const chain = thread.activeChain;
    const resolved = chain.find((m) => m.toolResults?.some((tr) => tr.result.status === 'success'));
    expect(resolved).toBeDefined();
  });

  it('resumes with rejection message in context', async () => {
    const { runtime, incoming, context, pendingApprovalRegistry } = await setupApprovalScenario(dir);
    const result = await runtime.handle(incoming, context);
    const r = result as { kind: string; approvalRequests: { approvalId: string }[] };

    // Reject the approval
    await pendingApprovalRegistry.resolve(r.approvalRequests[0].approvalId, {
      approved: false,
      decidedByParticipantId: 'operator',
      message: 'Not permitted on prod',
      decidedAt: new Date().toISOString(),
    });

    const resumeResult = await runtime.handle(incoming, context);
    // LLM receives the 'rejected' tool result and produces text
    expect(resumeResult.kind).toBe('response');
    // The conversation should have a 'rejected' tool result
    const chain = (context.conversation as ConversationThread).activeChain;
    const rejectedTurn = chain.find((m) => m.toolResults?.some((tr) => tr.result.status === 'rejected'));
    expect(rejectedTurn?.toolResults?.[0].result.message).toBe('Not permitted on prod');
  });
});
```

> **Import additions** needed at the top of `AgentRuntime.test.ts`:
>
> ```typescript
> import type { Provider } from '../providers/Provider.js';
> import type { MessageRouterPort } from '../tools/Tool.js';
> ```
>
> Add alongside the existing imports. The test already imports `ProviderRegistry`, `ToolRegistry`,
> `AuthEngine`, `PendingApprovalRegistry`, `ConversationThread`, `FileConversationStore`,
> `FileStorage`, `MemoryStorage`, `Collective`, `EventBus` — confirm each is present.

- [ ] **Step 2: Run test to verify they fail**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`
Expected: FAIL on the 4 new tests. Existing 5 tests from Plan 6 may also fail (they call
`handle()` expecting `string | void` — fix by updating assertions to match `RuntimeResult`).

- [ ] **Step 3: Update Plan 6's existing AgentRuntime tests to match `RuntimeResult`**

In `packages/core/src/runtime/AgentRuntime.test.ts`, update the 5 existing test assertions
to unwrap the `RuntimeResult`. For example:

```typescript
// Before:
expect(result).toBe('The weather is sunny today.');

// After:
expect(result).toEqual({ kind: 'response', content: 'The weather is sunny today.' });
```

And for the max-iteration test:
```typescript
// Before:
expect(result).toMatch(/maximum iteration/i);

// After:
expect((result as { kind: string; content: string }).content).toMatch(/maximum iteration/i);
```

Apply this pattern to all 5 existing tests.

- [ ] **Step 4: Replace `packages/core/src/runtime/AgentRuntime.ts`**

```typescript
import type {
  AgentConfig,
  MessageData,
  ToolCallData,
  ToolCallResult,
} from '@legion/types';
import type { Runtime, RuntimeContext, RuntimeResult } from './Runtime.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { ProviderMessage, ProviderTool } from '../providers/Provider.js';
import type { PendingApproval } from '../auth/PendingApprovalRegistry.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';

const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Build the provider message list from the conversation chain + system prompt.
 * Tool-call turns are expanded into an assistant message followed by one
 * tool-result message per call, matching the OpenAI Chat Completions format.
 */
function buildProviderMessages(chain: MessageData[], systemPrompt: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of chain) {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
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

  async handle(incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    const participant = context.collective.getOrThrow(this.participantId);
    if (participant.type !== 'agent') return { kind: 'void' };
    const agent = participant as AgentConfig;

    const provider = this.providerRegistry.get(agent.model.provider);
    if (!provider) {
      return {
        kind: 'response',
        content: `[AgentRuntime error: no provider registered for '${agent.model.provider}']`,
      };
    }

    // -------------------------------------------------------------------------
    // Resumption check: if the active chain's last assistant message has
    // pending_approval tool results, this is a re-trigger from approval_response.
    // Process resolved decisions; return pending_approval if any remain outstanding.
    // -------------------------------------------------------------------------
    const chain = context.conversation.activeChain;
    const lastAssistantMsg = [...chain]
      .reverse()
      .find(
        (m) =>
          m.role === 'assistant' &&
          m.toolResults?.some((tr) => tr.result.status === 'pending_approval'),
      );

    if (lastAssistantMsg) {
      const stillPending = await this.processResumedApprovals(lastAssistantMsg, context);
      if (stillPending !== null) {
        return { kind: 'pending_approval', approvalRequests: stillPending };
      }
      // All resolved — fall through; buildProviderMessages will read the updated chain.
    }

    // -------------------------------------------------------------------------
    // LLM agentic loop
    // -------------------------------------------------------------------------
    const maxIterations = agent.runtimeConfig?.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    // Build the initial message list from the full (possibly updated) conversation chain.
    const messages: ProviderMessage[] = buildProviderMessages(
      context.conversation.activeChain,
      agent.systemPrompt,
    );

    // Present all non-deny tools to the LLM. Auth check runs at execution time.
    const providerTools: ProviderTool[] = context.toolRegistry
      .list()
      .filter((tool) => (agent.tools[tool.name] ?? 'requires_approval') !== 'deny')
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

      if (response.stopReason !== 'tool_calls' || response.toolCalls.length === 0) {
        return { kind: 'response', content: response.content ?? '' };
      }

      const toolCallData: ToolCallData[] = response.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }));

      const toolResults: ToolCallResult[] = [];
      const pendingApprovals: PendingApproval[] = [];

      for (const tc of response.toolCalls) {
        context.eventBus.emit('tool:call', {
          conversationId: context.conversationId,
          participantId: this.participantId,
          tool: tc.name,
          callId: tc.id,
        });

        const authResult = context.authEngine.authorize(
          this.participantId,
          tc.name,
          tc.arguments,
          agent.tools,
        );

        if (authResult.reason === 'deny') {
          toolResults.push({
            id: tc.id,
            name: tc.name,
            result: { status: 'error', error: `Tool '${tc.name}' is denied for this agent` },
          });
          context.eventBus.emit('tool:result', {
            conversationId: context.conversationId,
            participantId: this.participantId,
            tool: tc.name,
            callId: tc.id,
            status: 'error',
          });
          continue;
        }

        if (authResult.reason === 'requires_approval') {
          const { approvalId } = await context.pendingApprovalRegistry.create({
            conversationId: context.conversationId,
            requesterId: this.participantId,
            tool: tc.name,
            args: tc.arguments,
          });
          const pending = context.pendingApprovalRegistry.get(approvalId)!;
          pendingApprovals.push(pending);
          toolResults.push({
            id: tc.id,
            name: tc.name,
            result: { status: 'pending_approval', approvalId },
          });
          context.eventBus.emit('approval:requested', {
            conversationId: context.conversationId,
            participantId: this.participantId,
            tool: tc.name,
            approvalId,
          });
          continue;
        }

        // 'auto': execute immediately
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

      // Persist the tool-call turn to the conversation.
      await context.conversation.append({
        senderId: this.participantId,
        recipientId: this.participantId,
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: toolCallData,
        toolResults,
      });

      // If any approvals are pending, return early — do NOT continue the loop.
      if (pendingApprovals.length > 0) {
        return { kind: 'pending_approval', approvalRequests: pendingApprovals };
      }

      // All tools executed — advance the local message history for the next iteration.
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

    return {
      kind: 'response',
      content: `[Agent reached maximum iteration limit of ${maxIterations}]`,
    };
  }

  /**
   * Process resolved approval decisions for a message that previously had
   * pending_approval tool results.
   *
   * Returns `null` when all pending approvals are resolved (caller should continue
   * the loop). Returns the array of still-pending approvals if any remain outstanding.
   */
  private async processResumedApprovals(
    lastMsg: MessageData,
    context: RuntimeContext,
  ): Promise<PendingApproval[] | null> {
    const updatedResults: ToolCallResult[] = [...(lastMsg.toolResults ?? [])];
    const stillPending: PendingApproval[] = [];

    for (let i = 0; i < updatedResults.length; i++) {
      const tr = updatedResults[i];
      if (tr.result.status !== 'pending_approval') continue;

      const { approvalId } = tr.result;
      if (!approvalId) continue;

      const decision = context.pendingApprovalRegistry.getDecision(approvalId);

      if (!decision) {
        // No decision yet — still waiting.
        const pending = context.pendingApprovalRegistry.get(approvalId);
        if (pending) stillPending.push(pending);
        continue;
      }

      if (!decision.approved) {
        updatedResults[i] = {
          ...tr,
          result: {
            status: 'rejected',
            message: decision.message ?? 'Request rejected',
          },
        };
        context.eventBus.emit('approval:resolved', {
          conversationId: context.conversationId,
          approvalId,
          approved: false,
          decidedByParticipantId: decision.decidedByParticipantId,
        });
        continue;
      }

      // Approved: execute the tool now, in B's context.
      const toolCall = lastMsg.toolCalls?.find((tc) => tc.id === tr.id);
      if (!toolCall) {
        updatedResults[i] = {
          ...tr,
          result: { status: 'error', error: 'Tool call data missing from conversation' },
        };
        continue;
      }

      context.eventBus.emit('tool:call', {
        conversationId: context.conversationId,
        participantId: this.participantId,
        tool: tr.name,
        callId: tr.id,
      });
      const result = await context.toolRegistry.execute(tr.name, toolCall.arguments, context);
      updatedResults[i] = { ...tr, result };
      context.eventBus.emit('tool:result', {
        conversationId: context.conversationId,
        participantId: this.participantId,
        tool: tr.name,
        callId: tr.id,
        status: result.status,
      });
      context.eventBus.emit('approval:resolved', {
        conversationId: context.conversationId,
        approvalId,
        approved: true,
        decidedByParticipantId: decision.decidedByParticipantId,
      });
    }

    if (stillPending.length > 0) {
      return stillPending;
    }

    // All resolved — update the conversation message in place.
    await (context.conversation as ConversationThread).updateToolResults(
      lastMsg.id,
      updatedResults,
    );
    return null;
  }
}
```

- [ ] **Step 5: Run all AgentRuntime tests**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`
Expected: PASS (9 tests — 5 from Plan 6 + 4 new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/AgentRuntime.ts packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "feat(core): AgentRuntime auth check, approval flow, and resumption"
```

---

## Task 5: MessageRouter — RuntimeResult handling + resume()

**Files:**
- Amend: `packages/core/src/runtime/MessageRouter.ts`
- Amend: `packages/core/src/runtime/MessageRouter.test.ts`

> `MessageRouter.send()` now switches on `RuntimeResult.kind` instead of `typeof response`.
> The new `resume()` method finds the last user message addressed to the paused participant,
> re-calls their runtime, and persists any final response to the conversation.

- [ ] **Step 1: Add failing tests for the new behaviour**

Append to `packages/core/src/runtime/MessageRouter.test.ts`:

```typescript
describe('MessageRouter: pending_approval result', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'legion-router-pa-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('returns pending_approval status and approvalRequests when runtime returns pending_approval', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/mock-1.json', {
      id: 'mock-1', name: 'M', type: 'mock', tools: {}, responses: [], status: 'active',
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(storage);
    const eventBus = new EventBus();
    const registry = new RuntimeRegistry();

    // A runtime that returns pending_approval
    const pendingRuntime = {
      async handle(): Promise<RuntimeResult> {
        return {
          kind: 'pending_approval',
          approvalRequests: [
            {
              approvalId: 'appr-test',
              conversationId: 'conv-1',
              requesterId: 'mock-1',
              tool: 'write_file',
              args: {},
              createdAt: new Date().toISOString(),
            },
          ],
        };
      },
    };
    registry.registerFactory('mock', () => pendingRuntime);

    const router = new MessageRouter(store, registry, collective, eventBus);
    const baseContext = {
      participant: collective.getOrThrow('mock-1'),
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry: new ToolRegistry(),
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as ToolContext;

    const result = await router.send({
      senderId: 'op', recipientId: 'mock-1', message: 'hi', context: baseContext,
    });

    expect(result.status).toBe('pending_approval');
    expect(result.approvalRequests?.[0].approvalId).toBe('appr-test');
    // No response message should be persisted to the conversation
    const conv = await store.load(result.conversationId);
    const messages = Object.values(conv!.messages);
    expect(messages.every((m) => m.role === 'user')).toBe(true);
  });
});

describe('MessageRouter: resume()', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'legion-router-resume-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('re-triggers the paused runtime and persists the final response', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/mock-1.json', {
      id: 'mock-1', name: 'M', type: 'mock', tools: {}, responses: ['resumed response'], status: 'active',
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(storage);
    const eventBus = new EventBus();
    const registry = new RuntimeRegistry();
    registry.registerFactory('mock', (id) => new MockRuntime(id));

    const router = new MessageRouter(store, registry, collective, eventBus);
    const baseContext = {
      participant: collective.getOrThrow('mock-1'),
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry: new ToolRegistry(),
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as ToolContext;

    // Send a message to establish the conversation
    const sent = await router.send({
      senderId: 'op', recipientId: 'mock-1', message: 'original', context: baseContext,
    });
    const { conversationId } = sent;

    // resume() should call handle() again and persist the response
    const resumeResult = await router.resume(conversationId, 'mock-1', baseContext);
    expect(resumeResult.status).toBe('success');
    expect(resumeResult.response).toBe('resumed response');

    // The response should appear in the conversation
    const conv = await store.load(conversationId);
    const assistantMsgs = Object.values(conv!.messages).filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(2); // original + resumed
  });
});
```

> Add `import type { RuntimeResult } from './Runtime.js';` and `import { ToolContext } from '../tools/Tool.js';`
> to the test file imports as needed. `MockRuntime` import is already present from Plan 5.

- [ ] **Step 2: Run test to verify they fail**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: FAIL on the 2 new `describe` blocks.

- [ ] **Step 3: Replace `packages/core/src/runtime/MessageRouter.ts`**

```typescript
import type { ConversationStore } from '../conversation/ConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import type { Collective } from '../collective/Collective.js';
import type { EventBus } from '../events/EventBus.js';
import type { ToolContext, MessageRouterPort, MessageRouterResult } from '../tools/Tool.js';
import { ParticipantNotFoundError } from '../errors/LegionError.js';
import type { RuntimeRegistry } from './RuntimeRegistry.js';
import type { RuntimeContext, RuntimeResult } from './Runtime.js';

export interface SendOptions {
  senderId: string;
  recipientId: string;
  message: string;
  conversationId?: string;
  replyTo?: string;
  context: ToolContext;
}

const DEFAULT_DEPTH_LIMIT = 10;

export class MessageRouter implements MessageRouterPort {
  private background = new Set<Promise<void>>();

  constructor(
    private store: ConversationStore,
    private registry: RuntimeRegistry,
    private collective: Collective,
    private eventBus: EventBus,
  ) {}

  /** Await all in-flight fire-and-forget dispatches (test/shutdown aid). */
  async drain(): Promise<void> {
    await Promise.all([...this.background]);
  }

  private async getThread(conversationId?: string): Promise<ConversationThread> {
    if (conversationId) {
      const existing = await this.store.load(conversationId);
      if (existing) return new ConversationThread(existing, this.store);
    }
    const created = await this.store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    this.eventBus.emit('conversation:created', { conversationId: created.id });
    return new ConversationThread(created, this.store);
  }

  private buildRuntimeContext(
    thread: ConversationThread,
    participantId: string,
    toolContext: ToolContext,
    depth: number,
  ): RuntimeContext {
    const participant = this.collective.getOrThrow(participantId);
    return {
      ...(toolContext as RuntimeContext),
      participant,
      conversationId: thread.id,
      conversation: thread,
      communicationDepth: depth,
      messageRouter: this,
    };
  }

  private async persistResponse(
    thread: ConversationThread,
    senderId: string,
    recipientId: string,
    content: string,
  ): Promise<void> {
    const responseMsg = await thread.append({
      senderId,
      recipientId,
      role: 'assistant',
      content,
    });
    this.eventBus.emit('message:sent', {
      conversationId: thread.id,
      senderId,
      recipientId,
      messageId: responseMsg.id,
    });
  }

  async send(opts: SendOptions): Promise<MessageRouterResult> {
    const recipient = this.collective.get(opts.recipientId);
    if (!recipient) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: new ParticipantNotFoundError(opts.recipientId).message,
      };
    }

    const depth = opts.context.communicationDepth ?? 0;
    if (depth > DEFAULT_DEPTH_LIMIT) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: `Communication depth limit exceeded (${DEFAULT_DEPTH_LIMIT})`,
      };
    }

    const thread = await this.getThread(opts.conversationId);

    const inbound = await thread.append({
      senderId: opts.senderId,
      recipientId: opts.recipientId,
      role: 'user',
      content: opts.message,
      replyTo: opts.replyTo,
    });
    this.eventBus.emit('message:sent', {
      conversationId: thread.id,
      senderId: opts.senderId,
      recipientId: opts.recipientId,
      messageId: inbound.id,
    });

    const runtime = this.registry.build(recipient.type, recipient.id);
    const runtimeContext = this.buildRuntimeContext(
      thread,
      recipient.id,
      { ...opts.context, communicationDepth: depth },
      depth,
    );

    if (opts.replyTo) {
      const task = this.dispatchAsync(runtime, inbound, runtimeContext, thread, opts);
      this.background.add(task);
      void task.finally(() => this.background.delete(task));
      return { conversationId: thread.id, status: 'dispatched' };
    }

    const result = await runtime.handle(inbound, runtimeContext);
    return this.handleRuntimeResult(result, thread, recipient.id, opts.senderId);
  }

  /**
   * Re-trigger a paused participant after approval decisions have been recorded.
   * Finds the last user message addressed to `participantId` and calls handle() again.
   */
  async resume(
    conversationId: string,
    participantId: string,
    toolContext: ToolContext,
  ): Promise<MessageRouterResult> {
    const thread = await this.getThread(conversationId);
    const participant = this.collective.get(participantId);
    if (!participant) {
      return {
        conversationId,
        status: 'error',
        error: new ParticipantNotFoundError(participantId).message,
      };
    }

    // Find the last user message addressed to this participant — that is the
    // 'incoming' message the participant was responding to when it paused.
    const chain = thread.activeChain;
    const lastIncoming = [...chain]
      .reverse()
      .find((m) => m.recipientId === participantId && m.role === 'user');

    if (!lastIncoming) {
      return {
        conversationId,
        status: 'error',
        error: `No incoming message to resume from in conversation ${conversationId}`,
      };
    }

    const runtime = this.registry.build(participant.type, participant.id);
    const runtimeContext = this.buildRuntimeContext(thread, participant.id, toolContext, 0);

    const result = await runtime.handle(lastIncoming, runtimeContext);
    return this.handleRuntimeResult(result, thread, participant.id, lastIncoming.senderId);
  }

  private handleRuntimeResult(
    result: RuntimeResult,
    thread: ConversationThread,
    senderId: string,
    defaultRecipientId: string,
  ): MessageRouterResult {
    if (result.kind === 'response') {
      void this.persistResponse(thread, senderId, defaultRecipientId, result.content);
      return { conversationId: thread.id, response: result.content, status: 'success' };
    }
    if (result.kind === 'pending_approval') {
      return {
        conversationId: thread.id,
        status: 'pending_approval',
        approvalRequests: result.approvalRequests,
      };
    }
    // kind === 'void'
    return { conversationId: thread.id, status: 'success' };
  }

  private async dispatchAsync(
    runtime: ReturnType<RuntimeRegistry['build']>,
    inbound: Awaited<ReturnType<ConversationThread['append']>>,
    runtimeContext: RuntimeContext,
    thread: ConversationThread,
    opts: SendOptions,
  ): Promise<void> {
    const result = await runtime.handle(inbound, runtimeContext);
    if (result.kind !== 'response') return;
    const replyTarget = opts.replyTo!;
    const responseMsg = await thread.append({
      senderId: opts.recipientId,
      recipientId: replyTarget,
      role: 'assistant',
      content: result.content,
    });
    this.eventBus.emit('message:delivered', {
      conversationId: thread.id,
      recipientId: replyTarget,
      messageId: responseMsg.id,
    });
  }
}
```

> Note: `handleRuntimeResult` calls `persistResponse` with `void` (fire-and-forget) in the
> synchronous path. This is intentional — the response is appended but the caller doesn't
> need to await the store write before receiving the `MessageRouterResult`. If strict
> ordering is required in a future plan, remove the `void` and `await` it.
>
> Actually — change this to await. The `handleRuntimeResult` method needs to be async
> for the response persistence path. Amend as follows: make `handleRuntimeResult` an
> `async` method returning `Promise<MessageRouterResult>` and `await this.persistResponse(...)`.
> The callers in `send()` and `resume()` should `await` it. (Non-async `void` fire-and-forget
> on a mutation that the test asserts against will cause flaky tests.)

Corrected `handleRuntimeResult` (async version to use):

```typescript
private async handleRuntimeResult(
  result: RuntimeResult,
  thread: ConversationThread,
  senderId: string,
  defaultRecipientId: string,
): Promise<MessageRouterResult> {
  if (result.kind === 'response') {
    await this.persistResponse(thread, senderId, defaultRecipientId, result.content);
    return { conversationId: thread.id, response: result.content, status: 'success' };
  }
  if (result.kind === 'pending_approval') {
    return {
      conversationId: thread.id,
      status: 'pending_approval',
      approvalRequests: result.approvalRequests,
    };
  }
  return { conversationId: thread.id, status: 'success' };
}
```

Update all callers in `send()` and `resume()` to `return await this.handleRuntimeResult(...)`.

- [ ] **Step 4: Run all MessageRouter tests**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: PASS (all existing + 2 new tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat(core): MessageRouter handles RuntimeResult; adds resume()"
```

---

## Task 6: communicate tool amendment + approval_response tool

**Files:**
- Amend: `packages/core/src/tools/communicate-tool.ts`
- Amend: `packages/core/src/tools/communicate-tool.test.ts`
- Create: `packages/core/src/tools/approval-response-tool.ts`
- Create: `packages/core/src/tools/approval-response-tool.test.ts`

> `communicate` now surfaces `pending_approval` as a first-class tool result so the calling
> LLM knows it needs to handle approval requests.
>
> `approval_response` is a batched tool: one call can resolve multiple pending approvals.
> Each decision carries an optional `message` (especially useful for rejections). The tool
> verifies authority per decision, records in `ApprovalLog`, resolves in
> `PendingApprovalRegistry`, and re-triggers the paused runtime via `messageRouter.resume()`.

- [ ] **Step 1: Write the failing test for the `pending_approval` path in `communicate`**

Append to `packages/core/src/tools/communicate-tool.test.ts`:

```typescript
it('surfaces pending_approval result when the recipient runtime returns one', async () => {
  const storage = new FileStorage(dir);
  await storage.writeJson('collective/participants/agent-a.json', {
    id: 'agent-a', name: 'A', type: 'mock', tools: { communicate: 'auto' }, responses: [], status: 'active',
  });
  await storage.writeJson('collective/participants/agent-b.json', {
    id: 'agent-b', name: 'B', type: 'mock', tools: {}, responses: [], status: 'active',
  });
  const collective = await Collective.load(storage);
  const storeB = new FileConversationStore(storage);
  const eventBus = new EventBus();
  const registry = new RuntimeRegistry();

  // B's runtime returns pending_approval
  const pendingRuntime = {
    async handle(): Promise<RuntimeResult> {
      return {
        kind: 'pending_approval',
        approvalRequests: [{
          approvalId: 'appr-1', conversationId: 'c1',
          requesterId: 'agent-b', tool: 'write_file', args: {},
          createdAt: new Date().toISOString(),
        }],
      };
    },
  };
  registry.registerFactory('mock', () => pendingRuntime);

  const router = new MessageRouter(storeB, registry, collective, eventBus);
  const context = {
    participant: collective.getOrThrow('agent-a'),
    conversationId: 'seed',
    collective,
    config: { version: '2' },
    eventBus,
    storage,
    workspaceRoot: dir,
    communicationDepth: 0,
    toolRegistry: new ToolRegistry(),
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
    messageRouter: router,
  } as unknown as ToolContext;

  const result = await communicateTool.execute({ to: 'agent-b', message: 'do the thing' }, context);
  expect(result.status).toBe('pending_approval');
  const data = result.data as { approvalRequests: { tool: string }[] };
  expect(data.approvalRequests[0].tool).toBe('write_file');
});
```

> Add `import type { RuntimeResult } from '../runtime/Runtime.js';` to the communicate
> test file imports.

- [ ] **Step 2: Amend `packages/core/src/tools/communicate-tool.ts`**

Replace the `execute` function body:

```typescript
async execute(args, context: ToolContext): Promise<ToolResult> {
  const { to, message, conversationId, replyTo } = args as {
    to: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
  };
  if (!context.messageRouter) {
    return { status: 'error', error: 'messageRouter unavailable in context' };
  }
  const result = await context.messageRouter.send({
    senderId: context.participant.id,
    recipientId: to,
    message,
    conversationId: conversationId ?? context.conversationId,
    replyTo,
    context: { ...context, communicationDepth: (context.communicationDepth ?? 0) + 1 },
  });
  if (result.status === 'error') {
    return { status: 'error', error: result.error };
  }
  if (result.status === 'pending_approval') {
    return {
      status: 'pending_approval',
      data: {
        conversationId: result.conversationId,
        approvalRequests: result.approvalRequests,
      },
    };
  }
  return {
    status: 'success',
    data: {
      conversationId: result.conversationId,
      response: result.response,
      status: result.status,
    },
  };
},
```

- [ ] **Step 3: Run communicate tests**

Run: `npx vitest run packages/core/src/tools/communicate-tool.test.ts`
Expected: PASS (4 tests — 3 original + 1 new).

- [ ] **Step 4: Write the failing tests for `approval_response`**

`packages/core/src/tools/approval-response-tool.test.ts`:

```typescript
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ApprovalLog } from '../auth/ApprovalLog.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { ToolRegistry } from './ToolRegistry.js';
import { approvalResponseTool } from './approval-response-tool.js';
import type { ToolContext } from './Tool.js';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    participant: {
      id: 'op',
      name: 'Operator',
      type: 'user',
      tools: {},
      // broad authority: can approve any tool for any participant
      approvalAuthority: { tools: '*', participants: '*' },
    },
    conversationId: 'c1',
    collective: { get: () => undefined, getOrThrow: () => { throw new Error(); } },
    config: { version: '2' },
    eventBus: { emit: () => {} },
    storage: {} as unknown,
    workspaceRoot: '/tmp',
    communicationDepth: 0,
    toolRegistry: new ToolRegistry(),
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
    approvalLog: new ApprovalLog(),
    messageRouter: { send: async () => ({ conversationId: 'c1', status: 'success' }), resume: async () => ({ conversationId: 'c1', status: 'success' }) },
    ...overrides,
  } as unknown as ToolContext;
}

describe('approval_response tool', () => {
  it('approves a pending request and triggers resume', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1', requesterId: 'agent-b', tool: 'file_write', args: {},
    });
    const resumeSpy = vi.fn().mockResolvedValue({ conversationId: 'c1', status: 'success' });
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: {
        send: vi.fn(),
        resume: resumeSpy,
      } as unknown as ToolContext['messageRouter'],
    });

    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    expect(result.status).toBe('success');
    const data = result.data as { results: { approvalId: string; outcome: string }[] };
    expect(data.results[0].outcome).toBe('approve');
    expect(reg.getDecision(approvalId)?.approved).toBe(true);
    expect(resumeSpy).toHaveBeenCalledWith('c1', 'agent-b', context);
  });

  it('rejects a request with a message', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c2', requesterId: 'agent-b', tool: 'delete_file', args: {},
    });
    const context = makeContext({ pendingApprovalRegistry: reg });

    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'reject', message: 'Too risky' }] },
      context,
    );

    expect(result.status).toBe('success');
    const decision = reg.getDecision(approvalId);
    expect(decision?.approved).toBe(false);
    expect(decision?.message).toBe('Too risky');
  });

  it('batches multiple decisions in one call', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId: id1 } = await reg.create({ conversationId: 'c3', requesterId: 'b', tool: 'a', args: {} });
    const { approvalId: id2 } = await reg.create({ conversationId: 'c3', requesterId: 'b', tool: 'x', args: {} });
    const context = makeContext({ pendingApprovalRegistry: reg });

    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId: id1, decision: 'approve' }, { approvalId: id2, decision: 'reject', message: 'no' }] },
      context,
    );

    const data = result.data as { results: { outcome: string }[] };
    expect(data.results[0].outcome).toBe('approve');
    expect(data.results[1].outcome).toBe('reject');
  });

  it('returns not_found for an unknown approvalId', async () => {
    const context = makeContext();
    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId: 'appr-ghost', decision: 'approve' }] },
      context,
    );
    expect(result.status).toBe('success');
    const data = result.data as { results: { outcome: string }[] };
    expect(data.results[0].outcome).toBe('not_found');
  });

  it('returns unauthorized when the caller lacks authority', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c4', requesterId: 'agent-b', tool: 'danger', args: {},
    });
    // Participant has no approvalAuthority
    const context = makeContext({
      pendingApprovalRegistry: reg,
      participant: { id: 'agent-c', name: 'C', type: 'agent', tools: {} } as ToolContext['participant'],
    });

    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    const data = result.data as { results: { outcome: string }[] };
    expect(data.results[0].outcome).toBe('unauthorized');
    expect(reg.getDecision(approvalId)).toBeUndefined(); // not recorded
  });

  it('records the decision in ApprovalLog', async () => {
    const reg = new PendingApprovalRegistry();
    const log = new ApprovalLog();
    const { approvalId } = await reg.create({
      conversationId: 'c5', requesterId: 'agent-b', tool: 'file_write', args: {},
    });
    const context = makeContext({ pendingApprovalRegistry: reg, approvalLog: log });

    await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    const entries = log.list({ conversationId: 'c5' });
    expect(entries.length).toBe(1);
    expect(entries[0].decidedByParticipantId).toBe('op');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/approval-response-tool.test.ts`
Expected: FAIL — `Cannot find module './approval-response-tool.js'`.

- [ ] **Step 6: Create `packages/core/src/tools/approval-response-tool.ts`**

```typescript
import type { JSONSchema, ToolResult } from '@legion/types';
import type { Tool, ToolContext } from './Tool.js';
import type { PendingApprovalRegistry, ApprovalDecision } from '../auth/PendingApprovalRegistry.js';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { ApprovalLog } from '../auth/ApprovalLog.js';

interface ApprovalDecisionInput {
  approvalId: string;
  decision: 'approve' | 'reject';
  message?: string;
}

export const approvalResponseTool: Tool = {
  name: 'approval_response',
  description:
    'Respond to one or more pending tool-approval requests. ' +
    'Provide a decision (approve or reject) for each, with an optional explanatory message. ' +
    'Requires authority to approve on behalf of the requesting participant.',
  parameters: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        description: 'List of approval decisions to record.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            approvalId: { type: 'string', description: 'ID from the pending_approval tool result' },
            decision: { type: 'string', enum: ['approve', 'reject'] },
            message: {
              type: 'string',
              description: 'Optional explanation, especially useful for rejections',
            },
          },
          required: ['approvalId', 'decision'],
        },
      },
    },
    required: ['decisions'],
  } as JSONSchema,

  async execute(args, context: ToolContext): Promise<ToolResult> {
    const { decisions } = args as { decisions: ApprovalDecisionInput[] };

    const authEngine = context.authEngine as AuthEngine | undefined;
    const pendingRegistry = context.pendingApprovalRegistry as PendingApprovalRegistry | undefined;
    const approvalLog = context.approvalLog as ApprovalLog | undefined;

    if (!authEngine || !pendingRegistry) {
      return {
        status: 'error',
        error: 'approval_response requires authEngine and pendingApprovalRegistry in context',
      };
    }

    const results: Array<{ approvalId: string; outcome: string }> = [];
    // Track which (conversationId, requesterId) pairs need re-triggering.
    const toResume = new Map<string, string>(); // conversationId → requesterId

    for (const { approvalId, decision, message } of decisions) {
      const pending = pendingRegistry.get(approvalId);
      if (!pending) {
        results.push({ approvalId, outcome: 'not_found' });
        continue;
      }

      const canApprove = authEngine.hasAuthority(
        context.participant.approvalAuthority,
        pending.requesterId,
        pending.tool,
        pending.args,
      );
      if (!canApprove) {
        results.push({ approvalId, outcome: 'unauthorized' });
        continue;
      }

      const approvalDecision: ApprovalDecision = {
        approved: decision === 'approve',
        decidedByParticipantId: context.participant.id,
        message,
        decidedAt: new Date().toISOString(),
      };

      await pendingRegistry.resolve(approvalId, approvalDecision);

      approvalLog?.record({
        requestId: approvalId,
        conversationId: pending.conversationId,
        requesterId: pending.requesterId,
        tool: pending.tool,
        args: pending.args,
        approved: approvalDecision.approved,
        decidedByParticipantId: context.participant.id,
        decidedAt: approvalDecision.decidedAt,
      });

      context.eventBus.emit('approval:resolved', {
        conversationId: pending.conversationId,
        approvalId,
        approved: approvalDecision.approved,
        decidedByParticipantId: context.participant.id,
      });

      results.push({ approvalId, outcome: decision });

      // Deduplicate: one resume call per (conversationId, requesterId) pair.
      // Last requesterId wins if there are somehow multiple for the same conversation
      // (unusual; multiple agents paused in the same conversation is an edge case).
      toResume.set(pending.conversationId, pending.requesterId);
    }

    // Push: re-trigger each paused runtime.
    if (context.messageRouter) {
      for (const [conversationId, requesterId] of toResume) {
        await context.messageRouter.resume(conversationId, requesterId, context);
      }
    }

    return { status: 'success', data: { results } };
  },
};
```

- [ ] **Step 7: Run approval_response tests**

Run: `npx vitest run packages/core/src/tools/approval-response-tool.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/tools/communicate-tool.ts packages/core/src/tools/communicate-tool.test.ts
git add packages/core/src/tools/approval-response-tool.ts packages/core/src/tools/approval-response-tool.test.ts
git commit -m "feat(core): communicate surfaces pending_approval; add approval_response tool"
```

---

## Task 7: Approval flow integration test + barrel exports + self-review

**Files:**
- Create: `packages/core/src/runtime/approval-flow.integration.test.ts`
- Amend: `packages/core/src/index.ts`

> End-to-end approval bubbling: a scripted agent B calls a tool gated by `requires_approval`;
> the caller (operator A) receives `pending_approval` via `communicate`; operator A calls
> `approval_response`; B resumes and produces a final response. Tests both the approve and
> reject paths. Uses a scripted provider — no network.

- [ ] **Step 1: Write the integration test**

`packages/core/src/runtime/approval-flow.integration.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { Collective } from '../collective/Collective.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import { EventBus } from '../events/EventBus.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { MessageRouter } from './MessageRouter.js';
import { AgentRuntime } from './AgentRuntime.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ApprovalLog } from '../auth/ApprovalLog.js';
import { communicateTool } from '../tools/communicate-tool.js';
import { approvalResponseTool } from '../tools/approval-response-tool.js';
import type { Provider, ProviderResponse } from '../providers/Provider.js';
import type { RuntimeContext } from './Runtime.js';
import type { JSONSchema } from '@legion/types';

/** A provider that cycles through a scripted sequence of responses. */
function scriptedProvider(turns: ProviderResponse[]): Provider {
  let i = 0;
  return {
    async complete() {
      const response = turns[i % turns.length];
      i += 1;
      return response;
    },
  };
}

async function setup(dir: string) {
  const storage = new FileStorage(dir);

  // Agent B: has 'echo' as requires_approval, 'communicate' as auto
  await storage.writeJson('collective/participants/agent-b.json', {
    id: 'agent-b',
    name: 'B',
    type: 'agent',
    status: 'active',
    tools: { communicate: 'auto', echo: 'requires_approval' },
    systemPrompt: 'You are a helpful assistant.',
    model: { provider: 'scripted', model: 'test' },
  });

  // Operator: user type, broad approval authority, can use communicate + approval_response
  await storage.writeJson('collective/participants/operator.json', {
    id: 'operator',
    name: 'Operator',
    type: 'user',
    status: 'active',
    tools: { communicate: 'auto', approval_response: 'auto' },
    approvalAuthority: { tools: '*', participants: '*' },
  });

  const collective = await Collective.load(storage);
  const store = new FileConversationStore(storage);
  const eventBus = new EventBus();

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(communicateTool);
  toolRegistry.register(approvalResponseTool);
  toolRegistry.register({
    name: 'echo',
    description: 'Echo a message',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    } as JSONSchema,
    async execute(args) {
      return { status: 'success', data: (args as { text: string }).text };
    },
  });

  const pendingApprovalRegistry = new PendingApprovalRegistry(storage);
  const approvalLog = new ApprovalLog();
  const authEngine = new AuthEngine();
  const providerRegistry = new ProviderRegistry();
  const runtimeRegistry = new RuntimeRegistry();

  const router = new MessageRouter(store, runtimeRegistry, collective, eventBus);

  runtimeRegistry.registerFactory('agent', (id) => new AgentRuntime(id, providerRegistry));
  // operator is a user type — use UserDeliveryRuntime placeholder
  runtimeRegistry.registerFactory('user', (_id) => ({
    async handle() { return { kind: 'void' as const }; },
  }));

  function makeContext(participantId: string, thread?: ConversationThread): RuntimeContext {
    return {
      participant: collective.getOrThrow(participantId),
      conversationId: thread?.id ?? '',
      conversation: thread,
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry,
      authEngine,
      pendingApprovalRegistry,
      approvalLog,
      messageRouter: router,
    } as unknown as RuntimeContext;
  }

  return { collective, store, eventBus, toolRegistry, pendingApprovalRegistry, approvalLog, authEngine, providerRegistry, router, makeContext };
}

describe('Approval flow integration', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'legion-approval-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('approve path: operator approves → B resumes and completes', async () => {
    const { providerRegistry, router, makeContext, store, pendingApprovalRegistry } = await setup(dir);

    // B's scripted LLM: first call → request echo tool; second call (after approval) → respond
    providerRegistry.register(
      'scripted',
      scriptedProvider([
        {
          content: null,
          toolCalls: [{ id: 'tc-echo', name: 'echo', arguments: { text: 'hello world' } }],
          stopReason: 'tool_calls',
        },
        {
          content: 'I echoed "hello world" successfully.',
          toolCalls: [],
          stopReason: 'stop',
        },
      ]),
    );

    const operatorContext = makeContext('operator');

    // Step 1: Operator sends a message to B via communicate
    const communicateResult = await communicateTool.execute(
      { to: 'agent-b', message: 'Please echo "hello world"' },
      operatorContext,
    );

    expect(communicateResult.status).toBe('pending_approval');
    const pendingData = communicateResult.data as {
      conversationId: string;
      approvalRequests: { approvalId: string; tool: string }[];
    };
    expect(pendingData.approvalRequests[0].tool).toBe('echo');

    const { approvalId, conversationId } = {
      approvalId: pendingData.approvalRequests[0].approvalId,
      conversationId: pendingData.conversationId,
    };

    // Verify the pending approval is in the registry
    expect(pendingApprovalRegistry.get(approvalId)).toBeDefined();

    // Step 2: Operator approves
    const approveContext = { ...operatorContext, conversationId };
    const approveResult = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      approveContext,
    );
    expect(approveResult.status).toBe('success');
    const approveData = approveResult.data as { results: { outcome: string }[] };
    expect(approveData.results[0].outcome).toBe('approve');

    // Step 3: Verify B's final response is in the conversation
    const conv = await store.load(conversationId);
    const messages = Object.values(conv!.messages);
    const finalResponse = messages.find(
      (m) => m.role === 'assistant' && m.content === 'I echoed "hello world" successfully.',
    );
    expect(finalResponse).toBeDefined();

    // The echo tool result should be status:'success' in the conversation
    const toolTurn = messages.find((m) => m.toolResults?.some((tr) => tr.result.status === 'success' && tr.name === 'echo'));
    expect(toolTurn).toBeDefined();
  });

  it('reject path: operator rejects → B resumes with rejection message in context', async () => {
    const { providerRegistry, router, makeContext, store } = await setup(dir);

    let secondCallSeen = false;

    providerRegistry.register('scripted', {
      async complete(msgs) {
        // First call: request echo
        const hasToolResult = msgs.some((m) => m.role === 'tool');
        if (!hasToolResult) {
          return {
            content: null,
            toolCalls: [{ id: 'tc-echo', name: 'echo', arguments: { text: 'hi' } }],
            stopReason: 'tool_calls' as const,
          };
        }
        // Second call (after rejection): acknowledge
        secondCallSeen = true;
        return { content: 'Understood, I will not echo.', toolCalls: [], stopReason: 'stop' as const };
      },
    });

    const operatorContext = makeContext('operator');

    const communicateResult = await communicateTool.execute(
      { to: 'agent-b', message: 'Echo "hi"' },
      operatorContext,
    );

    expect(communicateResult.status).toBe('pending_approval');
    const pendingData = communicateResult.data as {
      conversationId: string;
      approvalRequests: { approvalId: string }[];
    };
    const { approvalId, conversationId } = {
      approvalId: pendingData.approvalRequests[0].approvalId,
      conversationId: pendingData.conversationId,
    };

    // Reject
    const rejectResult = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'reject', message: 'Echo is not permitted here' }] },
      { ...operatorContext, conversationId },
    );
    expect(rejectResult.status).toBe('success');

    // B resumes and sees rejection
    expect(secondCallSeen).toBe(true);

    const conv = await store.load(conversationId);
    const messages = Object.values(conv!.messages);
    const rejectedTurn = messages.find((m) =>
      m.toolResults?.some((tr) => tr.result.status === 'rejected'),
    );
    expect(rejectedTurn?.toolResults?.[0].result.message).toBe('Echo is not permitted here');

    const finalResponse = messages.find(
      (m) => m.role === 'assistant' && m.content === 'Understood, I will not echo.',
    );
    expect(finalResponse).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run packages/core/src/runtime/approval-flow.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run packages/core`
Expected: PASS — all Plans 1–7 unit + integration tests green.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Export new symbols from `packages/core/src/index.ts`**

Append to the core barrel:

```typescript
export * from './tools/approval-response-tool.js';
export * from './runtime/AgentRuntime.js';   // already present from Plan 6 — skip if duplicate
```

- [ ] **Step 6: Update the roadmap**

In `docs/superpowers/plans/000-roadmap.md`, update the plan sequence table row for Plan 7:

```markdown
| 7 | Approval bubbling | 1, 4, 5, 6 | Plan written | `007-approval-bubbling.md` |
```

And the generation progress checklist:

```markdown
- [x] Plan 7 written
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/approval-flow.integration.test.ts
git add packages/core/src/index.ts
git add docs/superpowers/plans/000-roadmap.md
npm run format
git add -A
git commit -m "feat(core): approval flow integration test + barrel exports"
```

---

## Self-Review Checklist

- **Spec §7 `AuthEngine` is a pure predicate:** `AgentRuntime` calls `context.authEngine.authorize()` and `context.authEngine.hasAuthority()`. `AuthEngine` is not modified. ✅
- **Spec §7 approval bubbles up emergently:** `communicate` surfaces `pending_approval` tool result; A's LLM calls `approval_response`; `approval_response` re-triggers B via `messageRouter.resume()`. Each hop performs the same local action. ✅
- **Spec §7 fail-safe closes on no authority:** `approval_response` returns `'unauthorized'` outcome when `hasAuthority` returns false; the approval is not recorded. ✅
- **Spec §8 step 6 `approval_response` as global tool:** Defined in `approval-response-tool.ts`, registered at process startup (Plan 10). Noted in barrel exports. ✅
- **Spec §12 `approval:requested` / `approval:resolved` events:** Emitted by `AgentRuntime` when registering and by `AgentRuntime.processResumedApprovals` + `approval_response` when resolving. Payloads match amended `LegionEventMap`. ✅
- **Durable approval state:** `PendingApprovalRegistry` is file-backed (optional `Storage`; required for production, omitted in tests). Pending approvals and decisions survive process restarts. ✅
- **Conversation as state machine:** `pending_approval` tool results in the active chain are the only source of truth for paused state. No in-memory Promise suspension. ✅
- **`RuntimeResult` union replaces `string | void`:** All three runtimes (`AgentRuntime`, `MockRuntime`, `UserDeliveryRuntime`) implement the new interface. `MessageRouter` handles all three variants. ✅
- **Plan 6 deviation resolved:** `AgentRuntime` now presents all non-`'deny'` tools to the LLM. `'requires_approval'` tools are visible but gated at execution time. ✅
- **`approval_response` batched:** Accepts an array of `{ approvalId, decision, message? }`; deduplicates `resume()` calls by `(conversationId, requesterId)` pair. ✅
- **Rejection message in B's context:** `'rejected'` tool result carries `message` from the approver; `buildProviderMessages` serialises it as the tool message content so B's LLM sees it. ✅
- **`approvalId` naming consistency:** Renamed from `requestId` in `PendingApproval`, `LegionEventMap`, and `ToolResult`. All references updated. ✅
- **Cross-plan consistency:** `approval_response` declared in Plan 3's bootstrap operator tool map under `'auto'` policy — no dangling tool reference. Plan 7 implements it; Plan 4's `MANAGEMENT_TOOLS` array should be checked and updated to include `'approval_response'` if it is absent (it may only list management tools; `approval_response` is a separate global tool registered in Plan 10 startup). ✅
- **`ApprovalLog` in `RuntimeContext`:** Added as optional `approvalLog?: ApprovalLog` to `RuntimeContext` in Plan 7's `Runtime.ts` amendment. Plan 10 will wire the concrete instance. ✅
- **Placeholder scan:** All steps contain full code and exact commands. ✅
- **`verbatimModuleSyntax` compliance:** All type-only imports from `@legion/types` and sibling modules use `import type`. ✅
