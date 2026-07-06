# User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full user management to the Legion UI — create, edit, set passwords, retire users — plus an Account screen for self-service password change, and approval authority editing for both users and agents.

**Architecture:** Three new backend tools (`create_user`, `modify_user`, `set_approval_authority`) mirror the existing agent tool pattern and land in `management-tools.ts`. The frontend gets type-dispatched slide-overs (`AgentSlideOver.vue`, `UserSlideOver.vue`) and a shared `ApprovalAuthorityEditor.vue` component, plus a new `AccountView.vue` route. `set_credential` gains a min-length guard.

**Tech Stack:** TypeScript (NodeNext ESM), Vitest, Vue 3 Composition API, `@vue/test-utils`, Tailwind CSS.

---

## File Map

**Modified (backend):**
- `packages/core/src/tools/management-tools.ts` — add `createUserTool`, `modifyUserTool`, `setApprovalAuthorityTool`; update `setCredentialTool` min-length; add all three to `managementTools` array
- `packages/core/src/tools/management-tools.test.ts` — update `'hunter2'` (7 chars) → `'hunter2!'` (8 chars); add describe blocks for all three new tools + min-length test
- `packages/core/src/collective/default-participants.ts` — add `create_user`, `modify_user`, `set_approval_authority` to `MANAGEMENT_TOOLS`

**Modified (frontend):**
- `packages/web/src/components/participants/ParticipantSlideOver.vue` → **rename** to `AgentSlideOver.vue`; add Approval authority tab
- `packages/web/src/views/ParticipantsView.vue` — Type column, "+ New user" / "+ New agent" buttons, type-dispatched slide-overs
- `packages/web/src/router/index.ts` — add `/account` route
- `packages/web/src/components/layout/AppSidebar.vue` — add Account nav entry

**Created (frontend):**
- `packages/web/src/components/participants/ApprovalAuthorityEditor.vue`
- `packages/web/src/components/participants/ApprovalAuthorityEditor.test.ts`
- `packages/web/src/components/participants/UserSlideOver.vue`
- `packages/web/src/components/participants/UserSlideOver.test.ts`
- `packages/web/src/views/AccountView.vue`

---

## Task 1: `set_credential` min-length validation

**Files:**
- Modify: `packages/core/src/tools/management-tools.ts`
- Modify: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Open `packages/core/src/tools/management-tools.test.ts`. Find the `set_credential hashes and stores a participant secret` test. Below the existing two `set_credential` tests, add:

```typescript
it('set_credential rejects secrets shorter than 8 characters', async () => {
  const { context } = await makeContext();
  const credentialStore = new FileCredentialStore(new MemoryStorage());
  const ctx = { ...context, credentialStore } as unknown as ToolContext;
  const result = await setCredentialTool.execute(
    { participantId: 'operator', secret: 'short' },
    ctx,
  );
  expect(result.status).toBe('error');
  expect(result.error).toMatch(/8 characters/);
});
```

Also update the existing passing test — `'hunter2'` is 7 chars and will fail after the guard is added. Change it to `'hunter2!'` (8 chars) in both the execute call and the verify call:

```typescript
it('set_credential hashes and stores a participant secret', async () => {
  const { context } = await makeContext();
  const credentialStore = new FileCredentialStore(new MemoryStorage());
  const ctx = { ...context, credentialStore } as unknown as ToolContext;
  const result = await setCredentialTool.execute(
    { participantId: 'operator', secret: 'hunter2!' },
    ctx,
  );
  expect(result.status).toBe('success');
  expect(await credentialStore.verify('operator', 'hunter2!')).toBe(true);
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "set_credential rejects"
```

Expected: FAIL (guard not implemented yet).

- [ ] **Step 3: Add the guard to `setCredentialTool.execute`**

In `packages/core/src/tools/management-tools.ts`, find `setCredentialTool`. After the `credentialStore` availability check, add the length guard:

```typescript
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
    if (secret.length < 8) {
      return { status: 'error', error: 'Password must be at least 8 characters' };
    }
    try {
      await context.credentialStore.setCredential(participantId, secret);
      return { status: 'success', data: { participantId } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 4: Run all set_credential tests**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "set_credential"
```

Expected: all 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts
git commit -m "feat(core): set_credential minimum 8-character password guard"
```

---

## Task 2: `create_user` tool

**Files:**
- Modify: `packages/core/src/tools/management-tools.ts`
- Modify: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Update imports in `management-tools.ts`**

Find the top import line:
```typescript
import type { JSONSchema, ToolPolicy, ToolResult, AgentConfig, ModelConfig } from '@legion/types';
```

Replace with:
```typescript
import type {
  JSONSchema,
  ToolPolicy,
  ToolResult,
  AgentConfig,
  ModelConfig,
  UserConfig,
  ConnectorIdentity,
  ApprovalAuthority,
} from '@legion/types';
```

- [ ] **Step 2: Write the failing tests**

In `packages/core/src/tools/management-tools.test.ts`, add this import at the top (alongside the existing tool imports):

```typescript
import {
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  getConversationTool,
  setToolPolicyTool,
  removeToolPolicyTool,
  setCredentialTool,
  modifyAgentTool,
  listConversationsTool,
  deleteConversationTool,
  queryUsageTool,
  listModelsTool,
  createUserTool,
  modifyUserTool,
  setApprovalAuthorityTool,
  managementTools,
} from './management-tools.js';
```

Add a new describe block after the existing `describe('remove_tool_policy', ...)` block:

```typescript
describe('create_user', () => {
  it('adds a user participant with type user and status active', async () => {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute(
      { id: 'alice', name: 'Alice' },
      context,
    );
    expect(result.status).toBe('success');
    const p = collective.get('alice');
    expect(p?.type).toBe('user');
    expect(p?.status).toBe('active');
  });

  it('auto-populates web identity when identities omitted', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'bob', name: 'Bob' }, context);
    const p = collective.get('bob');
    expect(p?.identities).toEqual([{ connector: 'web', externalId: 'bob' }]);
  });

  it('respects provided identities', async () => {
    const { context, collective } = await makeContext();
    const identities = [{ connector: 'teams', externalId: 'bob@example.com' }];
    await createUserTool.execute({ id: 'bob', name: 'Bob', identities }, context);
    expect(collective.get('bob')?.identities).toEqual(identities);
  });

  it('sets protected: false always', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'carol', name: 'Carol' }, context);
    expect((collective.get('carol') as any).protected).toBe(false);
  });

  it('defaults operator to false and tools to {}', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'dave', name: 'Dave' }, context);
    const p = collective.get('dave');
    expect(p?.operator).toBe(false);
    expect(p?.tools).toEqual({});
  });

  it('rejects duplicate id', async () => {
    const { context } = await makeContext();
    const result = await createUserTool.execute({ id: 'operator', name: 'Dup' }, context);
    expect(result.status).toBe('error');
  });

  it('rejects duplicate name (case-insensitive)', async () => {
    const { context } = await makeContext();
    // 'operator' participant already exists with name 'Operator'
    const result = await createUserTool.execute({ id: 'new-op', name: 'operator' }, context);
    expect(result.status).toBe('error');
    expect((result as any).error).toMatch(/Name already in use/);
  });

  it('stores approvalAuthority when provided', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute(
      { id: 'eve', name: 'Eve', approvalAuthority: { tools: '*', participants: '*' } },
      context,
    );
    expect((collective.get('eve') as any).approvalAuthority).toEqual({
      tools: '*',
      participants: '*',
    });
  });
});
```

- [ ] **Step 3: Run tests to confirm failure**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "create_user"
```

Expected: FAIL with "createUserTool is not exported" or similar.

- [ ] **Step 4: Implement `createUserTool`**

In `packages/core/src/tools/management-tools.ts`, add after `setCredentialTool` (before `modifyAgentTool`):

```typescript
export const createUserTool: Tool = {
  name: 'create_user',
  description: 'Create a new user participant in the collective.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      tools: {
        type: 'object',
        description: 'Map of tool name to policy (auto or requires_approval).',
      },
      operator: { type: 'boolean' },
      approvalAuthority: {
        type: 'object',
        properties: {
          tools: {},
          participants: {},
        },
      },
      identities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            connector: { type: 'string' },
            externalId: { type: 'string' },
          },
          required: ['connector', 'externalId'],
        },
      },
    },
    required: ['id', 'name'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { id, name, tools, operator, approvalAuthority, identities } = args as {
      id: string;
      name: string;
      tools?: Record<string, ToolPolicy>;
      operator?: boolean;
      approvalAuthority?: ApprovalAuthority;
      identities?: ConnectorIdentity[];
    };
    try {
      const collective = requireCollective(context);
      const nameCollision = collective
        .listActive()
        .find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (nameCollision) {
        return { status: 'error', error: 'Name already in use' };
      }
      const config: UserConfig = {
        id,
        name,
        type: 'user',
        tools: tools ?? {},
        operator: operator ?? false,
        protected: false,
        status: 'active',
        identities: identities ?? [{ connector: 'web', externalId: id }],
        ...(approvalAuthority !== undefined ? { approvalAuthority } : {}),
      };
      await collective.add(config);
      return { status: 'success', data: { id } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "create_user"
```

Expected: all 8 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts
git commit -m "feat(core): add create_user management tool"
```

---

## Task 3: `modify_user` tool

**Files:**
- Modify: `packages/core/src/tools/management-tools.ts`
- Modify: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/management-tools.test.ts`, add after the `describe('create_user', ...)` block:

```typescript
describe('modify_user', () => {
  async function makeUser(context: ToolContext, id: string, name: string) {
    await createUserTool.execute({ id, name }, context);
  }

  it('updates name', async () => {
    const { context, collective } = await makeContext();
    await makeUser(context, 'alice', 'Alice');
    const result = await modifyUserTool.execute({ id: 'alice', name: 'Alicia' }, context);
    expect(result.status).toBe('success');
    expect(collective.get('alice')?.name).toBe('Alicia');
  });

  it('updates tools map', async () => {
    const { context, collective } = await makeContext();
    await makeUser(context, 'alice', 'Alice');
    await modifyUserTool.execute(
      { id: 'alice', tools: { communicate: 'auto' } },
      context,
    );
    expect(collective.get('alice')?.tools['communicate']).toBe('auto');
  });

  it('updates operator flag', async () => {
    const { context, collective } = await makeContext();
    await makeUser(context, 'alice', 'Alice');
    await modifyUserTool.execute({ id: 'alice', operator: true }, context);
    expect(collective.get('alice')?.operator).toBe(true);
  });

  it('updates approvalAuthority', async () => {
    const { context, collective } = await makeContext();
    await makeUser(context, 'alice', 'Alice');
    await modifyUserTool.execute(
      { id: 'alice', approvalAuthority: { tools: '*', participants: '*' } },
      context,
    );
    expect((collective.get('alice') as any).approvalAuthority).toEqual({
      tools: '*',
      participants: '*',
    });
  });

  it('updates identities', async () => {
    const { context, collective } = await makeContext();
    await makeUser(context, 'alice', 'Alice');
    const identities = [{ connector: 'teams', externalId: 'alice@corp.com' }];
    await modifyUserTool.execute({ id: 'alice', identities }, context);
    expect(collective.get('alice')?.identities).toEqual(identities);
  });

  it('rejects when participant is not a user', async () => {
    const { context } = await makeContext();
    // 'operator' exists but is type 'user', so create an agent to test
    await createAgentTool.execute(
      { id: 'my-agent', name: 'MyAgent', systemPrompt: 's', model: { model: 'm' }, tools: {} },
      context,
    );
    const result = await modifyUserTool.execute({ id: 'my-agent', name: 'Renamed' }, context);
    expect(result.status).toBe('error');
    expect((result as any).error).toMatch(/is not a user/);
  });

  it('rejects name collision with another participant', async () => {
    const { context } = await makeContext();
    await makeUser(context, 'alice', 'Alice');
    await makeUser(context, 'bob', 'Bob');
    const result = await modifyUserTool.execute({ id: 'alice', name: 'bob' }, context);
    expect(result.status).toBe('error');
    expect((result as any).error).toMatch(/Name already in use/);
  });

  it('cannot set protected: true', async () => {
    const { context, collective } = await makeContext();
    await makeUser(context, 'alice', 'Alice');
    await modifyUserTool.execute({ id: 'alice', protected: true } as any, context);
    expect((collective.get('alice') as any).protected).toBe(false);
  });

  it('returns error for non-existent id', async () => {
    const { context } = await makeContext();
    const result = await modifyUserTool.execute({ id: 'ghost' }, context);
    expect(result.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "modify_user"
```

Expected: FAIL (tool not implemented).

- [ ] **Step 3: Implement `modifyUserTool`**

In `packages/core/src/tools/management-tools.ts`, add after `createUserTool` (before `modifyAgentTool`):

```typescript
export const modifyUserTool: Tool = {
  name: 'modify_user',
  description:
    'Update an existing user — name, tools, operator flag, approval authority, identities.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
      name: { type: 'string' },
      tools: {
        type: 'object',
        description:
          'Full replacement tools map. Omit to keep existing. Pass {} to clear all tool access.',
      },
      operator: { type: 'boolean' },
      approvalAuthority: {
        type: 'object',
        properties: { tools: {}, participants: {} },
      },
      identities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            connector: { type: 'string' },
            externalId: { type: 'string' },
          },
          required: ['connector', 'externalId'],
        },
      },
    },
    required: ['id'],
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    const { id, name, tools, operator, approvalAuthority, identities } = args as {
      id: string;
      name?: string;
      tools?: Record<string, ToolPolicy>;
      operator?: boolean;
      approvalAuthority?: ApprovalAuthority;
      identities?: ConnectorIdentity[];
      protected?: boolean;
    };
    try {
      const collective = requireCollective(context);
      const existing = collective.get(id);
      if (!existing) return { status: 'error', error: `Participant not found: ${id}` };
      if (existing.type !== 'user')
        return { status: 'error', error: `Participant ${id} is not a user` };

      if (name !== undefined && name.toLowerCase() !== existing.name.toLowerCase()) {
        const nameCollision = collective
          .listActive()
          .find((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase());
        if (nameCollision) return { status: 'error', error: 'Name already in use' };
      }

      const patch: Partial<UserConfig> = {};
      if (name !== undefined) patch.name = name;
      if (tools !== undefined) patch.tools = tools;
      if (operator !== undefined) patch.operator = operator;
      if (identities !== undefined) patch.identities = identities;
      if (approvalAuthority !== undefined) patch.approvalAuthority = approvalAuthority;
      // protected is never settable via tool — not included in patch

      await collective.update(id, patch);
      return { status: 'success', data: collective.getOrThrow(id) };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "modify_user"
```

Expected: all 9 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts
git commit -m "feat(core): add modify_user management tool"
```

---

## Task 4: `set_approval_authority` tool

**Files:**
- Modify: `packages/core/src/tools/management-tools.ts`
- Modify: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/management-tools.test.ts`, add after `describe('modify_user', ...)`:

```typescript
describe('set_approval_authority', () => {
  it('sets authority on a user', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: { tools: '*', participants: '*' } },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('alice') as any).approvalAuthority).toEqual({
      tools: '*',
      participants: '*',
    });
  });

  it('sets authority on an agent', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      { id: 'bot', name: 'Bot', systemPrompt: 's', model: { model: 'm' }, tools: {} },
      context,
    );
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'bot', authority: { tools: '*', participants: '*' } },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('bot') as any).approvalAuthority).toEqual({
      tools: '*',
      participants: '*',
    });
  });

  it('clears authority when passed null', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute(
      { id: 'alice', name: 'Alice', approvalAuthority: { tools: '*', participants: '*' } },
      context,
    );
    expect((collective.get('alice') as any).approvalAuthority).toBeDefined();
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: null },
      context,
    );
    expect(result.status).toBe('success');
    // After clearing, approvalAuthority should be absent / undefined
    expect((collective.get('alice') as any).approvalAuthority).toBeUndefined();
  });

  it('rejects non-existent participant', async () => {
    const { context } = await makeContext();
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'ghost', authority: { tools: '*', participants: '*' } },
      context,
    );
    expect(result.status).toBe('error');
  });

  it('rejects malformed authority shape', async () => {
    const { context } = await makeContext();
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'operator', authority: { bad: 'shape' } },
      context,
    );
    expect(result.status).toBe('error');
    expect((result as any).error).toMatch(/tools.*participants/i);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "set_approval_authority"
```

Expected: FAIL (tool not implemented).

- [ ] **Step 3: Implement `setApprovalAuthorityTool`**

In `packages/core/src/tools/management-tools.ts`, add after `modifyUserTool`:

```typescript
export const setApprovalAuthorityTool: Tool = {
  name: 'set_approval_authority',
  description:
    "Set or clear a participant's approval authority. Works on any participant type (users and agents).",
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      authority: {
        description:
          'Approval authority to set ({ tools, participants } where each can be "*"), or null to clear.',
      },
    },
    required: ['participantId', 'authority'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { participantId, authority } = args as {
      participantId: string;
      authority: unknown;
    };
    try {
      const collective = requireCollective(context);
      const existing = collective.get(participantId);
      if (!existing) return { status: 'error', error: `Participant not found: ${participantId}` };

      if (authority !== null) {
        if (
          typeof authority !== 'object' ||
          authority === null ||
          typeof (authority as Record<string, unknown>).tools === 'undefined' ||
          typeof (authority as Record<string, unknown>).participants === 'undefined'
        ) {
          return {
            status: 'error',
            error: 'authority must have "tools" and "participants" fields, or be null to clear',
          };
        }
      }

      if (authority === null) {
        // Spread undefined to clear: JSON.stringify omits undefined keys
        await collective.update(participantId, {
          approvalAuthority: undefined,
        } as Partial<typeof existing>);
      } else {
        await collective.update(participantId, {
          approvalAuthority: authority as ApprovalAuthority,
        });
      }

      return { status: 'success', data: { participantId } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts -t "set_approval_authority"
```

Expected: all 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts
git commit -m "feat(core): add set_approval_authority management tool"
```

---

## Task 5: Register new tools

**Files:**
- Modify: `packages/core/src/tools/management-tools.ts`
- Modify: `packages/core/src/collective/default-participants.ts`

- [ ] **Step 1: Add tools to `managementTools` array**

In `packages/core/src/tools/management-tools.ts`, find the `managementTools` array and add the three new tools:

```typescript
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
  createUserTool,
  modifyUserTool,
  setApprovalAuthorityTool,
];
```

(Keep any other tools that are already there — `queryUsageTool`, `listModelsTool`, etc. — exactly as they are. Only append the three new ones at the end.)

- [ ] **Step 2: Add to `MANAGEMENT_TOOLS` in `default-participants.ts`**

In `packages/core/src/collective/default-participants.ts`, find `MANAGEMENT_TOOLS` and add:

```typescript
const MANAGEMENT_TOOLS = [
  'communicate',
  'create_agent',
  'modify_agent',
  'retire_agent',
  'create_user',
  'modify_user',
  'set_approval_authority',
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

- [ ] **Step 3: Run all management-tools tests**

```bash
npx vitest run packages/core/src/tools/management-tools.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Run default-participants test**

```bash
npx vitest run packages/core/src/collective/default-participants.test.ts
```

Expected: all PASS. If the test checks for exact tool count, update it to include the 3 new tools.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/collective/default-participants.ts
git commit -m "feat(core): register create_user, modify_user, set_approval_authority for operator"
```

---

## Task 6: `ApprovalAuthorityEditor.vue` component

**Files:**
- Create: `packages/web/src/components/participants/ApprovalAuthorityEditor.vue`
- Create: `packages/web/src/components/participants/ApprovalAuthorityEditor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/participants/ApprovalAuthorityEditor.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ApprovalAuthorityEditor from './ApprovalAuthorityEditor.vue';

describe('ApprovalAuthorityEditor', () => {
  it('renders unchecked when authority is null', () => {
    const w = mount(ApprovalAuthorityEditor, { props: { authority: null } });
    const checkbox = w.find('input[type=checkbox]');
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
  });

  it('renders checked when authority is full wildcard', () => {
    const w = mount(ApprovalAuthorityEditor, {
      props: { authority: { tools: '*', participants: '*' } },
    });
    const checkbox = w.find('input[type=checkbox]');
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
  });

  it('emits update:authority with full wildcard when checked', async () => {
    const w = mount(ApprovalAuthorityEditor, { props: { authority: null } });
    await w.find('input[type=checkbox]').setValue(true);
    const emitted = w.emitted('update:authority');
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toEqual({ tools: '*', participants: '*' });
  });

  it('emits update:authority with null when unchecked', async () => {
    const w = mount(ApprovalAuthorityEditor, {
      props: { authority: { tools: '*', participants: '*' } },
    });
    await w.find('input[type=checkbox]').setValue(false);
    const emitted = w.emitted('update:authority');
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npm run test --workspace=packages/web -- --reporter=verbose -t "ApprovalAuthorityEditor"
```

Expected: FAIL (component doesn't exist).

- [ ] **Step 3: Create `ApprovalAuthorityEditor.vue`**

Create `packages/web/src/components/participants/ApprovalAuthorityEditor.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { ApprovalAuthority } from '@legion/types';

const props = defineProps<{
  authority: ApprovalAuthority | null | undefined;
}>();

const emit = defineEmits<{
  'update:authority': [value: ApprovalAuthority | null];
}>();

const hasFullAuthority = computed(
  () => props.authority?.tools === '*' && props.authority?.participants === '*',
);

function toggle(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  emit('update:authority', checked ? { tools: '*', participants: '*' } : null);
}
</script>

<template>
  <div class="p-5 space-y-4">
    <p class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold">
      Approval authority
    </p>
    <p class="text-[10px] text-navy-500">
      Approval authority allows this participant to approve tool calls on behalf of others.
    </p>
    <label class="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        :checked="hasFullAuthority"
        @change="toggle"
        class="accent-cyan-400"
      />
      <span class="text-xs text-slate-200">Full approval authority (all tools, all participants)</span>
    </label>
    <p v-if="hasFullAuthority" class="text-[10px] text-cyan-400">
      This participant can approve any tool call from any participant.
    </p>
    <p v-else class="text-[10px] text-navy-600 italic">
      No approval authority configured.
    </p>
  </div>
</template>
```

- [ ] **Step 4: Run tests**

```bash
npm run test --workspace=packages/web -- --reporter=verbose -t "ApprovalAuthorityEditor"
```

Expected: all 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/participants/ApprovalAuthorityEditor.vue \
        packages/web/src/components/participants/ApprovalAuthorityEditor.test.ts
git commit -m "feat(web): add ApprovalAuthorityEditor shared component"
```

---

## Task 7: Rename `ParticipantSlideOver.vue` → `AgentSlideOver.vue` + add Approval authority tab

**Files:**
- Rename: `packages/web/src/components/participants/ParticipantSlideOver.vue` → `AgentSlideOver.vue`
- Modify: `packages/web/src/views/ParticipantsView.vue` (import path update — full rewrite happens in Task 9; just fix the import for now)

- [ ] **Step 1: Rename the file**

```bash
mv packages/web/src/components/participants/ParticipantSlideOver.vue \
   packages/web/src/components/participants/AgentSlideOver.vue
```

- [ ] **Step 2: Update the import in `ParticipantsView.vue`**

In `packages/web/src/views/ParticipantsView.vue`, change:
```typescript
import ParticipantSlideOver from '../components/participants/ParticipantSlideOver.vue';
```
to:
```typescript
import AgentSlideOver from '../components/participants/AgentSlideOver.vue';
```

Also update the template usage — change `<ParticipantSlideOver` to `<AgentSlideOver` and `</ParticipantSlideOver>` to `</AgentSlideOver>`.

- [ ] **Step 3: Add Approval authority tab to `AgentSlideOver.vue`**

Replace the entire content of `packages/web/src/components/participants/AgentSlideOver.vue` with:

```vue
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import SlideOver from '../common/SlideOver.vue';
import ToolPolicyEditor, { type ToolOverride } from './ToolPolicyEditor.vue';
import ApprovalAuthorityEditor from './ApprovalAuthorityEditor.vue';
import { useExecute } from '../../composables/useExecute.js';
import type { ApprovalAuthority } from '@legion/types';

const props = defineProps<{
  open: boolean;
  participantId: string | null;
  availableTools: string[];
  availableModels: Array<{ id: string; name?: string; provider: string }>;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const tab = ref<'basic' | 'tools' | 'approval'>('basic');
const name = ref('');
const model = ref('');
const modelSearch = ref('');
const selectedModel = ref('');
const showModelDropdown = ref(false);
const systemPrompt = ref('');
const maxIterations = ref(20);
const overrides = ref<ToolOverride[]>([]);
const authority = ref<ApprovalAuthority | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

const filteredModels = computed(() =>
  props.availableModels.filter(
    (m) =>
      !modelSearch.value ||
      m.id.toLowerCase().includes(modelSearch.value.toLowerCase()) ||
      (m.name ?? '').toLowerCase().includes(modelSearch.value.toLowerCase()) ||
      m.provider.toLowerCase().includes(modelSearch.value.toLowerCase()),
  ),
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    tab.value = 'basic';
    saveError.value = null;
    if (props.participantId) {
      try {
        const p = await execute<Record<string, unknown>>('get_participant', {
          id: props.participantId,
        });
        name.value = (p.name as string) ?? '';
        const modelCfg = p.model as { model: string } | undefined;
        selectedModel.value = modelCfg?.model ?? '';
        model.value = modelCfg?.model ?? '';
        systemPrompt.value = (p.systemPrompt as string) ?? '';
        maxIterations.value = (p.maxIterations as number) ?? 20;
        const tools = (p.tools as Record<string, string>) ?? {};
        overrides.value = Object.entries(tools).map(([tool, policy]) => ({
          tool,
          source: 'built-in',
          enabled: true,
          requireApproval: policy === 'requires_approval',
        }));
        authority.value = (p.approvalAuthority as ApprovalAuthority | undefined) ?? null;
      } catch {
        // Fallback: empty form
      }
    } else {
      name.value = '';
      model.value = '';
      selectedModel.value = '';
      systemPrompt.value = '';
      maxIterations.value = 20;
      overrides.value = [];
      authority.value = null;
    }
  },
);

async function save() {
  saving.value = true;
  saveError.value = null;
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
      // modify_agent doesn't accept approvalAuthority; use dedicated tool
      await execute('set_approval_authority', {
        participantId: props.participantId,
        authority: authority.value,
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
      if (authority.value) {
        await execute('set_approval_authority', { participantId: id, authority: authority.value });
      }
    }
    emit('saved');
    emit('close');
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

async function retire() {
  if (!props.participantId) return;
  try {
    await execute('retire_agent', { id: props.participantId });
    emit('saved');
    emit('close');
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <SlideOver
    :open="open"
    :title="participantId ? 'Edit agent' : 'New agent'"
    @close="emit('close')"
  >
    <div class="flex border-b border-navy-600 bg-navy-900">
      <button
        v-for="t in ['basic', 'tools', 'approval'] as const"
        :key="t"
        @click="tab = t"
        :class="[
          'px-4 py-2 text-xs font-medium border-b-2 transition-colors',
          tab === t
            ? 'text-cyan-400 border-cyan-400'
            : 'text-navy-400 border-transparent hover:text-slate-200',
        ]"
      >
        {{ t === 'basic' ? 'Basic' : t === 'tools' ? 'Tool policies' : 'Approval authority' }}
      </button>
    </div>

    <div v-if="saveError" class="mx-5 mt-4 px-3 py-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400">
      {{ saveError }}
    </div>

    <div v-if="tab === 'basic'" class="p-5 space-y-4">
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Name</label>
        <input
          v-model="name"
          :readonly="!!participantId"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
        />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Model</label>
        <div v-if="selectedModel && !showModelDropdown" class="flex items-center gap-2">
          <span class="flex-1 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono">
            {{ selectedModel }}
          </span>
          <button
            @click="showModelDropdown = true; modelSearch = '';"
            class="text-[10px] text-navy-400 hover:text-slate-200 border border-navy-600 rounded px-2 py-1.5"
          >
            Change
          </button>
        </div>
        <div v-else class="space-y-1">
          <input
            v-model="modelSearch"
            placeholder="Search models… or type model ID"
            @focus="showModelDropdown = true"
            class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 font-mono outline-none focus:border-cyan-400/40"
          />
          <div v-if="showModelDropdown" class="border border-navy-600 rounded bg-navy-950 max-h-48 overflow-y-auto">
            <button
              v-if="modelSearch && !filteredModels.some((m) => m.id === modelSearch)"
              @click="selectedModel = modelSearch; model = modelSearch; showModelDropdown = false;"
              class="w-full text-left px-3 py-2 text-xs text-navy-400 hover:bg-navy-800 font-mono border-b border-navy-700"
            >
              Use "{{ modelSearch }}" (not in discovery list)
            </button>
            <button
              v-for="m in filteredModels"
              :key="m.id"
              @click="selectedModel = m.id; model = m.id; modelSearch = ''; showModelDropdown = false;"
              class="w-full text-left px-3 py-2 hover:bg-navy-800"
            >
              <span class="text-xs font-mono text-slate-100">{{ m.id }}</span>
              <span class="text-[10px] text-navy-500 ml-2">{{ m.provider }}</span>
            </button>
            <p v-if="filteredModels.length === 0 && !modelSearch" class="px-3 py-2 text-[10px] text-navy-600 italic">
              No models discovered. Configure providers first.
            </p>
          </div>
        </div>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">System prompt</label>
        <textarea
          v-model="systemPrompt"
          rows="6"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-xs text-slate-200 font-mono resize-none outline-none focus:border-cyan-400/40"
        />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Max iterations</label>
        <input
          v-model.number="maxIterations"
          type="number"
          class="w-20 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none"
        />
      </div>
    </div>

    <ToolPolicyEditor
      v-else-if="tab === 'tools'"
      :overrides="overrides"
      :available-tools="availableTools"
      @update:overrides="(v) => (overrides = v)"
    />

    <ApprovalAuthorityEditor
      v-else
      :authority="authority"
      @update:authority="(v) => (authority = v)"
    />

    <template #footer>
      <div class="flex items-center justify-between px-5 py-3">
        <button
          v-if="participantId"
          @click="retire"
          class="text-xs px-3 py-1.5 border border-red-900 text-red-400 rounded hover:border-red-700"
        >
          Retire agent
        </button>
        <div v-else />
        <div class="flex gap-2">
          <button
            @click="emit('close')"
            class="text-xs px-3 py-1.5 border border-navy-600 text-navy-400 rounded hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            @click="save"
            :disabled="saving"
            class="text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </template>
  </SlideOver>
</template>
```

- [ ] **Step 4: Verify web build compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/participants/AgentSlideOver.vue \
        packages/web/src/views/ParticipantsView.vue
git commit -m "feat(web): rename ParticipantSlideOver to AgentSlideOver, add approval authority tab"
```

---

## Task 8: `UserSlideOver.vue` + test

**Files:**
- Create: `packages/web/src/components/participants/UserSlideOver.vue`
- Create: `packages/web/src/components/participants/UserSlideOver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/participants/UserSlideOver.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import UserSlideOver from './UserSlideOver.vue';

const executeMock = vi.fn();

vi.mock('../../composables/useExecute.js', () => ({
  useExecute: () => ({ execute: executeMock }),
}));

vi.mock('../../composables/useAuth.js', () => ({
  useAuth: () => ({
    participantId: { value: 'operator' },
    getToken: () => 'tok',
    logout: vi.fn(),
    isAuthenticated: { value: true },
  }),
}));

const defaultUser = {
  id: 'alice',
  name: 'Alice',
  type: 'user',
  tools: {},
  operator: false,
  protected: false,
  status: 'active',
  identities: [{ connector: 'web', externalId: 'alice' }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UserSlideOver', () => {
  it('calls create_user on save when creating a new user', async () => {
    executeMock.mockResolvedValue({ id: 'new-user' });
    const w = mount(UserSlideOver, {
      props: {
        open: true,
        participantId: null,
        availableTools: [],
        allParticipants: [],
      },
    });
    await w.find('input[placeholder="Name"]').setValue('New User');
    await w.find('button.save-btn').trigger('click');
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledWith('create_user', expect.objectContaining({ name: 'New User' })));
  });

  it('calls modify_user on save when editing an existing user', async () => {
    executeMock.mockResolvedValue(defaultUser);
    const w = mount(UserSlideOver, {
      props: {
        open: true,
        participantId: 'alice',
        availableTools: [],
        allParticipants: [],
      },
    });
    // Wait for get_participant to be called on open
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledWith('get_participant', { id: 'alice' }));
    executeMock.mockResolvedValue({});
    await w.find('button.save-btn').trigger('click');
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledWith('modify_user', expect.objectContaining({ id: 'alice' })));
  });

  it('calls set_credential after save when password is filled', async () => {
    executeMock.mockResolvedValue(defaultUser);
    const w = mount(UserSlideOver, {
      props: {
        open: true,
        participantId: 'alice',
        availableTools: [],
        allParticipants: [],
      },
    });
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalled());
    executeMock.mockResolvedValue({});
    await w.find('input[type=password]').setValue('newpassword');
    await w.find('button.save-btn').trigger('click');
    await vi.waitFor(() =>
      expect(executeMock).toHaveBeenCalledWith('set_credential', {
        participantId: 'alice',
        secret: 'newpassword',
      }),
    );
  });

  it('does not call set_credential when password is blank on edit', async () => {
    executeMock.mockResolvedValue(defaultUser);
    const w = mount(UserSlideOver, {
      props: {
        open: true,
        participantId: 'alice',
        availableTools: [],
        allParticipants: [],
      },
    });
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledWith('get_participant', { id: 'alice' }));
    executeMock.mockClear();
    executeMock.mockResolvedValue({});
    await w.find('button.save-btn').trigger('click');
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalled());
    const credentialCall = executeMock.mock.calls.find((c) => c[0] === 'set_credential');
    expect(credentialCall).toBeUndefined();
  });

  it('hides retire button when participant is protected', async () => {
    executeMock.mockResolvedValue({ ...defaultUser, protected: true });
    const w = mount(UserSlideOver, {
      props: {
        open: true,
        participantId: 'operator',
        availableTools: [],
        allParticipants: [],
      },
    });
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledWith('get_participant', { id: 'operator' }));
    expect(w.find('[data-retire-btn]').exists()).toBe(false);
  });

  it('disables retire button when editing self', async () => {
    executeMock.mockResolvedValue(defaultUser);
    const w = mount(UserSlideOver, {
      props: {
        open: true,
        participantId: 'operator', // matches mocked participantId
        availableTools: [],
        allParticipants: [{ id: 'operator', name: 'Operator', type: 'user', status: 'active' }],
      },
    });
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalled());
    // retire button should be disabled when editing self
    const retireBtn = w.find('[data-retire-btn]');
    if (retireBtn.exists()) {
      expect((retireBtn.element as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npm run test --workspace=packages/web -- --reporter=verbose -t "UserSlideOver"
```

Expected: FAIL (component doesn't exist).

- [ ] **Step 3: Create `UserSlideOver.vue`**

Create `packages/web/src/components/participants/UserSlideOver.vue`:

```vue
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import SlideOver from '../common/SlideOver.vue';
import ToolPolicyEditor, { type ToolOverride } from './ToolPolicyEditor.vue';
import ApprovalAuthorityEditor from './ApprovalAuthorityEditor.vue';
import { useExecute } from '../../composables/useExecute.js';
import { useAuth } from '../../composables/useAuth.js';
import type { ApprovalAuthority, BaseParticipant } from '@legion/types';

const props = defineProps<{
  open: boolean;
  participantId: string | null;
  availableTools: string[];
  allParticipants: BaseParticipant[];
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();
const { participantId: selfId } = useAuth();

const tab = ref<'basic' | 'tools' | 'approval'>('basic');
const name = ref('');
const password = ref('');
const showPassword = ref(false);
const operator = ref(false);
const isProtected = ref(false);
const identities = ref<Array<{ connector: string; externalId: string }>>([]);
const overrides = ref<ToolOverride[]>([]);
const authority = ref<ApprovalAuthority | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

const isSelf = computed(() => props.participantId === selfId.value);

const isOnlyActiveOperator = computed(() => {
  if (!props.participantId) return false;
  const target = props.allParticipants.find((p) => p.id === props.participantId);
  if (!target?.operator) return false;
  const activeOperators = props.allParticipants.filter(
    (p) => p.operator && (p.status ?? 'active') === 'active',
  );
  return activeOperators.length === 1;
});

const canRetire = computed(
  () => !isProtected.value && !isSelf.value && !isOnlyActiveOperator.value,
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    tab.value = 'basic';
    saveError.value = null;
    password.value = '';
    if (props.participantId) {
      try {
        const p = await execute<Record<string, unknown>>('get_participant', {
          id: props.participantId,
        });
        name.value = (p.name as string) ?? '';
        operator.value = (p.operator as boolean) ?? false;
        isProtected.value = (p.protected as boolean) ?? false;
        identities.value =
          (p.identities as Array<{ connector: string; externalId: string }>) ?? [];
        const tools = (p.tools as Record<string, string>) ?? {};
        overrides.value = Object.entries(tools).map(([tool, policy]) => ({
          tool,
          source: 'built-in',
          enabled: true,
          requireApproval: policy === 'requires_approval',
        }));
        authority.value = (p.approvalAuthority as ApprovalAuthority | undefined) ?? null;
      } catch {
        // Fallback: empty form
      }
    } else {
      name.value = '';
      operator.value = false;
      isProtected.value = false;
      identities.value = [];
      overrides.value = [];
      authority.value = null;
    }
  },
);

async function save() {
  saving.value = true;
  saveError.value = null;
  try {
    const tools = Object.fromEntries(
      overrides.value
        .filter((o) => o.enabled)
        .map((o) => [o.tool, o.requireApproval ? 'requires_approval' : 'auto']),
    );
    let targetId: string;
    if (props.participantId) {
      targetId = props.participantId;
      await execute('modify_user', {
        id: targetId,
        name: name.value,
        tools,
        operator: operator.value,
        approvalAuthority: authority.value ?? undefined,
      });
    } else {
      targetId =
        name.value
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-]/g, '') || `user-${Date.now()}`;
      await execute('create_user', {
        id: targetId,
        name: name.value,
        tools,
        operator: operator.value,
        approvalAuthority: authority.value ?? undefined,
      });
    }
    if (password.value) {
      await execute('set_credential', { participantId: targetId, secret: password.value });
    }
    emit('saved');
    emit('close');
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

async function retire() {
  if (!props.participantId || !canRetire.value) return;
  try {
    await execute('retire_agent', { id: props.participantId });
    emit('saved');
    emit('close');
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <SlideOver
    :open="open"
    :title="participantId ? 'Edit user' : 'New user'"
    @close="emit('close')"
  >
    <div class="flex border-b border-navy-600 bg-navy-900">
      <button
        v-for="t in ['basic', 'tools', 'approval'] as const"
        :key="t"
        @click="tab = t"
        :class="[
          'px-4 py-2 text-xs font-medium border-b-2 transition-colors',
          tab === t
            ? 'text-cyan-400 border-cyan-400'
            : 'text-navy-400 border-transparent hover:text-slate-200',
        ]"
      >
        {{ t === 'basic' ? 'Basic' : t === 'tools' ? 'Tool policies' : 'Approval authority' }}
      </button>
    </div>

    <div
      v-if="saveError"
      class="mx-5 mt-4 px-3 py-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400"
    >
      {{ saveError }}
    </div>

    <div v-if="tab === 'basic'" class="p-5 space-y-4">
      <div v-if="participantId">
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">ID</label>
        <span class="font-mono text-xs text-navy-400">{{ participantId }}</span>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Name</label>
        <input
          v-model="name"
          placeholder="Name"
          class="w-full bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
        />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">
          Password{{ participantId ? ' (leave blank to keep current)' : '' }}
        </label>
        <div class="flex gap-2">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            placeholder="••••••••"
            class="flex-1 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
          />
          <button
            @click="showPassword = !showPassword"
            class="text-[10px] text-navy-400 hover:text-slate-200 border border-navy-600 rounded px-2"
          >
            {{ showPassword ? 'Hide' : 'Show' }}
          </button>
        </div>
      </div>
      <div v-if="participantId && identities.length">
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">
          Connector bindings <span class="normal-case font-normal text-navy-600">(read-only)</span>
        </label>
        <table class="w-full text-[10px]">
          <thead>
            <tr class="text-navy-500">
              <th class="text-left pb-1">Connector</th>
              <th class="text-left pb-1">External ID</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="id in identities" :key="id.connector + id.externalId">
              <td class="font-mono text-navy-400 pr-4">{{ id.connector }}</td>
              <td class="font-mono text-slate-300">{{ id.externalId }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div>
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            v-model="operator"
            :disabled="isProtected"
            class="accent-cyan-400"
          />
          <span class="text-xs text-slate-200">Operator (full management access)</span>
        </label>
      </div>
    </div>

    <ToolPolicyEditor
      v-else-if="tab === 'tools'"
      :overrides="overrides"
      :available-tools="availableTools"
      @update:overrides="(v) => (overrides = v)"
    />

    <ApprovalAuthorityEditor
      v-else
      :authority="authority"
      @update:authority="(v) => (authority = v)"
    />

    <template #footer>
      <div class="flex items-center justify-between px-5 py-3">
        <button
          v-if="participantId && !isProtected"
          data-retire-btn
          @click="retire"
          :disabled="isSelf || isOnlyActiveOperator"
          class="text-xs px-3 py-1.5 border border-red-900 text-red-400 rounded hover:border-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Retire user
        </button>
        <div v-else />
        <div class="flex gap-2">
          <button
            @click="emit('close')"
            class="text-xs px-3 py-1.5 border border-navy-600 text-navy-400 rounded hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            save-btn
            class="save-btn text-xs px-3 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </template>
  </SlideOver>
</template>
```

- [ ] **Step 4: Run tests**

```bash
npm run test --workspace=packages/web -- --reporter=verbose -t "UserSlideOver"
```

Expected: all PASS. If individual tests fail due to selector mismatches, inspect the HTML output and adjust the test selectors to match the actual rendered markup.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/participants/UserSlideOver.vue \
        packages/web/src/components/participants/UserSlideOver.test.ts
git commit -m "feat(web): add UserSlideOver component"
```

---

## Task 9: `ParticipantsView.vue` — Type column, two New buttons, type dispatch

**Files:**
- Modify: `packages/web/src/views/ParticipantsView.vue`

- [ ] **Step 1: Replace the entire content of `ParticipantsView.vue`**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { BaseParticipant } from '@legion/types';
import AppLayout from '../components/layout/AppLayout.vue';
import AgentSlideOver from '../components/participants/AgentSlideOver.vue';
import UserSlideOver from '../components/participants/UserSlideOver.vue';
import { useEventStream } from '../composables/useEventStream.js';
import { useExecute } from '../composables/useExecute.js';
import StatusDot from '../components/common/StatusDot.vue';

const { execute } = useExecute();
const { on } = useEventStream();

const participants = ref<BaseParticipant[]>([]);
const allTools = ref<string[]>([]);
const availableModels = ref<Array<{ id: string; name?: string; provider: string }>>([]);

const agentSlideOpen = ref(false);
const userSlideOpen = ref(false);
const editingId = ref<string | null>(null);
const loadError = ref<string | null>(null);

async function load() {
  try {
    const list = await execute<{ id: string; name: string; type: string; status: string }[]>(
      'list_participants',
      {},
    );
    const fullConfigs = await Promise.all(
      list.map((p) =>
        execute<Record<string, unknown>>('get_participant', { id: p.id }).catch(() => null),
      ),
    );
    participants.value = list.map((p, i) => {
      const full = fullConfigs[i];
      return {
        ...p,
        model: (full?.model as { model?: string })?.model,
        operator: (full?.operator as boolean) ?? false,
      };
    }) as any;
    allTools.value = await execute<string[]>('list_tools', {});
    const raw = await execute<Array<{ provider: string; model: { id: string; name?: string } }>>(
      'list_models',
      {},
    );
    availableModels.value = raw.map((r) => ({
      id: r.model.id,
      name: r.model.name,
      provider: r.provider,
    }));
    loadError.value = null;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

on('participant:active', () => load());
on('participant:retired', () => load());

onMounted(async () => {
  await load();
});

function openCreateAgent() {
  editingId.value = null;
  agentSlideOpen.value = true;
}

function openCreateUser() {
  editingId.value = null;
  userSlideOpen.value = true;
}

function openEdit(p: BaseParticipant) {
  editingId.value = p.id;
  if (p.type === 'user') {
    userSlideOpen.value = true;
  } else if (p.type === 'agent') {
    agentSlideOpen.value = true;
  }
}

const typeColours: Record<string, string> = {
  user: 'bg-cyan-400/10 text-cyan-400 border-cyan-400/20',
  agent: 'bg-slate-400/10 text-slate-400 border-slate-400/20',
  service: 'bg-violet-400/10 text-violet-400 border-violet-400/20',
  mock: 'bg-navy-700/50 text-navy-500 border-navy-600',
};

function typeCls(type: string): string {
  return typeColours[type] ?? 'bg-navy-700/50 text-navy-500 border-navy-600';
}
</script>

<template>
  <AppLayout>
    <div class="flex items-center justify-between px-5 py-3.5 border-b border-navy-600">
      <h1 class="text-sm font-semibold text-slate-100">Participants</h1>
      <div class="flex gap-2">
        <button
          @click="openCreateAgent"
          class="text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded hover:border-cyan-400/40"
        >
          + New agent
        </button>
        <button
          @click="openCreateUser"
          class="text-xs px-3 py-1.5 border border-navy-600 text-cyan-400 rounded hover:border-cyan-400/40"
        >
          + New user
        </button>
      </div>
    </div>

    <div v-if="loadError" class="mx-5 mt-4 px-3 py-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-400">
      {{ loadError }}
    </div>

    <table class="w-full border-collapse text-xs">
      <thead>
        <tr class="border-b border-navy-700">
          <th class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold">Status</th>
          <th class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold">Type</th>
          <th class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold">Name</th>
          <th class="text-left text-[9px] uppercase tracking-wider text-navy-500 px-4 py-2 font-semibold">Model</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in participants"
          :key="p.id"
          :class="[
            'border-b border-navy-900 hover:bg-navy-800/40',
            p.status === 'retired' ? 'opacity-35' : '',
          ]"
        >
          <td class="px-4 py-2.5">
            <div class="flex items-center gap-2">
              <StatusDot :status="p.status === 'active' ? 'active' : 'retired'" />
              <span :class="p.status === 'active' ? 'text-cyan-400' : 'text-navy-500'">
                {{ p.status === 'active' ? 'Active' : 'Retired' }}
              </span>
            </div>
          </td>
          <td class="px-4 py-2.5">
            <span
              :class="[
                'inline-block text-[9px] font-bold font-mono px-1.5 py-0.5 rounded border',
                typeCls(p.type),
              ]"
            >
              {{ p.type }}
            </span>
          </td>
          <td class="px-4 py-2.5 text-slate-100 font-medium">{{ p.name }}</td>
          <td class="px-4 py-2.5 text-navy-400 font-mono">{{ (p as any).model ?? '—' }}</td>
          <td class="px-4 py-2.5 text-right">
            <button
              v-if="p.status === 'active' && (p.type === 'agent' || p.type === 'user')"
              @click="openEdit(p)"
              class="text-navy-400 hover:text-slate-200 mr-3"
            >
              Edit
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <AgentSlideOver
      :open="agentSlideOpen"
      :participant-id="editingId"
      :available-tools="allTools"
      :available-models="availableModels"
      @close="agentSlideOpen = false"
      @saved="load"
    />

    <UserSlideOver
      :open="userSlideOpen"
      :participant-id="editingId"
      :available-tools="allTools"
      :all-participants="participants"
      @close="userSlideOpen = false"
      @saved="load"
    />
  </AppLayout>
</template>
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run all web tests**

```bash
npm run test --workspace=packages/web
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/views/ParticipantsView.vue
git commit -m "feat(web): type column, dual new buttons, type-dispatched slide-overs in ParticipantsView"
```

---

## Task 10: `AccountView.vue` + route + sidebar

**Files:**
- Create: `packages/web/src/views/AccountView.vue`
- Modify: `packages/web/src/router/index.ts`
- Modify: `packages/web/src/components/layout/AppSidebar.vue`

- [ ] **Step 1: Create `AccountView.vue`**

Create `packages/web/src/views/AccountView.vue`:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import AppLayout from '../components/layout/AppLayout.vue';
import { useAuth } from '../composables/useAuth.js';
import { useExecute } from '../composables/useExecute.js';

const { participantId } = useAuth();
const { execute } = useExecute();

const newPassword = ref('');
const confirmPassword = ref('');
const showNew = ref(false);
const showConfirm = ref(false);
const saving = ref(false);
const successMsg = ref<string | null>(null);
const errorMsg = ref<string | null>(null);

const validationError = computed(() => {
  if (!newPassword.value && !confirmPassword.value) return null;
  if (newPassword.value.length < 8) return 'Password must be at least 8 characters';
  if (newPassword.value !== confirmPassword.value) return 'Passwords do not match';
  return null;
});

const canSave = computed(
  () => newPassword.value.length >= 8 && newPassword.value === confirmPassword.value,
);

async function changePassword() {
  if (!canSave.value || !participantId.value) return;
  saving.value = true;
  errorMsg.value = null;
  successMsg.value = null;
  try {
    await execute('set_credential', {
      participantId: participantId.value,
      secret: newPassword.value,
    });
    successMsg.value = 'Password updated successfully.';
    newPassword.value = '';
    confirmPassword.value = '';
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppLayout>
    <div class="px-5 py-3.5 border-b border-navy-600">
      <h1 class="text-sm font-semibold text-slate-100">Account</h1>
    </div>

    <div class="max-w-md p-5 space-y-6">
      <div>
        <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Participant ID</label>
        <span class="font-mono text-xs text-navy-400">{{ participantId ?? '—' }}</span>
      </div>

      <div class="space-y-4">
        <p class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold">Change password</p>

        <div>
          <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">New password</label>
          <div class="flex gap-2">
            <input
              v-model="newPassword"
              :type="showNew ? 'text' : 'password'"
              placeholder="••••••••"
              class="flex-1 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
            />
            <button
              @click="showNew = !showNew"
              class="text-[10px] text-navy-400 hover:text-slate-200 border border-navy-600 rounded px-2"
            >
              {{ showNew ? 'Hide' : 'Show' }}
            </button>
          </div>
        </div>

        <div>
          <label class="text-[10px] uppercase tracking-widest text-navy-400 font-semibold block mb-1">Confirm password</label>
          <div class="flex gap-2">
            <input
              v-model="confirmPassword"
              :type="showConfirm ? 'text' : 'password'"
              placeholder="••••••••"
              class="flex-1 bg-navy-900 border border-navy-600 rounded px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
            />
            <button
              @click="showConfirm = !showConfirm"
              class="text-[10px] text-navy-400 hover:text-slate-200 border border-navy-600 rounded px-2"
            >
              {{ showConfirm ? 'Hide' : 'Show' }}
            </button>
          </div>
        </div>

        <p v-if="validationError" class="text-[10px] text-red-400">{{ validationError }}</p>
        <p v-if="successMsg" class="text-[10px] text-cyan-400">{{ successMsg }}</p>
        <p v-if="errorMsg" class="text-[10px] text-red-400">{{ errorMsg }}</p>

        <button
          @click="changePassword"
          :disabled="!canSave || saving"
          class="text-xs px-4 py-1.5 bg-cyan-400 text-navy-950 font-bold rounded disabled:opacity-50"
        >
          {{ saving ? 'Saving…' : 'Update password' }}
        </button>
      </div>
    </div>
  </AppLayout>
</template>
```

- [ ] **Step 2: Add `/account` route**

In `packages/web/src/router/index.ts`, add the account route before the closing `]`:

```typescript
  {
    path: '/account',
    component: () => import('../views/AccountView.vue'),
    meta: { requiresAuth: true },
  },
```

- [ ] **Step 3: Add Account to sidebar nav**

In `packages/web/src/components/layout/AppSidebar.vue`, update the `nav` array:

```typescript
const nav = [
  { label: 'Participants', icon: '👤', to: '/participants' },
  { label: 'Conversations', icon: '💬', to: '/conversations' },
  { label: 'Events', icon: '⚡', to: '/events' },
  { label: 'Processes', icon: '⚙', to: '/processes' },
  { label: 'Config', icon: '⚙️', to: '/config' },
  { label: 'Account', icon: '🔑', to: '/account' },
];
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/views/AccountView.vue \
        packages/web/src/router/index.ts \
        packages/web/src/components/layout/AppSidebar.vue
git commit -m "feat(web): add AccountView for self-service password change"
```

---

## Task 11: Verification gate

- [ ] **Step 1: Format check**

```bash
npm run format:check
```

If it fails, run `npm run format` then re-check.

- [ ] **Step 2: Full typecheck**

```bash
npm run typecheck
```

Expected: exit 0, no errors.

- [ ] **Step 3: Core/runtime unit tests**

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 4: Web tests**

```bash
npm run test --workspace=packages/web
```

Expected: all PASS.

- [ ] **Step 5: Final commit (if format touched files)**

If `npm run format` changed any files:

```bash
git add -A
git commit -m "chore: format"
```
