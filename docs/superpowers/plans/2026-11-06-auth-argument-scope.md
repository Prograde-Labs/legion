# Argument Scope Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional per-argument scope constraints to participant tool policies, enforce them in authorization, and let operators set and edit them.

**Architecture:** Widen `ToolPolicy` in `@legion-collective/types` to accept an object form with a `scope` map. A pure `ArgumentScope` evaluator resolves constraints, including filesystem containment for `pathPrefix`. `AuthEngine` delegates to it and returns a new `'scope'` reason; every authorization site maps that reason to a structured error, and the approval-resume path re-checks. Management tools validate policies on write, and the web editor renders and edits scopes.

**Tech Stack:** TypeScript strict ESM, Vitest, Vue 3 + happy-dom, Prettier.

**Spec:** `docs/superpowers/specs/2026-11-06-auth-argument-scope-design.md`

## Global Constraints

- Node `>= 20`.
- TypeScript strict ESM; use `.js` suffixes on relative imports.
- Prettier: single quotes, semicolons, trailing commas, print width 100, tab width 2.
- Existing `'auto'` and `'requires_approval'` string policies must keep working unchanged.
- Scope keys are top-level argument names only.
- A scope violation is a hard deny; it is never escalated to approval.
- Fail closed on missing context, type mismatches, and filesystem errors.
- No migration of stored participant configs.
- No roadmap #7 (contact/group visibility) work.
- Work in the existing worktree `threads/2026-11-06-auth-scope/legion` on `feat/auth-argument-scope`.
- Run the full gate before the final commit: `npm run format:check`, `npm run typecheck`, `npm test`, and `cd packages/web && npm test`.

---

### Task 1: Policy types and normalization

**Files:**
- Modify: `packages/types/src/tool.ts:32`
- Create: `packages/types/src/tool.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ArgScope`, `ToolScope`, widened `ToolPolicy`, and `normalizeToolPolicy(policy: ToolPolicy | undefined): { policy: 'auto' | 'requires_approval'; scope?: ToolScope } | undefined`.

- [ ] **Step 1: Write the failing test**

Create `packages/types/src/tool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeToolPolicy, type ToolPolicy } from './tool.js';

describe('normalizeToolPolicy', () => {
  it('maps the legacy auto string', () => {
    expect(normalizeToolPolicy('auto')).toEqual({ policy: 'auto' });
  });

  it('maps the legacy requires_approval string', () => {
    expect(normalizeToolPolicy('requires_approval')).toEqual({ policy: 'requires_approval' });
  });

  it('returns undefined for an absent policy', () => {
    expect(normalizeToolPolicy(undefined)).toBeUndefined();
  });

  it('passes through the object form with a scope', () => {
    const policy: ToolPolicy = {
      policy: 'auto',
      scope: { path: { pathPrefix: 'work' } },
    };
    expect(normalizeToolPolicy(policy)).toEqual(policy);
  });

  it('accepts an object form without a scope', () => {
    expect(normalizeToolPolicy({ policy: 'requires_approval' })).toEqual({
      policy: 'requires_approval',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- packages/types/src/tool.test.ts`
Expected: FAIL because `normalizeToolPolicy` is not exported.

- [ ] **Step 3: Implement the types and helper**

In `packages/types/src/tool.ts`, replace the line `export type ToolPolicy = 'auto' | 'requires_approval';` with:

```ts
export interface ArgScope {
  /** When true, the argument must be present (and non-null). Default: absent passes. */
  required?: boolean;
  /** Exact string match against one of the listed values. */
  enum?: string[];
  /** JavaScript regular expression source, validated when the policy is set. */
  pattern?: string;
  /** String length bounds. */
  minLength?: number;
  maxLength?: number;
  /** Numeric bounds. */
  min?: number;
  max?: number;
  /**
   * Path containment. Relative prefixes resolve against workspaceRoot;
   * absolute prefixes are used as-is.
   */
  pathPrefix?: string;
}

/** Scope keyed by top-level argument name. */
export type ToolScope = Record<string, ArgScope>;

export type ToolPolicy =
  | 'auto'
  | 'requires_approval'
  | { policy: 'auto' | 'requires_approval'; scope?: ToolScope };

/**
 * Normalizes the legacy string form and the object form to a single shape.
 * `undefined` means the tool is absent from the participant's map (hidden).
 */
export function normalizeToolPolicy(
  policy: ToolPolicy | undefined,
): { policy: 'auto' | 'requires_approval'; scope?: ToolScope } | undefined {
  if (policy === undefined) return undefined;
  if (typeof policy === 'string') return { policy };
  return policy;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- packages/types/src/tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/tool.ts packages/types/src/tool.test.ts
git commit -m "feat(types): add argument scope to tool policies"
```

---

### Task 2: Argument scope evaluator

**Files:**
- Create: `packages/core/src/auth/ArgumentScope.ts`
- Create: `packages/core/src/auth/ArgumentScope.test.ts`

**Interfaces:**
- Consumes: `ArgScope`, `ToolScope` from `@legion-collective/types`.
- Produces:
  - `ScopeContext { workspaceRoot: string }`
  - `ScopeResult = { ok: true } | { ok: false; arg: string; reason: string }`
  - `evaluateScope(tool: string, args: unknown, scope: ToolScope, ctx: ScopeContext): ScopeResult`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/auth/ArgumentScope.test.ts`:

```ts
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateScope } from './ArgumentScope.js';

describe('evaluateScope', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'legion-scope-'));
    await mkdir(join(root, 'work'), { recursive: true });
    await mkdir(join(root, 'other'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes an empty scope', () => {
    expect(evaluateScope('t', { path: 'anything' }, {}, { workspaceRoot: root })).toEqual({
      ok: true,
    });
  });

  it('passes an absent argument by default', () => {
    expect(
      evaluateScope('t', {}, { path: { enum: ['a'] } }, { workspaceRoot: root }),
    ).toEqual({ ok: true });
  });

  it('fails a required argument when it is absent', () => {
    expect(
      evaluateScope('t', {}, { path: { required: true } }, { workspaceRoot: root }),
    ).toEqual({ ok: false, arg: 'path', reason: 'is required' });
  });

  it('fails a required argument when it is null', () => {
    expect(
      evaluateScope('t', { path: null }, { path: { required: true } }, { workspaceRoot: root }),
    ).toEqual({ ok: false, arg: 'path', reason: 'is required' });
  });

  it('enforces enum membership', () => {
    const scope = { detail: { enum: ['minimal', 'standard'] } };
    expect(evaluateScope('t', { detail: 'standard' }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { detail: 'full' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'detail',
      reason: 'must be one of: minimal, standard',
    });
  });

  it('enforces pattern matches', () => {
    const scope = { model: { pattern: '^claude-' } };
    expect(evaluateScope('t', { model: 'claude-3' }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { model: 'gpt-4' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'model',
      reason: 'does not match /^claude-/',
    });
  });

  it('fails an invalid pattern closed', () => {
    expect(
      evaluateScope('t', { model: 'x' }, { model: { pattern: '[' } }, { workspaceRoot: root }),
    ).toEqual({ ok: false, arg: 'model', reason: 'has an invalid pattern' });
  });

  it('enforces string length bounds', () => {
    const scope = { message: { minLength: 2, maxLength: 4 } };
    expect(evaluateScope('t', { message: 'abc' }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { message: 'a' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'message',
      reason: 'must be at least 2 characters',
    });
    expect(evaluateScope('t', { message: 'abcde' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'message',
      reason: 'must be at most 4 characters',
    });
  });

  it('enforces numeric bounds', () => {
    const scope = { timeoutMs: { min: 1, max: 60000 } };
    expect(evaluateScope('t', { timeoutMs: 1000 }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { timeoutMs: 0 }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'timeoutMs',
      reason: 'must be at least 1',
    });
    expect(evaluateScope('t', { timeoutMs: 60001 }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'timeoutMs',
      reason: 'must be at most 60000',
    });
  });

  it('fails a type mismatch closed', () => {
    expect(
      evaluateScope('t', { message: 5 }, { message: { maxLength: 10 } }, { workspaceRoot: root }),
    ).toEqual({ ok: false, arg: 'message', reason: 'must be a string' });
    expect(
      evaluateScope('t', { timeoutMs: '5' }, { timeoutMs: { max: 10 } }, { workspaceRoot: root }),
    ).toEqual({ ok: false, arg: 'timeoutMs', reason: 'must be a finite number' });
  });

  it('passes a relative path inside the allowed prefix', () => {
    expect(
      evaluateScope(
        't',
        { path: 'work/a.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: true });
  });

  it('fails a parent-directory escape', () => {
    expect(
      evaluateScope(
        't',
        { path: '../escape.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('fails an absolute path outside the workspace prefix', () => {
    expect(
      evaluateScope(
        't',
        { path: '/etc/passwd' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('does not match a sibling prefix that shares a name', () => {
    expect(
      evaluateScope(
        't',
        { path: 'workspace/a.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('passes a non-existent path under an allowed parent', () => {
    expect(
      evaluateScope(
        't',
        { path: 'work/new/file.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: true });
  });

  it('fails a non-existent path outside the allowed prefix', () => {
    expect(
      evaluateScope(
        't',
        { path: 'other/new/file.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('fails a symlink that escapes the allowed prefix', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(root, 'work', 'link.txt'));
    expect(
      evaluateScope(
        't',
        { path: 'work/link.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('fails when arguments are not an object', () => {
    expect(evaluateScope('t', 'nope', { path: { enum: ['a'] } }, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: '<args>',
      reason: 'arguments must be an object',
    });
  });

  it('ands multiple constraints on one argument', () => {
    const scope = { message: { minLength: 2, pattern: '^hi' } };
    expect(evaluateScope('t', { message: 'hi' }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { message: 'yo' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'message',
      reason: 'does not match /^hi/',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/core/src/auth/ArgumentScope.test.ts`
Expected: FAIL because `ArgumentScope.ts` does not exist.

- [ ] **Step 3: Implement the evaluator**

Create `packages/core/src/auth/ArgumentScope.ts`:

```ts
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ArgScope, ToolScope } from '@legion-collective/types';

export interface ScopeContext {
  workspaceRoot: string;
}

export type ScopeResult = { ok: true } | { ok: false; arg: string; reason: string };

function fail(arg: string, reason: string): ScopeResult {
  return { ok: false, arg, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves symlinks in the deepest existing ancestor and appends missing segments. */
function realpathWithMissingTail(target: string): string {
  let current = target;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : current;
  return path.join(base, ...tail);
}

function resolvePath(value: string, ctx: ScopeContext): string {
  return realpathWithMissingTail(path.resolve(ctx.workspaceRoot, value));
}

function evaluateArg(arg: string, value: unknown, rule: ArgScope, ctx: ScopeContext): ScopeResult {
  if (rule.enum || rule.pattern !== undefined || rule.minLength !== undefined || rule.maxLength !== undefined) {
    if (typeof value !== 'string') return fail(arg, 'must be a string');
    if (rule.enum && !rule.enum.includes(value)) {
      return fail(arg, `must be one of: ${rule.enum.join(', ')}`);
    }
    if (rule.pattern !== undefined) {
      let expression: RegExp;
      try {
        expression = new RegExp(rule.pattern);
      } catch {
        return fail(arg, 'has an invalid pattern');
      }
      if (!expression.test(value)) return fail(arg, `does not match /${rule.pattern}/`);
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      return fail(arg, `must be at least ${rule.minLength} characters`);
    }
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      return fail(arg, `must be at most ${rule.maxLength} characters`);
    }
  }

  if (rule.min !== undefined || rule.max !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(arg, 'must be a finite number');
    }
    if (rule.min !== undefined && value < rule.min) {
      return fail(arg, `must be at least ${rule.min}`);
    }
    if (rule.max !== undefined && value > rule.max) {
      return fail(arg, `must be at most ${rule.max}`);
    }
  }

  if (rule.pathPrefix !== undefined) {
    if (typeof value !== 'string') return fail(arg, 'must be a string');
    try {
      const prefix = resolvePath(rule.pathPrefix, ctx);
      const target = resolvePath(value, ctx);
      if (target !== prefix && !target.startsWith(prefix + path.sep)) {
        return fail(arg, `must be under ${rule.pathPrefix}`);
      }
    } catch {
      return fail(arg, 'could not be resolved');
    }
  }

  return { ok: true };
}

export function evaluateScope(
  _tool: string,
  args: unknown,
  scope: ToolScope,
  ctx: ScopeContext,
): ScopeResult {
  if (!isPlainObject(args)) return fail('<args>', 'arguments must be an object');

  for (const [arg, rule] of Object.entries(scope)) {
    const value = args[arg];
    const present = value !== undefined && value !== null;
    if (!present) {
      if (rule.required) return fail(arg, 'is required');
      continue;
    }
    const result = evaluateArg(arg, value, rule, ctx);
    if (!result.ok) return result;
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/core/src/auth/ArgumentScope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth/ArgumentScope.ts packages/core/src/auth/ArgumentScope.test.ts
git commit -m "feat(core): evaluate tool argument scopes"
```

---

### Task 3: AuthEngine scope integration

**Files:**
- Modify: `packages/core/src/auth/AuthEngine.ts`
- Modify: `packages/core/src/auth/AuthEngine.test.ts`

**Interfaces:**
- Consumes: `evaluateScope` from `./ArgumentScope.js`; `normalizeToolPolicy` from `@legion-collective/types`.
- Produces: `AuthResult` gains `reason?: 'auto' | 'requires_approval' | 'hidden' | 'scope'` and `detail?: string`. `authorize` gains an optional fifth parameter `ctx?: { workspaceRoot: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/auth/AuthEngine.test.ts`:

```ts
describe('AuthEngine.authorize argument scope', () => {
  const ctx = { workspaceRoot: '/tmp' };

  it('authorizes an object policy whose arguments fit the scope', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_read',
      { path: 'work/a.txt' },
      { file_read: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } } },
      ctx,
    );
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('auto');
  });

  it('returns a scope reason with detail when an argument is out of scope', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_read',
      { path: '../escape.txt' },
      { file_read: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } } },
      ctx,
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('scope');
    expect(result.detail).toBe('argument scope violation: file_read.path must be under work');
  });

  it('checks scope before requires_approval', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_write',
      { path: '../escape.txt' },
      { file_write: { policy: 'requires_approval', scope: { path: { pathPrefix: 'work' } } } },
      ctx,
    );
    expect(result.reason).toBe('scope');
  });

  it('returns requires_approval when the scope passes', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_write',
      { path: 'work/a.txt' },
      { file_write: { policy: 'requires_approval', scope: { path: { pathPrefix: 'work' } } } },
      ctx,
    );
    expect(result.reason).toBe('requires_approval');
  });

  it('fails closed when a scope is configured but context is missing', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'file_read', { path: 'work/a.txt' }, {
      file_read: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } },
    });
    expect(result.reason).toBe('scope');
    expect(result.detail).toBe('argument scope unavailable: workspaceRoot missing');
  });

  it('keeps the legacy string policies working without a scope context', () => {
    const engine = new AuthEngine();
    expect(engine.authorize('p1', 'file_read', {}, { file_read: 'auto' }).reason).toBe('auto');
    expect(
      engine.authorize('p1', 'danger', {}, { danger: 'requires_approval' }).reason,
    ).toBe('requires_approval');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/core/src/auth/AuthEngine.test.ts`
Expected: FAIL because `authorize` ignores scope and has no `ctx` parameter.

- [ ] **Step 3: Implement the integration**

Replace `packages/core/src/auth/AuthEngine.ts` with:

```ts
import { normalizeToolPolicy } from '@legion-collective/types';
import type { ApprovalAuthority, ToolPolicy } from '@legion-collective/types';
import { evaluateScope } from './ArgumentScope.js';

export interface AuthResult {
  authorized: boolean;
  reason?: 'auto' | 'requires_approval' | 'hidden' | 'scope';
  /** Human-readable detail for reason 'scope'. */
  detail?: string;
}

export class AuthEngine {
  authorize(
    _participantId: string,
    tool: string,
    args: unknown,
    participantPolicies?: Record<string, ToolPolicy>,
    ctx?: { workspaceRoot: string },
  ): AuthResult {
    const policy = normalizeToolPolicy(participantPolicies?.[tool]);
    if (!policy) return { authorized: false, reason: 'hidden' };

    if (policy.scope) {
      if (!ctx) {
        return {
          authorized: false,
          reason: 'scope',
          detail: 'argument scope unavailable: workspaceRoot missing',
        };
      }
      const scopeResult = evaluateScope(tool, args, policy.scope, ctx);
      if (!scopeResult.ok) {
        return {
          authorized: false,
          reason: 'scope',
          detail: `argument scope violation: ${tool}.${scopeResult.arg} ${scopeResult.reason}`,
        };
      }
    }

    if (policy.policy === 'auto') return { authorized: true, reason: 'auto' };
    return { authorized: false, reason: 'requires_approval' };
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/core/src/auth/AuthEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth/AuthEngine.ts packages/core/src/auth/AuthEngine.test.ts
git commit -m "feat(core): enforce argument scope in AuthEngine"
```

---

### Task 4: Policy validation

**Files:**
- Create: `packages/core/src/auth/validateToolPolicy.ts`
- Create: `packages/core/src/auth/validateToolPolicy.test.ts`

**Interfaces:**
- Consumes: `AnyTool`, `ToolRegistryLike` from `../tools/Tool.js`; `ArgScope`, `ToolPolicy`, `ToolScope`, `JSONSchema` from `@legion-collective/types`.
- Produces:
  - `validateToolPolicy(tool: AnyTool | undefined, value: unknown): { ok: true; policy: ToolPolicy } | { ok: false; error: string }`
  - `validateToolsMap(registry: Pick<ToolRegistryLike, 'get'> | undefined, tools: Record<string, unknown>): { ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/auth/validateToolPolicy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AnyTool } from '../tools/Tool.js';
import { validateToolPolicy, validateToolsMap } from './validateToolPolicy.js';

const fileTool: AnyTool = {
  name: 'file_write',
  description: 'write',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  execute: async () => ({ status: 'success' }),
};

describe('validateToolPolicy', () => {
  it('accepts the legacy string forms', () => {
    expect(validateToolPolicy(fileTool, 'auto')).toEqual({ ok: true, policy: 'auto' });
    expect(validateToolPolicy(fileTool, 'requires_approval')).toEqual({
      ok: true,
      policy: 'requires_approval',
    });
  });

  it('accepts an object policy with a valid scope', () => {
    expect(
      validateToolPolicy(fileTool, {
        policy: 'auto',
        scope: { path: { pathPrefix: 'work' }, content: { maxLength: 100 } },
      }),
    ).toEqual({
      ok: true,
      policy: {
        policy: 'auto',
        scope: { path: { pathPrefix: 'work' }, content: { maxLength: 100 } },
      },
    });
  });

  it('accepts an empty scope', () => {
    expect(validateToolPolicy(fileTool, { policy: 'auto', scope: {} })).toEqual({
      ok: true,
      policy: { policy: 'auto', scope: {} },
    });
  });

  it('rejects a non-object policy', () => {
    const result = validateToolPolicy(fileTool, 42);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/policy must be/);
  });

  it('rejects an invalid policy literal', () => {
    const result = validateToolPolicy(fileTool, { policy: 'always' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/policy.policy/);
  });

  it('rejects a non-object scope', () => {
    const result = validateToolPolicy(fileTool, { policy: 'auto', scope: 'work' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/scope must be an object/);
  });

  it('rejects an unknown argument name when the tool declares properties', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { destination: { pathPrefix: 'work' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unknown argument "destination" for tool file_write');
  });

  it('allows any argument name when the tool is unknown', () => {
    expect(
      validateToolPolicy(undefined, { policy: 'auto', scope: { anything: { enum: ['x'] } } }),
    ).toEqual({ ok: true, policy: { policy: 'auto', scope: { anything: { enum: ['x'] } } } });
  });

  it('rejects an unknown constraint field', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { path: { prefix: 'work' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown constraint "prefix"/);
  });

  it('rejects an empty enum', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { path: { enum: [] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/enum must be a non-empty array/);
  });

  it('rejects an invalid regex', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { path: { pattern: '[' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a valid regular expression/);
  });

  it('rejects inconsistent numeric bounds', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { content: { minLength: 10, maxLength: 2 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/minLength.*maxLength/);
  });

  it('rejects a non-finite numeric bound', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { content: { maxLength: Number.POSITIVE_INFINITY } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-negative integer/);
  });

  it('rejects an empty pathPrefix', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { path: { pathPrefix: '' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pathPrefix/);
  });
});

describe('validateToolsMap', () => {
  it('validates every entry', () => {
    const registry = { get: (name: string) => (name === 'file_write' ? fileTool : undefined) };
    expect(
      validateToolsMap(registry, {
        file_write: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } },
      }),
    ).toEqual({ ok: true });
  });

  it('returns the first invalid entry', () => {
    const registry = { get: (name: string) => (name === 'file_write' ? fileTool : undefined) };
    const result = validateToolsMap(registry, {
      file_write: { policy: 'auto', scope: { nope: { enum: ['x'] } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown argument "nope"/);
  });

  it('skips tool lookup when no registry is available', () => {
    expect(validateToolsMap(undefined, { anything: 'auto' })).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/core/src/auth/validateToolPolicy.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the validator**

Create `packages/core/src/auth/validateToolPolicy.ts`:

```ts
import type { ArgScope, ToolPolicy, ToolScope } from '@legion-collective/types';
import type { AnyTool, ToolRegistryLike } from '../tools/Tool.js';

const CONSTRAINT_KEYS = [
  'required',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'min',
  'max',
  'pathPrefix',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArgScope(arg: string, value: unknown): string | null {
  if (!isPlainObject(value)) return `scope.${arg} must be an object`;

  for (const key of Object.keys(value)) {
    if (!(CONSTRAINT_KEYS as readonly string[]).includes(key)) {
      return `unknown constraint "${key}" for ${arg}`;
    }
  }

  const required = value['required'];
  if (required !== undefined && typeof required !== 'boolean') {
    return `scope.${arg}.required must be a boolean`;
  }

  const enumValues = value['enum'];
  if (enumValues !== undefined) {
    if (
      !Array.isArray(enumValues) ||
      enumValues.length === 0 ||
      enumValues.some((entry) => typeof entry !== 'string' || entry === '')
    ) {
      return `scope.${arg}.enum must be a non-empty array of strings`;
    }
  }

  const pattern = value['pattern'];
  if (pattern !== undefined) {
    if (typeof pattern !== 'string' || pattern === '') {
      return `scope.${arg}.pattern must be a non-empty string`;
    }
    try {
      new RegExp(pattern);
    } catch {
      return `scope.${arg}.pattern is not a valid regular expression`;
    }
  }

  for (const key of ['minLength', 'maxLength'] as const) {
    const bound = value[key];
    if (
      bound !== undefined &&
      (typeof bound !== 'number' || !Number.isFinite(bound) || !Number.isInteger(bound) || bound < 0)
    ) {
      return `scope.${arg}.${key} must be a non-negative integer`;
    }
  }

  if (
    typeof value['minLength'] === 'number' &&
    typeof value['maxLength'] === 'number' &&
    value['minLength'] > value['maxLength']
  ) {
    return `scope.${arg}.minLength must not exceed maxLength`;
  }

  for (const key of ['min', 'max'] as const) {
    const bound = value[key];
    if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) {
      return `scope.${arg}.${key} must be a finite number`;
    }
  }

  if (
    typeof value['min'] === 'number' &&
    typeof value['max'] === 'number' &&
    value['min'] > value['max']
  ) {
    return `scope.${arg}.min must not exceed max`;
  }

  const pathPrefix = value['pathPrefix'];
  if (pathPrefix !== undefined && (typeof pathPrefix !== 'string' || pathPrefix === '')) {
    return `scope.${arg}.pathPrefix must be a non-empty string`;
  }

  return null;
}

export function validateToolPolicy(
  tool: AnyTool | undefined,
  value: unknown,
): { ok: true; policy: ToolPolicy } | { ok: false; error: string } {
  if (value === 'auto' || value === 'requires_approval') {
    return { ok: true, policy: value };
  }

  if (!isPlainObject(value)) {
    return { ok: false, error: 'policy must be "auto", "requires_approval", or an object' };
  }

  const policy = value['policy'];
  if (policy !== 'auto' && policy !== 'requires_approval') {
    return { ok: false, error: 'policy.policy must be "auto" or "requires_approval"' };
  }

  const scope = value['scope'];
  if (scope !== undefined) {
    if (!isPlainObject(scope)) {
      return { ok: false, error: 'policy.scope must be an object' };
    }

    const properties = tool?.parameters?.properties;
    const declared =
      properties && typeof properties === 'object'
        ? new Set(Object.keys(properties as Record<string, unknown>))
        : undefined;

    for (const [arg, rule] of Object.entries(scope)) {
      if (arg === '') {
        return { ok: false, error: 'scope argument names must be non-empty' };
      }
      if (declared && !declared.has(arg)) {
        return {
          ok: false,
          error: `unknown argument "${arg}" for tool ${tool?.name ?? '<unknown>'}`,
        };
      }
      const error = validateArgScope(arg, rule);
      if (error) return { ok: false, error };
    }
  }

  return { ok: true, policy: value as ToolPolicy };
}

export function validateToolsMap(
  registry: Pick<ToolRegistryLike, 'get'> | undefined,
  tools: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  for (const [name, value] of Object.entries(tools)) {
    const result = validateToolPolicy(registry?.get(name), value);
    if (!result.ok) return result;
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/core/src/auth/validateToolPolicy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth/validateToolPolicy.ts packages/core/src/auth/validateToolPolicy.test.ts
git commit -m "feat(core): validate tool policy scopes"
```

---

### Task 5: AgentRuntime scope enforcement and resume re-check

**Files:**
- Modify: `packages/core/src/runtime/AgentRuntime.ts:413-455` and `processResumedApprovals` around line 560
- Modify: `packages/core/src/runtime/AgentRuntime.test.ts`

**Interfaces:**
- Consumes: `AuthEngine.authorize(..., ctx)` from Task 3.
- Produces: a `'scope'` authorization reason produces an error tool result and blocks execution, both in the normal loop and on approval resume.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/runtime/AgentRuntime.test.ts`:

```ts
describe('AgentRuntime: auth – argument scope', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-ar-scope-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does not execute a tool whose arguments violate its scope', async () => {
    const { context, inbound, router } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
        stopReason: 'tool_calls',
      },
      { content: 'Done', toolCalls: [], stopReason: 'stop' },
    ]);
    const execute = vi.spyOn(context.toolRegistry, 'execute');
    context.participant.tools = {
      echo: { policy: 'auto', scope: { text: { enum: ['ok'] } } },
    };

    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(inbound, context);

    expect(result.kind).toBe('response');
    expect(execute).not.toHaveBeenCalled();
    const toolTurn = context.conversation.activeChain.find((m) => m.toolResults?.length);
    expect(toolTurn?.toolResults?.[0].result.status).toBe('error');
    expect(toolTurn?.toolResults?.[0].result.error).toMatch(/argument scope violation: echo\.text/);
  });

  it('re-checks scope on approval resume and fails closed after a policy change', async () => {
    const { runtime, incoming, context, thread, pendingApprovalRegistry } =
      await setupApprovalScenario(dir);
    context.participant.tools = {
      echo: { policy: 'requires_approval', scope: { text: { enum: ['hello'] } } },
    };

    const result = await runtime.handle(incoming, context);
    expect(result.kind).toBe('pending_approval');
    const approvalId = (
      result as { approvalRequests: { approvalId: string }[] }
    ).approvalRequests[0].approvalId;

    await pendingApprovalRegistry.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: new Date().toISOString(),
    });

    context.participant.tools = {
      echo: { policy: 'requires_approval', scope: { text: { enum: ['other'] } } },
    };

    const resumeResult = await runtime.handle(incoming, context);
    expect(resumeResult.kind).toBe('response');
    const scopeError = thread.activeChain
      .flatMap((m) => m.toolResults ?? [])
      .find((tr) => tr.result.error?.includes('argument scope violation'));
    expect(scopeError).toBeDefined();
    expect(
      thread.activeChain
        .flatMap((m) => m.toolResults ?? [])
        .some((tr) => tr.result.status === 'success'),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/core/src/runtime/AgentRuntime.test.ts -t "argument scope"`
Expected: FAIL because the tool executes despite the scope.

- [ ] **Step 3: Handle the scope reason in the tool loop**

In `packages/core/src/runtime/AgentRuntime.ts`, change the `authorize` call to pass the context:

```ts
const authResult = context.authEngine.authorize(
  this.participantId,
  tc.name,
  tc.arguments,
  agent.tools,
  { workspaceRoot: context.workspaceRoot },
);
```

Then add a branch before the `requires_approval` branch:

```ts
if (authResult.reason === 'scope') {
  toolResults.push({
    id: tc.id,
    name: tc.name,
    result: {
      status: 'error',
      error: authResult.detail ?? `argument scope violation: ${tc.name}`,
    },
  });
  continue;
}
```

- [ ] **Step 4: Re-check scope on approval resume**

In `processResumedApprovals`, immediately before the `// Approved: execute the tool now.` block, insert:

```ts
const authResult = context.authEngine.authorize(
  this.participantId,
  tr.name,
  toolCall.arguments,
  context.participant.tools,
  { workspaceRoot: context.workspaceRoot },
);
if (authResult.reason === 'scope') {
  updatedResults[i] = {
    ...tr,
    result: {
      status: 'error',
      error: authResult.detail ?? `argument scope violation: ${tr.name}`,
    },
  };
  continue;
}
if (authResult.reason === 'hidden') {
  updatedResults[i] = {
    ...tr,
    result: { status: 'error', error: `Tool '${tr.name}' not available` },
  };
  continue;
}
```

Note: `authResult.reason === 'requires_approval'` must still execute because the approval has already been granted.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- packages/core/src/runtime/AgentRuntime.test.ts`
Expected: PASS, including the existing auth tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/AgentRuntime.ts packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "feat(core): enforce scopes in agent tool calls and approval resumes"
```

---

### Task 6: ServiceContext scope enforcement

**Files:**
- Modify: `packages/core/src/service/ServiceContextImpl.ts:99-108`
- Modify: `packages/core/src/service/ServiceContextImpl.test.ts`

**Interfaces:**
- Consumes: `AuthEngine.authorize(..., ctx)` from Task 3.
- Produces: `callTool` returns a structured scope error and never executes the tool.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('callTool')` block in `packages/core/src/service/ServiceContextImpl.test.ts`:

```ts
it('fails closed when arguments violate the tool scope', async () => {
  const { dir: d, deps } = await setup();
  dir = d;
  const ctx = new ServiceContextImpl({
    ...deps,
    participant: {
      ...BASE_CONFIG,
      tools: { file_read: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } } },
    },
  });
  const result = await ctx.callTool('file_read', { path: '../escape.txt' });
  expect(result.status).toBe('error');
  expect((result as { error: string }).error).toMatch(
    /argument scope violation: file_read\.path/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- packages/core/src/service/ServiceContextImpl.test.ts -t "scope"`
Expected: FAIL because the mock registry executes the tool.

- [ ] **Step 3: Implement the context and reason mapping**

In `packages/core/src/service/ServiceContextImpl.ts`, change the `authorize` call:

```ts
const authResult = authEngine.authorize(
  participant.id,
  toolName,
  args,
  participant.tools,
  { workspaceRoot: this.deps.workspaceRoot },
);
```

Replace the reason mapping with:

```ts
if (!authResult.authorized) {
  const reason =
    authResult.reason === 'scope'
      ? (authResult.detail ?? `argument scope violation: ${toolName}`)
      : authResult.reason === 'requires_approval'
        ? 'requires_approval — no authority chain in service context'
        : authResult.reason === 'hidden'
          ? 'tool not available to this participant'
          : (authResult.reason ?? 'not authorized');
  return { status: 'error', error: reason };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/core/src/service/ServiceContextImpl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/service/ServiceContextImpl.ts packages/core/src/service/ServiceContextImpl.test.ts
git commit -m "feat(core): enforce scopes in service tool calls"
```

---

### Task 7: Middleware scope enforcement

**Files:**
- Modify: `packages/core/src/middleware/MiddlewareRunner.ts:130-145`, `:1621-1640`
- Modify: `packages/core/src/middleware/MiddlewareRunner.test.ts:105-115`
- Modify: `packages/runtime/src/LegionProcess.ts:190-212`

**Interfaces:**
- Consumes: `AuthEngine.authorize(..., ctx)` from Task 3.
- Produces: `MiddlewareRunnerDependencies` gains `workspaceRoot: string`; a scope violation records a rejected action and never executes the tool.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/middleware/MiddlewareRunner.test.ts` near the other auth tests:

```ts
it('rejects a middleware tool whose arguments violate its scope', async () => {
  const f = await fixture([instance('request')]);
  f.participant.tools = {
    risky: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } },
  };
  const execute = vi.fn(async () => ({ status: 'success' as const }));
  f.toolRegistry.register({ name: 'risky', description: 'risky', parameters: schema, execute });
  f.registry.register(
    middlewareDefinition({
      beforeSend: () => ({
        kind: 'tool',
        requestId: 'scope-risky',
        tool: 'risky',
        arguments: { path: '../escape.txt' },
      }),
    }),
    'test:runner',
  );

  const result = await f.runner.runMessagePhase({
    operationId: 'scope-rejected',
    phase: 'beforeSend',
    participant: f.participant,
    thread: f.thread,
    draft: draft(),
    actions: [],
    final: true,
  });

  expect(result.kind).toBe('abort');
  expect(execute).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- packages/core/src/middleware/MiddlewareRunner.test.ts -t "scope"`
Expected: FAIL because the tool executes.

- [ ] **Step 3: Add workspaceRoot to the runner dependencies**

In `packages/core/src/middleware/MiddlewareRunner.ts`, add to `MiddlewareRunnerDependencies`:

```ts
  /** Workspace root used to resolve path-based argument scopes. */
  workspaceRoot: string;
```

In the authorization block, pass the context and handle scope before the generic unauthorized branch:

```ts
const authorization = this.dependencies.authEngine.authorize(
  input.participant.id,
  request.tool,
  request.arguments,
  input.participant.tools,
  { workspaceRoot: this.dependencies.workspaceRoot },
);
if (authorization.reason === 'scope') {
  const message = authorization.detail ?? `argument scope violation: ${request.tool}`;
  return this.toolFailure(
    instance,
    phase,
    input,
    snapshots,
    request,
    'rejected',
    new Error(message),
    { status: 'rejected', message },
  );
}
if (!authorization.authorized && authorization.reason !== 'requires_approval') {
  return this.toolFailure(
    instance,
    phase,
    input,
    snapshots,
    request,
    'rejected',
    new Error('Middleware tool is not authorized'),
    { status: 'rejected', message: 'Middleware tool is not authorized' },
  );
}
```

- [ ] **Step 4: Supply workspaceRoot where the runner is constructed**

In `packages/runtime/src/LegionProcess.ts`, add to the `new MiddlewareRunner({ ... })` call:

```ts
      workspaceRoot,
```

- [ ] **Step 5: Update the test fixture**

In `packages/core/src/middleware/MiddlewareRunner.test.ts`, add to `runnerDependencies`:

```ts
    workspaceRoot: '/workspace',
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- packages/core/src/middleware/MiddlewareRunner.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/middleware/MiddlewareRunner.ts packages/core/src/middleware/MiddlewareRunner.test.ts packages/runtime/src/LegionProcess.ts
git commit -m "feat(core): enforce scopes for middleware tool requests"
```

---

### Task 8: LegionProcess callTool and streamTool

**Files:**
- Modify: `packages/runtime/src/LegionProcess.ts:858` and `:946`
- Modify: `packages/runtime/src/LegionProcess.integration.test.ts`

**Interfaces:**
- Consumes: `AuthEngine.authorize(..., ctx)` from Task 3.
- Produces: `callTool` and `streamTool` return the structured scope error.

- [ ] **Step 1: Write the failing test**

Add inside the first `describe('LegionProcess config and runtime tools')` block in `packages/runtime/src/LegionProcess.integration.test.ts`:

```ts
it('enforces argument scope for connector tool calls and streams', async () => {
  process_ = await LegionProcess.start(workspaceRoot);
  const operator = process_.collective.getOrThrow('operator');
  await process_.collective.update('operator', {
    tools: {
      ...operator.tools,
      file_read: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } },
    },
  });

  const call = await process_.runtimeDeps.callTool('operator', 'file_read', {
    path: '../escape.txt',
  });
  expect(call.result.status).toBe('error');
  expect(call.result.error).toMatch(/argument scope violation: file_read\.path/);

  const stream = await process_.runtimeDeps.streamTool('operator', 'file_read', {
    path: '../escape.txt',
  });
  const chunks: Array<{ type: string; error?: string }> = [];
  for await (const chunk of stream.gen) chunks.push(chunk);
  expect(chunks[0]).toMatchObject({ type: 'stream:error' });
  expect(chunks[0].error).toMatch(/argument scope violation: file_read\.path/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- packages/runtime/src/LegionProcess.integration.test.ts -t "argument scope"`
Expected: FAIL because the tool executes or the scope is ignored.

- [ ] **Step 3: Implement callTool**

In `LegionProcess.ts`, update the `callTool` authorization:

```ts
const authResult = authEngine.authorize(participantId, toolName, args, participant.tools, {
  workspaceRoot,
});
if (!authResult.authorized) {
  return {
    result: {
      status: 'error',
      error:
        authResult.reason === 'scope'
          ? (authResult.detail ?? `argument scope violation: ${toolName}`)
          : (authResult.reason ?? 'Not authorized'),
    },
    conversationId: '',
  };
}
```

- [ ] **Step 4: Implement streamTool**

Update the `streamTool` authorization:

```ts
const authResult = authEngine.authorize(participantId, toolName, args, participant.tools, {
  workspaceRoot,
});
if (!authResult.authorized) {
  const error =
    authResult.reason === 'scope'
      ? (authResult.detail ?? `argument scope violation: ${toolName}`)
      : (authResult.reason ?? 'Not authorized');
  const gen = (async function* () {
    yield { type: 'stream:error', error } as const;
  })();
  return { gen, conversationId: '' };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- packages/runtime/src/LegionProcess.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts packages/runtime/src/LegionProcess.integration.test.ts
git commit -m "feat(runtime): enforce scopes for connector tool calls"
```

---

### Task 9: Management tools and policy API

**Files:**
- Modify: `packages/core/src/tools/management-tools.ts:181-245`, `:315-350`, `:819-885`, `:883-905`
- Modify: `packages/core/src/tools/user-tools.ts:37-170`
- Modify: `packages/core/src/tools/management-tools.test.ts`
- Modify: `packages/core/src/tools/user-tools.test.ts`

**Interfaces:**
- Consumes: `validateToolPolicy`, `validateToolsMap` from Task 4; `normalizeToolPolicy` from `@legion-collective/types`.
- Produces:
  - `set_tool_policy` accepts optional `scope`, validates it, and replaces/clears it.
  - `create_agent`, `modify_agent`, `create_user`, `modify_user` validate their tools maps.
  - `list_tools` returns normalized `callerPolicy` objects and a `parameters` map.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/tools/management-tools.test.ts`:

```ts
it('set_tool_policy stores a validated scope', async () => {
  const { context, collective } = await makeContext();
  await createAgentTool.execute(
    { id: 'agent-x', name: 'X', systemPrompt: 's', model: { model: 'm' }, tools: {} },
    context,
  );
  const result = await setToolPolicyTool.execute(
    {
      participantId: 'agent-x',
      tool: 'file_write',
      policy: 'auto',
      scope: { path: { pathPrefix: 'work' } },
    },
    context,
  );
  expect(result.status).toBe('success');
  expect(collective.get('agent-x')?.tools['file_write']).toEqual({
    policy: 'auto',
    scope: { path: { pathPrefix: 'work' } },
  });
});

it('set_tool_policy rejects an unknown argument for a known tool', async () => {
  const { context } = await makeContext();
  context.toolRegistry.register({
    name: 'file_write',
    description: 'write',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    },
    execute: async () => ({ status: 'success' }),
  });
  await createAgentTool.execute(
    { id: 'agent-x', name: 'X', systemPrompt: 's', model: { model: 'm' }, tools: {} },
    context,
  );
  const result = await setToolPolicyTool.execute(
    {
      participantId: 'agent-x',
      tool: 'file_write',
      policy: 'auto',
      scope: { destination: { pathPrefix: 'work' } },
    },
    context,
  );
  expect(result.status).toBe('error');
  expect((result as { error: string }).error).toMatch(/unknown argument "destination"/);
});

it('set_tool_policy clears a scope with an empty object', async () => {
  const { context, collective } = await makeContext();
  await createAgentTool.execute(
    { id: 'agent-x', name: 'X', systemPrompt: 's', model: { model: 'm' }, tools: {} },
    context,
  );
  await setToolPolicyTool.execute(
    {
      participantId: 'agent-x',
      tool: 'file_write',
      policy: 'auto',
      scope: { path: { pathPrefix: 'work' } },
    },
    context,
  );
  await setToolPolicyTool.execute(
    { participantId: 'agent-x', tool: 'file_write', policy: 'auto', scope: {} },
    context,
  );
  expect(collective.get('agent-x')?.tools['file_write']).toBe('auto');
});

it('create_agent accepts the object policy form', async () => {
  const { context, collective } = await makeContext();
  context.toolRegistry.register({
    name: 'notify',
    description: 'notify',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
    },
    execute: async () => ({ status: 'success' }),
  });
  const result = await createAgentTool.execute(
    {
      id: 'agent-x',
      name: 'X',
      systemPrompt: 's',
      model: { model: 'm' },
      tools: { notify: { policy: 'auto', scope: { message: { maxLength: 100 } } } },
    },
    context,
  );
  expect(result.status).toBe('success');
  expect(collective.get('agent-x')?.tools['notify']).toEqual({
    policy: 'auto',
    scope: { message: { maxLength: 100 } },
  });
});
```

Update the existing `describe('list_tools')` assertions to the normalized shape:

```ts
    expect(result.data.callerPolicy['list_tools']).toEqual({ policy: 'auto' });
    expect(result.data.callerPolicy['create_agent']).toEqual({ policy: 'auto' });
    expect(Object.values(result.data.callerPolicy).every((p) => p.policy === 'auto')).toBe(true);
```

For the second test:

```ts
    expect(result.data.callerPolicy).toEqual({
      communicate: { policy: 'auto' },
      edit_message: { policy: 'requires_approval' },
    });
```

Add one assertion for parameters:

```ts
    expect(result.data.parameters['list_tools']).toEqual(
      expect.objectContaining({ type: 'object' }),
    );
```

Add to `packages/core/src/tools/user-tools.test.ts`:

```ts
it('create_user accepts an object policy form', async () => {
  const { context, collective } = await makeContext();
  const result = await createUserTool.execute(
    {
      id: 'dave',
      name: 'Dave',
      tools: { communicate: { policy: 'auto', scope: { message: { maxLength: 50 } } } },
    },
    context,
  );
  expect(result.status).toBe('success');
  expect((collective.get('dave') as UserConfig).tools['communicate']).toEqual({
    policy: 'auto',
    scope: { message: { maxLength: 50 } },
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/core/src/tools/management-tools.test.ts packages/core/src/tools/user-tools.test.ts`
Expected: FAIL because scopes are stored unvalidated and `list_tools` still returns strings.

- [ ] **Step 3: Add imports**

In `packages/core/src/tools/management-tools.ts`, extend the types import with `ToolScope`, and import:

```ts
import { normalizeToolPolicy } from '@legion-collective/types';
import { validateToolPolicy, validateToolsMap } from '../auth/validateToolPolicy.js';
```

In `packages/core/src/tools/user-tools.ts`, add:

```ts
import { validateToolsMap } from '../auth/validateToolPolicy.js';
```

- [ ] **Step 4: Update `set_tool_policy`**

Replace the schema and execute body with:

```ts
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      tool: { type: 'string' },
      policy: { type: 'string', enum: ['auto', 'requires_approval'] },
      scope: {
        type: 'object',
        description:
          'Argument scope keyed by argument name. Pass {} to clear; omit to keep the existing scope.',
      },
    },
    required: ['participantId', 'tool', 'policy'],
  },
```

```ts
    const { participantId, tool, policy, scope } = args as {
      participantId: string;
      tool: string;
      policy: 'auto' | 'requires_approval';
      scope?: ToolScope;
    };
    if (context.participant.operator !== true) {
      return { status: 'error', error: 'Only an operator can change tool policies' };
    }
    try {
      const collective = requireCollective(context);
      const participant = collective.getOrThrow(participantId);
      const existing = normalizeToolPolicy(participant.tools[tool]);

      let next: ToolPolicy;
      if (scope === undefined) {
        const validated = validateToolPolicy(context.toolRegistry?.get(tool), policy);
        if (!validated.ok) return { status: 'error', error: validated.error };
        next = existing?.scope ? { policy, scope: existing.scope } : policy;
      } else if (Object.keys(scope).length === 0) {
        next = policy;
      } else {
        const validated = validateToolPolicy(context.toolRegistry?.get(tool), { policy, scope });
        if (!validated.ok) return { status: 'error', error: validated.error };
        next = validated.policy;
      }

      const tools = { ...participant.tools, [tool]: next };
      await collective.update(participantId, { tools });
      return { status: 'success', data: { participantId, tool, policy: next } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
```

- [ ] **Step 5: Validate create/modify agent tools maps**

In `createAgentTool`, after the operator guard:

```ts
      if (tools !== undefined) {
        const validated = validateToolsMap(context.toolRegistry, tools);
        if (!validated.ok) throw new Error(validated.error);
      }
```

Do the same in `modifyAgentTool` after its operator guard.

- [ ] **Step 6: Validate create/modify user tools maps**

In `createUserTool` and `modifyUserTool`, after the operator guard:

```ts
    if (tools !== undefined) {
      const validated = validateToolsMap(context.toolRegistry, tools);
      if (!validated.ok) return { status: 'error', error: validated.error };
    }
```

- [ ] **Step 7: Update `list_tools`**

Replace the execute body with:

```ts
  async execute(_rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
    const toolRegistry = context.toolRegistry;
    if (!toolRegistry) return { status: 'error', error: 'toolRegistry unavailable' };

    const callerPolicy: Record<
      string,
      { policy: 'auto' | 'requires_approval'; scope?: ToolScope }
    > = {};
    for (const [tool, policy] of Object.entries(context.participant.tools ?? {})) {
      const normalized = normalizeToolPolicy(policy);
      if (normalized) callerPolicy[tool] = normalized;
    }

    const parameters: Record<string, JSONSchema> = {};
    for (const name of toolRegistry.listAll()) {
      const tool = toolRegistry.get(name);
      if (tool) parameters[name] = tool.parameters;
    }

    return { status: 'success', data: { tools: toolRegistry.listAll(), callerPolicy, parameters } };
  },
```

Ensure `JSONSchema` and `ToolScope` are imported in the type import list.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- packages/core/src/tools/management-tools.test.ts packages/core/src/tools/user-tools.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/user-tools.ts packages/core/src/tools/management-tools.test.ts packages/core/src/tools/user-tools.test.ts
git commit -m "feat(core): expose and validate argument scopes in management tools"
```

---

### Task 10: Web scope editor and access normalization

**Files:**
- Modify: `packages/web/src/composables/useToolAccess.ts`
- Modify: `packages/web/src/composables/useToolAccess.test.ts`
- Modify: `packages/web/src/components/participants/ToolPolicyEditor.vue`
- Modify: `packages/web/src/components/participants/ToolPolicyEditor.test.ts`
- Modify: `packages/web/src/views/AgentEditor.vue`
- Modify: `packages/web/src/views/AgentEditor.test.ts`
- Modify: `packages/web/src/views/UserEditor.vue`
- Modify: `packages/web/src/views/UserEditor.test.ts`

**Interfaces:**
- Consumes: normalized `list_tools` from Task 9; `ToolPolicy`, `ToolScope`, `ArgScope`, `JSONSchema` from `@legion-collective/types`.
- Produces: `ToolOverride` gains `scope?: ToolScope`; editors save the object form when a scope exists; `useToolAccess` accepts both forms.

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/composables/useToolAccess.test.ts`:

```ts
  it('normalizes object caller policies', async () => {
    executeMock.mockResolvedValue({
      tools: ['file_write'],
      callerPolicy: {
        file_write: { policy: 'requires_approval', scope: { path: { pathPrefix: 'work' } } },
      },
    });
    await useToolAccess().refresh();
    expect(useToolAccess().can('file_write')).toBe('requires_approval');
  });
```

Add to `packages/web/src/components/participants/ToolPolicyEditor.test.ts`:

```ts
  it('adds an argument rule when the scope editor is opened', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          { tool: 'file_write', source: 'built-in', enabled: true, requireApproval: false },
        ],
        availableTools: ['file_write'],
        parameters: {
          file_write: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
          },
        },
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    await w.find('[data-add-arg]').trigger('click');
    const payload = w.emitted('update:overrides')![0][0] as Array<{
      tool: string;
      scope?: Record<string, unknown>;
    }>;
    expect(payload[0].scope).toEqual({ path: {} });
  });

  it('renders an existing scope rule', () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'file_write',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { path: { pathPrefix: 'work' } },
          },
        ],
        availableTools: ['file_write'],
        parameters: { file_write: { type: 'object', properties: { path: { type: 'string' } } } },
      },
    });
    expect(w.find('[data-scope-editor]').exists()).toBe(false);
    expect(w.find('[data-scope-count]').text()).toContain('1');
  });
```

Add to `packages/web/src/views/AgentEditor.test.ts`:

```ts
  it('saves the object policy form when a scope is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return toolResponse('get_participant', {
            ...AGENT,
            tools: {
              file_write: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } },
            },
          });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: ['file_write'], callerPolicy: {} });
        if (body.tool === 'list_models') return toolResponse('list_models', []);
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions: [] });
        if (body.tool === 'modify_agent') return toolResponse('modify_agent', { id: 'agent-a' });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-name"]').element as HTMLInputElement).value).toBe(
        'Agent A',
      ),
    );
    await wrapper.find('[data-test="agent-save"]').trigger('click');
    await flushPromises();
    const saveCall = (vi.mocked(fetch).mock.calls as Array<[string, RequestInit]>).find(
      ([, init]) => JSON.parse(String(init?.body)).tool === 'modify_agent',
    );
    expect(JSON.parse(String(saveCall?.[1].body)).args.tools).toEqual({
      file_write: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } },
    });
  });
```

Add to `packages/web/src/views/UserEditor.test.ts`:

```ts
  it('saves the object policy form when a scope is present', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tool === 'get_participant')
        return toolResponse('get_participant', {
          ...USER,
          tools: {
            communicate: { policy: 'auto', scope: { message: { maxLength: 50 } } },
          },
        });
      if (body.tool === 'list_tools')
        return toolResponse('list_tools', { tools: ['communicate'], callerPolicy: {} });
      if (body.tool === 'modify_user') return toolResponse('modify_user', { id: 'alice' });
      return toolResponse(body.tool, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => JSON.parse(String(c[1]?.body)).tool === 'modify_user',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body)).args.tools).toEqual({
        communicate: { policy: 'auto', scope: { message: { maxLength: 50 } } },
      });
    });
  });
```

The existing test files already define `AGENT`, `USER`, `toolResponse`, `stubFetch`, `waitLoaded`, `mount`, and `flushPromises`; reuse them.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd packages/web && npx vitest run src/composables/useToolAccess.test.ts src/components/participants/ToolPolicyEditor.test.ts src/views/AgentEditor.test.ts
```

Expected: FAIL because object policies are not normalized and the editor has no scope UI.

- [ ] **Step 3: Normalize `useToolAccess`**

Replace the type and refresh body:

```ts
export type ToolAccessPolicy = 'auto' | 'requires_approval';
type CallerPolicyEntry = ToolAccessPolicy | { policy: ToolAccessPolicy; scope?: unknown };
```

```ts
    const data = await execute<{
      tools: string[];
      callerPolicy: Record<string, CallerPolicyEntry>;
    }>('list_tools', {});
    if (requestGeneration !== generation) return;
    const normalized: Record<string, ToolAccessPolicy> = {};
    for (const [tool, entry] of Object.entries(data.callerPolicy ?? {})) {
      normalized[tool] = typeof entry === 'string' ? entry : entry.policy;
    }
    access.value = normalized;
```

- [ ] **Step 4: Add scope state and handlers to `ToolPolicyEditor.vue`**

Replace the `<script setup>` block with:

```vue
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ArgScope, JSONSchema, ToolScope } from '@legion-collective/types';

export interface ToolOverride {
  tool: string;
  source: string;
  enabled: boolean;
  requireApproval: boolean;
  scope?: ToolScope;
}

const props = defineProps<{
  overrides: ToolOverride[];
  availableTools: string[];
  parameters?: Record<string, JSONSchema>;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  'update:overrides': [value: ToolOverride[]];
}>();

const expanded = ref<Record<string, boolean>>({});

const rows = computed(() => {
  const overrideMap = new Map(props.overrides.map((o) => [o.tool, o]));
  return props.availableTools.map((tool) => ({
    tool,
    override: overrideMap.get(tool) ?? null,
  }));
});

function setEnabled(tool: string, enabled: boolean) {
  const existing = props.overrides.find((o) => o.tool === tool);
  if (enabled) {
    if (existing) {
      emit(
        'update:overrides',
        props.overrides.map((o) => (o.tool === tool ? { ...o, enabled: true } : o)),
      );
    } else {
      emit('update:overrides', [
        ...props.overrides,
        { tool, source: 'built-in', enabled: true, requireApproval: false },
      ]);
    }
  } else {
    emit(
      'update:overrides',
      props.overrides.filter((o) => o.tool !== tool),
    );
  }
}

function toggleApproval(tool: string) {
  emit(
    'update:overrides',
    props.overrides.map((o) =>
      o.tool === tool ? { ...o, requireApproval: !o.requireApproval } : o,
    ),
  );
}

function toggleScope(tool: string) {
  expanded.value = { ...expanded.value, [tool]: !expanded.value[tool] };
}

function scopeRows(override: ToolOverride): Array<[string, ArgScope]> {
  return Object.entries(override.scope ?? {});
}

function argumentNames(tool: string, current: string): string[] {
  const properties = props.parameters?.[tool]?.properties;
  const names =
    properties && typeof properties === 'object'
      ? Object.keys(properties as Record<string, unknown>)
      : [];
  return names.includes(current) ? names : [...names, current];
}

function replaceOverride(tool: string, patch: Partial<ToolOverride>) {
  emit(
    'update:overrides',
    props.overrides.map((o) => (o.tool === tool ? { ...o, ...patch } : o)),
  );
}

function updateScope(tool: string, scope: ToolScope) {
  replaceOverride(tool, { scope });
}

function addArgument(tool: string) {
  const override = props.overrides.find((o) => o.tool === tool);
  if (!override) return;
  const existing = override.scope ?? {};
  const used = new Set(Object.keys(existing));
  const declared = argumentNames(tool, '').filter((name) => name !== '');
  const next = declared.find((name) => !used.has(name)) ?? `arg${Object.keys(existing).length + 1}`;
  updateScope(tool, { ...existing, [next]: {} });
}

function removeArgument(tool: string, arg: string) {
  const override = props.overrides.find((o) => o.tool === tool);
  if (!override) return;
  const next = { ...(override.scope ?? {}) };
  delete next[arg];
  updateScope(tool, next);
}

function renameArgument(tool: string, from: string, to: string) {
  const override = props.overrides.find((o) => o.tool === tool);
  if (!override || to === '' || from === to) return;
  const next: ToolScope = {};
  for (const [key, rule] of Object.entries(override.scope ?? {})) {
    next[key === from ? to : key] = rule;
  }
  updateScope(tool, next);
}

function updateRule(tool: string, arg: string, patch: Partial<ArgScope>) {
  const override = props.overrides.find((o) => o.tool === tool);
  if (!override) return;
  const merged = { ...(override.scope?.[arg] ?? {}), ...patch };
  const clean = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as ArgScope;
  updateScope(tool, { ...(override.scope ?? {}), [arg]: clean });
}

function onArgName(tool: string, from: string, event: Event) {
  renameArgument(tool, from, (event.target as HTMLSelectElement).value);
}

function onRequired(tool: string, arg: string, event: Event) {
  updateRule(tool, arg, {
    required: (event.target as HTMLInputElement).checked || undefined,
  });
}

function onEnum(tool: string, arg: string, event: Event) {
  const values = (event.target as HTMLInputElement).value
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  updateRule(tool, arg, { enum: values.length ? values : undefined });
}

function onText(tool: string, arg: string, key: 'pattern' | 'pathPrefix', event: Event) {
  const value = (event.target as HTMLInputElement).value;
  updateRule(tool, arg, { [key]: value === '' ? undefined : value });
}

function onNumber(
  tool: string,
  arg: string,
  key: 'minLength' | 'maxLength' | 'min' | 'max',
  event: Event,
) {
  const raw = (event.target as HTMLInputElement).value;
  updateRule(tool, arg, { [key]: raw === '' ? undefined : Number(raw) });
}
</script>
```

- [ ] **Step 5: Add the scope UI to the template**

Inside each `[data-tool-row]`, after the approval button, add:

```vue
      <button
        v-if="override?.enabled"
        type="button"
        :disabled="readonly"
        data-scope-toggle
        class="text-[9px] px-2 py-0.5 rounded border border-line text-faint"
        @click="toggleScope(tool)"
      >
        scope<span data-scope-count v-if="override?.scope"> {{ Object.keys(override.scope).length }}</span>
      </button>
      <div
        v-if="override?.enabled && expanded[tool]"
        data-scope-editor
        class="w-full mt-1 space-y-1 rounded border border-line bg-surface p-2"
      >
        <div
          v-for="[arg, rule] in scopeRows(override)"
          :key="arg"
          data-scope-row
          class="grid grid-cols-2 gap-1 items-center"
        >
          <select
            :value="arg"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 font-mono text-[10px]"
            @change="onArgName(tool, arg, $event)"
          >
            <option v-for="name in argumentNames(tool, arg)" :key="name" :value="name">
              {{ name }}
            </option>
          </select>
          <label class="flex items-center gap-1 text-[10px] text-faint">
            <input
              type="checkbox"
              :checked="rule.required ?? false"
              :disabled="readonly"
              @change="onRequired(tool, arg, $event)"
            />
            required
          </label>
          <input
            placeholder="enum (comma separated)"
            :value="rule.enum?.join(', ') ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onEnum(tool, arg, $event)"
          />
          <input
            placeholder="pattern"
            :value="rule.pattern ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onText(tool, arg, 'pattern', $event)"
          />
          <input
            type="number"
            placeholder="min"
            :value="rule.min ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onNumber(tool, arg, 'min', $event)"
          />
          <input
            type="number"
            placeholder="max"
            :value="rule.max ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onNumber(tool, arg, 'max', $event)"
          />
          <input
            type="number"
            placeholder="min length"
            :value="rule.minLength ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onNumber(tool, arg, 'minLength', $event)"
          />
          <input
            type="number"
            placeholder="max length"
            :value="rule.maxLength ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onNumber(tool, arg, 'maxLength', $event)"
          />
          <input
            placeholder="path prefix"
            :value="rule.pathPrefix ?? ''"
            :disabled="readonly"
            class="rounded border border-line bg-surface px-1 py-0.5 text-[10px]"
            @change="onText(tool, arg, 'pathPrefix', $event)"
          />
          <button
            type="button"
            :disabled="readonly"
            class="text-[9px] px-2 py-0.5 rounded border border-line text-faint"
            @click="removeArgument(tool, arg)"
          >
            remove
          </button>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            :disabled="readonly"
            data-add-arg
            class="text-[9px] px-2 py-0.5 rounded border border-line text-faint"
            @click="addArgument(tool)"
          >
            add argument
          </button>
          <button
            type="button"
            :disabled="readonly"
            class="text-[9px] px-2 py-0.5 rounded border border-line text-faint"
            @click="updateScope(tool, {})"
          >
            clear scope
          </button>
        </div>
      </div>
```

- [ ] **Step 6: Update AgentEditor save/load**

In `AgentEditor.vue`, import:

```ts
import {
  normalizeToolPolicy,
  type JSONSchema,
  type ToolPolicy,
} from '@legion-collective/types';
```

Add state next to `availableTools`:

```ts
const toolParameters = ref<Record<string, JSONSchema>>({});
```

Replace `overridesToToolsMap`:

```ts
function overridesToToolsMap(list: ToolOverride[]): Record<string, ToolPolicy> {
  return Object.fromEntries(
    list
      .filter((o) => o.enabled)
      .map((o) => {
        const policy = o.requireApproval ? 'requires_approval' : 'auto';
        return [
          o.tool,
          o.scope && Object.keys(o.scope).length > 0 ? { policy, scope: o.scope } : policy,
        ];
      }),
  );
}
```

Replace the load parsing:

```ts
      const toolsMap = (p['tools'] ?? {}) as Record<string, ToolPolicy>;
      overrides.value = Object.entries(toolsMap).flatMap(([tool, value]) => {
        const normalized = normalizeToolPolicy(value);
        if (!normalized) return [];
        return [
          {
            tool,
            source: 'built-in',
            enabled: true,
            requireApproval: normalized.policy === 'requires_approval',
            ...(normalized.scope ? { scope: normalized.scope } : {}),
          },
        ];
      });
```

Update the `list_tools` call type and store parameters:

```ts
  void execute<{
    tools: string[];
    callerPolicy: Record<string, unknown>;
    parameters?: Record<string, JSONSchema>;
  }>('list_tools', {})
    .then(({ tools, parameters }) => {
      availableTools.value = tools;
      toolParameters.value = parameters ?? {};
      overrides.value = [
        ...overrides.value.filter((o) => tools.includes(o.tool) || o.enabled),
        ...tools
          .filter((t) => !overrides.value.some((o) => o.tool === t))
          .map((t) => ({ tool: t, source: 'built-in', enabled: false, requireApproval: false })),
      ];
    })
    .catch(() => {});
```

Pass the prop:

```vue
      <ToolPolicyEditor
        :available-tools="availableTools"
        :parameters="toolParameters"
        :overrides="overrides"
        :readonly="!callerIsOperator"
        @update:overrides="overrides = $event"
      />
```

- [ ] **Step 7: Update UserEditor save/load**

Apply the same import, `toolParameters` state, `overridesToToolsMap`, load parsing, `list_tools` call, and `:parameters="toolParameters"` changes to `UserEditor.vue`. Its `list_tools` call currently destructures `{ tools }`; replace it with the block above.

- [ ] **Step 8: Run the web tests**

Run:

```bash
cd packages/web && npx vitest run src/composables/useToolAccess.test.ts src/components/participants/ToolPolicyEditor.test.ts src/views/AgentEditor.test.ts src/views/UserEditor.test.ts
```

Expected: PASS. Fix any harness mismatch in `AgentEditor.test.ts` by reusing its existing mount helper.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/composables/useToolAccess.ts packages/web/src/composables/useToolAccess.test.ts packages/web/src/components/participants/ToolPolicyEditor.vue packages/web/src/components/participants/ToolPolicyEditor.test.ts packages/web/src/views/AgentEditor.vue packages/web/src/views/AgentEditor.test.ts packages/web/src/views/UserEditor.vue packages/web/src/views/UserEditor.test.ts
git commit -m "feat(web): edit and display tool argument scopes"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/superpowers/plans/012-post-mvp-roadmap.md` (item #6)
- Modify: `docs/legion-v2-greenfield-spec.md` §7

**Interfaces:**
- Consumes: the implementation from Tasks 1–10.
- Produces: roadmap and greenfield spec reflect the new scope predicate.

- [ ] **Step 1: Update roadmap item #6**

After the `### #6 — AuthEngine argument scope control` bullets, append:

```md
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
```

- [ ] **Step 2: Update the greenfield spec**

In `docs/legion-v2-greenfield-spec.md` §7, after the `AuthEngine is a pure predicate` code block, add:

```md
A participant's per-tool policy may also carry an argument scope:

```typescript
type ToolPolicy =
  | 'auto'
  | 'requires_approval'
  | { policy: 'auto' | 'requires_approval'; scope?: ToolScope };
```

`authorize(..., ctx)` evaluates the scope before returning `auto` or `requires_approval`.
Scope keys are top-level argument names; supported constraints are `required`, `enum`,
`pattern`, `minLength`/`maxLength`, `min`/`max`, and `pathPrefix` (resolved containment
under the workspace root). A violation returns `reason: 'scope'` and is a hard deny, never
an approval request. `hasAuthority` remains unscoped.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/012-post-mvp-roadmap.md docs/legion-v2-greenfield-spec.md
git commit -m "docs: record argument scope control as landed"
```

---

### Final gate

- [ ] **Step 1: Format check**

Run: `npm run format:check`
Expected: PASS. If it fails, run `npm run format` and commit the formatting changes.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Core and runtime tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Web tests**

Run: `cd packages/web && npm test`
Expected: PASS.

- [ ] **Step 5: Verify the worktree**

Run: `git status -sb`
Expected: clean, on `feat/auth-argument-scope`.
