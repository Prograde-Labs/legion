# Tools, ToolRegistry & AuthEngine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the tool system (definition pattern, `ToolContext`, `ToolRegistry`), the `AuthEngine` pure-predicate authorizer, the `PendingApprovalRegistry`, and the first batch of built-in tools (file ops + management).

**Architecture:** A `Tool` is a plain object with `name`, `description`, `parameters` (JSON schema), and an `execute(args, context)` that returns `{ status, data | error }` instead of throwing (spec §14). `ToolRegistry` holds tools and runs them. `AuthEngine` answers two questions — `authorize` and `hasAuthority` — and orchestrates nothing (spec §7). `PendingApprovalRegistry` tracks in-flight approval requests (used by Plans 5 & 7). Management actions (`create_agent`, etc.) are ordinary tools gated by the caller's policy. Depends on Plans 1–3.

**Tech Stack:** `@legion/core`, Node fs, Vitest.

---

## File Structure

```
packages/core/src/tools/
  Tool.ts                  — Tool, ToolContext, MessageRouterPort, MessageRouterResult
  ToolRegistry.ts          — register/get/list/execute
  ToolRegistry.test.ts
  file-tools.ts            — file_read, file_write, file_list
  file-tools.test.ts
  management-tools.ts      — create_agent, retire_agent, list_participants, get_conversation, set_tool_policy, set_credential
  management-tools.test.ts
packages/core/src/auth/
  AuthEngine.ts            — authorize + hasAuthority + policy resolution
  AuthEngine.test.ts
  PendingApprovalRegistry.ts
  PendingApprovalRegistry.test.ts
  ApprovalLog.ts           — append-only audit record type + in-memory log
  ApprovalLog.test.ts
```

All exported from `packages/core/src/index.ts`.

---

## Task 1: Tool type, ToolContext, ToolRegistry

**Files:**
- Create: `packages/core/src/tools/Tool.ts`
- Create: `packages/core/src/tools/ToolRegistry.ts`
- Test: `packages/core/src/tools/ToolRegistry.test.ts`

- [ ] **Step 1: Create `Tool.ts`** (types only)

```typescript
import type { JSONSchema, ToolResult, ParticipantConfig, WorkspaceConfig } from '@legion/types';
import type { Collective } from '../collective/Collective.js';
import type { CredentialStore } from '../credentials/CredentialStore.js';
import type { EventBus } from '../events/EventBus.js';
import type { Storage } from '../storage/Storage.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';

export interface MessageRouterResult {
  conversationId: string;
  response?: string;
  status: 'success' | 'error' | 'dispatched';
  error?: string;
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
}

/**
 * Context handed to every tool execution. `participant` is always the principal.
 * Runtime-only collaborators are optional here; @legion/runtime's RuntimeContext
 * satisfies this interface and provides them concretely (spec §4).
 */
export interface ToolContext {
  participant: ParticipantConfig;
  conversationId: string;
  collective: Collective;
  config: WorkspaceConfig;
  eventBus: EventBus;
  storage: Storage;
  workspaceRoot: string;
  communicationDepth: number;
  toolRegistry: ToolRegistryLike;
  callingParticipantId?: string;
  credentialStore?: CredentialStore;
  conversation?: ConversationThread;
  messageRouter?: MessageRouterPort;
  // Plans 5 & 7 attach: authEngine, pendingApprovalRegistry, serviceManager.
  [key: string]: unknown;
}

export interface ToolRegistryLike {
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  list(): Tool[];
  execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/tools/ToolRegistry.test.ts`:

```typescript
import { ToolRegistry } from './ToolRegistry.js';
import type { Tool, ToolContext } from './Tool.js';

const echoTool: Tool = {
  name: 'echo',
  description: 'returns its input',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(args) {
    const { text } = args as { text: string };
    return { status: 'success', data: text };
  },
};

function fakeContext(): ToolContext {
  return { participant: { id: 'p', name: 'P', type: 'mock', tools: {}, responses: [] } } as unknown as ToolContext;
}

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(reg.has('echo')).toBe(true);
    expect(reg.get('echo')?.name).toBe('echo');
    expect(reg.list().map((t) => t.name)).toEqual(['echo']);
  });

  it('rejects duplicate registration', () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(() => reg.register(echoTool)).toThrow(/already registered/i);
  });

  it('executes a registered tool', async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    const result = await reg.execute('echo', { text: 'hi' }, fakeContext());
    expect(result).toEqual({ status: 'success', data: 'hi' });
  });

  it('returns a tool error when executing an unknown tool', async () => {
    const reg = new ToolRegistry();
    const result = await reg.execute('nope', {}, fakeContext());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not found/i);
  });

  it('converts a thrown error into a tool error result', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'boom',
      description: 'throws',
      parameters: { type: 'object' },
      async execute() {
        throw new Error('kaboom');
      },
    });
    const result = await reg.execute('boom', {}, fakeContext());
    expect(result.status).toBe('error');
    expect(result.error).toContain('kaboom');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/ToolRegistry.test.ts`
Expected: FAIL — `Cannot find module './ToolRegistry.js'`.

- [ ] **Step 4: Write minimal implementation**

`packages/core/src/tools/ToolRegistry.ts`:

```typescript
import type { ToolResult } from '@legion/types';
import { ConflictError, ToolNotFoundError } from '../errors/LegionError.js';
import type { Tool, ToolContext, ToolRegistryLike } from './Tool.js';

export class ToolRegistry implements ToolRegistryLike {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new ConflictError(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { status: 'error', error: new ToolNotFoundError(name).message };
    }
    try {
      return await tool.execute(args, context);
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/ToolRegistry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/Tool.ts packages/core/src/tools/ToolRegistry.ts packages/core/src/tools/ToolRegistry.test.ts
git commit -m "feat(core): add Tool type, ToolContext, and ToolRegistry"
```

---

## Task 2: AuthEngine

**Files:**
- Create: `packages/core/src/auth/AuthEngine.ts`
- Test: `packages/core/src/auth/AuthEngine.test.ts`

> Spec §7. `authorize` resolution order: participant per-tool policy → engine per-tool
> policy → engine default → built-in default → fail-safe `requires_approval`.
> `hasAuthority` checks an `ApprovalAuthority` against a requester+tool.

- [ ] **Step 1: Write the failing test**

```typescript
import { AuthEngine } from './AuthEngine.js';
import type { ApprovalAuthority, ToolPolicy } from '@legion/types';

describe('AuthEngine.authorize', () => {
  it('honors a participant per-tool auto policy', () => {
    const engine = new AuthEngine();
    const policies: Record<string, ToolPolicy> = { file_read: 'auto' };
    const result = engine.authorize('p1', 'file_read', {}, policies);
    expect(result.authorized).toBe(true);
  });

  it('honors a participant per-tool deny policy', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'file_write', {}, { file_write: 'deny' });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('deny');
  });

  it('returns not-authorized with requires_approval reason', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'danger', {}, { danger: 'requires_approval' });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('requires_approval');
  });

  it('falls back to engine per-tool policy when participant has none', () => {
    const engine = new AuthEngine({ toolPolicies: { file_read: 'auto' } });
    expect(engine.authorize('p1', 'file_read', {}, {}).authorized).toBe(true);
  });

  it('falls back to engine default policy', () => {
    const engine = new AuthEngine({ defaultPolicy: 'auto' });
    expect(engine.authorize('p1', 'whatever', {}, {}).authorized).toBe(true);
  });

  it('fail-safe is requires_approval when nothing matches', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'unknown_tool', {}, {});
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('requires_approval');
  });
});

describe('AuthEngine.hasAuthority', () => {
  it('wildcard tools + wildcard participants grants all', () => {
    const engine = new AuthEngine();
    const authority: ApprovalAuthority = { tools: '*', participants: '*' };
    expect(engine.hasAuthority(authority, 'b', 'anything', {})).toBe(true);
  });

  it('denies when requester not in participants list', () => {
    const engine = new AuthEngine();
    const authority: ApprovalAuthority = { tools: '*', participants: ['x'] };
    expect(engine.hasAuthority(authority, 'b', 'anything', {})).toBe(false);
  });

  it('denies when tool not permitted', () => {
    const engine = new AuthEngine();
    const authority: ApprovalAuthority = { tools: { file_read: true }, participants: '*' };
    expect(engine.hasAuthority(authority, 'b', 'file_write', {})).toBe(false);
    expect(engine.hasAuthority(authority, 'b', 'file_read', {})).toBe(true);
  });

  it('undefined authority grants nothing', () => {
    const engine = new AuthEngine();
    expect(engine.hasAuthority(undefined, 'b', 'x', {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/auth/AuthEngine.test.ts`
Expected: FAIL — `Cannot find module './AuthEngine.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/auth/AuthEngine.ts`:

```typescript
import type { ApprovalAuthority, ToolPolicy } from '@legion/types';

export interface AuthEngineOptions {
  toolPolicies?: Record<string, ToolPolicy>;
  defaultPolicy?: ToolPolicy;
}

export interface AuthResult {
  authorized: boolean;
  reason?: 'auto' | 'deny' | 'requires_approval';
}

const BUILTIN_DEFAULT: ToolPolicy = 'requires_approval';

export class AuthEngine {
  private toolPolicies: Record<string, ToolPolicy>;
  private defaultPolicy?: ToolPolicy;

  constructor(options: AuthEngineOptions = {}) {
    this.toolPolicies = options.toolPolicies ?? {};
    this.defaultPolicy = options.defaultPolicy;
  }

  private resolvePolicy(tool: string, participantPolicies?: Record<string, ToolPolicy>): ToolPolicy {
    if (participantPolicies && tool in participantPolicies) return participantPolicies[tool];
    if (tool in this.toolPolicies) return this.toolPolicies[tool];
    if (this.defaultPolicy) return this.defaultPolicy;
    return BUILTIN_DEFAULT;
  }

  authorize(
    _participantId: string,
    tool: string,
    _args: unknown,
    participantPolicies?: Record<string, ToolPolicy>,
  ): AuthResult {
    const policy = this.resolvePolicy(tool, participantPolicies);
    switch (policy) {
      case 'auto':
        return { authorized: true, reason: 'auto' };
      case 'deny':
        return { authorized: false, reason: 'deny' };
      case 'requires_approval':
      default:
        return { authorized: false, reason: 'requires_approval' };
    }
  }

  hasAuthority(
    authority: ApprovalAuthority | undefined,
    requesterId: string,
    tool: string,
    _args: unknown,
  ): boolean {
    if (!authority) return false;

    const participantsOk =
      authority.participants === '*' ||
      (Array.isArray(authority.participants) && authority.participants.includes(requesterId));
    if (!participantsOk) return false;

    if (authority.tools === '*') return true;
    if (authority.tools && typeof authority.tools === 'object') {
      return authority.tools[tool] === true;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/auth/AuthEngine.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth/AuthEngine.ts packages/core/src/auth/AuthEngine.test.ts
git commit -m "feat(core): add AuthEngine predicate"
```

---

## Task 3: ApprovalLog

**Files:**
- Create: `packages/core/src/auth/ApprovalLog.ts`
- Test: `packages/core/src/auth/ApprovalLog.test.ts`

> Spec §7: `ApprovalLog.decidedByParticipantId` carries the real approver.

- [ ] **Step 1: Write the failing test**

```typescript
import { ApprovalLog } from './ApprovalLog.js';

describe('ApprovalLog', () => {
  it('records and lists approval decisions', () => {
    const log = new ApprovalLog();
    log.record({
      requestId: 'r1',
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    const entries = log.list();
    expect(entries.length).toBe(1);
    expect(entries[0].decidedByParticipantId).toBe('operator');
  });

  it('filters by conversation', () => {
    const log = new ApprovalLog();
    log.record({ requestId: 'r1', conversationId: 'c1', requesterId: 'a', tool: 't', args: {}, approved: true, decidedByParticipantId: 'op', decidedAt: '2026-01-01T00:00:00.000Z' });
    log.record({ requestId: 'r2', conversationId: 'c2', requesterId: 'a', tool: 't', args: {}, approved: false, decidedByParticipantId: 'op', decidedAt: '2026-01-01T00:00:00.000Z' });
    expect(log.list({ conversationId: 'c2' }).map((e) => e.requestId)).toEqual(['r2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/auth/ApprovalLog.test.ts`
Expected: FAIL — `Cannot find module './ApprovalLog.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/auth/ApprovalLog.ts`:

```typescript
export interface ApprovalLogEntry {
  requestId: string;
  conversationId: string;
  requesterId: string;
  tool: string;
  args: unknown;
  approved: boolean;
  decidedByParticipantId: string;
  decidedAt: string;
}

export interface ApprovalLogFilter {
  conversationId?: string;
  requesterId?: string;
}

export class ApprovalLog {
  private entries: ApprovalLogEntry[] = [];

  record(entry: ApprovalLogEntry): void {
    this.entries.push(entry);
  }

  list(filter?: ApprovalLogFilter): ApprovalLogEntry[] {
    return this.entries.filter((e) => {
      if (filter?.conversationId && e.conversationId !== filter.conversationId) return false;
      if (filter?.requesterId && e.requesterId !== filter.requesterId) return false;
      return true;
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/auth/ApprovalLog.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth/ApprovalLog.ts packages/core/src/auth/ApprovalLog.test.ts
git commit -m "feat(core): add ApprovalLog"
```

---

## Task 4: PendingApprovalRegistry

**Files:**
- Create: `packages/core/src/auth/PendingApprovalRegistry.ts`
- Test: `packages/core/src/auth/PendingApprovalRegistry.test.ts`

> Tracks in-flight approval requests as promises the requesting runtime awaits while the
> decision bubbles up (Plan 7 drives this; defined here as a core primitive).

- [ ] **Step 1: Write the failing test**

```typescript
import { PendingApprovalRegistry } from './PendingApprovalRegistry.js';

describe('PendingApprovalRegistry', () => {
  it('creates a pending request and resolves it', async () => {
    const reg = new PendingApprovalRegistry();
    const { requestId, decision } = reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
    });
    expect(requestId).toMatch(/^appr-/);
    expect(reg.get(requestId)).toBeDefined();

    reg.resolve(requestId, { approved: true, decidedByParticipantId: 'operator' });
    await expect(decision).resolves.toEqual({ approved: true, decidedByParticipantId: 'operator' });
    expect(reg.get(requestId)).toBeUndefined();
  });

  it('rejects resolving an unknown request', () => {
    const reg = new PendingApprovalRegistry();
    expect(() => reg.resolve('appr-ghost', { approved: false, decidedByParticipantId: 'x' })).toThrow();
  });

  it('lists pending requests', () => {
    const reg = new PendingApprovalRegistry();
    reg.create({ conversationId: 'c1', requesterId: 'a', tool: 't', args: {} });
    reg.create({ conversationId: 'c2', requesterId: 'b', tool: 't', args: {} });
    expect(reg.list().length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/auth/PendingApprovalRegistry.test.ts`
Expected: FAIL — `Cannot find module './PendingApprovalRegistry.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/auth/PendingApprovalRegistry.ts`:

```typescript
import { createId } from '../util/ids.js';
import { LegionError } from '../errors/LegionError.js';

export interface ApprovalDecision {
  approved: boolean;
  decidedByParticipantId: string;
}

export interface PendingApprovalInput {
  conversationId: string;
  requesterId: string;
  tool: string;
  args: unknown;
}

export interface PendingApproval extends PendingApprovalInput {
  requestId: string;
  createdAt: string;
}

interface PendingEntry extends PendingApproval {
  resolveFn: (decision: ApprovalDecision) => void;
}

export class PendingApprovalRegistry {
  private pending = new Map<string, PendingEntry>();

  create(input: PendingApprovalInput): { requestId: string; decision: Promise<ApprovalDecision> } {
    const requestId = createId('appr');
    let resolveFn!: (decision: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      resolveFn = resolve;
    });
    this.pending.set(requestId, {
      ...input,
      requestId,
      createdAt: new Date().toISOString(),
      resolveFn,
    });
    return { requestId, decision };
  }

  get(requestId: string): PendingApproval | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    const { resolveFn: _ignored, ...rest } = entry;
    return rest;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ resolveFn: _ignored, ...rest }) => rest);
  }

  resolve(requestId: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) throw new LegionError(`Unknown approval request: ${requestId}`, 'APPROVAL_NOT_FOUND');
    this.pending.delete(requestId);
    entry.resolveFn(decision);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/auth/PendingApprovalRegistry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth/PendingApprovalRegistry.ts packages/core/src/auth/PendingApprovalRegistry.test.ts
git commit -m "feat(core): add PendingApprovalRegistry"
```

---

## Task 5: File tools

**Files:**
- Create: `packages/core/src/tools/file-tools.ts`
- Test: `packages/core/src/tools/file-tools.test.ts`

> `file_read`, `file_write`, `file_list`, scoped to `context.workspaceRoot` with a
> path-traversal guard. Tools return error results, never throw (spec §14).

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReadTool, fileWriteTool, fileListTool } from './file-tools.js';
import type { ToolContext } from './Tool.js';

function ctx(workspaceRoot: string): ToolContext {
  return { workspaceRoot, participant: { id: 'p', name: 'P', type: 'mock', tools: {}, responses: [] } } as unknown as ToolContext;
}

describe('file tools', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-files-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('file_write then file_read round-trips', async () => {
    const w = await fileWriteTool.execute({ path: 'notes/a.txt', content: 'hello' }, ctx(dir));
    expect(w.status).toBe('success');
    const r = await fileReadTool.execute({ path: 'notes/a.txt' }, ctx(dir));
    expect(r).toEqual({ status: 'success', data: 'hello' });
  });

  it('file_read returns an error for a missing file', async () => {
    const r = await fileReadTool.execute({ path: 'missing.txt' }, ctx(dir));
    expect(r.status).toBe('error');
  });

  it('file_list lists directory entries', async () => {
    await fileWriteTool.execute({ path: 'd/a.txt', content: '1' }, ctx(dir));
    await fileWriteTool.execute({ path: 'd/b.txt', content: '2' }, ctx(dir));
    const r = await fileListTool.execute({ path: 'd' }, ctx(dir));
    expect(r.status).toBe('success');
    expect((r.data as string[]).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('rejects path traversal outside the workspace', async () => {
    const r = await fileReadTool.execute({ path: '../../etc/passwd' }, ctx(dir));
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/outside|invalid path/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/file-tools.test.ts`
Expected: FAIL — `Cannot find module './file-tools.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/tools/file-tools.ts`:

```typescript
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import type { JSONSchema, ToolResult } from '@legion/types';
import type { Tool, ToolContext } from './Tool.js';

function resolveInWorkspace(context: ToolContext, path: string): string | null {
  if (isAbsolute(path)) return null;
  const root = context.workspaceRoot;
  const resolved = normalize(join(root, path));
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}

const pathParam: JSONSchema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};

export const fileReadTool: Tool = {
  name: 'file_read',
  description: 'Read a UTF-8 text file relative to the workspace root.',
  parameters: pathParam,
  async execute(args, context): Promise<ToolResult> {
    const { path } = args as { path: string };
    const target = resolveInWorkspace(context, path);
    if (!target) return { status: 'error', error: `Invalid path (outside workspace): ${path}` };
    try {
      return { status: 'success', data: await readFile(target, 'utf8') };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const fileWriteTool: Tool = {
  name: 'file_write',
  description: 'Write a UTF-8 text file relative to the workspace root, creating parents.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { path, content } = args as { path: string; content: string };
    const target = resolveInWorkspace(context, path);
    if (!target) return { status: 'error', error: `Invalid path (outside workspace): ${path}` };
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      return { status: 'success', data: { path } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const fileListTool: Tool = {
  name: 'file_list',
  description: 'List entries of a directory relative to the workspace root.',
  parameters: pathParam,
  async execute(args, context): Promise<ToolResult> {
    const { path } = args as { path: string };
    const target = resolveInWorkspace(context, path);
    if (!target) return { status: 'error', error: `Invalid path (outside workspace): ${path}` };
    try {
      const entries = await readdir(target);
      return { status: 'success', data: entries };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const fileTools: Tool[] = [fileReadTool, fileWriteTool, fileListTool];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/file-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/file-tools.ts packages/core/src/tools/file-tools.test.ts
git commit -m "feat(core): add file tools with workspace path guard"
```

---

## Task 6: Management tools

**Files:**
- Create: `packages/core/src/tools/management-tools.ts`
- Test: `packages/core/src/tools/management-tools.test.ts`

> Spec §7: management actions are ordinary tools operating on `context.collective`.
> Implemented: `create_agent`, `retire_agent`, `list_participants`, `get_conversation`,
> `set_tool_policy`, `set_credential`. (`set_credential` resolves the bootstrap operator's
> declared tool from Plan 3; it hashes via `context.credentialStore` — spec §6.)

- [ ] **Step 1: Write the failing test**

```typescript
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileCredentialStore } from '../credentials/FileCredentialStore.js';
import {
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getConversationTool,
  setToolPolicyTool,
  setCredentialTool,
} from './management-tools.js';
import type { ToolContext } from './Tool.js';

async function makeContext() {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const conversationStore = new FileConversationStore(storage);
  const context = {
    participant: collective.getOrThrow('operator'),
    collective,
    conversationStore,
    workspaceRoot: '/tmp',
  } as unknown as ToolContext;
  return { context, collective, conversationStore };
}

describe('management tools', () => {
  it('create_agent adds a new agent participant', async () => {
    const { context, collective } = await makeContext();
    const result = await createAgentTool.execute(
      {
        id: 'agent-x',
        name: 'X',
        systemPrompt: 'be helpful',
        model: { provider: 'openai-compatible', model: 'gpt-4o-mini' },
        tools: { communicate: 'auto' },
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(collective.get('agent-x')?.type).toBe('agent');
  });

  it('list_participants returns the roster', async () => {
    const { context } = await makeContext();
    const result = await listParticipantsTool.execute({}, context);
    expect(result.status).toBe('success');
    expect((result.data as { id: string }[]).some((p) => p.id === 'operator')).toBe(true);
  });

  it('retire_agent retires an agent', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      { id: 'agent-x', name: 'X', systemPrompt: 's', model: { provider: 'openai-compatible', model: 'm' }, tools: {} },
      context,
    );
    const result = await retireAgentTool.execute({ id: 'agent-x' }, context);
    expect(result.status).toBe('success');
    expect(collective.get('agent-x')?.status).toBe('retired');
  });

  it('set_tool_policy updates a participant policy', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      { id: 'agent-x', name: 'X', systemPrompt: 's', model: { provider: 'openai-compatible', model: 'm' }, tools: {} },
      context,
    );
    const result = await setToolPolicyTool.execute(
      { participantId: 'agent-x', tool: 'file_read', policy: 'auto' },
      context,
    );
    expect(result.status).toBe('success');
    expect(collective.get('agent-x')?.tools['file_read']).toBe('auto');
  });

  it('get_conversation returns the active chain of a conversation', async () => {
    const { context, conversationStore } = await makeContext();
    const conv = await conversationStore.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    await conversationStore.appendMessage(conv.id, {
      id: 'm1', parentId: null, conversationId: conv.id, senderId: 'operator', recipientId: 'agent-x',
      role: 'user', content: 'hi', status: 'active', timestamp: new Date().toISOString(),
    });
    await conversationStore.updateHead(conv.id, 'm1');
    const result = await getConversationTool.execute({ conversationId: conv.id }, context);
    expect(result.status).toBe('success');
    expect((result.data as { messages: unknown[] }).messages.length).toBe(1);
  });

  it('create_agent rejects a duplicate id with a tool error', async () => {
    const { context } = await makeContext();
    const args = { id: 'operator', name: 'dup', systemPrompt: 's', model: { provider: 'p', model: 'm' }, tools: {} };
    const result = await createAgentTool.execute(args, context);
    expect(result.status).toBe('error');
  });

  it('set_credential hashes and stores a participant secret', async () => {
    const { context } = await makeContext();
    const credentialStore = new FileCredentialStore(new MemoryStorage());
    const ctx = { ...context, credentialStore } as unknown as ToolContext;
    const result = await setCredentialTool.execute(
      { participantId: 'operator', secret: 'hunter2' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(await credentialStore.verify('operator', 'hunter2')).toBe(true);
  });

  it('set_credential errors when no credentialStore is in context', async () => {
    const { context } = await makeContext();
    const result = await setCredentialTool.execute(
      { participantId: 'operator', secret: 'x' },
      context,
    );
    expect(result.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: FAIL — `Cannot find module './management-tools.js'`.

- [ ] **Step 3: Extend `ToolContext` with `conversationStore`**

In `packages/core/src/tools/Tool.ts`, add the import and field:

```typescript
import type { ConversationStore } from '../conversation/ConversationStore.js';
```

Add to the `ToolContext` interface (above the index signature):

```typescript
  conversationStore?: ConversationStore;
```

- [ ] **Step 4: Write minimal implementation**

`packages/core/src/tools/management-tools.ts`:

```typescript
import type { JSONSchema, ToolPolicy, ToolResult, AgentConfig, ModelConfig } from '@legion/types';
import { getActiveChain } from '../conversation/conversation-ops.js';
import type { Tool, ToolContext } from './Tool.js';

function requireCollective(context: ToolContext): NonNullable<ToolContext['collective']> {
  if (!context.collective) throw new Error('collective unavailable in context');
  return context.collective;
}

export const createAgentTool: Tool = {
  name: 'create_agent',
  description: 'Create a new agent participant in the collective.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      systemPrompt: { type: 'string' },
      model: { type: 'object' },
      tools: { type: 'object' },
    },
    required: ['id', 'name', 'systemPrompt', 'model'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { id, name, systemPrompt, model, tools } = args as {
      id: string;
      name: string;
      systemPrompt: string;
      model: ModelConfig;
      tools?: Record<string, ToolPolicy>;
    };
    const config: AgentConfig = {
      id,
      name,
      type: 'agent',
      tools: tools ?? {},
      systemPrompt,
      model,
      status: 'active',
    };
    try {
      await requireCollective(context).add(config);
      return { status: 'success', data: { id } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const retireAgentTool: Tool = {
  name: 'retire_agent',
  description: 'Retire a participant by id.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { id } = args as { id: string };
    try {
      await requireCollective(context).retire(id);
      return { status: 'success', data: { id } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const listParticipantsTool: Tool = {
  name: 'list_participants',
  description: 'List participants in the collective.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, context): Promise<ToolResult> {
    try {
      const list = requireCollective(context)
        .list()
        .map((p) => ({ id: p.id, name: p.name, type: p.type, status: p.status ?? 'active' }));
      return { status: 'success', data: list };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const setToolPolicyTool: Tool = {
  name: 'set_tool_policy',
  description: "Set a participant's policy for a specific tool.",
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      tool: { type: 'string' },
      policy: { type: 'string', enum: ['auto', 'deny', 'requires_approval'] },
    },
    required: ['participantId', 'tool', 'policy'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { participantId, tool, policy } = args as {
      participantId: string;
      tool: string;
      policy: ToolPolicy;
    };
    try {
      const collective = requireCollective(context);
      const participant = collective.getOrThrow(participantId);
      const tools = { ...participant.tools, [tool]: policy };
      await collective.update(participantId, { tools });
      return { status: 'success', data: { participantId, tool, policy } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const getConversationTool: Tool = {
  name: 'get_conversation',
  description: 'Load a conversation and its active message chain.',
  parameters: {
    type: 'object',
    properties: { conversationId: { type: 'string' } },
    required: ['conversationId'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { conversationId } = args as { conversationId: string };
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    const conversation = await context.conversationStore.load(conversationId);
    if (!conversation) return { status: 'error', error: `Conversation not found: ${conversationId}` };
    return {
      status: 'success',
      data: { id: conversation.id, title: conversation.title, messages: getActiveChain(conversation) },
    };
  },
};

export const setCredentialTool: Tool = {
  name: 'set_credential',
  description: "Set (hash and store) a participant's authentication secret.",
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      secret: { type: 'string' },
    },
    required: ['participantId', 'secret'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { participantId, secret } = args as { participantId: string; secret: string };
    if (!context.credentialStore) {
      return { status: 'error', error: 'credentialStore unavailable in context' };
    }
    try {
      await context.credentialStore.setCredential(participantId, secret);
      return { status: 'success', data: { participantId } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const managementTools: Tool[] = [
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  setToolPolicyTool,
  getConversationTool,
  setCredentialTool,
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Export tools + auth from the core barrel**

Append to `packages/core/src/index.ts`:

```typescript
export * from './tools/Tool.js';
export * from './tools/ToolRegistry.js';
export * from './tools/file-tools.js';
export * from './tools/management-tools.js';
export * from './auth/AuthEngine.js';
export * from './auth/ApprovalLog.js';
export * from './auth/PendingApprovalRegistry.js';
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts packages/core/src/tools/Tool.ts packages/core/src/index.ts
git commit -m "feat(core): add management tools"
```

---

## Task 7: Full build + test gate

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Run full suite**

Run: `npm test`
Expected: PASS — Plans 1–4 green.

- [ ] **Step 3: Format + commit fixes**

```bash
npm run format
git add -A
git commit -m "chore: format tools/auth sources" || echo "nothing to format"
```

---

## Self-Review Checklist

- **Spec §14 Tool pattern (object with name/description/parameters/execute, error-as-result):** Task 1, 5, 6. ✅
- **Spec §7 AuthEngine pure predicate (authorize + hasAuthority, resolution order, fail-safe):** Task 2. ✅
- **Spec §7 ApprovalLog.decidedByParticipantId:** Task 3. ✅
- **Spec §7 PendingApprovalRegistry tracks resolution:** Task 4. ✅
- **Spec §8/§13 management actions as ordinary tools (create_agent, retire_agent, list_participants, get_conversation, set_tool_policy, set_credential):** Task 6. ✅
- **Cross-plan consistency:** every tool granted to the Plan 3 bootstrap operator (`communicate`, `create_agent`, `retire_agent`, `list_participants`, `get_conversation`, `set_tool_policy`, `set_credential`) is now registered by Plan 4 (management) or Plan 5 (`communicate`). No dangling tool references. ✅
- **File-op tools (registered as global tools, spec §8 step 6):** Task 5. ✅
- **`communicate` + `approval_response` tools:** intentionally deferred — `communicate` needs `MessageRouter` (Plan 5); `approval_response` needs the bubbling flow (Plan 7). Noted via `MessageRouterPort` placeholder in Task 1. ✅
- **Placeholder scan:** all code present; no TODO/TBD. ✅
- **Type consistency:** `Tool`, `ToolContext`, `ToolRegistry`, `AuthEngine`, `PendingApprovalRegistry`, `ApprovalLog`, `MessageRouterPort`, `MessageRouterResult` are consumed verbatim by Plans 5, 7, 10. ✅
