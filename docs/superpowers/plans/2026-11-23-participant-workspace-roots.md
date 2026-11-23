# Participant Workspace Roots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each participant declare an optional `workspaceRoot` that becomes the base directory for file tools and the default process `cwd`, without relocating `.legion/` storage.

**Architecture:** Add one resolution helper (`resolveParticipantWorkspaceRoot`) that is the single source of truth for the effective root. Stamp the effective root into every `ToolContext`, and add `collectiveWorkspaceRoot` to carry the launch root so nested contexts can resolve recipient roots. File tools keep lexical containment; process tools resolve `cwd` before calling the unchanged `ProcessManager`.

**Tech Stack:** TypeScript (strict, NodeNext ESM), Node >= 20, Vitest, Vue 3 + happy-dom for the web package.

**Spec:** `docs/superpowers/specs/2026-11-23-participant-workspace-roots-design.md`

## Global Constraints

- Node >= 20; pure ESM. Every relative import in `.ts` source uses a `.js` extension.
- `verbatimModuleSyntax`: use `import type` for type-only imports.
- `noUnusedLocals` / `noUnusedParameters`: no unused variables or parameters.
- Prettier: single quotes, semicolons, trailing commas, 100 columns, 2 spaces.
- Never edit `dist/`; rebuild with `npm run build`.
- `.legion/` stays at the launch root. `WorkspaceConfig.workspaceRoot` only supplies the default tool/process base.
- Effective-root order: `participant.workspaceRoot` -> `WorkspaceConfig.workspaceRoot` -> launch root.
- Relative participant/config roots resolve against the launch root; absolute roots are used as-is.
- File tools accept absolute paths only when lexically inside the effective root; `..` escapes fail.
- Process `cwd`: omitted -> effective root; relative -> under effective root; absolute -> as-is.
- Validation on write: root must exist and be a directory; boot never fails when a stored root disappears.
- `modify_*`: omit `workspaceRoot` to keep; `null` or `""` to clear/inherit.

---

### Task 1: Participant field, context field, and root-resolution helper

**Files:**

- Modify: `packages/types/src/participant.ts` (add `workspaceRoot` to `BaseParticipant`)
- Modify: `packages/core/src/tools/Tool.ts` (add `collectiveWorkspaceRoot` to `ToolContext`)
- Create: `packages/core/src/collective/workspace-root.ts`
- Test: `packages/core/src/collective/workspace-root.test.ts`
- Modify: `packages/core/src/index.ts` (export the helper)

**Interfaces:**

- Consumes: `BaseParticipant` and `WorkspaceConfig` from `@legion-collective/types`.
- Produces:
  - `BaseParticipant.workspaceRoot?: string`
  - `ToolContext.collectiveWorkspaceRoot?: string`
  - `resolveParticipantWorkspaceRoot(participant: Pick<BaseParticipant, 'workspaceRoot'> | undefined, config: Pick<WorkspaceConfig, 'workspaceRoot'> | undefined, collectiveWorkspaceRoot: string): string`
  - `workspaceRootError(value: string, collectiveWorkspaceRoot: string): Promise<string | null>`

- [ ] **Step 1: Write the failing helper tests**

Create `packages/core/src/collective/workspace-root.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveParticipantWorkspaceRoot, workspaceRootError } from './workspace-root.js';

describe('resolveParticipantWorkspaceRoot', () => {
  const launch = '/launch';

  it('uses an absolute participant root as-is', () => {
    expect(resolveParticipantWorkspaceRoot({ workspaceRoot: '/srv/a' }, undefined, launch)).toBe(
      '/srv/a',
    );
  });

  it('resolves a relative participant root against the collective root', () => {
    expect(
      resolveParticipantWorkspaceRoot({ workspaceRoot: 'projects/a' }, undefined, launch),
    ).toBe('/launch/projects/a');
  });

  it('falls back to the config default when the participant has no root', () => {
    expect(
      resolveParticipantWorkspaceRoot(undefined, { workspaceRoot: '/srv/default' }, launch),
    ).toBe('/srv/default');
  });

  it('resolves a relative config default against the collective root', () => {
    expect(resolveParticipantWorkspaceRoot(undefined, { workspaceRoot: 'shared' }, launch)).toBe(
      '/launch/shared',
    );
  });

  it('prefers the participant root over the config default', () => {
    expect(
      resolveParticipantWorkspaceRoot(
        { workspaceRoot: 'projects/a' },
        { workspaceRoot: 'shared' },
        launch,
      ),
    ).toBe('/launch/projects/a');
  });

  it('falls back to the collective root', () => {
    expect(resolveParticipantWorkspaceRoot(undefined, undefined, launch)).toBe(launch);
  });
});

describe('workspaceRootError', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'legion-root-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts an existing directory', async () => {
    await mkdir(join(root, 'project'));
    await expect(workspaceRootError(join(root, 'project'), root)).resolves.toBeNull();
  });

  it('accepts a relative directory under the collective root', async () => {
    await mkdir(join(root, 'project'));
    await expect(workspaceRootError('project', root)).resolves.toBeNull();
  });

  it('rejects a missing path', async () => {
    await expect(workspaceRootError('missing', root)).resolves.toBe(
      'workspaceRoot does not exist: missing',
    );
  });

  it('rejects a file', async () => {
    await writeFile(join(root, 'file.txt'), 'x');
    await expect(workspaceRootError('file.txt', root)).resolves.toBe(
      'workspaceRoot is not a directory: file.txt',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/collective/workspace-root.test.ts`
Expected: FAIL because `./workspace-root.js` does not exist.

- [ ] **Step 3: Add the participant and context fields**

In `packages/types/src/participant.ts`, inside `BaseParticipant`, after `replyTimeoutMs`:

```ts
  /**
   * Base directory for file tools and default process execution. Absolute or
   * relative to the collective workspace root. Absent inherits the collective
   * default. This is a default base, not a sandbox.
   */
  workspaceRoot?: string;
```

In `packages/core/src/tools/Tool.ts`, inside `ToolContext`, after `workspaceRoot`:

```ts
  /**
   * The collective (launch) root. `workspaceRoot` is the participant's
   * effective root; this anchor resolves relative participant roots and the
   * `WorkspaceConfig.workspaceRoot` default. Absent in legacy contexts means
   * `workspaceRoot` itself.
   */
  collectiveWorkspaceRoot?: string;
```

- [ ] **Step 4: Create the helper**

Create `packages/core/src/collective/workspace-root.ts`:

```ts
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { BaseParticipant, WorkspaceConfig } from '@legion-collective/types';

/**
 * Resolve the effective workspace root for a participant.
 *
 * Precedence: participant root > WorkspaceConfig.workspaceRoot > collective
 * (launch) root. Absolute values are used as-is; relative values resolve
 * against the collective root.
 */
export function resolveParticipantWorkspaceRoot(
  participant: Pick<BaseParticipant, 'workspaceRoot'> | undefined,
  config: Pick<WorkspaceConfig, 'workspaceRoot'> | undefined,
  collectiveWorkspaceRoot: string,
): string {
  const configured = participant?.workspaceRoot ?? config?.workspaceRoot;
  if (!configured) return collectiveWorkspaceRoot;
  return isAbsolute(configured)
    ? resolve(configured)
    : resolve(collectiveWorkspaceRoot, configured);
}

/**
 * Validate a user-supplied participant root. Returns an error message when the
 * resolved path is missing or is not a directory; `null` means valid.
 */
export async function workspaceRootError(
  value: string,
  collectiveWorkspaceRoot: string,
): Promise<string | null> {
  const resolved = resolve(collectiveWorkspaceRoot, value);
  try {
    const info = await stat(resolved);
    return info.isDirectory() ? null : `workspaceRoot is not a directory: ${value}`;
  } catch {
    return `workspaceRoot does not exist: ${value}`;
  }
}
```

- [ ] **Step 5: Export the helper**

In `packages/core/src/index.ts`, after `export * from './collective/default-participants.js';`:

```ts
export * from './collective/workspace-root.js';
```

- [ ] **Step 6: Run the helper tests and typecheck**

Run: `npx vitest run packages/core/src/collective/workspace-root.test.ts`
Expected: PASS (10 tests).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/participant.ts packages/core/src/tools/Tool.ts \
  packages/core/src/collective/workspace-root.ts \
  packages/core/src/collective/workspace-root.test.ts packages/core/src/index.ts
git commit -m "feat: add participant workspace root resolution helper"
```

---

### Task 2: File tools accept absolute paths inside the effective root

**Files:**

- Modify: `packages/core/src/tools/file-tools.ts`
- Test: `packages/core/src/tools/file-tools.test.ts`

**Interfaces:**

- Consumes: `ToolContext.workspaceRoot` (already the effective root after Task 4/5/7).
- Produces: `resolveInWorkspace(context, path)` accepts absolute paths lexically inside `context.workspaceRoot` and rejects absolute paths outside it.

- [ ] **Step 1: Add failing tests**

At the top of `packages/core/src/tools/file-tools.test.ts`, change the fs import to:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
```

Add these tests inside `describe('file tools', ...)` after the traversal test:

```ts
it('accepts an absolute path inside the workspace root', async () => {
  await mkdir(join(dir, 'inside'), { recursive: true });
  await writeFile(join(dir, 'inside', 'a.txt'), 'hello');
  const r = await fileReadTool.execute({ path: join(dir, 'inside', 'a.txt') }, ctx(dir));
  expect(r).toEqual({ status: 'success', data: 'hello' });
});

it('rejects an absolute path outside the workspace root', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'legion-outside-'));
  try {
    await writeFile(join(outside, 'a.txt'), 'outside');
    const r = await fileReadTool.execute({ path: join(outside, 'a.txt') }, ctx(dir));
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/outside/i);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it('rejects an absolute path that escapes with ..', async () => {
  const r = await fileReadTool.execute({ path: `${dir}/../escape.txt` }, ctx(dir));
  expect(r.status).toBe('error');
  expect(r.error).toMatch(/outside/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/file-tools.test.ts`
Expected: FAIL on the absolute-inside test (current code returns `null` for every absolute path).

- [ ] **Step 3: Implement absolute-inside support**

In `packages/core/src/tools/file-tools.ts`, change the path import to include `resolve`:

```ts
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
```

Replace `resolveInWorkspace` with:

```ts
function resolveInWorkspace(context: ToolContext, path: string): string | null {
  const root = resolve(context.workspaceRoot);
  const resolved = isAbsolute(path) ? normalize(path) : normalize(join(root, path));
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core/src/tools/file-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/file-tools.ts packages/core/src/tools/file-tools.test.ts
git commit -m "feat: allow file tools to read absolute paths inside the participant root"
```

---

### Task 3: Process tools resolve `cwd` against the effective root

**Files:**

- Modify: `packages/core/src/process/process-tools.ts`
- Test: `packages/core/src/process/process-tools.test.ts`

**Interfaces:**

- Consumes: `ToolContext.workspaceRoot`.
- Produces: `resolveCwd(ctx, cwd)` returns `ctx.workspaceRoot` when `cwd` is absent, resolves relative `cwd` under it, and returns absolute `cwd` unchanged. `ProcessManager` is unchanged.

- [ ] **Step 1: Add failing tests**

In `packages/core/src/process/process-tools.test.ts`, add inside `describe('execute_command', ...)`:

```ts
it('defaults cwd to the participant workspace root', async () => {
  const ctx = makeCtx();
  ctx.workspaceRoot = '/work/root';
  await getTool('execute_command').execute({ command: 'pwd' }, ctx);
  const pm = (ctx as any).processManager;
  expect(pm.execute.mock.calls[0][0].cwd).toBe('/work/root');
});

it('resolves a relative cwd against the participant workspace root', async () => {
  const ctx = makeCtx();
  ctx.workspaceRoot = '/work/root';
  await getTool('execute_command').execute({ command: 'pwd', cwd: 'sub' }, ctx);
  const pm = (ctx as any).processManager;
  expect(pm.execute.mock.calls[0][0].cwd).toBe('/work/root/sub');
});

it('uses an absolute cwd as-is', async () => {
  const ctx = makeCtx();
  ctx.workspaceRoot = '/work/root';
  await getTool('execute_command').execute({ command: 'pwd', cwd: '/other' }, ctx);
  const pm = (ctx as any).processManager;
  expect(pm.execute.mock.calls[0][0].cwd).toBe('/other');
});
```

Add inside `describe('start_process', ...)`:

```ts
it('defaults cwd to the participant workspace root', async () => {
  const ctx = makeCtx();
  ctx.workspaceRoot = '/work/root';
  await getTool('start_process').execute({ command: 'sleep', args: ['1'] }, ctx);
  const pm = (ctx as any).processManager;
  expect(pm.start.mock.calls[0][0].cwd).toBe('/work/root');
});

it('resolves a relative cwd against the participant workspace root', async () => {
  const ctx = makeCtx();
  ctx.workspaceRoot = '/work/root';
  await getTool('start_process').execute({ command: 'sleep', cwd: 'sub' }, ctx);
  const pm = (ctx as any).processManager;
  expect(pm.start.mock.calls[0][0].cwd).toBe('/work/root/sub');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/process/process-tools.test.ts`
Expected: FAIL because the tools currently pass `cwd` through unchanged.

- [ ] **Step 3: Implement cwd resolution**

In `packages/core/src/process/process-tools.ts`, add the path import:

```ts
import { isAbsolute, resolve } from 'node:path';
```

Add after the `err` helper:

```ts
function resolveCwd(ctx: ToolContext, cwd: string | undefined): string {
  if (!cwd) return ctx.workspaceRoot;
  return isAbsolute(cwd) ? cwd : resolve(ctx.workspaceRoot, cwd);
}
```

Change the `cwd` schema description:

```ts
    cwd: {
      type: 'string',
      description:
        'Working directory; defaults to the participant workspace root. ' +
        'Relative paths resolve against it.',
    },
```

In `executeCommandTool.execute`, change the `cwd` line to:

```ts
          cwd: resolveCwd(ctx, a.cwd),
```

In `startProcessTool.execute`, change the call to:

```ts
const args = argsRaw as Record<string, unknown> & { cwd?: string };
const handle = await pm(ctx).start({ ...args, cwd: resolveCwd(ctx, args.cwd) }, ctx.participant.id);
```

Rename the raw argument parameter in `startProcessTool.execute` to `argsRaw`:

```ts
  async execute(argsRaw: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = argsRaw as Record<string, unknown> & { cwd?: string };
      const handle = await pm(ctx).start(
        { ...args, cwd: resolveCwd(ctx, args.cwd) },
        ctx.participant.id,
      );
      return ok(handle);
    } catch (e) {
      return err(e);
    }
  },
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core/src/process/process-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/process/process-tools.ts packages/core/src/process/process-tools.test.ts
git commit -m "feat: resolve process cwd against the participant workspace root"
```

---

### Task 4: MessageRouter gives the recipient its own root

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.ts`
- Test: `packages/core/src/runtime/MessageRouter.test.ts`

**Interfaces:**

- Consumes: `resolveParticipantWorkspaceRoot` from `../collective/workspace-root.js`.
- Produces: `buildRuntimeContext` sets `workspaceRoot` to the recipient's effective root and `collectiveWorkspaceRoot` to the launch root, regardless of the sender's context.

- [ ] **Step 1: Add the failing router test**

In `packages/core/src/runtime/MessageRouter.test.ts`, change the Runtime import to include `RuntimeContext`:

```ts
import type { Runtime, RuntimeContext, RuntimeResult } from './Runtime.js';
```

Add inside `describe('MessageRouter: synchronous send', ...)`:

```ts
it('gives the recipient its own workspace root instead of the sender root', async () => {
  const { collective, store, eventBus, baseContext } = await setup(dir);
  await collective.add({
    id: 'mock-root-b',
    name: 'Mock Root B',
    type: 'mock',
    tools: {},
    responses: [],
    status: 'active',
    workspaceRoot: join(dir, 'root-b'),
  });
  const registry = new RuntimeRegistry();
  let seen: RuntimeContext | undefined;
  registry.registerFactory('mock', () => ({
    async handle(_incoming, context) {
      seen = context;
      return { kind: 'response' as const, content: 'ok' };
    },
    async *handleStream() {
      yield { type: 'text_delta', delta: 'ok' } as const;
      return { kind: 'response' as const, content: 'ok' };
    },
  }));
  const router = new MessageRouter(store, registry, collective, eventBus);
  const senderContext = {
    ...baseContext,
    workspaceRoot: join(dir, 'root-a'),
    collectiveWorkspaceRoot: dir,
  } as ToolContext;

  const result = await router.send({
    senderId: 'op',
    recipientId: 'mock-root-b',
    message: 'hi',
    context: senderContext,
  });

  expect(result.status).toBe('success');
  expect(seen?.workspaceRoot).toBe(join(dir, 'root-b'));
  expect(seen?.collectiveWorkspaceRoot).toBe(dir);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts -t "gives the recipient its own workspace root"`
Expected: FAIL because `workspaceRoot` is still the sender's `root-a`.

- [ ] **Step 3: Implement recipient-root recomputation**

In `packages/core/src/runtime/MessageRouter.ts`, add the import:

```ts
import { resolveParticipantWorkspaceRoot } from '../collective/workspace-root.js';
```

In `buildRuntimeContext`, after `const participant = this.collective.getOrThrow(participantId);`:

```ts
const collectiveWorkspaceRoot = toolContext.collectiveWorkspaceRoot ?? toolContext.workspaceRoot;
```

Then change the context literal to include:

```ts
      workspaceRoot: resolveParticipantWorkspaceRoot(
        participant,
        toolContext.config,
        collectiveWorkspaceRoot,
      ),
      collectiveWorkspaceRoot,
```

The full literal now starts:

```ts
const context: RuntimeContext = {
  ...(toolContext as RuntimeContext),
  participant,
  workspaceRoot: resolveParticipantWorkspaceRoot(
    participant,
    toolContext.config,
    collectiveWorkspaceRoot,
  ),
  collectiveWorkspaceRoot,
  conversationId: thread.id,
  conversation: thread,
  communicationDepth: depth,
  messageRouter: this,
  ...(middlewareState === undefined
    ? {}
    : { middlewareActions: snapshotMiddlewareActions(middlewareState.actions) }),
};
```

- [ ] **Step 4: Run the test and the router suite**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat: build recipient runtime contexts with their own workspace root"
```

---

### Task 5: Service contexts and service tool auth use the participant root

**Files:**

- Modify: `packages/core/src/service/ServiceContextImpl.ts`
- Modify: `packages/core/src/service/ServiceManager.ts`
- Test: `packages/core/src/service/ServiceContextImpl.test.ts`

**Interfaces:**

- Consumes: `resolveParticipantWorkspaceRoot` and `workspaceConfig`/`participant` already present in `ServiceContextDeps`.
- Produces: service `callTool` authorization and `ToolContext` use the service's effective root; `collectiveWorkspaceRoot` is the launch root.

- [ ] **Step 1: Add the failing service test**

In `packages/core/src/service/ServiceContextImpl.test.ts`, add inside `describe('callTool', ...)`:

```ts
it('resolves scopes and tool contexts against the participant root', async () => {
  const { dir: d, deps } = await setup();
  dir = d;
  const participantRoot = join(d, 'project');
  await mkdir(join(participantRoot, 'allowed'), { recursive: true });
  deps.participant = {
    ...BASE_CONFIG,
    workspaceRoot: participantRoot,
    tools: {
      file_read: { policy: 'auto', scope: { path: { pathPrefix: 'allowed' } } },
    },
  } as ServiceConfig;

  let seenRoot: string | undefined;
  const originalExecute = deps.toolRegistry.execute;
  deps.toolRegistry = {
    ...deps.toolRegistry,
    execute: async (name, args, ctx) => {
      seenRoot = (ctx as ToolContext).workspaceRoot;
      return originalExecute(name, args, ctx);
    },
  };

  const ctx = new ServiceContextImpl(deps);
  const ok = await ctx.callTool('file_read', { path: 'allowed/ok.txt' });
  expect(ok.status).toBe('success');
  expect(seenRoot).toBe(participantRoot);

  const outside = await ctx.callTool('file_read', { path: 'other.txt' });
  expect(outside.status).toBe('error');
  expect(outside.error).toMatch(/argument scope violation/);
});
```

Change the fs import at the top of the test file to include `mkdir`:

```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/service/ServiceContextImpl.test.ts -t "participant root"`
Expected: FAIL because the scope resolves against the launch root and the service root is not set.

- [ ] **Step 3: Implement effective roots in ServiceContextImpl**

In `packages/core/src/service/ServiceContextImpl.ts`, add the import:

```ts
import { resolveParticipantWorkspaceRoot } from '../collective/workspace-root.js';
```

Add a private helper inside the class, before `callTool`:

```ts
  private effectiveWorkspaceRoot(): string {
    return resolveParticipantWorkspaceRoot(
      this.deps.participant,
      this.deps.workspaceConfig,
      this.deps.workspaceRoot,
    );
  }
```

In `callTool`, change the authorize call to:

```ts
const authResult = authEngine.authorize(participant.id, toolName, args, participant.tools, {
  workspaceRoot: this.effectiveWorkspaceRoot(),
});
```

In `buildToolContext`, replace `workspaceRoot,` in the returned object with:

```ts
      workspaceRoot: this.effectiveWorkspaceRoot(),
      collectiveWorkspaceRoot: this.deps.workspaceRoot,
```

- [ ] **Step 4: Update ServiceManager's base context**

In `packages/core/src/service/ServiceManager.ts`, add the import:

```ts
import { resolveParticipantWorkspaceRoot } from '../collective/workspace-root.js';
```

In `buildBaseToolContext`, replace `workspaceRoot: this.deps.workspaceRoot,` with:

```ts
      workspaceRoot: resolveParticipantWorkspaceRoot(
        config,
        this.deps.workspaceConfig,
        this.deps.workspaceRoot,
      ),
      collectiveWorkspaceRoot: this.deps.workspaceRoot,
```

- [ ] **Step 5: Run the service tests**

Run: `npx vitest run packages/core/src/service/ServiceContextImpl.test.ts packages/core/src/service/ServiceManager.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/service/ServiceContextImpl.ts \
  packages/core/src/service/ServiceManager.ts \
  packages/core/src/service/ServiceContextImpl.test.ts
git commit -m "feat: resolve service tool scopes and contexts against the service root"
```

---

### Task 6: MiddlewareRunner authorizes scopes against the participant root

**Files:**

- Modify: `packages/core/src/middleware/MiddlewareRunner.ts`
- Test: `packages/core/src/middleware/MiddlewareRunner.test.ts`

**Interfaces:**

- Consumes: an optional `resolveWorkspaceRoot(participant)` dependency supplied by `LegionProcess` in Task 7.
- Produces: both `authorize` call sites use `resolveWorkspaceRoot?.(participant) ?? dependencies.workspaceRoot`.

- [ ] **Step 1: Add the failing middleware test**

In `packages/core/src/middleware/MiddlewareRunner.test.ts`, add after the existing `rejects a middleware tool whose arguments violate its scope` test:

```ts
it('authorizes middleware scopes against the participant workspace root', async () => {
  const f = await fixture([instance('request')]);
  f.runnerDependencies.resolveWorkspaceRoot = () => '/workspace/participant-b';
  f.participant.tools = { risky: 'auto' };
  const execute = vi.fn(async () => ({ status: 'success' as const }));
  f.toolRegistry.register({ name: 'risky', description: 'risky', parameters: schema, execute });
  const authorize = vi.spyOn(f.runnerDependencies.authEngine, 'authorize');
  f.registry.register(
    middlewareDefinition({
      beforeSend: () => ({
        kind: 'tool',
        requestId: 'root-scope',
        tool: 'risky',
        arguments: { path: 'work/a.txt' },
      }),
    }),
    'test:runner',
  );

  const result = await f.runner.runMessagePhase({
    operationId: 'root-scope',
    phase: 'beforeSend',
    participant: f.participant,
    thread: f.thread,
    draft: draft(),
    actions: [],
    final: true,
  });

  expect(result.kind).toBe('continue');
  expect(authorize).toHaveBeenCalledWith(
    'participant',
    'risky',
    { path: 'work/a.txt' },
    f.participant.tools,
    { workspaceRoot: '/workspace/participant-b' },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/middleware/MiddlewareRunner.test.ts -t "participant workspace root"`
Expected: FAIL because `resolveWorkspaceRoot` is not in the dependency type and is ignored.

- [ ] **Step 3: Add the dependency and use it at both authorize sites**

In `packages/core/src/middleware/MiddlewareRunner.ts`, add to `MiddlewareRunnerDependencies` after `workspaceRoot`:

```ts
  /** Resolves a participant's effective root for argument scopes. */
  resolveWorkspaceRoot?: (participant: ParticipantConfig) => string;
```

In `resumeAction`, change the authorize context to:

```ts
        {
          workspaceRoot:
            this.dependencies.resolveWorkspaceRoot?.(participant) ??
            this.dependencies.workspaceRoot,
        },
```

In `requestTool`, change the authorize context to:

```ts
        {
          workspaceRoot:
            this.dependencies.resolveWorkspaceRoot?.(input.participant) ??
            this.dependencies.workspaceRoot,
        },
```

- [ ] **Step 4: Run the middleware suite**

Run: `npx vitest run packages/core/src/middleware/MiddlewareRunner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/middleware/MiddlewareRunner.ts \
  packages/core/src/middleware/MiddlewareRunner.test.ts
git commit -m "feat: resolve middleware argument scopes against the participant root"
```

---

### Task 7: LegionProcess stamps effective roots on every context

**Files:**

- Modify: `packages/runtime/src/LegionProcess.ts`

**Interfaces:**

- Consumes: `resolveParticipantWorkspaceRoot` from `@legion-collective/core`.
- Produces:
  - `MiddlewareRunner` receives `resolveWorkspaceRoot`.
  - `buildMiddlewareToolContext` receives `collectiveWorkspaceRoot`.
  - Connector `submit`, `callTool`, and `streamTool` build contexts with the acting participant's effective root and `collectiveWorkspaceRoot: launchRoot`.

- [ ] **Step 1: Import the helper**

In the `@legion-collective/core` import block in `packages/runtime/src/LegionProcess.ts`, add after `Collective,`:

```ts
  resolveParticipantWorkspaceRoot,
```

- [ ] **Step 2: Wire MiddlewareRunner**

In the `new MiddlewareRunner({ ... })` call, after `workspaceRoot,` add:

```ts
      resolveWorkspaceRoot: (participant) =>
        resolveParticipantWorkspaceRoot(participant, mergedConfig, workspaceRoot),
```

- [ ] **Step 3: Update the middleware tool-context builder**

In `interface MiddlewareToolContextDeps`, add after `workspaceRoot: string;`:

```ts
collectiveWorkspaceRoot: string;
```

In the `buildMiddlewareToolContext` call, add after `workspaceRoot,`:

```ts
          collectiveWorkspaceRoot: workspaceRoot,
```

In `buildMiddlewareToolContext`, replace `workspaceRoot: deps.workspaceRoot,` with:

```ts
    workspaceRoot: resolveParticipantWorkspaceRoot(
      deps.participant,
      deps.config,
      deps.collectiveWorkspaceRoot,
    ),
    collectiveWorkspaceRoot: deps.collectiveWorkspaceRoot,
```

- [ ] **Step 4: Update connector `submit`**

In `buildConnectorContext`, change the start of `submit(msg)` to:

```ts
    async submit(msg) {
      const sender = collective.getOrThrow(msg.senderId);
      const baseCtx: ToolContext = {
        participant: sender,
        conversationId: msg.conversationId ?? '',
        conversation: undefined as any, // router creates/loads the thread
        collective,
        communicationDepth: 0,
        toolRegistry,
        config,
        eventBus,
        storage,
        workspaceRoot: resolveParticipantWorkspaceRoot(sender, config, workspaceRoot),
        collectiveWorkspaceRoot: workspaceRoot,
        authEngine,
        pendingApprovalRegistry,
        messageRouter: router,
        serviceManager,
        conversationStore: store,
        processManager,
        middlewareValidator: middlewareRegistry,
        secretStore: secrets,
        credentialStore: credentials,
      };
```

- [ ] **Step 5: Update connector `callTool`**

In `callTool`, after the participant lookup, add:

```ts
const effectiveRoot = resolveParticipantWorkspaceRoot(participant, config, workspaceRoot);
```

Change the authorize call to:

```ts
const authResult = authEngine.authorize(participantId, toolName, args, participant.tools, {
  workspaceRoot: effectiveRoot,
});
```

In the `toolCtx` literal, replace `workspaceRoot,` with:

```ts
        workspaceRoot: effectiveRoot,
        collectiveWorkspaceRoot: workspaceRoot,
```

- [ ] **Step 6: Update connector `streamTool`**

In `streamTool`, after the participant lookup, add:

```ts
const effectiveRoot = resolveParticipantWorkspaceRoot(participant, config, workspaceRoot);
```

Change the authorize call to:

```ts
const authResult = authEngine.authorize(participantId, toolName, args, participant.tools, {
  workspaceRoot: effectiveRoot,
});
```

In the `toolCtx` literal, replace `workspaceRoot,` with:

```ts
        workspaceRoot: effectiveRoot,
        collectiveWorkspaceRoot: workspaceRoot,
```

- [ ] **Step 7: Typecheck and run runtime unit tests**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx vitest run packages/runtime/src/LegionProcess.loader.test.ts packages/runtime/src/server/WebConnector.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts
git commit -m "feat: stamp effective workspace roots on runtime and connector contexts"
```

---

### Task 8: `create_agent` / `modify_agent` workspace root parameter

**Files:**

- Modify: `packages/core/src/tools/management-tools.ts`
- Test: `packages/core/src/tools/management-tools.test.ts`

**Interfaces:**

- Consumes: `workspaceRootError` from `../collective/workspace-root.js`.
- Produces:
  - `create_agent` accepts `workspaceRoot?: string`; validates non-empty values; stores the trimmed raw value.
  - `modify_agent` accepts `workspaceRoot?: string | null`; omit keeps, `null`/`""` clears, non-empty validates and replaces.

- [ ] **Step 1: Add failing management-tool tests**

At the top of `packages/core/src/tools/management-tools.test.ts`, add:

```ts
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Add inside `describe('management tools', ...)` after `create_agent accepts the object policy form`:

```ts
it('create_agent stores a validated absolute workspace root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legion-agent-root-'));
  try {
    const { context, collective } = await makeContext();
    const result = await createAgentTool.execute(
      {
        id: 'rooted-agent',
        name: 'Rooted',
        systemPrompt: 'x',
        model: { model: 'gpt-4o' },
        workspaceRoot: root,
      },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('rooted-agent') as AgentConfig).workspaceRoot).toBe(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('create_agent resolves and stores a relative workspace root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'legion-agent-base-'));
  try {
    await mkdir(join(base, 'projects', 'a'), { recursive: true });
    const { context, collective } = await makeContext();
    (context as { collectiveWorkspaceRoot?: string }).collectiveWorkspaceRoot = base;
    const result = await createAgentTool.execute(
      {
        id: 'relative-agent',
        name: 'Relative',
        systemPrompt: 'x',
        model: { model: 'gpt-4o' },
        workspaceRoot: 'projects/a',
      },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('relative-agent') as AgentConfig).workspaceRoot).toBe('projects/a');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

it('create_agent rejects a missing workspace root without adding the agent', async () => {
  const { context, collective } = await makeContext();
  const result = await createAgentTool.execute(
    {
      id: 'bad-root',
      name: 'Bad',
      systemPrompt: 'x',
      model: { model: 'gpt-4o' },
      workspaceRoot: join(tmpdir(), 'legion-does-not-exist-xyz'),
    },
    context,
  );
  expect(result.status).toBe('error');
  expect(result.error).toMatch(/does not exist/);
  expect(collective.get('bad-root')).toBeUndefined();
});

it('create_agent rejects a file as the workspace root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'legion-agent-file-'));
  try {
    await mkdir(join(base, 'dir'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(base, 'file.txt'), 'x');
    const { context, collective } = await makeContext();
    (context as { collectiveWorkspaceRoot?: string }).collectiveWorkspaceRoot = base;
    const result = await createAgentTool.execute(
      {
        id: 'file-root',
        name: 'File Root',
        systemPrompt: 'x',
        model: { model: 'gpt-4o' },
        workspaceRoot: 'file.txt',
      },
      context,
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not a directory/);
    expect(collective.get('file-root')).toBeUndefined();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
```

Add inside `describe('modify_agent', ...)`:

```ts
it('sets, keeps, and clears the workspace root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legion-mod-root-'));
  try {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      {
        id: 'mod-root',
        name: 'Mod Root',
        systemPrompt: 'x',
        model: { model: 'gpt-4o' },
      },
      context,
    );

    await modifyAgentTool.execute({ id: 'mod-root', workspaceRoot: root }, context);
    expect((collective.get('mod-root') as AgentConfig).workspaceRoot).toBe(root);

    await modifyAgentTool.execute({ id: 'mod-root', name: 'Renamed' }, context);
    expect((collective.get('mod-root') as AgentConfig).workspaceRoot).toBe(root);

    await modifyAgentTool.execute({ id: 'mod-root', workspaceRoot: '' }, context);
    expect((collective.get('mod-root') as AgentConfig).workspaceRoot).toBeUndefined();

    await modifyAgentTool.execute({ id: 'mod-root', workspaceRoot: null }, context);
    expect((collective.get('mod-root') as AgentConfig).workspaceRoot).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('modify_agent rejects an invalid root and keeps the existing value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legion-mod-invalid-'));
  try {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      {
        id: 'mod-invalid',
        name: 'Mod Invalid',
        systemPrompt: 'x',
        model: { model: 'gpt-4o' },
        workspaceRoot: root,
      },
      context,
    );
    const result = await modifyAgentTool.execute(
      { id: 'mod-invalid', workspaceRoot: join(tmpdir(), 'legion-missing-xyz') },
      context,
    );
    expect(result.status).toBe('error');
    expect((collective.get('mod-invalid') as AgentConfig).workspaceRoot).toBe(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts -t "workspace root"`
Expected: FAIL because the parameter is ignored and no validation exists.

- [ ] **Step 3: Add the import and `create_agent` parameter**

In `packages/core/src/tools/management-tools.ts`, add:

```ts
import { workspaceRootError } from '../collective/workspace-root.js';
```

In `createAgentTool.parameters.properties`, after `middleware`:

```ts
      workspaceRoot: {
        type: 'string',
        description:
          'Base directory for file tools and default process execution. Absolute or ' +
          'relative to the collective workspace root. Omit to inherit the collective root.',
      },
```

In `createAgentTool.execute`, destructure `workspaceRoot`:

```ts
const { id, name, systemPrompt, model, tools, maxIterations, middleware, workspaceRoot } = args as {
  id: string;
  name: string;
  systemPrompt: string;
  model: ModelConfig;
  tools?: Record<string, ToolPolicy>;
  maxIterations?: number;
  middleware?: unknown;
  workspaceRoot?: string;
};
```

Before building `config`, add:

```ts
let participantRoot: string | undefined;
if (workspaceRoot !== undefined && workspaceRoot.trim() !== '') {
  const problem = await workspaceRootError(
    workspaceRoot.trim(),
    context.collectiveWorkspaceRoot ?? context.workspaceRoot,
  );
  if (problem) throw new Error(problem);
  participantRoot = workspaceRoot.trim();
}
```

In the `config` literal, before `status: 'active',` add:

```ts
        ...(participantRoot === undefined ? {} : { workspaceRoot: participantRoot }),
```

- [ ] **Step 4: Add the `modify_agent` parameter**

In `modifyAgentTool.parameters.properties`, after `tools`:

```ts
      workspaceRoot: {
        type: 'string',
        description:
          'Base directory for file tools and default process execution. Absolute or ' +
          'relative to the collective workspace root. Omit to keep the existing value; ' +
          'pass an empty string (or null) to inherit the collective default.',
      },
```

In `modifyAgentTool.execute`, destructure `workspaceRoot`:

```ts
const { id, name, model, systemPrompt, maxIterations, tools, workspaceRoot } = args as {
  id: string;
  name?: string;
  model?: ModelConfig | string;
  systemPrompt?: string;
  maxIterations?: number;
  tools?: Record<string, ToolPolicy>;
  workspaceRoot?: string | null;
};
```

Replace the `collective.update(id, { ... })` call with a patch:

```ts
const patch: Partial<AgentConfig> = {
  name: name ?? agent.name,
  model: updatedModel,
  systemPrompt: systemPrompt ?? agent.systemPrompt,
  maxIterations: maxIterations ?? agent.maxIterations,
  tools: tools ?? agent.tools,
};
if (workspaceRoot !== undefined) {
  if (workspaceRoot === null || workspaceRoot.trim() === '') {
    patch.workspaceRoot = undefined;
  } else {
    const problem = await workspaceRootError(
      workspaceRoot.trim(),
      context.collectiveWorkspaceRoot ?? context.workspaceRoot,
    );
    if (problem) throw new Error(problem);
    patch.workspaceRoot = workspaceRoot.trim();
  }
}
await collective.update(id, patch);
```

- [ ] **Step 5: Stamp the fallback management context**

In `createManagementTools`, in the context literal, add after `workspaceRoot: '/tmp',`:

```ts
    collectiveWorkspaceRoot: '/tmp',
```

- [ ] **Step 6: Run the management tests**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tools/management-tools.ts \
  packages/core/src/tools/management-tools.test.ts
git commit -m "feat: add workspaceRoot to create_agent and modify_agent"
```

---

### Task 9: `create_user` / `modify_user` workspace root parameter

**Files:**

- Modify: `packages/core/src/tools/user-tools.ts`
- Test: `packages/core/src/tools/user-tools.test.ts`

**Interfaces:**

- Consumes: `workspaceRootError` from `../collective/workspace-root.js`.
- Produces:
  - `create_user` accepts `workspaceRoot?: string`; validates non-empty values; stores the trimmed raw value.
  - `modify_user` accepts `workspaceRoot?: string | null`; omit keeps, `null`/`""` clears, non-empty validates and replaces.

- [ ] **Step 1: Add failing user-tool tests**

In `packages/core/src/tools/user-tools.test.ts`, add imports:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Add `workspaceRoot: '/tmp'` to the context in `makeContext`:

```ts
const context = { collective, participant, workspaceRoot: '/tmp' } as unknown as ToolContext;
```

Add inside `describe('create_user', ...)`:

```ts
it('create_user stores a validated workspace root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legion-user-root-'));
  try {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute(
      { id: 'rooted-user', name: 'Rooted User', workspaceRoot: root },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('rooted-user') as UserConfig).workspaceRoot).toBe(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('create_user rejects a missing workspace root without adding the user', async () => {
  const { context, collective } = await makeContext();
  const result = await createUserTool.execute(
    { id: 'bad-user', name: 'Bad User', workspaceRoot: join(tmpdir(), 'legion-user-missing-xyz') },
    context,
  );
  expect(result.status).toBe('error');
  expect(result.error).toMatch(/does not exist/);
  expect(collective.get('bad-user')).toBeUndefined();
});
```

Add inside `describe('modify_user', ...)`:

```ts
it('sets, keeps, and clears the workspace root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legion-user-mod-root-'));
  try {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'mod-user', name: 'Mod User' }, context);

    await modifyUserTool.execute({ id: 'mod-user', workspaceRoot: root }, context);
    expect((collective.get('mod-user') as UserConfig).workspaceRoot).toBe(root);

    await modifyUserTool.execute({ id: 'mod-user', name: 'Renamed' }, context);
    expect((collective.get('mod-user') as UserConfig).workspaceRoot).toBe(root);

    await modifyUserTool.execute({ id: 'mod-user', workspaceRoot: '' }, context);
    expect((collective.get('mod-user') as UserConfig).workspaceRoot).toBeUndefined();

    await modifyUserTool.execute({ id: 'mod-user', workspaceRoot: null }, context);
    expect((collective.get('mod-user') as UserConfig).workspaceRoot).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('modify_user rejects an invalid root and keeps the existing value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legion-user-invalid-'));
  try {
    const { context, collective } = await makeContext();
    await createUserTool.execute(
      { id: 'mod-invalid-user', name: 'Mod Invalid', workspaceRoot: root },
      context,
    );
    const result = await modifyUserTool.execute(
      { id: 'mod-invalid-user', workspaceRoot: join(tmpdir(), 'legion-user-missing-xyz') },
      context,
    );
    expect(result.status).toBe('error');
    expect((collective.get('mod-invalid-user') as UserConfig).workspaceRoot).toBe(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/user-tools.test.ts -t "workspace root"`
Expected: FAIL because the parameter is ignored.

- [ ] **Step 3: Add the import and `create_user` parameter**

In `packages/core/src/tools/user-tools.ts`, add:

```ts
import { workspaceRootError } from '../collective/workspace-root.js';
```

In `createUserTool.parameters.properties`, after `tools`:

```ts
      workspaceRoot: {
        type: 'string',
        description:
          'Base directory for file tools and default process execution. Absolute or ' +
          'relative to the collective workspace root. Omit to inherit the collective root.',
      },
```

In `createUserTool.execute`, destructure `workspaceRoot`:

```ts
const { id, name, operator, tools, workspaceRoot } = args as {
  id: string;
  name: string;
  operator?: boolean;
  tools?: Record<string, ToolPolicy>;
  workspaceRoot?: string;
};
```

Before building `config`, add:

```ts
let participantRoot: string | undefined;
if (workspaceRoot !== undefined && workspaceRoot.trim() !== '') {
  const problem = await workspaceRootError(
    workspaceRoot.trim(),
    context.collectiveWorkspaceRoot ?? context.workspaceRoot,
  );
  if (problem) return { status: 'error', error: problem };
  participantRoot = workspaceRoot.trim();
}
```

In the `config` literal, before `status: 'active',` add:

```ts
        ...(participantRoot === undefined ? {} : { workspaceRoot: participantRoot }),
```

- [ ] **Step 4: Add the `modify_user` parameter**

In `modifyUserTool.parameters.properties`, after `tools`:

```ts
      workspaceRoot: {
        type: 'string',
        description:
          'Base directory for file tools and default process execution. Absolute or ' +
          'relative to the collective workspace root. Omit to keep the existing value; ' +
          'pass an empty string (or null) to inherit the collective default.',
      },
```

In `modifyUserTool.execute`, destructure `workspaceRoot`:

```ts
const { id, name, operator, tools, workspaceRoot } = args as {
  id: string;
  name?: string;
  operator?: boolean;
  tools?: Record<string, ToolPolicy>;
  workspaceRoot?: string | null;
};
```

After building `patch`, before `collective.update`:

```ts
if (workspaceRoot !== undefined) {
  if (workspaceRoot === null || workspaceRoot.trim() === '') {
    patch.workspaceRoot = undefined;
  } else {
    const problem = await workspaceRootError(
      workspaceRoot.trim(),
      context.collectiveWorkspaceRoot ?? context.workspaceRoot,
    );
    if (problem) return { status: 'error', error: problem };
    patch.workspaceRoot = workspaceRoot.trim();
  }
}
```

- [ ] **Step 5: Run the user-tool tests**

Run: `npx vitest run packages/core/src/tools/user-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/user-tools.ts packages/core/src/tools/user-tools.test.ts
git commit -m "feat: add workspaceRoot to create_user and modify_user"
```

---

### Task 10: AgentEditor workspace root input

**Files:**

- Modify: `packages/web/src/views/AgentEditor.vue`
- Test: `packages/web/src/views/AgentEditor.test.ts`

**Interfaces:**

- Consumes: `get_participant` returns `workspaceRoot`; `create_agent` / `modify_agent` accept it.
- Produces: a text input bound to `workspaceRoot`; save sends the value (empty string clears on modify).

- [ ] **Step 1: Add the failing web test**

In `packages/web/src/views/AgentEditor.test.ts`, add after `save on an existing agent calls modify_agent with edited fields`:

```ts
it('loads, edits, and clears the workspace root', async () => {
  const baseFetch = stubFetch();
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.tool === 'get_participant') {
      return toolResponse('get_participant', { ...AGENT, workspaceRoot: 'projects/a' });
    }
    return baseFetch(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
  await vi.waitFor(() =>
    expect(
      (wrapper.find('[data-test="agent-workspace-root"]').element as HTMLInputElement).value,
    ).toBe('projects/a'),
  );
  await wrapper.find('[data-test="agent-workspace-root"]').setValue('');
  await wrapper.find('[data-test="agent-save"]').trigger('click');
  await vi.waitFor(() => {
    const call = fetchMock.mock.calls.find(
      (c) => JSON.parse(String(c[1]?.body)).tool === 'modify_agent',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call![1]?.body)).args.workspaceRoot).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=packages/web -- AgentEditor.test.ts -t "workspace root"`
Expected: FAIL because the input does not exist.

- [ ] **Step 3: Implement the editor changes**

In `packages/web/src/views/AgentEditor.vue`, add near the other refs:

```ts
const workspaceRoot = ref('');
```

In `load()`, in the `new` branch, add:

```ts
workspaceRoot.value = '';
```

In the existing branch, after `maxIterations.value = Number(p['maxIterations'] ?? 20);`:

```ts
workspaceRoot.value = String(p['workspaceRoot'] ?? '');
```

In `save()`, add `workspaceRoot: workspaceRoot.value,` to both `create_agent` and `modify_agent` payloads.

In the template, after the max-iterations label, add:

```html
<label class="flex flex-col gap-1">
  <span class="text-xs text-faint">Workspace root</span>
  <input
    v-model="workspaceRoot"
    data-test="agent-workspace-root"
    placeholder="Inherit collective workspace root"
    class="rounded border border-line bg-surface px-2 py-1"
  />
  <span class="text-xs text-muted">
    Base directory for file and process tools. Absolute or relative to the collective root. Empty
    inherits the collective root.
  </span>
</label>
```

- [ ] **Step 4: Run the web tests**

Run: `npm run test --workspace=packages/web -- AgentEditor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/views/AgentEditor.vue packages/web/src/views/AgentEditor.test.ts
git commit -m "feat: add workspace root field to the agent editor"
```

---

### Task 11: UserEditor workspace root input

**Files:**

- Modify: `packages/web/src/views/UserEditor.vue`
- Test: `packages/web/src/views/UserEditor.test.ts`

**Interfaces:**

- Consumes: `get_participant` returns `workspaceRoot`; `create_user` / `modify_user` accept it.
- Produces: a text input bound to `workspaceRoot`; save sends the value (empty string clears on modify).

- [ ] **Step 1: Add the failing web test**

In `packages/web/src/views/UserEditor.test.ts`, add after `save calls modify_user with full-replacement tools`:

```ts
it('loads, edits, and saves the workspace root', async () => {
  const baseFetch = stubFetch({ ...USER, workspaceRoot: 'projects/b' });
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.tool === 'get_participant') {
      return toolResponse('get_participant', { ...USER, workspaceRoot: 'projects/b' });
    }
    return baseFetch(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
  await waitLoaded(wrapper);
  expect(
    (wrapper.find('[data-test="user-workspace-root"]').element as HTMLInputElement).value,
  ).toBe('projects/b');
  await wrapper.find('[data-test="user-workspace-root"]').setValue('projects/c');
  await wrapper.find('form').trigger('submit');
  await vi.waitFor(() => {
    const call = fetchMock.mock.calls.find(
      (c) => JSON.parse(String(c[1]?.body)).tool === 'modify_user',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call![1]?.body)).args.workspaceRoot).toBe('projects/c');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=packages/web -- UserEditor.test.ts -t "workspace root"`
Expected: FAIL because the input does not exist.

- [ ] **Step 3: Implement the editor changes**

In `packages/web/src/views/UserEditor.vue`, add near the other refs:

```ts
const workspaceRoot = ref('');
```

In `load()`, in the `new` branch, add:

```ts
workspaceRoot.value = '';
```

In the existing branch, after `name.value = String(p['name'] ?? '');`:

```ts
workspaceRoot.value = String(p['workspaceRoot'] ?? '');
```

In `save()`, add `workspaceRoot: workspaceRoot.value,` to both `create_user` and `modify_user` payloads.

In the template, after the operator label/paragraph, add:

```html
<label class="flex flex-col gap-1">
  <span class="text-xs text-faint">Workspace root</span>
  <input
    v-model="workspaceRoot"
    data-test="user-workspace-root"
    placeholder="Inherit collective workspace root"
    class="rounded border border-line bg-surface px-2 py-1"
  />
  <span class="text-xs text-muted">
    Base directory for file and process tools. Absolute or relative to the collective root. Empty
    inherits the collective root.
  </span>
</label>
```

- [ ] **Step 4: Run the web tests**

Run: `npm run test --workspace=packages/web -- UserEditor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/views/UserEditor.vue packages/web/src/views/UserEditor.test.ts
git commit -m "feat: add workspace root field to the user editor"
```

---

### Task 12: Full verification gate and live collective acceptance run

**Files:**

- Create: `scripts/acceptance-workspace-roots.mjs`

**Interfaces:**

- Consumes: a built Legion (`npm run build`) and the mock provider defined in the script.
- Produces: a PASS/FAIL script that exercises the real Fastify connector, auth, router, file tools, process tools, and scope resolution with two agents on different roots plus one config-default agent.

- [ ] **Step 1: Run the full automated gate**

Run, in order:

```bash
npm run format:check
npm run typecheck
npm test
npm run test --workspace=packages/web
npm run build
```

Expected: all PASS.

- [ ] **Step 2: Create the acceptance script**

Create `scripts/acceptance-workspace-roots.mjs`:

```js
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const REPO = process.cwd();
const PORT = 4310;
const PROVIDER_PORT = 4311;
const PASSWORD = 'acceptance-password';

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`PASS: ${message}`);
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function textChunks(text) {
  return [
    { choices: [{ delta: { content: text }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
}

function toolChunks(id, name, args) {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
}

function startProvider() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const request = JSON.parse(body);
      const messages = request.messages ?? [];
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const toolMessage = [...messages].reverse().find((message) => message.role === 'tool');

      if (system.includes('SCENARIO=LIST_ROOT')) {
        if (toolMessage) {
          sse(res, textChunks(`ROOT_CONTENT=${toolMessage.content}`));
        } else {
          sse(res, toolChunks('list-root', 'file_list', { path: '.' }));
        }
        return;
      }
      if (system.includes('SCENARIO=FORWARD')) {
        if (toolMessage) {
          sse(res, textChunks(`FORWARDED=${toolMessage.content}`));
        } else {
          sse(
            res,
            toolChunks('forward', 'communicate', { to: 'agent-b', message: 'list your root' }),
          );
        }
        return;
      }
      sse(res, textChunks('NO_SCENARIO'));
    });
  });
  return new Promise((resolveStart) => {
    server.listen(PROVIDER_PORT, '127.0.0.1', () => resolveStart(server));
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function login(name, password) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`login ${name}: ${JSON.stringify(json)}`);
  return json.token;
}

async function rawCall(token, tool, args) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/execute?stream=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool, args }),
  });
  const json = await res.json();
  return json.result;
}

async function call(token, tool, args) {
  const result = await rawCall(token, tool, args);
  if (result?.status !== 'success') {
    throw new Error(`${tool}: ${JSON.stringify(result)}`);
  }
  return result.data;
}

const root = await mkdtemp(join(tmpdir(), 'legion-acceptance-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const roots = join(workspace, 'roots');
const dirs = {
  a: join(roots, 'a'),
  b: join(roots, 'b'),
  default: join(roots, 'default'),
};

let provider;
let legion;

try {
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  await mkdir(join(dirs.a, 'sub'), { recursive: true });
  await mkdir(join(dirs.a, 'allowed'), { recursive: true });
  await writeFile(join(dirs.a, 'root-a.txt'), 'A');
  await writeFile(join(dirs.a, 'other.txt'), 'other');
  await writeFile(join(dirs.a, 'allowed', 'ok.txt'), 'ok');
  await writeFile(join(dirs.b, 'root-b.txt'), 'B');
  await writeFile(join(dirs.default, 'default.txt'), 'D');

  await mkdir(join(home, '.config', 'legion', 'providers'), { recursive: true });
  await writeFile(
    join(home, '.config', 'legion', 'providers', 'Mock.json'),
    JSON.stringify({
      name: 'Mock',
      type: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
      apiKey: 'x',
      priority: 1,
    }),
  );
  await writeFile(
    join(home, '.config', 'legion', 'config.json'),
    JSON.stringify({ routing: { models: { 'mock-model': ['Mock'] } } }),
  );
  await mkdir(join(workspace, '.legion'), { recursive: true });
  await writeFile(
    join(workspace, '.legion', 'config.json'),
    JSON.stringify({ version: '2', workspaceRoot: 'roots/default' }),
  );

  provider = await startProvider();
  legion = spawn('node', [join(REPO, 'packages/runtime/bin/legion.js')], {
    env: {
      ...process.env,
      HOME: home,
      LEGION_WORKSPACE: workspace,
      PORT: String(PORT),
      LEGION_BOOTSTRAP_PASSWORD: PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  legion.stdout.on('data', (data) => process.stdout.write(`[legion] ${data}`));
  legion.stderr.on('data', (data) => process.stderr.write(`[legion] ${data}`));

  await waitFor(`http://127.0.0.1:${PORT}/api/health`, 20_000);
  const operator = await login('Operator', PASSWORD);

  await call(operator, 'create_agent', {
    id: 'agent-a',
    name: 'Agent A',
    systemPrompt: 'SCENARIO=FORWARD',
    model: { model: 'mock-model' },
    tools: {
      communicate: 'auto',
      file_list: 'auto',
      file_read: 'auto',
      execute_command: 'auto',
    },
    workspaceRoot: dirs.a,
  });
  await call(operator, 'create_agent', {
    id: 'agent-b',
    name: 'Agent B',
    systemPrompt: 'SCENARIO=LIST_ROOT',
    model: { model: 'mock-model' },
    tools: { file_list: 'auto' },
    workspaceRoot: 'roots/b',
  });
  await call(operator, 'create_agent', {
    id: 'agent-c',
    name: 'Agent C',
    systemPrompt: 'SCENARIO=LIST_ROOT',
    model: { model: 'mock-model' },
    tools: { file_list: 'auto' },
  });
  await call(operator, 'set_credential', { participantId: 'agent-a', secret: PASSWORD });
  await call(operator, 'set_credential', { participantId: 'agent-b', secret: PASSWORD });
  await call(operator, 'set_credential', { participantId: 'agent-c', secret: PASSWORD });

  const a = await login('Agent A', PASSWORD);
  const b = await login('Agent B', PASSWORD);
  const c = await login('Agent C', PASSWORD);

  const aFiles = await call(a, 'file_list', { path: '.' });
  assert(aFiles.includes('root-a.txt'), 'agent A lists its own root');
  assert(!aFiles.includes('root-b.txt'), 'agent A does not see agent B files');

  const bFiles = await call(b, 'file_list', { path: '.' });
  assert(bFiles.includes('root-b.txt'), 'agent B lists its own relative root');
  assert(!bFiles.includes('root-a.txt'), 'agent B does not see agent A files');

  const cFiles = await call(c, 'file_list', { path: '.' });
  assert(cFiles.includes('default.txt'), 'agent C inherits WorkspaceConfig.workspaceRoot');

  const inside = await call(a, 'file_read', { path: join(dirs.a, 'root-a.txt') });
  assert(inside === 'A', 'absolute path inside the participant root is readable');

  const outside = await rawCall(a, 'file_read', { path: join(dirs.b, 'root-b.txt') });
  assert(
    outside.status === 'error' && /outside/i.test(outside.error),
    'absolute path outside is rejected',
  );

  const traversal = await rawCall(a, 'file_read', { path: '../b/root-b.txt' });
  assert(traversal.status === 'error', '.. escape is rejected');

  const pwd = await call(a, 'execute_command', { command: 'pwd' });
  assert(pwd.stdout.trim() === dirs.a, 'execute_command defaults to the participant root');

  const pwdRelative = await call(a, 'execute_command', { command: 'pwd', cwd: 'sub' });
  assert(
    pwdRelative.stdout.trim() === join(dirs.a, 'sub'),
    'relative cwd resolves under the participant root',
  );

  const pwdAbsolute = await call(a, 'execute_command', { command: 'pwd', cwd: dirs.b });
  assert(pwdAbsolute.stdout.trim() === dirs.b, 'absolute cwd is used as-is');

  await call(operator, 'modify_agent', {
    id: 'agent-a',
    tools: {
      communicate: 'auto',
      file_list: 'auto',
      execute_command: 'auto',
      file_read: { policy: 'auto', scope: { path: { pathPrefix: 'allowed' } } },
    },
  });
  const scopedOk = await call(a, 'file_read', { path: 'allowed/ok.txt' });
  assert(scopedOk === 'ok', 'pathPrefix scope resolves under the participant root');
  const scopedBad = await rawCall(a, 'file_read', { path: 'other.txt' });
  assert(
    scopedBad.status === 'error' && /argument scope violation/.test(scopedBad.error),
    'pathPrefix scope rejects paths outside the participant root',
  );

  const forwarded = await call(a, 'communicate', { to: 'agent-b', message: 'go' });
  const forwardedText = JSON.stringify(forwarded);
  assert(forwardedText.includes('root-b.txt'), 'cross-agent message uses the recipient root');
  assert(
    !forwardedText.includes('root-a.txt'),
    'cross-agent message does not leak the sender root',
  );

  console.log('ACCEPTANCE PASS');
} finally {
  if (legion) {
    legion.kill('SIGTERM');
    await new Promise((resolveExit) => legion.once('exit', resolveExit));
  }
  if (provider) {
    await new Promise((resolveClose) => provider.close(resolveClose));
  }
  await rm(root, { recursive: true, force: true });
}
```

- [ ] **Step 3: Run the live acceptance script**

Run: `node scripts/acceptance-workspace-roots.mjs`
Expected: every `PASS:` line prints, followed by `ACCEPTANCE PASS`.

- [ ] **Step 4: Commit**

```bash
git add scripts/acceptance-workspace-roots.mjs
git commit -m "test: add live acceptance script for participant workspace roots"
```

- [ ] **Step 5: Final gate re-run**

Run:

```bash
npm run format:check
npm run typecheck
npm test
npm run test --workspace=packages/web
```

Expected: all PASS.
