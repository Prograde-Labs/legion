# Tool Policy Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `ToolPolicy` from 3 values to 2 (`'auto' | 'requires_approval'`), make absent tools hidden from the LLM by default, remove the dead engine-level policy layer from `AuthEngine`, remove `defaultPolicy`/`composeTools` from management tools, add `remove_tool_policy` tool, and update the UI to show per-tool checkboxes with no default selector.

**Architecture:** `AuthEngine` becomes a thin map lookup — no constructor options, no engine-level fallback. `AgentRuntime` filters tools to only those present in the participant's `tools` map. Management tools accept an explicit `tools` map; no composition logic. Frontend `ToolPolicyEditor` lists every tool as a checkbox row with an approval toggle.

**Tech Stack:** TypeScript strict ESM, Vitest, Vue 3

---

### Task 1: Narrow `ToolPolicy` type and `AuthResult`

**Files:**

- Modify: `packages/types/src/tool.ts:32`

- [ ] **Step 1: Update `ToolPolicy` and `AuthResult`**

Replace the type at line 32 of `packages/types/src/tool.ts`:

```ts
export type ToolPolicy = 'auto' | 'requires_approval';
```

The file currently has no `AuthResult` — that lives in `AuthEngine.ts`. No change to `tool.ts` beyond the type.

- [ ] **Step 2: Run typecheck to see what breaks**

```bash
npm run typecheck 2>&1 | head -60
```

Expected: TypeScript errors wherever `'deny'` is used as a `ToolPolicy` value. These are the exact locations Task 2–5 will fix. Do not fix them yet — just catalogue them.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/tool.ts
git commit -m "refactor(types): narrow ToolPolicy to auto | requires_approval"
```

---

### Task 2: Simplify `AuthEngine`

**Files:**

- Modify: `packages/core/src/auth/AuthEngine.ts`
- Modify: `packages/core/src/auth/AuthEngine.test.ts`

- [ ] **Step 1: Rewrite `AuthEngine.ts`**

Replace the entire file content:

```ts
import type { ApprovalAuthority, ToolPolicy } from '@legion/types';

export interface AuthResult {
  authorized: boolean;
  reason?: 'auto' | 'requires_approval' | 'hidden';
}

export class AuthEngine {
  authorize(
    _participantId: string,
    tool: string,
    _args: unknown,
    participantPolicies?: Record<string, ToolPolicy>,
  ): AuthResult {
    const policy = participantPolicies?.[tool];
    if (policy === 'auto') return { authorized: true, reason: 'auto' };
    if (policy === 'requires_approval') return { authorized: false, reason: 'requires_approval' };
    return { authorized: false, reason: 'hidden' };
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

Removed: `AuthEngineOptions`, `BUILTIN_DEFAULT`, `resolvePolicy`. `new AuthEngine()` still valid — no constructor args needed.

- [ ] **Step 2: Rewrite `AuthEngine.test.ts`**

Replace the entire file content:

```ts
import { AuthEngine } from './AuthEngine.js';
import type { ApprovalAuthority, ToolPolicy } from '@legion/types';

describe('AuthEngine.authorize', () => {
  it('honors a participant per-tool auto policy', () => {
    const engine = new AuthEngine();
    const policies: Record<string, ToolPolicy> = { file_read: 'auto' };
    const result = engine.authorize('p1', 'file_read', {}, policies);
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('auto');
  });

  it('returns not-authorized with requires_approval reason when policy is requires_approval', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'danger', {}, { danger: 'requires_approval' });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('requires_approval');
  });

  it('absent tool is hidden — not authorized, reason hidden', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'unknown_tool', {}, {});
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('hidden');
  });

  it('absent tool with undefined policies is hidden', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'any_tool', {}, undefined);
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('hidden');
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

- [ ] **Step 3: Run the auth tests**

```bash
npx vitest run packages/core/src/auth/AuthEngine.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/auth/AuthEngine.ts packages/core/src/auth/AuthEngine.test.ts
git commit -m "refactor(auth): simplify AuthEngine — remove engine-level policy layer"
```

---

### Task 3: Update `AgentRuntime` tool filter and deny branch

**Files:**

- Modify: `packages/core/src/runtime/AgentRuntime.ts:108,146-167`
- Modify: `packages/core/src/runtime/AgentRuntime.test.ts:268-367`

- [ ] **Step 1: Update the tool visibility filter**

In `packages/core/src/runtime/AgentRuntime.ts`, find line 108:

```ts
      .filter((tool) => (agent.tools[tool.name] ?? 'requires_approval') !== 'deny')
```

Replace with:

```ts
      .filter((tool) => agent.tools[tool.name] !== undefined)
```

- [ ] **Step 2: Replace the `deny` branch with a `hidden` defensive handler**

Find lines 146–167 in `AgentRuntime.ts`:

```ts
if (authResult.reason === 'deny') {
  // Denied tools bypass ToolRegistry — emit events here
  context.eventBus.emit('tool:call', {
    conversationId: context.conversationId,
    participantId: this.participantId,
    tool: tc.name,
    callId: tc.id,
  });
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
```

Replace with:

```ts
if (authResult.reason === 'hidden') {
  // Unreachable in normal operation — filter above excludes absent tools.
  // Defensive guard for direct authorize() calls that bypass the filter.
  toolResults.push({
    id: tc.id,
    name: tc.name,
    result: { status: 'error', error: `Tool '${tc.name}' not available` },
  });
  continue;
}
```

- [ ] **Step 3: Rewrite the "deny policy" describe block in `AgentRuntime.test.ts`**

The describe block at lines 268–367 tests `tools: { echo: 'deny' }`. Replace it entirely with a test for a hidden (absent) tool. Find the block starting at line 268:

```ts
// Auth: deny policy
// ---------------------------------------------------------------------------
describe('AgentRuntime: auth – deny policy', () => {
```

Replace the entire block (lines 268–368) with:

```ts
// ---------------------------------------------------------------------------
// Auth: hidden tool (absent from tools map) — LLM never sees it
// ---------------------------------------------------------------------------
describe('AgentRuntime: auth – hidden tool (absent from map)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-ar-hidden-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('tool absent from map is not presented to LLM; LLM responds directly', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('collective/participants/agent-1.json', {
      id: 'agent-1',
      name: 'A',
      type: 'agent',
      status: 'active',
      tools: {}, // echo is absent — hidden from LLM
      systemPrompt: 'You are an assistant.',
      model: { model: 'test' },
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(new FileStorage(dir));
    const eventBus = new EventBus();
    const thread = new ConversationThread(
      await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} }),
      store,
    );

    // Provider: should never receive echo as an available tool — returns text directly
    let toolsSeenByProvider: string[] = [];
    const provider: Provider = {
      async complete(_msgs, tools) {
        toolsSeenByProvider = (tools ?? []).map((t) => t.name);
        return { content: 'No tools available', toolCalls: [], stopReason: 'stop' };
      },
    };
    const router = new MockModelRouter(new Map([['test', provider]])) as ModelRouter;

    const echoTool: Tool = {
      name: 'echo',
      description: 'echo',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      } as JSONSchema,
      async execute(args) {
        return { status: 'success', data: (args as { text: string }).text };
      },
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
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
      messageRouter: { send: vi.fn(), resume: vi.fn() } as unknown as MessageRouterPort,
    } as unknown as RuntimeContext;

    const incoming: MessageData = {
      id: 'msg-1',
      parentId: null,
      conversationId: thread.id,
      senderId: 'op',
      recipientId: 'agent-1',
      role: 'user',
      content: 'use echo',
      status: 'active',
      timestamp: new Date().toISOString(),
    };

    const runtime = new AgentRuntime('agent-1', router);
    const result = await runtime.handle(incoming, context);

    // LLM never saw echo
    expect(toolsSeenByProvider).not.toContain('echo');
    expect(result.kind).toBe('response');
    expect((result as { kind: string; content: string }).content).toBe('No tools available');
  });
});
```

- [ ] **Step 4: Run the AgentRuntime tests**

```bash
npx vitest run packages/core/src/runtime/AgentRuntime.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/AgentRuntime.ts packages/core/src/runtime/AgentRuntime.test.ts
git commit -m "refactor(runtime): hidden tools filtered from LLM; replace deny branch with hidden guard"
```

---

### Task 4: Update `ServiceContextImpl` and its tests

**Files:**

- Modify: `packages/core/src/service/ServiceContextImpl.ts:94-99`
- Modify: `packages/core/src/service/ServiceContextImpl.test.ts:129-140`
- Modify: `packages/core/src/service/ServiceManager.test.ts:64`
- Modify: `packages/core/src/service/service.integration.test.ts:44`

- [ ] **Step 1: Update error message branching in `ServiceContextImpl.ts`**

Find lines 94–99 in `packages/core/src/service/ServiceContextImpl.ts`:

```ts
if (!authResult.authorized) {
  const reason =
    authResult.reason === 'requires_approval'
      ? 'requires_approval — no authority chain in service context (denied)'
      : (authResult.reason ?? 'denied');
  return { status: 'error', error: reason };
}
```

Replace with:

```ts
if (!authResult.authorized) {
  const reason =
    authResult.reason === 'requires_approval'
      ? 'requires_approval — no authority chain in service context (denied)'
      : authResult.reason === 'hidden'
        ? 'tool not available to this participant'
        : (authResult.reason ?? 'denied');
  return { status: 'error', error: reason };
}
```

- [ ] **Step 2: Update `ServiceContextImpl.test.ts` — rewrite the "denied" test**

Find lines 129–140:

```ts
it('returns error result when tool is denied', async () => {
  const { dir: d, deps } = await setup();
  dir = d;
  const ctx = new ServiceContextImpl({
    ...deps,
    participant: { ...BASE_CONFIG, tools: {} },
    authEngine: new AuthEngine({ defaultPolicy: 'deny' }),
  });
  const result = await ctx.callTool('file_read', {});
  expect(result.status).toBe('error');
  expect((result as any).error).toMatch(/deny/i);
});
```

Replace with:

```ts
it('returns error result when tool is not in participant tools map (hidden)', async () => {
  const { dir: d, deps } = await setup();
  dir = d;
  const ctx = new ServiceContextImpl({
    ...deps,
    participant: { ...BASE_CONFIG, tools: {} }, // file_read absent = hidden
  });
  const result = await ctx.callTool('file_read', {});
  expect(result.status).toBe('error');
  expect((result as any).error).toMatch(/not available/i);
});
```

Note: `authEngine` is no longer overridden — the default `new AuthEngine()` (no options) handles absent tools as hidden.

- [ ] **Step 3: Fix `ServiceContextImpl.test.ts` setup — remove `defaultPolicy: 'auto'`**

Find line 69 in `packages/core/src/service/ServiceContextImpl.test.ts`:

```ts
    authEngine: new AuthEngine({ defaultPolicy: 'auto' }),
```

Replace with:

```ts
    authEngine: new AuthEngine(),
```

The `setup()` function's participant (`BASE_CONFIG`) must have `file_read: 'auto'` in its `tools` map so the "executes an authorized tool" test passes. Find `BASE_CONFIG` in the file and check it has `tools: { file_read: 'auto' }`. If it uses `tools: {}`, update it:

```ts
// Find BASE_CONFIG definition (near top of file) and ensure it includes:
tools: { file_read: 'auto' },
```

- [ ] **Step 4: Fix `ServiceManager.test.ts` — remove `defaultPolicy: 'auto'`**

Find line 64 in `packages/core/src/service/ServiceManager.test.ts`:

```ts
    authEngine: new AuthEngine({ defaultPolicy: 'auto' }),
```

Replace with:

```ts
    authEngine: new AuthEngine(),
```

The `ServiceManager` tests test lifecycle (start/stop), not auth — no participant tool calls that would be affected by this change.

- [ ] **Step 5: Fix `service.integration.test.ts` — remove `defaultPolicy: 'auto'`**

Find line 44 in `packages/core/src/service/service.integration.test.ts`:

```ts
const authEngine = new AuthEngine({ defaultPolicy: 'auto' });
```

Replace with:

```ts
const authEngine = new AuthEngine();
```

The integration test's service config at line 85 has `tools: {}` and the service itself doesn't call tools directly — the authEngine here is for `callTool` paths that aren't exercised in this test. No further changes needed.

- [ ] **Step 6: Run service tests**

```bash
npx vitest run packages/core/src/service/
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/service/ServiceContextImpl.ts packages/core/src/service/ServiceContextImpl.test.ts packages/core/src/service/ServiceManager.test.ts packages/core/src/service/service.integration.test.ts
git commit -m "refactor(service): update ServiceContextImpl for hidden tool reason; remove AuthEngine options from tests"
```

---

### Task 5: Simplify management tools — remove `composeTools`, `defaultPolicy`, add `remove_tool_policy`

**Files:**

- Modify: `packages/core/src/tools/management-tools.ts`
- Modify: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Remove `normalizePolicy` and `composeTools` from `management-tools.ts`**

Delete lines 22–48 (the `normalizePolicy` and `composeTools` functions) entirely.

- [ ] **Step 2: Simplify `createAgentTool` parameters and execute**

Replace the `createAgentTool` definition (lines 50–96) with:

```ts
export const createAgentTool: Tool = {
  name: 'create_agent',
  description: 'Create a new agent participant in the collective.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      systemPrompt: { type: 'string' },
      model: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
      tools: {
        type: 'object',
        description:
          'Map of tool name to policy (auto or requires_approval). Absent tools are hidden from the agent.',
      },
      maxIterations: { type: 'number' },
    },
    required: ['id', 'name', 'systemPrompt', 'model'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { id, name, systemPrompt, model, tools, maxIterations } = args as {
      id: string;
      name: string;
      systemPrompt: string;
      model: ModelConfig;
      tools?: Record<string, ToolPolicy>;
      maxIterations?: number;
    };
    try {
      const collective = requireCollective(context);
      const config: AgentConfig = {
        id,
        name,
        type: 'agent',
        tools: tools ?? {},
        systemPrompt,
        model: sanitizeModelConfig(model),
        maxIterations: maxIterations ?? 20,
        status: 'active',
      };
      await collective.add(config);
      return { status: 'success', data: { id } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 3: Simplify `modifyAgentTool`**

Replace the `modifyAgentTool` definition (lines 258–317) with:

```ts
export const modifyAgentTool: Tool = {
  name: 'modify_agent',
  description:
    'Update an existing agent — name, model, system prompt, max iterations, tool policies.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
      name: { type: 'string' },
      model: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
      systemPrompt: { type: 'string' },
      maxIterations: { type: 'number' },
      tools: {
        type: 'object',
        description:
          'Full replacement tools map. Omit to keep existing. Pass {} to clear all tool access.',
      },
    },
    required: ['id'],
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    const { id, name, model, systemPrompt, maxIterations, tools } = args as {
      id: string;
      name?: string;
      model?: ModelConfig | string;
      systemPrompt?: string;
      maxIterations?: number;
      tools?: Record<string, ToolPolicy>;
    };
    try {
      const collective = requireCollective(context);
      const existing = collective.get(id);
      if (!existing) return { status: 'error', error: `Agent not found: ${id}` };
      if (existing.type !== 'agent')
        return { status: 'error', error: `Participant ${id} is not an agent` };

      const agent = existing as AgentConfig;
      const updatedModel: ModelConfig =
        typeof model === 'string'
          ? sanitizeModelConfig({
              model,
              temperature: agent.model.temperature,
              maxTokens: agent.model.maxTokens,
            })
          : sanitizeModelConfig(model ?? agent.model);

      await collective.update(id, {
        name: name ?? agent.name,
        model: updatedModel,
        systemPrompt: systemPrompt ?? agent.systemPrompt,
        maxIterations: maxIterations ?? agent.maxIterations,
        tools: tools ?? agent.tools,
      });

      return { status: 'success', data: collective.getOrThrow(id) };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 4: Update `setToolPolicyTool` — narrow policy enum**

Find line 165 in `packages/core/src/tools/management-tools.ts`:

```ts
      policy: { type: 'string', enum: ['auto', 'deny', 'requires_approval'] },
```

Replace with:

```ts
      policy: { type: 'string', enum: ['auto', 'requires_approval'] },
```

- [ ] **Step 5: Add `removeToolPolicyTool`**

After the `setToolPolicyTool` definition and before `getConversationTool`, add:

```ts
export const removeToolPolicyTool: Tool = {
  name: 'remove_tool_policy',
  description:
    "Remove a tool from a participant's tools map, hiding it from the LLM. " +
    'The tool will no longer be visible or callable by the participant.',
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      tool: { type: 'string' },
    },
    required: ['participantId', 'tool'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { participantId, tool } = args as { participantId: string; tool: string };
    try {
      const collective = requireCollective(context);
      const participant = collective.getOrThrow(participantId);
      const tools = { ...participant.tools };
      delete tools[tool];
      await collective.update(participantId, { tools });
      return { status: 'success', data: { participantId, tool } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 6: Register `removeToolPolicyTool` in `managementTools` array**

Find the `managementTools` array (currently line 386):

```ts
export const managementTools: Tool[] = [
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  setToolPolicyTool,
  getConversationTool,
  setCredentialTool,
  modifyAgentTool,
  listToolsTool,
  listConversationsTool,
  deleteConversationTool,
];
```

Replace with:

```ts
export const managementTools: Tool[] = [
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  setToolPolicyTool,
  removeToolPolicyTool,
  getConversationTool,
  setCredentialTool,
  modifyAgentTool,
  listToolsTool,
  listConversationsTool,
  deleteConversationTool,
];
```

- [ ] **Step 7: Update `management-tools.test.ts` — remove `defaultPolicy`/`composeTools` tests, add `remove_tool_policy` tests**

Find and delete the test at lines 314–332 ("create_agent composes tools from defaultPolicy + toolPolicies").

Find and delete the test at lines 462–491 ("modify_agent with new defaultPolicy re-baselines all non-overridden tools").

Find the test at lines 364–399 ("modify_agent updates the collective record") which uses `defaultPolicy: 'deny'` and `toolPolicies`. Replace it with:

```ts
it('modify_agent replaces tools map when tools arg is provided', async () => {
  const { context, collective } = await makeContext();
  await createAgentTool.execute(
    {
      id: 'mod-agent',
      name: 'Before',
      systemPrompt: 'Original prompt.',
      model: { model: 'gpt-4o' },
      tools: { communicate: 'auto', list_participants: 'auto' },
    },
    context,
  );
  const result = await modifyAgentTool.execute(
    {
      id: 'mod-agent',
      name: 'After',
      model: { model: 'claude-3' },
      systemPrompt: 'Updated prompt.',
      maxIterations: 10,
      tools: { communicate: 'requires_approval' },
    },
    context,
  );
  expect(result.status).toBe('success');

  const p = collective.get('mod-agent') as any;
  expect(p.name).toBe('After');
  expect(p.model).toEqual({ model: 'claude-3' });
  expect(p.systemPrompt).toBe('Updated prompt.');
  expect(p.maxIterations).toBe(10);
  expect(p.tools['communicate']).toBe('requires_approval');
  expect(p.tools['list_participants']).toBeUndefined(); // replaced, not merged
});
```

Find the test at lines 335–362 ("updates model and systemPrompt") which uses `defaultPolicy: 'auto'`. Replace the `create_agent` call's args:

```ts
// Change:
defaultPolicy: 'auto',
// To:
tools: {},
```

Find the test at lines 364–376 ("modify_agent updates the collective record") which uses `defaultPolicy: 'auto'`. Replace that create call's args similarly:

```ts
// Change:
defaultPolicy: 'auto',
// To:
tools: {},
```

Add `remove_tool_policy` tests. Find the end of the `modify_agent` describe block and add a new describe block after it:

```ts
describe('remove_tool_policy', () => {
  it('removes a tool entry from the participant tools map', async () => {
    const deps = await buildTestDeps({});
    await invokeManagementTool(
      'create_agent',
      {
        id: 'policy-bot',
        name: 'Policy Bot',
        systemPrompt: 'test',
        model: { model: 'gpt-4o' },
        tools: { communicate: 'auto', list_participants: 'requires_approval' },
      },
      deps,
    );
    const result = await invokeManagementTool(
      'remove_tool_policy',
      { participantId: 'policy-bot', tool: 'communicate' },
      deps,
    );
    expect((result as { status: string }).status).toBe('success');
    const p = deps.collective.get('policy-bot') as any;
    expect(p.tools['communicate']).toBeUndefined();
    expect(p.tools['list_participants']).toBe('requires_approval'); // untouched
  });

  it('removing a non-existent tool entry is a no-op (succeeds)', async () => {
    const deps = await buildTestDeps({});
    await invokeManagementTool(
      'create_agent',
      {
        id: 'policy-bot-2',
        name: 'Policy Bot 2',
        systemPrompt: 'test',
        model: { model: 'gpt-4o' },
        tools: {},
      },
      deps,
    );
    const result = await invokeManagementTool(
      'remove_tool_policy',
      { participantId: 'policy-bot-2', tool: 'nonexistent' },
      deps,
    );
    expect((result as { status: string }).status).toBe('success');
  });
});
```

- [ ] **Step 8: Run management-tools tests**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts
git commit -m "refactor(tools): remove composeTools/defaultPolicy; add remove_tool_policy tool"
```

---

### Task 6: Update `default-participants.ts` — add `remove_tool_policy`

**Files:**

- Modify: `packages/core/src/collective/default-participants.ts:5-25`
- Modify: `packages/core/src/collective/default-participants.test.ts`

- [ ] **Step 1: Add `remove_tool_policy` to `MANAGEMENT_TOOLS`**

In `packages/core/src/collective/default-participants.ts`, find the `MANAGEMENT_TOOLS` array. Add `'remove_tool_policy'` after `'set_tool_policy'`:

```ts
const MANAGEMENT_TOOLS = [
  'communicate',
  'create_agent',
  'modify_agent',
  'retire_agent',
  'list_participants',
  'get_participant',
  'list_tools',
  'list_conversations',
  'get_conversation',
  'delete_conversation',
  'set_tool_policy',
  'remove_tool_policy',
  'set_credential',
  'approval_response',
  // runtime / config tools (registered by WebConnector layer)
  'list_providers',
  'save_provider',
  'delete_provider',
  'list_models',
  'get_routing',
  'save_routing',
] as const;
```

- [ ] **Step 2: Assert `remove_tool_policy: 'auto'` in the test**

In `packages/core/src/collective/default-participants.test.ts`, find the existing `it('grants the operator the web connector identity and management tools'` test block and add an assertion:

```ts
expect(operator.tools['remove_tool_policy']).toBe('auto');
```

alongside the existing `expect(operator.tools['set_tool_policy']).toBe('auto')` assertion (or similar nearby assertion).

- [ ] **Step 3: Run the test**

```bash
npx vitest run packages/core/src/collective/default-participants.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/collective/default-participants.ts packages/core/src/collective/default-participants.test.ts
git commit -m "feat(collective): add remove_tool_policy to operator management tools"
```

---

### Task 7: Update frontend — `ToolPolicyEditor.vue` and `ParticipantSlideOver.vue`

**Files:**

- Modify: `packages/web/src/components/participants/ToolPolicyEditor.vue`
- Modify: `packages/web/src/components/participants/ParticipantSlideOver.vue`

- [ ] **Step 1: Rewrite `ToolPolicyEditor.vue`**

Replace the entire file:

```vue
<script setup lang="ts">
import { computed } from 'vue';

export interface ToolOverride {
  tool: string;
  source: string;
  enabled: boolean;
  requireApproval: boolean;
}

const props = defineProps<{
  overrides: ToolOverride[];
  availableTools: string[];
}>();

const emit = defineEmits<{
  'update:overrides': [value: ToolOverride[]];
}>();

// Build a unified list: every available tool, with its current state
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
    // Remove from overrides entirely — absent = hidden
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
</script>

<template>
  <div class="space-y-1 p-5">
    <p class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold mb-3">
      Tool access
    </p>
    <div
      v-for="{ tool, override } in rows"
      :key="tool"
      data-tool-row
      class="flex items-center gap-2 py-1.5 border-b border-navy-900"
    >
      <input
        type="checkbox"
        :checked="override?.enabled ?? false"
        @change="setEnabled(tool, !override?.enabled)"
        class="accent-cyan-400"
      />
      <span
        :class="[
          'flex-1 font-mono text-xs',
          override?.enabled ? 'text-slate-100' : 'text-navy-500',
        ]"
      >
        {{ tool }}
      </span>
      <button
        v-if="override?.enabled"
        @click="toggleApproval(tool)"
        :class="[
          'text-[9px] px-2 py-0.5 rounded border transition-colors',
          override.requireApproval
            ? 'bg-amber-400/10 border-amber-400/30 text-amber-400'
            : 'border-navy-600 text-navy-500',
        ]"
      >
        require approval
      </button>
    </div>
    <p v-if="availableTools.length === 0" class="text-[10px] text-navy-600 italic py-2">
      No tools registered.
    </p>
  </div>
</template>
```

Key changes from prior version:

- Removed "Default policy" selector and `defaultPolicy` prop
- Removed "add tool override" select — every available tool is listed
- Unchecking a tool removes it from overrides entirely (absent = hidden), not just marks `enabled: false`
- `ToolOverride` interface unchanged (`enabled` + `requireApproval`)

- [ ] **Step 2: Update `ParticipantSlideOver.vue`**

Remove `defaultPolicy` ref (line 24) and its type. Find:

```ts
const defaultPolicy = ref<'allow' | 'require-approval' | 'deny'>('allow');
```

Delete this line entirely.

Remove the policy-count inference block inside the `watch` callback. Find lines 55–83:

```ts
const tools = (p.tools as Record<string, string>) ?? {};
const toolEntries = Object.entries(tools);
const policyCounts: Record<string, number> = {};
for (const [, policy] of toolEntries) {
  const uiPolicy =
    policy === 'auto' ? 'allow' : policy === 'requires_approval' ? 'require-approval' : 'deny';
  policyCounts[uiPolicy] = (policyCounts[uiPolicy] ?? 0) + 1;
}
const sorted = Object.entries(policyCounts).sort((a, b) => b[1] - a[1]);
defaultPolicy.value = (sorted[0]?.[0] as 'allow' | 'require-approval' | 'deny') ?? 'allow';

const defaultRuntime =
  defaultPolicy.value === 'allow'
    ? 'auto'
    : defaultPolicy.value === 'require-approval'
      ? 'requires_approval'
      : 'deny';
overrides.value = toolEntries
  .filter(([, policy]) => policy !== defaultRuntime)
  .map(([tool, policy]) => ({
    tool,
    source: 'built-in',
    enabled: policy !== 'deny',
    requireApproval: policy === 'requires_approval',
  }));
```

Replace with:

```ts
const tools = (p.tools as Record<string, string>) ?? {};
overrides.value = Object.entries(tools).map(([tool, policy]) => ({
  tool,
  source: 'built-in',
  enabled: true,
  requireApproval: policy === 'requires_approval',
}));
```

All entries in the tools map are enabled (they're in the map). Their `requireApproval` reflects `requires_approval` vs `auto`.

Update the new agent fallback (lines 88–95) — remove `defaultPolicy.value = 'allow'`:

```ts
    } else {
      name.value = '';
      model.value = '';
      selectedModel.value = '';
      systemPrompt.value = '';
      maxIterations.value = 20;
      overrides.value = [];
    }
```

Update the `save()` function. Replace the `toolPolicies` and `defaultPolicy` usage in `execute('modify_agent', ...)` and `execute('create_agent', ...)`:

```ts
async function save() {
  saving.value = true;
  try {
    const tools = Object.fromEntries(
      overrides.value
        .filter((o) => o.enabled)
        .map((o) => [o.tool, o.requireApproval ? 'requires_approval' : 'auto']),
    );
    if (props.participantId) {
      await execute('modify_agent', {
        id: props.participantId,
        name: name.value,
        model: { model: selectedModel.value || model.value },
        systemPrompt: systemPrompt.value,
        maxIterations: maxIterations.value,
        tools,
      });
    } else {
      const id =
        name.value
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-]/g, '') || `agent-${Date.now()}`;
      await execute('create_agent', {
        id,
        name: name.value,
        systemPrompt: systemPrompt.value || 'You are a helpful agent.',
        model: { model: selectedModel.value || model.value },
        tools,
      });
    }
    emit('saved');
    emit('close');
  } finally {
    saving.value = false;
  }
}
```

Update the `ToolPolicyEditor` binding in the template — remove `default-policy` and `@update:default-policy` props:

```vue
<ToolPolicyEditor
  v-else
  :overrides="overrides"
  :available-tools="availableTools"
  @update:overrides="(v) => (overrides = v)"
/>
```

- [ ] **Step 3: Run web tests**

```bash
npm run test --workspace=packages/web
```

Expected: all tests pass. (No direct tests for `ToolPolicyEditor` or `ParticipantSlideOver` exist — but the build should be clean.)

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/participants/ToolPolicyEditor.vue packages/web/src/components/participants/ParticipantSlideOver.vue
git commit -m "feat(web): remove defaultPolicy selector; show per-tool checkboxes in ToolPolicyEditor"
```

---

### Task 8: Full test suite + typecheck

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run web tests**

```bash
npm run test --workspace=packages/web
```

Expected: all tests pass.

- [ ] **Step 3: Run format check**

```bash
npm run format:check
```

If it fails, run `npm run format` and re-check.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit any format fixes**

```bash
git add -A
git commit -m "style: apply formatter"
```

(Only if format fixes were needed.)

---

### Task 9: Update live workspace participant configs

**Files:**

- Modify: `.legion/collective/participants/assistant.json`
- Modify: `.legion/collective/participants/operator.json` (already has no `deny` entries — verify only)

The live workspace participant configs may have `deny` entries from old snapshots. The `tools` map values must all be `'auto'` or `'requires_approval'` after this change.

- [ ] **Step 1: Check for `deny` entries**

```bash
grep -r '"deny"' .legion/collective/participants/
```

Expected: no matches (per earlier investigation, neither config uses `deny`). If any appear, replace them by removing the entry entirely (absent = hidden).

- [ ] **Step 2: Verify `operator.json` has `remove_tool_policy`**

Check `.legion/collective/participants/operator.json` — the `tools` map was seeded before `remove_tool_policy` existed. Add it:

Open the file and verify `"remove_tool_policy": "auto"` is present. If not, add it alongside `"set_tool_policy": "auto"`.

- [ ] **Step 3: Commit**

```bash
git add .legion/collective/participants/
git commit -m "chore: update live participant configs — add remove_tool_policy to operator"
```

---

### Task 10: Update documentation

**Files:**

- Modify: `docs/legion-v2-greenfield-spec.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-02-chat-interface-bugfixes-design.md`

- [ ] **Step 1: Update `docs/legion-v2-greenfield-spec.md` §7**

Find the `AuthEngine.authorize` code block (around line 434):

```
  //   'auto'              → { authorized: true }
  //   'deny'              → { authorized: false }
  //   'requires_approval' → { authorized: false } — must be approved by someone with authority
```

Replace with:

```
  //   'auto'              → { authorized: true }
  //   'requires_approval' → { authorized: false } — must be approved by someone with authority
  //   absent from map     → { authorized: false, reason: 'hidden' } — not visible to LLM
```

Find the policy resolution order line (line 445):

```
Policy resolution order: participant per-tool policy → engine per-tool policy → engine default → built-in default → fail-safe `requires_approval`.
```

Replace with:

```
Policy resolution: participant per-tool policy. Tools absent from the participant's `tools` map are hidden from the LLM and cannot be called.
```

- [ ] **Step 2: Update `AGENTS.md` line 14**

Find:

```
- **AuthEngine is a pure predicate** answering `auto` / `deny` / `requires_approval`. Approval bubbles up the call chain emergently to an authorized approver or boundary connector; fails closed if none.
```

Replace with:

```
- **AuthEngine is a pure predicate** answering `auto` / `requires_approval` / `hidden` (absent). Only tools explicitly listed in a participant's `tools` map are visible to the LLM. Approval bubbles up the call chain emergently to an authorized approver or boundary connector; fails closed if none.
```

- [ ] **Step 3: Update `README.md`**

Find the AuthEngine description (around line 14):

```
- **AuthEngine** — Pure policy resolver answering whether a tool call is `auto`, `deny`, or `requires_approval`. Approval requests bubble up the caller chain until it reaches an authorized approver or a boundary connector (which posts to the external human). If no authority is found, the call fails closed.
```

Replace with:

```
- **AuthEngine** — Pure policy resolver answering whether a tool call is `auto`, `requires_approval`, or `hidden` (absent from participant's tools map). Only tools explicitly listed in a participant's `tools` map are visible to the LLM. Approval requests bubble up the caller chain until reaching an authorized approver or boundary connector. If no authority is found, the call fails closed.
```

Find the policy resolution paragraph (around line 112) and update:

```
`AuthEngine` resolves tool policies through a priority chain: participant per-tool policy → engine default → built-in default → fail-safe `requires_approval`. When a call requires approval ...
```

Replace with:

```
`AuthEngine` resolves tool policies from the participant's `tools` map only. Tools absent from the map are hidden from the LLM entirely. When a call requires approval ...
```

- [ ] **Step 4: Note supersession in `2026-07-02-chat-interface-bugfixes-design.md`**

Find the `defaultPolicy` section (around lines 100–105) and add a note at the top of that section:

```markdown
> **Superseded:** The `defaultPolicy` parameter on `create_agent`/`modify_agent` and the UI "Default policy" selector have been removed as of the 2026-07-04 tool policy simplification (see `docs/superpowers/specs/2026-07-04-tool-policy-simplification-design.md`). The `tools` map is now the sole source of truth; absent tools are hidden.
```

- [ ] **Step 5: Commit**

```bash
git add docs/legion-v2-greenfield-spec.md AGENTS.md README.md docs/superpowers/specs/2026-07-02-chat-interface-bugfixes-design.md
git commit -m "docs: update AuthEngine vocabulary and policy resolution description"
```
