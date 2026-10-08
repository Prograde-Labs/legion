# Web UI Rewrite — Chat-First Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `packages/web` as a chat-first SPA — conversations are the home surface with a typed-part thread, inline fork navigation, a registry-driven right dock, master-detail Participants (with user management + topology map), carried-over Processes/Config pages plus a new MCP sources section, and the six net-new backend tools from spec §7.

**Architecture:** Vue 3 SPA in `packages/web` replaced in-place on this branch (no parallel old/new period). State is a thin foundation (`useLegionApi` + module-scoped WS event bus) under feature composables (`useConversations`, `useApprovals`, …) — plain functions with module-scoped refs, no service/DI. Every color/spacing decision goes through a Tailwind 4 `@theme` token layer with two `[data-theme]` token sets (command-deck dark default, blueprint-light). Backend changes are limited to exactly the six tools in spec §7 (3 core, 3 runtime); everything else UI needs already exists as authorized tool calls over `POST /api/execute` + WebSocket.

**Tech Stack:** Vue 3 + TypeScript (strict, ESM, NodeNext, `verbatimModuleSyntax`), Vite 5, Tailwind 4 (`@theme` tokens), vue-router 4 (hash history), vitest + happy-dom (web tests run separately), Playwright (existing `packages/e2e` suite), markdown-it + shiki + DOMPurify (carried over), no new runtime dependencies anywhere.

**Spec:** `docs/superpowers/specs/2026-10-07-web-ui-rewrite-design.md` (same branch) — the source of truth. This plan decomposes it; the spec's §-numbers are cited throughout. Mockup references: `.superpowers/brainstorm/700951-1791410143/content/` (shell layout, panels, branching, visual style, light theme, waiting).

## Global Constraints

- Repo: `/workspace/legion` npm workspaces; pure ESM `"type": "module"`, Node ≥ 20, TS ^5.5 strict + `noUnusedLocals` + `noUnusedParameters` + `verbatimModuleSyntax`.
- All relative imports in `.ts` source use `.js` extensions (NodeNext); type-only imports use `import type`. In `.vue` SFCs, same rules apply to `<script setup lang="ts">`.
- Prettier: single quotes, semicolons, trailing commas, 100 cols, 2-space (`npm run format` before committing).
- Web unit tests run separately: `npm run test --workspace=packages/web` (vitest + happy-dom, globals on). Root `npm test` does NOT cover `packages/web`.
- Full gate before claiming the whole plan done: `npm run format:check` → `npm run typecheck` → `npm test` → `npm run test --workspace=packages/web` → `npm run test:e2e`. E2E needs `npm install` + `npm run build` + `npx playwright install chromium` first.
- Every collective operation is a tool call over `POST /api/execute` (or streamed over `/ws` via `X-Stream-Connection` header + `useToolStream`) — no CRUD REST endpoints, ever.
- Components never use raw hex/named colors — only token-derived Tailwind utilities or `var(--token)`; the two `@theme` token sets are the only place colors are defined (spec §3.4).
- The event-log concept is not carried forward (spec §2): `EventStreamView.vue`, `EventDetailPanel.vue` and the `/events` route are deleted, not ported.
- Backend scope is frozen at the six tools in spec §7 (`create_user`, `modify_user`, `set_approval_authority` in core; `list_pending_approvals`, `list_mcp_sources`, `save_mcp_sources` in runtime). Any discovered gap beyond these six is a STOP-and-record (see plan preamble).
- Tool authorization model (do not re-derive): a tool is visible iff `participant.tools[name] !== undefined` (`ToolPolicy = 'auto' | 'requires_approval'`); `ApprovalAuthority = { tools?: Record<string, boolean> | '*'; participants?: string[] | '*' }`.
- Branch: work happens on `web-ui-rewrite` (this branch carries the spec). Commits as Chris's configured git identity.
- Types referenced by later tasks (verified on this branch): `BaseParticipant`/`UserConfig` in `packages/types/src/participant.ts` (`operator?`, `protected?`, `approvalAuthority?`, `identities?: ConnectorIdentity[]`); `MCPServerConfig` in `packages/types/src/config.ts` (`name`, `command`/`args`/`env` OR `url`/`headers`); `PendingApproval = { approvalId, conversationId, requesterId, tool, args, createdAt }` in `packages/core/src/auth/PendingApprovalRegistry.ts`; `WorkspaceConfig.mcpServers?: MCPServerConfig[]`.

## Verified repo facts (2026-10-08, branch `web-ui-rewrite` @ b4a3c7f)

Trust these over any re-derivation during execution:

- `management-tools.ts` (1059 lines) exports 17 tools incl. `create_agent`, `modify_agent` (rejects non-agents), `retire_agent`, `set_credential`, `set_tool_policy`, `remove_tool_policy`, `set_participant_middleware`, `edit_message` (creates sibling branch node; response carries `alternates`), `switch_branch`, `generate`, `get_conversation`. It exports a `managementTools` array plus `createManagementTools(deps)` factory; `packages/runtime/src/LegionProcess.ts` registers them at step 6.
- `runtime-tools.ts` (166 lines) has `list_providers`, `save_provider`, `delete_provider`, `list_models`, `get_routing`, `save_routing` via `createRuntimeTools(deps)`; deps wired in `LegionProcess.ts` (~line 248) from `systemStore` + routing save closures.
- MCP today: `loadMCPSources(configs, registry)` is called **once at startup** from `mergedConfig.mcpServers` (`LegionProcess.ts:260`); there is no read/write tool for these declarations.
- Approval surfacing today: approval lifecycle already streams to the web as `approval:requested` / `approval:resolved` chunks (consumed in `ConversationsView.vue:152` via `watch_activity`); `PendingApprovalRegistry.listPending(conversationId?)` at line 1881 is unexposed.
- Operator tool-policy bootstrap: `RUNTIME_TOOL_NAMES` / `SUBSCRIPTION_TOOL_NAMES` arrays in `LegionProcess.ts` (lines 402–427) are idempotently added to the bootstrap operator's tools map at every startup — new runtime tools are registered for the web user by appending to `RUNTIME_TOOL_NAMES`. Core management tools are granted via `MANAGEMENT_TOOLS` in `packages/core/src/collective/default-participants.ts` (startup-seeded only, NOT auto-migrated to existing collectives — new core tools must be added there too).
- Web today: `useExecute` (fetch wrapper), `useWebSocket` (module-scoped singleton WS with reconnect + `onStreamChunk`), `useToolStream` (streaming tool calls with cancel), `useAuth` (localStorage token + JWT exp), `useConversation` (per-conversation load/send/edit/branch/stop). Renderers: regex-pattern registry (`renderers/index.ts` — `registerRenderer(pattern, component)`, `lookupRenderer(toolName)`). Existing e2e auth flow: `/#/login` → operator/password, landing `/#/participants`.
- Router today: hash history (`createWebHashHistory`), `/` redirects to `/participants`.
- Web deps (package.json): vue 3.4, vue-router 4, tailwindcss 4, `@vueuse/core` 11, markdown-it 14, shiki 4, `@shikijs/markdown-it`, dompurify 3, ansi_up 6, `@vue/test-utils` 2, happy-dom 14, vitest 2, vue-tsc 2.
- The `feat/user-management` worktree at `/workspace/legion-user-mgmt` is **abandoned** (Chris's call) — do not build on it; its spec `2026-07-05-user-management-design.md` is reference-only.

## Preamble for executors

- Work in a dedicated git worktree on `web-ui-rewrite` if the main checkout sits on another branch (pattern: `git worktree add /workspace/legion-web-ui web-ui-rewrite`).
- **Backend-scope tripwire:** if a task seems to need a seventh backend change, STOP that thread, record it in "Open questions for Chris" at the bottom of this file, and continue with tasks that don't need it. The six-tool list was explicitly negotiated.
- Commit per task (message style: `feat(web): …` / `feat(core): …` / `test(e2e): …` / `docs(plan): …`), running the touched package's tests before each commit.
- After the final task, check off this preamble's gate with a full run of all five gate commands.

## File Structure

New `packages/web/src` layout (replaces the current one; carried-over files noted):

```
packages/web/src/
  main.ts                      — bootstrap: theme init, router, pinia-free
  App.vue                      — router-view only (shell lives in views/shell)
  router/index.ts              — / (= /chat), /participants, /processes, /config, /login
  theme/
    tokens.css                 — @theme block: shared + command-deck defaults
    light.css                  — [data-theme='blueprint-light'] overrides
    useTheme.ts                — composable: current theme ref, localStorage, data-theme attr, overrides
  lib/
    markdown.ts                — carried over (markdown-it + shiki + DOMPurify)
    ws.ts                      — carried over core of useWebSocket.ts, renamed to lib-level export
  composables/
    useLegionApi.ts            — typed execute<T>() + login/session + WS event bus (foundation)
    useAuth.ts                 — session identity (isAuthenticated, participantId, isOperator, tools)
    useConversations.ts        — list/draft/active conversation state + watch_conversations stream
    useParticipants.ts         — participants list/detail state
    useApprovals.ts            — pending-approval map (list_pending_approvals + live chunks)
    useProcesses.ts            — carried over logic, adapted to foundation
    useTheme.ts                — thin re-export of theme/useTheme (public surface)
    useToolStream.ts           — carried over (unchanged API)
  shell/
    AppShell.vue               — top nav + badge + avatar dropdown + <router-view>
    NavBadge.vue               — pending-approvals count pill
    AccountSlideOver.vue       — own password change (set_credential), session info, logout
    ConversationDrawer.vue     — mobile off-canvas conversation list
  chat/
    ChatView.vue               — 3-column layout: list / thread / dock
    ConversationList.vue       — rebuilt list (name, participants, activity, unread, approval marker)
    Thread.vue                 — active-chain renderer (typed parts, fork controls, highlight layer)
    MessagePart.vue            — part dispatcher: text | tool-call | reasoning | attachment
    ToolCallChip.vue           — chip w/ running state; click → dockOpen(tool, payload)
    ForkControls.vue           — ‹ 1/2 › sibling pager + branch marker chip
    MessageActions.vue         — hover menu: edit, re-run, create-branch, prune
    Composer.vue               — textarea, @-mentions, tool hints, stop, branch indicator
    ApprovalCard.vue           — inline approve/reject with optional reason
    MarkdownContent.vue        — carried over
    ReasoningDisclosure.vue    — carried over
  renderers/
    registry.ts                — tool-name-keyed renderer registry (evolves renderers/index.ts)
    TextResultRenderer.vue     — ANSI/plain text result (wraps ansi_up)
    JsonRenderer.vue           — carried over
    FileTreeRenderer.vue       — carried over
    SearchResultRenderer.vue   — carried over
    index.ts                   — registration side-effect module
  panels/
    registry.ts                — tool-name → dock panel component + open() helper
    DockPanel.vue              — dock frame: tab strip, resize, close, drag reorder
    ToolDetailPanel.vue        — generic fallback: inputs/status/timing/result
    CommunicatePanel.vue       — target conversation w/ highlight layer + breadcrumb
  views/
    LoginView.vue              — carried over (re-skinned)
    ChatView.vue               — re-export of chat/ChatView.vue (route target)
    ParticipantsView.vue       — master-detail page
    ParticipantsList.vue       — left column (search, type badges, status)
    AgentEditor.vue            — agent detail/editor pane
    UserEditor.vue             — user detail/editor pane (passwords, operator, authority)
    ParticipantDetail.vue      — services/mocks view-only pane
    TopologyMap.vue            — collective diagram (SVG, live edges)
    ProcessesView.vue          — carried over logic on new shell
    ConfigView.vue             — providers + routing + NEW mcp section
    McpSourcesEditor.vue       — MCP server list editor
  components/                  — shared small components carried over (StatusDot, TypeBadge, SearchableCombobox, SlideOver, AnsiOutput…)
```

Backend files (only these change):

```
packages/core/src/tools/user-tools.ts        — create_user + modify_user
packages/core/src/tools/approval-authority-tool.ts — set_approval_authority
packages/core/src/tools/management-tools.test.ts — (helpers shared, tests separate per tool file)
packages/core/src/index.ts                   — export the new tool arrays
packages/core/src/collective/default-participants.ts — grant new core tools to bootstrap operator
packages/runtime/src/server/runtime-tools.ts — list_pending_approvals + list_mcp_sources + save_mcp_sources
packages/runtime/src/LegionProcess.ts        — wire runtime deps (pendingApprovalRegistry, config path, reload); RUNTIME_TOOL_NAMES += the three
packages/types/src/index.ts                  — (no change expected; types already exist)
```

### Task 1: `create_user` + `modify_user` core tools (test-first)

**Files:**

- Create: `packages/core/src/tools/user-tools.ts`
- Create: `packages/core/src/tools/user-tools.test.ts`
- Modify: `packages/core/src/index.ts` (export `userTools`)
- Modify: `packages/core/src/collective/default-participants.ts` (add `create_user`, `modify_user` to `MANAGEMENT_TOOLS`)

**Interfaces:**

- Consumes: `Collective.add/update` (existing), `UserConfig` (types, existing), `Tool`/`ToolContext` (`packages/core/src/tools/Tool.ts`), `requireCollective` pattern from `management-tools.ts` (re-declare locally — it is module-private there).
- Produces: `export const userTools: Tool[]` containing `createUserTool` and `modifyUserTool` with exactly these contracts (web `UserEditor.vue` in Task 15 relies on them):
  - `create_user { id: string; name: string; operator?: boolean; tools?: Record<string, ToolPolicy> }` → `ToolResult{ status: 'success', data: { id } }`. Creates `UserConfig` with `type: 'user'`, `status: 'active'`, empty `tools` map by default. Errors: duplicate id (`Participant already exists: <id>`), missing required fields.
  - `modify_user { id: string; name?: string; operator?: boolean; tools?: Record<string, ToolPolicy> }` → `ToolResult{ status: 'success', data: <updated UserConfig> }`. Full-replacement semantics for `tools` (omit = keep existing, `{}` = clear all, mirroring `modify_agent`). Errors: unknown id, participant is not `type: 'user'`.
  - Passwords are NOT set here — `set_credential` (existing) handles them.

- [x] **Step 1: Write the failing tests**

Create `packages/core/src/tools/user-tools.test.ts` following the `management-tools.test.ts` fixture pattern (`makeContext()` with `MemoryStorage` + `Collective.load` + `seedDefaultsIfEmpty`):

```typescript
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { userTools } from './user-tools.js';
import type { ToolContext } from './Tool.js';
import type { UserConfig } from '@legion-collective/types';

async function makeContext(): Promise<{ context: ToolContext; collective: Collective }> {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const context = { collective } as unknown as ToolContext;
  return { context, collective };
}

const [createUserTool, modifyUserTool] = userTools;

describe('create_user', () => {
  it('creates a user participant with defaults', async () => {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    expect(result.status).toBe('success');
    const user = collective.get('alice') as UserConfig | undefined;
    expect(user?.type).toBe('user');
    expect(user?.status).toBe('active');
    expect(user?.tools).toEqual({});
  });

  it('rejects a duplicate id', async () => {
    const { context } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await createUserTool.execute({ id: 'alice', name: 'Alice 2' }, context);
    expect(result.status).toBe('error');
    expect(result.error).toContain('Participant already exists');
  });

  it('accepts operator and tools overrides', async () => {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute(
      { id: 'bob', name: 'Bob', operator: true, tools: { list_participants: 'auto' } },
      context,
    );
    expect(result.status).toBe('success');
    const user = collective.get('bob') as UserConfig;
    expect(user.operator).toBe(true);
    expect(user.tools).toEqual({ list_participants: 'auto' });
  });
});

describe('modify_user', () => {
  it('renames and flips operator', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await modifyUserTool.execute(
      { id: 'alice', name: 'Alice B', operator: true },
      context,
    );
    expect(result.status).toBe('success');
    const user = collective.get('alice') as UserConfig;
    expect(user.name).toBe('Alice B');
    expect(user.operator).toBe(true);
  });

  it('clears the tools map on empty object (full replacement)', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute(
      { id: 'alice', name: 'Alice', tools: { communicate: 'auto' } },
      context,
    );
    const result = await modifyUserTool.execute({ id: 'alice', tools: {} }, context);
    expect(result.status).toBe('success');
    expect((collective.get('alice') as UserConfig).tools).toEqual({});
  });

  it('keeps tools when omitted', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute(
      { id: 'alice', name: 'Alice', tools: { communicate: 'auto' } },
      context,
    );
    await modifyUserTool.execute({ id: 'alice', name: 'Alice B' }, context);
    expect((collective.get('alice') as UserConfig).tools).toEqual({ communicate: 'auto' });
  });

  it('rejects non-user participants', async () => {
    const { context } = await makeContext();
    const result = await modifyUserTool.execute({ id: 'operator' }, context);
    expect(result.status).toBe('error');
    expect(result.error).toContain('not a user');
  });

  it('rejects unknown ids', async () => {
    const { context } = await makeContext();
    const result = await modifyUserTool.execute({ id: 'ghost' }, context);
    expect(result.status).toBe('error');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/user-tools.test.ts`
Expected: FAIL — cannot resolve `./user-tools.js` (module not found).

- [x] **Step 3: Implement `user-tools.ts`**

Create `packages/core/src/tools/user-tools.ts` (note: `.js` import extensions, `import type` for types — this is the house style in every file):

```typescript
import type { ToolPolicy, ToolResult, UserConfig } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';

function requireCollective(context: ToolContext): NonNullable<ToolContext['collective']> {
  if (!context.collective) throw new Error('collective unavailable in context');
  return context.collective;
}

function toError(err: unknown): ToolResult {
  return { status: 'error', error: err instanceof Error ? err.message : String(err) };
}

export const createUserTool: Tool = {
  name: 'create_user',
  description: 'Create a user participant (a human operator identity with credentials).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      operator: { type: 'boolean', description: 'Grant operator flag. Default false.' },
      tools: {
        type: 'object',
        description: 'Map of tool name to policy (auto or requires_approval). Default empty.',
      },
    },
    required: ['id', 'name'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { id, name, operator, tools } = args as {
      id: string;
      name: string;
      operator?: boolean;
      tools?: Record<string, ToolPolicy>;
    };
    try {
      const config: UserConfig = {
        id,
        name,
        type: 'user',
        tools: tools ?? {},
        status: 'active',
        ...(operator === undefined ? {} : { operator }),
      };
      await requireCollective(context).add(config);
      return { status: 'success', data: { id } };
    } catch (err) {
      return toError(err);
    }
  },
};

export const modifyUserTool: Tool = {
  name: 'modify_user',
  description:
    'Update an existing user — name, operator flag, or full-replacement tool policies. ' +
    'Passwords are managed by set_credential.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
      name: { type: 'string' },
      operator: { type: 'boolean' },
      tools: {
        type: 'object',
        description:
          'Full replacement tools map. Omit to keep existing. Pass {} to clear all tool access.',
      },
    },
    required: ['id'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { id, name, operator, tools } = args as {
      id: string;
      name?: string;
      operator?: boolean;
      tools?: Record<string, ToolPolicy>;
    };
    try {
      const collective = requireCollective(context);
      const existing = collective.get(id);
      if (!existing) return { status: 'error', error: `User not found: ${id}` };
      if (existing.type !== 'user')
        return { status: 'error', error: `Participant ${id} is not a user` };
      const patch: Partial<UserConfig> = {};
      if (name !== undefined) patch.name = name;
      if (operator !== undefined) patch.operator = operator;
      if (tools !== undefined) patch.tools = tools;
      await collective.update(id, patch);
      return { status: 'success', data: collective.getOrThrow(id) };
    } catch (err) {
      return toError(err);
    }
  },
};

export const userTools: Tool[] = [createUserTool, modifyUserTool];
```

- [x] **Step 4: Register + grant to operator**

In `packages/core/src/index.ts`, next to the other tool exports: `export * from './tools/user-tools.js';`
In `packages/core/src/collective/default-participants.ts`, add `'create_user'` and `'modify_user'` to the `MANAGEMENT_TOOLS` const array (after `'set_credential'`).

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/tools/user-tools.test.ts`
Expected: PASS (8 tests). Then `npm run typecheck` — expected: 0 errors.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/tools/user-tools.ts packages/core/src/tools/user-tools.test.ts \
  packages/core/src/index.ts packages/core/src/collective/default-participants.ts
git commit -m "feat(core): create_user + modify_user tools (spec §7)"
```

### Task 2: `set_approval_authority` core tool (test-first)

**Files:**

- Create: `packages/core/src/tools/approval-authority-tool.ts`
- Create: `packages/core/src/tools/approval-authority-tool.test.ts`
- Modify: `packages/core/src/index.ts` (export `approvalAuthorityTool` module)
- Modify: `packages/core/src/collective/default-participants.ts` (add `set_approval_authority` to `MANAGEMENT_TOOLS`)

**Interfaces:**

- Consumes: `Collective.update` (existing), `ApprovalAuthority` (types, existing: `{ tools?: Record<string, boolean> | '*'; participants?: string[] | '*' }`), `createUserTool` (Task 1) for test fixtures.
- Produces: `export const setApprovalAuthorityTool: Tool` — `set_approval_authority { participantId: string; authority: ApprovalAuthority | null }` -> `ToolResult{ status: 'success', data: { participantId, authority } }`. `null` clears the authority. Works on ANY participant type (spec §6.1: agent editor AND user editor expose it). Errors: unknown participant id, malformed authority. Tasks 15/16 consume this contract.

- [x] **Step 1: Write the failing tests**

Create `packages/core/src/tools/approval-authority-tool.test.ts`:

```typescript
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { createUserTool } from './user-tools.js';
import { setApprovalAuthorityTool } from './approval-authority-tool.js';
import { createAgentTool } from './management-tools.js';
import type { ToolContext } from './Tool.js';
import type { AgentConfig, UserConfig } from '@legion-collective/types';

async function makeContext(): Promise<{ context: ToolContext; collective: Collective }> {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const context = { collective } as unknown as ToolContext;
  return { context, collective };
}

describe('set_approval_authority', () => {
  it('sets a wildcard authority on a user', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: { tools: '*', participants: '*' } },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('alice') as UserConfig).approvalAuthority).toEqual({
      tools: '*',
      participants: '*',
    });
  });

  it('sets a scoped authority on an agent', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      { id: 'bot', name: 'Bot', systemPrompt: 'p', model: { model: 'm' } },
      context,
    );
    const result = await setApprovalAuthorityTool.execute(
      {
        participantId: 'bot',
        authority: { tools: { communicate: true }, participants: ['alice'] },
      },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('bot') as AgentConfig).approvalAuthority).toEqual({
      tools: { communicate: true },
      participants: ['alice'],
    });
  });

  it('clears authority with null', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: { tools: '*' } },
      context,
    );
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: null },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('alice') as UserConfig).approvalAuthority).toBeFalsy();
  });

  it('rejects unknown participants', async () => {
    const { context } = await makeContext();
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'ghost', authority: { tools: '*' } },
      context,
    );
    expect(result.status).toBe('error');
  });

  it('rejects malformed authority objects', async () => {
    const { context } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: { bogus: true } },
      context,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('authority');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/approval-authority-tool.test.ts`
Expected: FAIL — cannot resolve `./approval-authority-tool.js`.

- [x] **Step 3: Implement `approval-authority-tool.ts`**

```typescript
import type { ApprovalAuthority, ToolResult } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';

function requireCollective(context: ToolContext): NonNullable<ToolContext['collective']> {
  if (!context.collective) throw new Error('collective unavailable in context');
  return context.collective;
}

function validateAuthority(value: unknown): ApprovalAuthority | null {
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('authority must be an object or null');
  }
  if (value === null) return null;
  const authority = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(authority)) {
    if (key !== 'tools' && key !== 'participants') {
      throw new Error(`authority contains an unknown property: ${String(key)}`);
    }
  }
  const validated: ApprovalAuthority = {};
  if (authority['tools'] !== undefined) {
    const tools = authority['tools'];
    if (tools !== '*' && (typeof tools !== 'object' || tools === null)) {
      throw new Error('authority.tools must be "*" or an object of booleans');
    }
    validated.tools = tools as ApprovalAuthority['tools'];
  }
  if (authority['participants'] !== undefined) {
    const participants = authority['participants'];
    if (
      participants !== '*' &&
      (!Array.isArray(participants) || participants.some((p) => typeof p !== 'string'))
    ) {
      throw new Error('authority.participants must be "*" or an array of participant ids');
    }
    validated.participants = participants as ApprovalAuthority['participants'];
  }
  return validated;
}

export const setApprovalAuthorityTool: Tool = {
  name: 'set_approval_authority',
  description:
    'Set or clear the approval authority of any participant — which tools they may approve ' +
    'on behalf of which requesters. Pass authority=null to clear.',
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string', description: 'Participant ID' },
      authority: {
        description:
          'ApprovalAuthority: { tools?: Record<string, boolean> | "*", participants?: string[] | "*" }. ' +
          'Pass null to clear.',
      },
    },
    required: ['participantId', 'authority'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { participantId, authority } = args as {
      participantId: string;
      authority: unknown;
    };
    try {
      const collective = requireCollective(context);
      if (!collective.get(participantId)) {
        return { status: 'error', error: `Participant not found: ${participantId}` };
      }
      const validated = validateAuthority(authority);
      if (validated === null) {
        const existing = collective.getOrThrow(participantId);
        const { approvalAuthority: _cleared, ...rest } = existing;
        await collective.update(participantId, rest);
      } else {
        await collective.update(participantId, { approvalAuthority: validated });
      }
      return { status: 'success', data: { participantId, authority: validated } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [x] **Step 4: Register + grant to operator**

In `packages/core/src/index.ts`: `export * from './tools/approval-authority-tool.js';`
In `packages/core/src/collective/default-participants.ts`, add `'set_approval_authority'` to `MANAGEMENT_TOOLS`.

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/tools/approval-authority-tool.test.ts`
Expected: PASS (5 tests). Then `npm run typecheck` — 0 errors.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/tools/approval-authority-tool.ts \
  packages/core/src/tools/approval-authority-tool.test.ts \
  packages/core/src/index.ts packages/core/src/collective/default-participants.ts
git commit -m "feat(core): set_approval_authority tool (spec §7)"
```

### Task 3: `list_pending_approvals` runtime tool (test-first)

**Files:**

- Modify: `packages/runtime/src/server/runtime-tools.ts`
- Modify: `packages/runtime/src/server/runtime-tools.test.ts`
- Modify: `packages/runtime/src/LegionProcess.ts` (wire `pendingApprovalRegistry` into `createRuntimeTools` deps; add `'list_pending_approvals'` to `RUNTIME_TOOL_NAMES`)

**Interfaces:**

- Consumes: `PendingApprovalRegistry.listPending(conversationId?: string): PendingApproval[]` (core, existing at `PendingApprovalRegistry.ts:1881`); `PendingApproval = { approvalId, conversationId, requesterId, tool, args, createdAt }`.
- Produces: `list_pending_approvals { conversationId?: string }` → `ToolResult{ status: 'success', data: PendingApproval[] }`. Also changes `RuntimeToolDeps` to `RuntimeToolDeps & { pendingApprovalRegistry: PendingApprovalRegistry }`. Task 12 (`useApprovals`) consumes the data shape.

- [ ] **Step 1: Write the failing test**

Append to `packages/runtime/src/server/runtime-tools.test.ts` (reuse its existing fixture helpers for the deps; extend them with an optional `pendingApprovalRegistry`. For the registry itself, mirror the constructor + `create(...)` usage found in `packages/core/src/auth/PendingApprovalRegistry.test.ts` — check it first):

```typescript
import { PendingApprovalRegistry } from '@legion-collective/core';

describe('list_pending_approvals', () => {
  it('returns pending approvals across conversations', async () => {
    const registry = makeApprovalRegistry(); // fixture helper you add, e.g. MemoryStorage-backed
    await registry.create({
      conversationId: 'conv-1',
      requesterId: 'agent-a',
      tool: 'file_write',
      args: { path: '/x' },
    });
    await registry.create({
      conversationId: 'conv-2',
      requesterId: 'agent-b',
      tool: 'shell',
      args: {},
    });
    const tools = createRuntimeTools(makeDeps({ pendingApprovalRegistry: registry }));
    const tool = tools.find((t) => t.name === 'list_pending_approvals')!;
    const result = await tool.execute({}, makeContext());
    expect(result.status).toBe('success');
    expect((result.data as unknown[]).length).toBe(2);
  });

  it('filters by conversationId', async () => {
    const registry = makeApprovalRegistry();
    await registry.create({
      conversationId: 'conv-1',
      requesterId: 'agent-a',
      tool: 'file_write',
      args: { path: '/x' },
    });
    await registry.create({
      conversationId: 'conv-2',
      requesterId: 'agent-b',
      tool: 'shell',
      args: {},
    });
    const tools = createRuntimeTools(makeDeps({ pendingApprovalRegistry: registry }));
    const tool = tools.find((t) => t.name === 'list_pending_approvals')!;
    const result = await tool.execute({ conversationId: 'conv-1' }, makeContext());
    expect(result.status).toBe('success');
    const data = result.data as Array<{ conversationId: string }>;
    expect(data.length).toBe(1);
    expect(data[0].conversationId).toBe('conv-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/runtime/src/server/runtime-tools.test.ts`
Expected: FAIL — `createRuntimeTools` does not accept `pendingApprovalRegistry` / no `list_pending_approvals` tool found.

- [ ] **Step 3: Implement**

In `runtime-tools.ts`, extend the deps interface and imports:

```typescript
import type { PendingApprovalRegistry } from '@legion-collective/core';

interface RuntimeToolDeps {
  systemStore: SystemProviderStore;
  systemRouting: RoutingConfig;
  workspaceRouting: RoutingConfig;
  saveSystemRouting: (routing: RoutingConfig) => Promise<void>;
  saveWorkspaceRouting: (routing: RoutingConfig) => Promise<void>;
  pendingApprovalRegistry: PendingApprovalRegistry;
}
```

and add to the returned array (before the closing `] satisfies Tool[]`):

```typescript
    {
      name: 'list_pending_approvals',
      description:
        'List pending approval requests, optionally scoped to one conversation. ' +
        'Drives the global pending-approvals badge.',
      parameters: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'Scope to one conversation.' },
        },
        required: [],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const { conversationId } = (rawArgs ?? {}) as { conversationId?: string };
          const pending = pendingApprovalRegistry.listPending(conversationId);
          return { status: 'success', data: pending };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },
```

In `LegionProcess.ts` (~line 248) pass `pendingApprovalRegistry` into the `createRuntimeTools({...})` call (the variable already exists in startup scope); add `'list_pending_approvals'` to `RUNTIME_TOOL_NAMES`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/runtime/src/server/runtime-tools.test.ts`
Expected: PASS (all, including the 2 new). Then `npm run typecheck` — 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/server/runtime-tools.ts packages/runtime/src/server/runtime-tools.test.ts \
  packages/runtime/src/LegionProcess.ts
git commit -m "feat(runtime): list_pending_approvals tool (spec §7)"
```

### Task 4: `list_mcp_sources` + `save_mcp_sources` runtime tools (test-first)

**Files:**

- Modify: `packages/runtime/src/server/runtime-tools.ts`
- Modify: `packages/runtime/src/server/runtime-tools.test.ts`
- Modify: `packages/runtime/src/LegionProcess.ts` (wire two closures; add both names to `RUNTIME_TOOL_NAMES`)

**Interfaces:**

- Consumes: `MCPServerConfig` (types, existing — `name` required; stdio `command`/`args`/`env` XOR http `url`/`headers`).
- Produces (Tasks 19–20 consume these):
  - `list_mcp_sources {}` → `ToolResult{ status: 'success', data: MCPServerConfig[] }` — returns what the running process loaded (merged config), cloned.
  - `save_mcp_sources { servers: MCPServerConfig[] }` → `ToolResult{ status: 'success', data: { saved: number } }` — validates then persists the FULL list (full-replacement semantics, matching `save_routing`). Validation errors: not an array; entry without `name`; entry with neither `command` nor `url`; entry with both; duplicate names. Takes effect on process restart (no live reload) — say so in the tool description.
  - `RuntimeToolDeps` gains `getMCPServers: () => Promise<MCPServerConfig[]>` and `saveMCPServers: (servers: MCPServerConfig[]) => Promise<void>` (closure-injected, mirroring `saveSystemRouting`/`saveWorkspaceRouting` — keeps file IO out of the tool module).

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime/src/server/runtime-tools.test.ts` (extend the existing deps fixture with `getMCPServers`/`saveMCPServers` in-memory closures):

```typescript
describe('mcp source tools', () => {
  it('list_mcp_sources returns the configured servers', async () => {
    const servers = [{ name: 'fs', command: 'npx', args: ['-y', '@mcp/fs'] }];
    const tools = createRuntimeTools(makeDeps({ getMCPServers: async () => servers }));
    const tool = tools.find((t) => t.name === 'list_mcp_sources')!;
    const result = await tool.execute({}, makeContext());
    expect(result.status).toBe('success');
    expect(result.data).toEqual(servers);
  });

  it('save_mcp_sources persists a valid full list', async () => {
    let stored: unknown[] = [];
    const tools = createRuntimeTools(makeDeps({ saveMCPServers: async (s) => void (stored = s) }));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute(
      {
        servers: [
          { name: 'fs', command: 'npx' },
          { name: 'http-one', url: 'http://localhost:3000/mcp' },
        ],
      },
      makeContext(),
    );
    expect(result.status).toBe('success');
    expect(stored.length).toBe(2);
  });

  it('save_mcp_sources rejects entries without name', async () => {
    const tools = createRuntimeTools(makeDeps({}));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute({ servers: [{ command: 'npx' }] }, makeContext());
    expect(result.status).toBe('error');
    expect(result.error).toContain('name');
  });

  it('save_mcp_sources rejects entries with both command and url', async () => {
    const tools = createRuntimeTools(makeDeps({}));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute(
      { servers: [{ name: 'x', command: 'npx', url: 'http://x' }] },
      makeContext(),
    );
    expect(result.status).toBe('error');
  });

  it('save_mcp_sources rejects duplicate names', async () => {
    const tools = createRuntimeTools(makeDeps({}));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute(
      {
        servers: [
          { name: 'x', command: 'a' },
          { name: 'x', command: 'b' },
        ],
      },
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('duplicate');
  });

  it('save_mcp_sources rejects non-array payloads', async () => {
    const tools = createRuntimeTools(makeDeps({}));
    const tool = tools.find((t) => t.name === 'save_mcp_sources')!;
    const result = await tool.execute({ servers: 'nope' }, makeContext());
    expect(result.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/runtime/src/server/runtime-tools.test.ts`
Expected: FAIL — the two tool names are not found in the returned array.

- [ ] **Step 3: Implement**

In `runtime-tools.ts` extend `RuntimeToolDeps` with the two closures and add to the returned array:

```typescript
    {
      name: 'list_mcp_sources',
      description:
        'List MCP server declarations the process was started with (from workspace config).',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          return { status: 'success', data: await getMCPServers() };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'save_mcp_sources',
      description:
        'Replace ALL MCP server declarations in the workspace config. Takes effect after restart.',
      parameters: {
        type: 'object',
        properties: {
          servers: {
            type: 'array',
            description:
              'Full replacement list of MCPServerConfig entries (name required; command for stdio or url for HTTP).',
            items: { type: 'object' },
          },
        },
        required: ['servers'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const { servers } = rawArgs as { servers: unknown };
          if (!Array.isArray(servers)) throw new Error('servers must be an array');
          const seen = new Set<string>();
          const validated: MCPServerConfig[] = servers.map((entry, index) => {
            const server = entry as Partial<MCPServerConfig>;
            if (typeof server.name !== 'string' || server.name.trim().length === 0) {
              throw new Error(`servers[${index}].name must be a non-empty string`);
            }
            if (seen.has(server.name)) {
              throw new Error(`duplicate MCP server name: ${server.name}`);
            }
            seen.add(server.name);
            if (server.command !== undefined && server.url !== undefined) {
              throw new Error(
                `servers[${index}] (${server.name}): command and url are mutually exclusive`,
              );
            }
            if (server.command === undefined && server.url === undefined) {
              throw new Error(
                `servers[${index}] (${server.name}): needs either command (stdio) or url (HTTP)`,
              );
            }
            return server as MCPServerConfig;
          });
          await saveMCPServers(validated);
          return { status: 'success', data: { saved: validated.length } };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },
```

(De-structure the new deps at the top of `createRuntimeTools` alongside the existing ones. Import `MCPServerConfig` type from `@legion-collective/types`.)

In `LegionProcess.ts`, extend the `createRuntimeTools({...})` call with:

```typescript
      getMCPServers: () => Promise.resolve(structuredClone(mergedConfig.mcpServers ?? [])),
      saveMCPServers: async (servers: MCPServerConfig[]) => {
        const configPath = join(workspaceRoot, '.legion', 'config.json');
        const current = await loadWorkspaceConfig(workspaceRoot);
        current.mcpServers = servers;
        await writeJsonFile(configPath, current);
      },
```

and add `'list_mcp_sources'` + `'save_mcp_sources'` to `RUNTIME_TOOL_NAMES`. Caveat to note in the Config page copy (Task 20): if `.legion/config.local.json` also declares `mcpServers`, it shadows config.json at load — the UI should warn when local overrides exist (detectable: saved list ≠ next `list_mcp_sources` after reload).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/runtime/src/server/runtime-tools.test.ts`
Expected: PASS (all, including the 6 new). Then `npm run typecheck` — 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/server/runtime-tools.ts packages/runtime/src/server/runtime-tools.test.ts \
  packages/runtime/src/LegionProcess.ts
git commit -m "feat(runtime): list_mcp_sources + save_mcp_sources tools (spec §7)"
```

### Task 5: Theme token layer — command-deck + blueprint-light (spec §3.4)

**Files:**

- Create: `packages/web/src/theme/tokens.css`
- Create: `packages/web/src/theme/light.css`
- Create: `packages/web/src/theme/useTheme.ts`
- Create: `packages/web/src/theme/useTheme.test.ts`
- Modify: `packages/web/src/assets/style.css` (replace `@theme` navy block with an import of the new token files; keep the `.md-content` prose styles)
- Modify: `packages/web/src/main.ts` (initialize theme before mount)

**Interfaces:**

- Produces (every later UI task consumes):
  - Token vocabulary (CSS custom properties, defined in `tokens.css`, overridden in `light.css`): `--color-bg` (app background), `--color-surface` (panels/cards), `--color-surface-raised` (modals/menus), `--color-border`, `--color-border-strong`, `--color-text` (primary), `--color-text-muted` (secondary), `--color-text-faint` (placeholders), `--color-accent` (cyan), `--color-accent-strong` (hover), `--color-accent-soft` (tinted bg), `--color-on-accent` (text on accent), `--color-danger`, `--color-warning`, `--color-success`, `--font-mono`, `--font-sans`, `--radius-sm/md/lg`.
  - `data-theme` attribute on `<html>`: `'command-deck'` (default, set in tokens.css via `:root`) and `'blueprint-light'` (overrides in `light.css` under `[data-theme='blueprint-light']`).
  - `useTheme(): { theme: Ref<'command-deck' | 'blueprint-light'>; setTheme(t): void }` — module-scoped state (spec §3.3 pattern), persisted in localStorage key `legion-theme`, writes `document.documentElement.dataset.theme`, defaults `'command-deck'`.
- Command-deck values (from the approved mockup, `.superpowers/brainstorm/700951-1791410143/content/04-visual-style.html` style card B): bg `#0a0e1a`, surface `#101828`, surface-raised `#0d1424`, border `#1e2d4d`, border-strong `#38e1ff33`, text `#c9d6ea`, text-muted `#5f7392`, text-faint `#3d4f6b`, accent `#38e1ff`, accent-strong `#7deaff`, accent-soft `rgba(56,225,255,.12)`, on-accent `#05080f`, danger `#ff6b6b`, warning `#ffb454`, success `#4ade80`, `--font-mono: 'JetBrains Mono', ui-monospace, monospace`, `--font-sans: 'Inter', system-ui, sans-serif`.
- Blueprint-light (mockup `05-light-theme.html` direction): bg paper `#fafbfc`, surface `#ffffff`, border `#dde3ea`, text `#1a2332`, same cyan family accent `#0891b2` (darker cyan for contrast on light), mono where it reads well (tool surfaces stay `--font-mono`).

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/theme/useTheme.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { useTheme } from './useTheme.js';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to command-deck and sets the attribute', () => {
    const { theme } = useTheme();
    expect(theme.value).toBe('command-deck');
    expect(document.documentElement.dataset.theme).toBe('command-deck');
  });

  it('setTheme switches and persists', () => {
    const first = useTheme();
    first.setTheme('blueprint-light');
    expect(document.documentElement.dataset.theme).toBe('blueprint-light');
    // module-scoped state: a fresh call sees the same theme
    const second = useTheme();
    expect(second.theme.value).toBe('blueprint-light');
    expect(localStorage.getItem('legion-theme')).toBe('blueprint-light');
  });

  it('restores the persisted theme on init', () => {
    localStorage.setItem('legion-theme', 'blueprint-light');
    // simulate a fresh module graph: initTheme is idempotent-safe to call again
    const { theme, initTheme } = useTheme();
    initTheme();
    expect(theme.value).toBe('blueprint-light');
    expect(document.documentElement.dataset.theme).toBe('blueprint-light');
  });

  it('ignores unknown persisted values', () => {
    localStorage.setItem('legion-theme', 'solarized');
    const { theme, initTheme } = useTheme();
    initTheme();
    expect(theme.value).toBe('command-deck');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/web -- src/theme/useTheme.test.ts`
Expected: FAIL — `./useTheme.js` not found.

- [ ] **Step 3: Implement the token files**

`packages/web/src/theme/tokens.css`:

```css
/* Command-deck (default dark) — the only place dark colors are defined. */
:root,
[data-theme='command-deck'] {
  --color-bg: #0a0e1a;
  --color-surface: #101828;
  --color-surface-raised: #0d1424;
  --color-border: #1e2d4d;
  --color-border-strong: rgba(56, 225, 255, 0.2);
  --color-text: #c9d6ea;
  --color-text-muted: #5f7392;
  --color-text-faint: #3d4f6b;
  --color-accent: #38e1ff;
  --color-accent-strong: #7deaff;
  --color-accent-soft: rgba(56, 225, 255, 0.12);
  --color-on-accent: #05080f;
  --color-danger: #ff6b6b;
  --color-warning: #ffb454;
  --color-success: #4ade80;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
}

/* Expose tokens as Tailwind 4 theme utilities (bg-surface, text-muted, border-line, ...). */
@theme inline {
  --color-bg: var(--color-bg);
  --color-surface: var(--color-surface);
  --color-surface-raised: var(--color-surface-raised);
  --color-line: var(--color-border);
  --color-line-strong: var(--color-border-strong);
  --color-ink: var(--color-text);
  --color-muted: var(--color-text-muted);
  --color-faint: var(--color-text-faint);
  --color-accent: var(--color-accent);
  --color-accent-strong: var(--color-accent-strong);
  --color-accent-soft: var(--color-accent-soft);
  --color-on-accent: var(--color-on-accent);
  --color-danger: var(--color-danger);
  --color-warning: var(--color-warning);
  --color-success: var(--color-success);
  --font-mono: var(--font-mono);
  --font-sans: var(--font-sans);
  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
}
```

`packages/web/src/theme/light.css`:

```css
/* Blueprint-light — overrides the same variables, never introduces new names. */
[data-theme='blueprint-light'] {
  --color-bg: #fafbfc;
  --color-surface: #ffffff;
  --color-surface-raised: #f1f4f8;
  --color-border: #dde3ea;
  --color-border-strong: rgba(8, 145, 178, 0.35);
  --color-text: #1a2332;
  --color-text-muted: #5c6b7f;
  --color-text-faint: #90a0b2;
  --color-accent: #0891b2;
  --color-accent-strong: #06a5c9;
  --color-accent-soft: rgba(8, 145, 178, 0.1);
  --color-on-accent: #ffffff;
  --color-danger: #dc2626;
  --color-warning: #b45309;
  --color-success: #16a34a;
}
```

`packages/web/src/theme/useTheme.ts`:

```typescript
import { ref } from 'vue';

export type ThemeName = 'command-deck' | 'blueprint-light';
const STORAGE_KEY = 'legion-theme';

const theme = ref<ThemeName>('command-deck');
let initialized = false;

function isThemeName(value: unknown): value is ThemeName {
  return value === 'command-deck' || value === 'blueprint-light';
}

function apply(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
}

export function useTheme() {
  function initTheme(): void {
    if (initialized) return;
    initialized = true;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isThemeName(stored)) theme.value = stored;
    apply(theme.value);
  }

  function setTheme(next: ThemeName): void {
    theme.value = next;
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  }

  return { theme, setTheme, initTheme };
}
```

- [ ] **Step 4: Wire into the app**

In `packages/web/src/assets/style.css`, replace the `@theme { --color-navy-… }` block with:

```css
@import '../theme/tokens.css';
@import '../theme/light.css';
```

(keep everything below the `@theme` block — the `.md-content` prose styles stay). In `packages/web/src/main.ts`, before `app.mount(...)`:

```typescript
import { useTheme } from './theme/useTheme.js';
// ...
useTheme().initTheme();
```

Note: Tailwind 4's `@theme inline` maps utility names to the CSS variables so runtime theme switches are pure variable redefinitions — no rebuild, no class swap (spec §3.4). If `@theme inline` is not supported by the installed Tailwind version, use plain `@theme` and verify in the browser that switching `data-theme` re-themes; the mechanism is what matters, the exact at-rule is the implementation detail. Components must reference utilities like `bg-surface text-ink border-line` or `var(--color-…)` — never hex.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web -- src/theme/useTheme.test.ts`
Expected: PASS (4 tests). Also `npm run build --workspace=packages/web` once to prove Tailwind accepts the token files — expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/theme packages/web/src/assets/style.css packages/web/src/main.ts
git commit -m "feat(web): theme token layer — command-deck + blueprint-light (spec §3.4)"
```

### Task 6: `useLegionApi` foundation composable (spec §3.3)

**Files:**

- Create: `packages/web/src/composables/useLegionApi.ts`
- Create: `packages/web/src/composables/useLegionApi.test.ts`
- Modify: delete later in Task 7 (`useExecute.ts` consumers migrate there first)

**Interfaces:**

- Consumes: existing `useAuth` login/logout/getToken logic, existing `useWebSocket` (its module-scoped singleton), router.
- Produces (the foundation everything composes with):
  - `useLegionApi(): { execute<T>(tool: string, args?: unknown): Promise<T>; login(name, password): Promise<void>; logout(): void; onEvent(type: string, handler: (data) => void): () => void; connectionId: Ref<string | null>; connected: Ref<boolean> }`
  - `execute` = typed `POST /api/execute?stream=false` wrapper: throws on HTTP error, throws `Error(data.result.error)` on `status: 'error'`, returns `data.result.data as T`, and on 401 logs out + routes to `/login`.
  - `onEvent(type, handler)` — typed subscription over the WS bus: internally subscribes to `useWebSocket().onMessage` and filters `msg.type === type`. Returns unsubscribe.
  - This is a merge of today's `useExecute` + login/session handling + the WS event bus facade — ONE foundation instead of every composable rolling its own (spec §3.3). `useWebSocket`/`useAuth` remain as the transport/session primitives underneath; `useLegionApi` is the only thing feature composables import.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/composables/useLegionApi.test.ts` (mock `fetch` with `vi.stubGlobal`, reuse the mocking pattern from `useExecute.test.ts`):

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useLegionApi } from './useLegionApi.js';

// useAuth reads localStorage; seed a valid token so isAuthenticated is true
function seedToken() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
}

describe('useLegionApi.execute', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    seedToken();
  });

  it('posts the tool call and unwraps result.data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'success', data: { id: 'x' } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { execute } = useLegionApi();
    const data = await execute<{ id: string }>('list_participants', {});
    expect(data).toEqual({ id: 'x' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/execute?stream=false');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ tool: 'list_participants', args: {} });
    expect(init.headers.Authorization).toBe('Bearer tok-123');
  });

  it('throws the tool error message on status:error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'error', error: 'boom' } }), {
          status: 200,
        }),
      ),
    );
    const { execute } = useLegionApi();
    await expect(execute('nope', {})).rejects.toThrow('boom');
  });

  it('logs out and rethrows on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })));
    const { execute, isAuthenticated } = useLegionApi();
    await expect(execute('list_participants', {})).rejects.toThrow('Unauthorized');
    expect(isAuthenticated.value).toBe(false);
  });
});

describe('useLegionApi.onEvent', () => {
  it('filters bus messages by type and unsubscribes', () => {
    // uses the mocked WebSocket transport from useWebSocket.test.ts patterns;
    // see that file for the happy-dom WS stub setup and reuse it here.
    seedToken();
    const { onEvent } = useLegionApi();
    const seen: unknown[] = [];
    const off = onEvent('approval:requested', (d) => seen.push(d));
    // dispatch through the transport exactly the way useWebSocket.test.ts does
    // (construct a WebSocket instance against the stubbed happy-dom server and
    //  emit a message frame {type: 'approval:requested', data: {...}}).
    off();
    expect(seen).toEqual([]); // after unsubscribe nothing arrives
  });
});
```

(Executor note: fill the last test's dispatch section by copying the WebSocket mock harness from `packages/web/src/composables/useWebSocket.test.ts` — that file already contains a working happy-dom WS stub; import/reuse its helper rather than writing a new one.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/web -- src/composables/useLegionApi.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { computed, ref, type Ref } from 'vue';
import { useAuth } from './useAuth.js';
import { useWebSocket } from './useWebSocket.js';
import { router } from '../router/index.js';

type EventHandler = (data: unknown) => void;

export function useLegionApi() {
  const auth = useAuth();
  const ws = useWebSocket();
  const connected = computed(() => ws.getConnectionId() !== null);
  const connectionId: Ref<string | null> = computed(() => ws.getConnectionId()) as Ref<
    string | null
  >;

  async function execute<T>(tool: string, args: unknown = {}): Promise<T> {
    const res = await fetch('/api/execute?stream=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.getToken() ?? ''}`,
      },
      body: JSON.stringify({ tool, args }),
    });
    if (res.status === 401) {
      auth.logout();
      void router.push('/login');
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { result: { status: string; data?: T; error?: string } };
    if (data.result.status === 'error') throw new Error(data.result.error ?? 'Tool error');
    return data.result.data as T;
  }

  async function login(name: string, password: string): Promise<void> {
    await auth.login(name, password);
    ws.connect();
  }

  function logout(): void {
    ws.disconnect();
    auth.logout();
  }

  function onEvent(type: string, handler: EventHandler): () => void {
    return ws.onMessage((msg) => {
      const typed = msg as Record<string, unknown>;
      if (typed['type'] === type) handler(typed['data']);
    });
  }

  return {
    execute,
    login,
    logout,
    onEvent,
    connected,
    connectionId,
    isAuthenticated: auth.isAuthenticated,
  };
}
```

(Adjust `isAuthenticated` exposure to whatever feature composables need; keep the returned surface stable — later tasks import exactly `{ execute, login, logout, onEvent, connected }`.)

- [ ] **Step 4: Verify no regressions in existing composable tests**

Run: `npm run test --workspace=packages/web`
Expected: PASS — existing `useExecute`/`useAuth`/`useWebSocket` tests still green (this task ADDS the foundation; consumers migrate in Task 7+, and `useExecute` is deleted in Task 21 once nothing imports it).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/composables/useLegionApi.ts packages/web/src/composables/useLegionApi.test.ts
git commit -m "feat(web): useLegionApi foundation composable (spec §3.3)"
```

### Task 7: Router + AppShell — nav tabs, badge, avatar dropdown, account slide-over (spec §3.1)

**Files:**

- Modify: `packages/web/src/router/index.ts` (new route table)
- Create: `packages/web/src/shell/AppShell.vue`
- Create: `packages/web/src/shell/NavBadge.vue`
- Create: `packages/web/src/shell/AccountSlideOver.vue`
- Modify: `packages/web/src/App.vue` (render AppShell around router-view)
- Test: `packages/web/src/shell/AppShell.test.ts`
- Delete: `packages/web/src/views/EventStreamView.vue`, `packages/web/src/components/events/EventDetailPanel.vue` (event log dies — spec §2)
- Modify: `packages/web/src/components/layout/AppLayout.vue` — DELETE (AppShell replaces it); update all current views' imports in the same commit

**Interfaces:**

- Consumes: `useLegionApi().onEvent('approval:requested' | 'approval:resolved', …)`; `useApprovals` from Task 12 (stub it if built before that task — see order note below); existing `useAuth`.
- Produces:
  - Route table: `/` + `/chat` → ChatView; `/participants`; `/processes`; `/config`; `/login`. All auth-gated except `/login` (keep the existing `requiresAuth` guard mechanism, defaulting `/` to redirect `/chat`).
  - `AppShell` — top nav with icon+label tabs: 💬 Chat, 👥 Participants, 🗂 Processes, ⚙️ Config (router-links, active state via `router-link-active`); `NavBadge` count slot; avatar dropdown (top right) with "Account" (opens slide-over) and "Logout".
  - `NavBadge.vue` — props `count: number`; renders nothing at 0; deep-links to the conversation with the oldest pending approval on click (prop `targetConversationId: string | null`).
  - `AccountSlideOver.vue` — wraps existing `components/common/SlideOver.vue`; change-own-password form (new + confirm, min 8 chars + match validation, calls `execute('set_credential', { participantId, secret })`), session info (participant id, login expiry), logout button.
  - Mobile (<768px): nav collapses to icons only (badge retained) — CSS-only via Tailwind responsive utilities.
- Build order note: if Tasks are executed in order, Task 12's `useApprovals` does not exist yet. Write AppShell against the interface `useApprovals(): { pendingCount: Ref<number>; oldest: Ref<{ conversationId: string } | null> }` and create a TEMPORARY module-scoped stub in `composables/useApprovals.ts` returning zeros (with a `// TODO(task-12)` comment) that Task 12 replaces wholesale. The shell's unit tests assert the stub-driven zeros; badge behavior with real data is covered in Task 12.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/shell/AppShell.test.ts` (mount with router; pattern from `ConversationsView.test.ts`):

```typescript
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import AppShell from './AppShell.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: { template: '<div id="chat-stub">chat</div>' } },
    { path: '/participants', component: { template: '<div>participants</div>' } },
    { path: '/processes', component: { template: '<div>processes</div>' } },
    { path: '/config', component: { template: '<div>config</div>' } },
  ],
});

describe('AppShell', () => {
  it('renders the four nav tabs with labels', async () => {
    await router.push('/');
    await router.isReady();
    const wrapper = mount(AppShell, { global: { plugins: [router] } });
    const nav = wrapper.find('nav');
    expect(nav.text()).toContain('Chat');
    expect(nav.text()).toContain('Participants');
    expect(nav.text()).toContain('Processes');
    expect(nav.text()).toContain('Config');
  });

  it('hides the badge at zero pending approvals', () => {
    const wrapper = mount(AppShell, { global: { plugins: [router] } });
    expect(wrapper.findComponent({ name: 'NavBadge' }).isVisible()).toBe(false);
  });

  it('shows a numeric badge and links to the oldest approval conversation', async () => {
    // seed the module-scoped approvals state (helper on the composable, Task 7 stub provides it)
    const { useApprovals } = await import('../composables/useApprovals.js');
    useApprovals().__setPendingForTests([{ conversationId: 'conv-9' }]);
    const wrapper = mount(AppShell, { global: { plugins: [router] } });
    const badge = wrapper.findComponent({ name: 'NavBadge' });
    expect(badge.props('count')).toBe(1);
    expect(badge.props('targetConversationId')).toBe('conv-9');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/web -- src/shell/AppShell.test.ts`
Expected: FAIL — `AppShell.vue` / `useApprovals.js` missing.

- [ ] **Step 3: Implement the shell**

`packages/web/src/shell/AppShell.vue` (template sketch — tokens only, no hex):

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useAuth } from '../composables/useAuth.js';
import { useApprovals } from '../composables/useApprovals.js';
import NavBadge from './NavBadge.vue';
import AccountSlideOver from './AccountSlideOver.vue';

const router = useRouter();
const { logout } = useLegionApi();
const { participantId } = useAuth();
const { pendingCount, oldest } = useApprovals();
const accountOpen = ref(false);
const menuOpen = ref(false);

function badgeClick() {
  if (oldest.value) void router.push(`/chat/${oldest.value.conversationId}`);
}
</script>

<template>
  <div class="flex h-screen flex-col bg-bg text-ink">
    <nav class="flex items-center gap-1 border-b border-line px-3 py-2">
      <RouterLink to="/chat" class="px-3 py-1.5 rounded-md text-sm hover:bg-surface">
        <span aria-hidden="true">💬</span><span class="ml-1.5 max-md:hidden">Chat</span>
      </RouterLink>
      <RouterLink to="/participants" class="px-3 py-1.5 rounded-md text-sm hover:bg-surface">
        <span aria-hidden="true">👥</span><span class="ml-1.5 max-md:hidden">Participants</span>
      </RouterLink>
      <RouterLink to="/processes" class="px-3 py-1.5 rounded-md text-sm hover:bg-surface">
        <span aria-hidden="true">🗂</span><span class="ml-1.5 max-md:hidden">Processes</span>
      </RouterLink>
      <RouterLink to="/config" class="px-3 py-1.5 rounded-md text-sm hover:bg-surface">
        <span aria-hidden="true">⚙️</span><span class="ml-1.5 max-md:hidden">Config</span>
      </RouterLink>
      <NavBadge
        :count="pendingCount"
        :target-conversation-id="oldest?.conversationId ?? null"
        @activate="badgeClick"
      />
      <div class="ml-auto relative">
        <button
          type="button"
          data-test="avatar"
          class="rounded-full size-8 bg-accent-soft text-accent"
          @click="menuOpen = !menuOpen"
        >
          {{ (participantId ?? '?').slice(0, 1).toUpperCase() }}
        </button>
        <div
          v-if="menuOpen"
          class="absolute right-0 mt-1 rounded-md border border-line bg-surface-raised py-1 text-sm"
        >
          <button
            type="button"
            class="block w-full px-3 py-1.5 text-left hover:bg-surface"
            @click="
              accountOpen = true;
              menuOpen = false;
            "
          >
            Account…
          </button>
          <button
            type="button"
            class="block w-full px-3 py-1.5 text-left hover:bg-surface"
            @click="logout()"
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
    <main class="min-h-0 flex-1"><RouterView /></main>
    <AccountSlideOver v-model:open="accountOpen" />
  </div>
</template>
```

`NavBadge.vue`: props `{ count: number; targetConversationId: string | null }`, emit `activate`; render `<button v-if="count > 0" data-test="nav-badge" class="…">{{ count }}</button>` with `@click="emit('activate')"`.

`AccountSlideOver.vue`: use the carried-over `components/common/SlideOver.vue`; password form fields `type="password" autocomplete="new-password"` ×2, validation `v = s.length >= 8 && s === confirm`, on submit `execute('set_credential', { participantId, secret })`, success feedback, error surface from thrown message. Session info block: participantId + token expiry from `useAuth()`.

Router: replace the current route table with the four pages + login (keep hash history and the `requiresAuth` guard; `/` redirects `/chat`; DELETE the `/events`, `/conversations*` entries — old views go away as their replacements land in Tasks 9–21; during the transition keep `/conversations/:id` temporarily pointing at the OLD `ConversationsView` so nothing is broken mid-rewrite, then Task 9 removes it).

- [ ] **Step 4: Update App.vue + delete event-log + fix imports**

`App.vue` becomes `AppShell` + `RouterView`. Delete `EventStreamView.vue` + `EventDetailPanel.vue` and remove their imports/route. Update every view still importing `AppLayout.vue` to import `AppShell` instead (mechanical: ConversationsView, ParticipantsView, ProcessesView, ConfigView keep working under the new shell).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS — new shell tests green; updated view tests still green (they only asserted inner content). `npm run build --workspace=packages/web` — succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): AppShell nav + approvals badge + account slide-over; drop event log (spec §3.1, §2)"
```

### Task 8: `useConversations` + `useParticipants` state composables (spec §3.3)

**Files:**

- Create: `packages/web/src/composables/useConversations.ts`
- Create: `packages/web/src/composables/useConversations.test.ts`
- Create: `packages/web/src/composables/useParticipants.ts`
- Create: `packages/web/src/composables/useParticipants.test.ts`

**Interfaces:**

- Consumes: `useLegionApi` (Task 6: `execute`, `onEvent`, `connected`), `useToolStream` (carried over, unchanged), types `ConversationMeta`, `BaseParticipant` from `@legion-collective/types`.
- Produces:
  - `useConversations(): { conversations: Ref<ConversationMeta[]>; loading: Ref<boolean>; load(): Promise<void>; filter: Ref<{ status: 'active' | 'archived' | 'all'; search: string }>; activeId: Ref<string | null>; select(id: string | null): void; }` — module-scoped refs (spec §3.3); `load()` calls `execute<…>('list_conversations', …)` and applies the filter client-side for `search` (server takes `participantId`/`status`); `select` writes `activeId` only (router sync lives in ChatView).
  - `useParticipants(): { participants: Ref<BaseParticipant[]>; loading: Ref<boolean>; byId(id): BaseParticipant | undefined; load(): Promise<void>; }` — `load()` = `execute<BaseParticipant[]>('list_participants', {})`; `byId` lookup helper.
  - Both export a `__resetForTests()` helper (clears module state) AND `__setConversationsForTests(list)` / `__setParticipantsForTests(list)` (seed module state directly — test files and view tests mount components that read this shared state; helpers live HERE in the composable, never exported from `.vue` SFC files, which cannot carry named exports).

- [ ] **Step 1: Write the failing tests**

`useConversations.test.ts` (fetch mocked via `vi.stubGlobal`, seeded token like Task 6):

```typescript
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useConversations } from './useConversations.js';

const CONVS = [
  {
    id: 'c1',
    title: 'First',
    participants: ['operator', 'agent-a'],
    status: 'active',
    updatedAt: '2026-10-08T00:00:00Z',
    tags: [],
  },
  {
    id: 'c2',
    title: 'Second',
    participants: ['agent-a'],
    status: 'archived',
    updatedAt: '2026-10-07T00:00:00Z',
    tags: [],
  },
];

describe('useConversations', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
    useConversations().__resetForTests();
  });

  it('loads conversations via list_conversations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { conversations: CONVS } } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const store = useConversations();
    await store.load();
    expect(store.conversations.value.length).toBe(2);
    expect(store.loading.value).toBe(false);
  });

  it('search filter narrows the visible list', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ result: { status: 'success', data: { conversations: CONVS } } }),
            { status: 200 },
          ),
        ),
    );
    const store = useConversations();
    await store.load();
    store.filter.value = { status: 'all', search: 'first' };
    expect(store.conversations.value.map((c) => c.id)).toEqual(['c1']);
  });

  it('select sets activeId on the shared module state', async () => {
    const store = useConversations();
    store.select('c2');
    expect(store.activeId.value).toBe('c2');
    expect(useConversations().activeId.value).toBe('c2');
  });
});
```

`useParticipants.test.ts` — same pattern: assert `load()` populates `participants`, `byId` finds/misses correctly, module state is shared across `useParticipants()` calls.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/web -- src/composables/useConversations.test.ts src/composables/useParticipants.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both composables**

`useConversations.ts` core shape (implementation follows the module-scoped pattern proven in `useAuth.ts`):

```typescript
import { computed, ref } from 'vue';
import { useLegionApi } from './useLegionApi.js';
import type { ConversationMeta } from '@legion-collective/types';

const conversations = ref<ConversationMeta[]>([]);
const loading = ref(false);
const activeId = ref<string | null>(null);
const filter = ref<{ status: 'active' | 'archived' | 'all'; search: string }>({
  status: 'active',
  search: '',
});

export function useConversations() {
  async function load(): Promise<void> {
    loading.value = true;
    try {
      const { execute } = useLegionApi();
      const result = await execute<{ conversations: ConversationMeta[] }>('list_conversations', {
        status: filter.value.status,
      });
      conversations.value = result.conversations;
    } finally {
      loading.value = false;
    }
  }
  const visible = computed(() => {
    const q = filter.value.search.trim().toLowerCase();
    if (!q) return conversations.value;
    return conversations.value.filter(
      (c) =>
        (c.title ?? c.id).toLowerCase().includes(q) ||
        c.participants.some((p) => p.toLowerCase().includes(q)),
    );
  });
  return {
    conversations: visible,
    loading,
    load,
    filter,
    activeId,
    select(id: string | null) {
      activeId.value = id;
    },
    __resetForTests() {
      conversations.value = [];
      loading.value = false;
      activeId.value = null;
      filter.value = { status: 'active', search: '' };
    },
  };
}
```

(Note: return `conversations` as the filtered computed so list consumers never re-implement search; keep raw list internal. `useParticipants.ts` is structurally identical with `list_participants` and a `byId` computed map.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS — new tests green, no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/composables/useConversations.ts packages/web/src/composables/useConversations.test.ts \
  packages/web/src/composables/useParticipants.ts packages/web/src/composables/useParticipants.test.ts
git commit -m "feat(web): useConversations + useParticipants state composables (spec §3.3)"
```

### Task 9: ChatView 3-column layout + rebuilt ConversationList (spec §3.2, §4.1)

**Files:**

- Create: `packages/web/src/chat/ChatView.vue`
- Create: `packages/web/src/chat/ConversationList.vue`
- Create: `packages/web/src/chat/ConversationList.test.ts`
- Modify: `packages/web/src/router/index.ts` (`/chat` + `/chat/:id` → ChatView; delete the temporary `/conversations*` routes from Task 7)
- Delete: `packages/web/src/views/ConversationsView.vue` (+ its test) — replaced by ChatView

**Interfaces:**

- Consumes: `useConversations` (Task 8), `useParticipants` (Task 8), `useApprovals` stub (Task 7 — for the per-conversation pending marker; Task 12 upgrades it), `useLegionApi`.
- Produces:
  - `ChatView` — desktop grid: left conversation column (fixed width ~17rem, `border-r`), center thread slot (Task 10's `<Thread>`; placeholder until that task lands), right dock slot (Task 13; placeholder). Mobile (<768px): conversation column becomes an off-canvas drawer toggled by a hamburger button in a slim view header; route param `:id` ↔ `activeId` sync (`watch` both directions; `/chat` with no id = list-only focus on mobile).
  - `ConversationList` — props none (reads the composable directly); emits `select(id)`. Rows: title/name, participant avatars (initials), last-activity relative time, unread dot, pending-approval marker (⚠ count when that conversation has pending approvals — from `useApprovals().pendingByConversation`), sorted by recent activity; search input on top (writes `useConversations().filter.value.search`); "＋ New conversation" pinned at the bottom (emits `select(null)` → route `/chat`).
  - ChatView wires `select` → `router.push('/chat/' + id)` (or `/chat` for null).

- [ ] **Step 1: Write the failing test**

`ConversationList.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ConversationList from './ConversationList.vue';
import { useConversations } from '../composables/useConversations.js';
import { useApprovals } from '../composables/useApprovals.js';

// The list component reads module-scoped composable state; tests seed that state
// through the composables' test helpers (helpers live in the composable modules —
// .vue SFC files cannot carry named exports).
const CONVS = [
  {
    id: 'c1',
    title: 'Deploy chat',
    participants: ['operator', 'agent-a'],
    status: 'active',
    updatedAt: '2026-10-08T01:00:00Z',
    tags: [],
  },
  {
    id: 'c2',
    title: 'Research',
    participants: ['agent-b'],
    status: 'active',
    updatedAt: '2026-10-08T00:30:00Z',
    tags: [],
  },
];

describe('ConversationList', () => {
  beforeEach(() => {
    useConversations().__setConversationsForTests(CONVS);
    useApprovals().__setPendingForTests([]);
  });

  it('renders rows newest-first with title and participants', () => {
    const wrapper = mount(ConversationList);
    const rows = wrapper.findAll('[data-test="conv-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].text()).toContain('Deploy chat');
    expect(rows[0].text()).toContain('agent-a');
  });

  it('marks conversations with pending approvals', () => {
    useApprovals().__setPendingForTests([{ conversationId: 'c2', approvalId: 'a1' }]);
    const wrapper = mount(ConversationList);
    const flagged = wrapper.findAll('[data-test="conv-row"][data-pending="true"]');
    expect(flagged.length).toBe(1);
    expect(flagged[0].attributes('data-id')).toBe('c2');
  });

  it('search input filters rows', async () => {
    const wrapper = mount(ConversationList);
    await wrapper.find('input[type="search"]').setValue('research');
    expect(wrapper.findAll('[data-test="conv-row"]').length).toBe(1);
  });

  it('emits select(null) from the new-conversation button', async () => {
    const wrapper = mount(ConversationList);
    await wrapper.find('[data-test="new-conv"]').trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual([null]);
  });

  it('emits select(id) on row click', async () => {
    const wrapper = mount(ConversationList);
    await wrapper.findAll('[data-test="conv-row"]')[0].trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['c1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/web -- src/chat/ConversationList.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement ConversationList + ChatView**

Implementation notes (component code follows standard SFC + composable patterns established in Tasks 5–8; the list reads `useConversations().conversations` (already search-filtered + status-filtered) and sorts client-side by `updatedAt` desc):

- Relative time helper: small `timeAgo(iso: string): string` local function ("3m", "2h", "5d") — no dependency.
- Participant initials chip: `participants.filter(p => p !== myParticipantId).slice(0,3)`.
- Pending marker data attribute wired to `useApprovals().pendingByConversation` (Task 12 will provide `Map<string, number>`; the Task 7 stub provides an empty map).
- `ChatView.vue` mobile drawer: `drawerOpen` ref; hamburger `@click` in view header; `<aside>` classes `max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:-translate-x-full` + `max-md:translate-x-0` when open; backdrop click closes. Desktop: static column. (Spec §3.2.)
- ChatView template until Tasks 10/13 land: center column shows `<div data-test="thread-placeholder" />`, dock column omitted.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS — list tests green; suite green (ConversationsView test deleted with the view). `npm run build --workspace=packages/web` — succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): ChatView 3-column layout + rebuilt ConversationList (spec §3.2, §4.1)"
```

### Task 10: Thread renderer — typed message parts + tool-call registry (spec §4.2)

**Files:**

- Create: `packages/web/src/chat/Thread.vue`
- Create: `packages/web/src/chat/MessagePart.vue`
- Create: `packages/web/src/chat/ToolCallChip.vue`
- Create: `packages/web/src/renderers/registry.ts`
- Create: `packages/web/src/renderers/registry.test.ts`
- Move: `packages/web/src/renderers/{Json,FileTree,SearchResult,ToolResult}Renderer.vue` stay in place (re-used); delete `packages/web/src/renderers/index.ts` (replaced by `registry.ts`) after migrating its one consumer (`ToolCallBlock.vue` dies this task)
- Delete: `packages/web/src/components/conversations/{ConversationThread,MessageBubble,SubThreadBlock,ToolCallBlock}.vue` (+ tests) — replaced by Thread/MessagePart/ToolCallChip
- Create: `packages/web/src/chat/Thread.test.ts`

**Interfaces:**

- Consumes: `get_conversation` (returns conversation + active chain; message shape `MessageData` incl. `toolCalls?: ToolCallData[]`, `toolResults?: ToolCallResult[]`, `reasoning?`, `alternates` via the existing `withAlternates` server-side enrichment — see `management-tools.ts` `MessageWithAlternates`); `useConversation`-style streaming via carried-over `useToolStream('communicate', …)`; `MarkdownContent` (carried over); `ReasoningDisclosure` (carried over).
- Produces:
  - `registry.ts` (the §4.2 renderer registry, evolving today's regex list into the tool-name-keyed pattern):
    ```typescript
    import type { Component } from 'vue';
    import JsonRenderer from './JsonRenderer.vue';
    import FileTreeRenderer from './FileTreeRenderer.vue';
    import SearchResultRenderer from './SearchResultRenderer.vue';
    import TextResultRenderer from './TextResultRenderer.vue';

    export interface RendererEntry {
      pattern: RegExp;
      component: Component;
    }
    const registry: RendererEntry[] = [
      { pattern: /^communicate$/, component: TextResultRenderer }, // sub-chat handled by panel, Task 13
      { pattern: /^mcp__web-search__/, component: SearchResultRenderer },
      { pattern: /^mcp__filesystem__list_/, component: FileTreeRenderer },
      { pattern: /^mcp__filesystem__read_/, component: JsonRenderer },
    ];
    export function registerRenderer(pattern: RegExp, component: Component): void {
      registry.unshift({ pattern, component });
    }
    export function lookupRenderer(toolName: string): Component {
      return registry.find((r) => r.pattern.test(toolName))?.component ?? JsonRenderer;
    }
    ```
    (Plus `TextResultRenderer.vue`: renders string results with `ansi_up` for ANSI output — the shell/process tool block from §4.2. Create it this task; it's 20 lines.)
  - `Thread.vue` — props `conversationId: string | null`; renders the active chain as `MessagePart` sequence; loads via `get_conversation`; appends stream chunks via `useToolStream('communicate', …)` for live tokens (streaming UX completed in Task 12; this task renders loaded + streamed state correctly).
  - `MessagePart.vue` — props `message: MessageWithAlternates`; renders `reasoning` via ReasoningDisclosure, `content` via MarkdownContent, each `toolCalls[i]` as a `ToolCallChip`, matching `toolResults[i]` resolved through `lookupRenderer(toolName)` inside a collapsible detail (the "unknown tools → generic collapsible detail" fallback).
  - `ToolCallChip.vue` — props `{ tool: string; status: 'running' | 'done' | 'error' }`; emits `open(tool, payload)`; click → dock (Task 13 consumes); shows running state (pulse) while the message is mid-stream.

- [ ] **Step 1: Write the failing tests**

`registry.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { lookupRenderer, registerRenderer } from './registry.js';
import JsonRenderer from './JsonRenderer.vue';
import SearchResultRenderer from './SearchResultRenderer.vue';

describe('renderer registry', () => {
  it('resolves exact tool names', () => {
    expect(lookupRenderer('communicate')).not.toBe(JsonRenderer); // TextResultRenderer
  });

  it('resolves MCP patterns', () => {
    expect(lookupRenderer('mcp__web-search__search')).toBe(SearchResultRenderer);
  });

  it('falls back to JsonRenderer for unknown tools', () => {
    expect(lookupRenderer('totally_unknown_tool')).toBe(JsonRenderer);
  });

  it('registerRenderer entries win over defaults (unshifted)', () => {
    const Fake = { template: '<div />' };
    registerRenderer(/^communicate$/, Fake);
    expect(lookupRenderer('communicate')).toBe(Fake);
  });
});
```

`Thread.test.ts` (mount with a mocked `get_conversation` fetch returning a two-message chain, one with `toolCalls: [{ id: 'tc1', name: 'mcp__filesystem__read_file', arguments: {} }]` and a matching `toolResults`; assert: text renders via `.md-content`, tool chip shows tool name, result content appears, chip click emits `open`):

```typescript
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import Thread from './Thread.vue';

// …seed token + stub fetch with a get_conversation payload (see Tasks 6/8 pattern)…

describe('Thread', () => {
  beforeEach(() => {
    /* token seed + fetch stub as in Task 8 */
  });

  it('renders text parts as markdown and tool calls as chips', async () => {
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));
    expect(wrapper.find('.md-content').exists()).toBe(true);
    const chip = wrapper.find('[data-test="tool-chip"]');
    expect(chip.text()).toContain('mcp__filesystem__read_file');
  });

  it('emits open(tool, payload) on chip click', async () => {
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => wrapper.find('[data-test="tool-chip"]').exists());
    await wrapper.find('[data-test="tool-chip"]').trigger('click');
    expect(wrapper.emitted('open')?.[0]?.[0]).toBe('mcp__filesystem__read_file');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/web -- src/renderers/registry.test.ts src/chat/Thread.test.ts`
Expected: FAIL — registry/Thread not found.

- [ ] **Step 3: Implement**

- Build `registry.ts` exactly as the block above; create `TextResultRenderer.vue` (props `{ result: unknown }`; if `typeof result === 'string'` render `new Updater().ansi_to_html(result)` in a `<pre class="font-mono">`, else JSON.stringify).
- `Thread.vue`: load chain on mount + `conversationId` watch (port the load logic from `useConversation.ts`, kept as-is where possible — it already handles `get_conversation` + optimistic messages + streaming refs); render each chain message with `MessagePart`; thread tail auto-scrolls (`nextTick` + `scrollTop = scrollHeight` on message-count change).
- `MessagePart.vue`: dispatch as described in Interfaces; hover menu slot for Task 11 (`<slot name="actions" :message="message" />`).
- Delete the four replaced components + their tests + `renderers/index.ts`; grep for stragglers: `grep -rn "renderers/index\|MessageBubble\|SubThreadBlock\|ToolCallBlock\|ConversationThread" packages/web/src` must come back empty.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS. `npm run build --workspace=packages/web` — succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): typed-part Thread + renderer registry (spec §4.2)"
```

### Task 11: Forks — inline sibling navigation + message actions (spec §4.3)

**Files:**

- Create: `packages/web/src/chat/ForkControls.vue`
- Create: `packages/web/src/chat/ForkControls.test.ts`
- Create: `packages/web/src/chat/MessageActions.vue`
- Create: `packages/web/src/chat/MessageActions.test.ts`
- Modify: `packages/web/src/chat/Thread.vue` (render ForkControls where the chain passes a message with `alternates`; mount MessageActions in the hover slot)

**Interfaces:**

- Consumes: `edit_message { conversationId, messageId, newContent }` (existing — creates a sibling branch node and returns the enriched chain with `alternates`); `switch_branch { conversationId, messageId }` (existing — activates the sibling); `prune_message` (existing); `generate { conversationId }` (existing — re-run); the `alternates?: Array<{ id, content, timestamp, status }>` field already enriched by `get_conversation`/`edit_message` (verified: `management-tools.ts` `withAlternates`).
- Produces:
  - `ForkControls.vue` — props `{ conversationId: string; message: { id: string; alternates?: Array<{ id: string; content: string }> } }`; renders `‹ 1/2 ›` pager + branch marker chip listing sibling branch names; emits `switch(messageId)`; internally calls `switch_branch` then re-emits `switched` so Thread reloads the chain (ChatGPT-regenerate pattern; NO header branch dropdown — spec §4.3).
  - `MessageActions.vue` — hover menu with Edit (inline textarea → `edit_message`), Re-run (`generate`), Create-branch note (edit IS branch creation; the menu labels it "Edit as new branch"), Prune (`prune_message` with confirm). Emits `mutated` after any action; Thread reloads on `mutated`.

- [ ] **Step 1: Write the failing tests**

`ForkControls.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ForkControls from './ForkControls.vue';

const message = {
  id: 'm1',
  content: 'active version',
  alternates: [{ id: 'alt-1', content: 'other version', timestamp: '', status: 'active' }],
};

describe('ForkControls', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
  });

  it('renders pager with correct position', () => {
    const wrapper = mount(ForkControls, { props: { conversationId: 'c1', message } });
    expect(wrapper.find('[data-test="fork-pager"]').text()).toBe('‹ 1/2 ›');
  });

  it('calls switch_branch and emits switched', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'success', data: {} } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ForkControls, { props: { conversationId: 'c1', message } });
    await wrapper.find('[data-test="fork-next"]').trigger('click');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool).toBe('switch_branch');
    expect(wrapper.emitted('switched')).toBeTruthy();
  });

  it('renders nothing when there are no alternates', () => {
    const wrapper = mount(ForkControls, {
      props: { conversationId: 'c1', message: { id: 'm1', content: 'x' } },
    });
    expect(wrapper.find('[data-test="fork-pager"]').exists()).toBe(false);
  });
});
```

`MessageActions.test.ts` — same fixture style: assert Edit flow calls `edit_message` with the new content; Prune shows a confirm step and then calls `prune_message`; `mutated` emitted after each success.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/web -- src/chat/ForkControls.test.ts src/chat/MessageActions.test.ts`
Expected: FAIL — components not found.

- [ ] **Step 3: Implement**

- `ForkControls.vue`: index state = which alternate is active (0 = the message itself, 1..n = alternates); `‹`/`›` cycle; on change → `execute('switch_branch', { conversationId, messageId: targetId })` → emit `switched`. Branch marker chip: lists alternates by truncated content; click jumps directly.
- `MessageActions.vue`: dropdown on hover button (`⋯`); Edit opens inline textarea pre-filled with content; Save → `edit_message` → emit `mutated`; Re-run → `generate { conversationId }` → emit `mutated`; Prune → confirm → `prune_message { conversationId, messageId }` → emit `mutated`.
- Thread integration: render `<ForkControls>` under a message whenever `message.alternates?.length` (listening for `switched` → reload chain); mount `MessageActions` in the `actions` slot from Task 10.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): inline fork navigation + message actions (spec §4.3)"
```

### Task 12: Approvals + streaming — `useApprovals`, ApprovalCard, Composer, live tokens (spec §4.4–4.6)

**Files:**

- Create: `packages/web/src/composables/useApprovals.ts` (REPLACES the Task 7 stub — same exported name, full implementation + keep `__setPendingForTests` for tests)
- Create: `packages/web/src/composables/useApprovals.test.ts`
- Create: `packages/web/src/chat/ApprovalCard.vue`
- Create: `packages/web/src/chat/ApprovalCard.test.ts`
- Create: `packages/web/src/chat/Composer.vue`
- Create: `packages/web/src/chat/Composer.test.ts`
- Modify: `packages/web/src/chat/Thread.vue` (render ApprovalCard inline where a pending approval's tool call sits; wire streaming states)

**Interfaces:**

- Consumes (verified chunk/event shapes):
  - `list_pending_approvals` (Task 3) → `PendingApproval[]` (`{ approvalId, conversationId, requesterId, tool, args, createdAt }`).
  - WS `approval:requested` → `{ conversationId, participantId, tool, approvalId }` (AgentRuntime.ts:475).
  - WS `approval:resolved` → `{ conversationId, approvalId, approved, decidedByParticipantId }` (AgentRuntime.ts:557/588).
  - `approval_response { approvalId, approved, message? }` (existing core tool) for card actions.
  - Composer: `communicate` streaming via carried-over `useToolStream` (send pattern from `useConversation.ts:145`); `cancel_stream` path via `useToolStream().cancel()`; participants from Task 8 for @-mentions.
- Produces:
  - `useApprovals(): { pending: Ref<PendingApproval[]>; pendingCount: Ref<number>; pendingByConversation: Ref<Map<string, number>>; oldest: Ref<{ conversationId: string; approvalId: string } | null>; refresh(): Promise<void>; }` — `refresh()` = `execute('list_pending_approvals', {})`; `onEvent('approval:requested', …)` appends; `onEvent('approval:resolved', …)` removes by `approvalId`. `__setPendingForTests(list)` mutates module state for tests.
  - `ApprovalCard.vue` — props `{ approval: PendingApproval }`; Approve/Reject buttons + optional reason textarea; on action → `approval_response` → optimistic local removal (WS `approval:resolved` reconciles).
  - `Composer.vue` — textarea (Enter sends, Shift+Enter newline; root element carries `data-test="composer"`); `@` triggers mention autocomplete listing active agents (`useParticipants` filter `type === 'agent' && status !== 'retired'`); tool hints line: tools the CURRENT user's `tools` map exposes (from `useAuth().me` if present — else hidden, never guessed); Stop button visible while `communicateStream.active`, calling `.cancel()`; branch indicator chip showing `useConversations().activeId`'s chain tail ("replying on branch …" from Thread-provided prop `branchLabel: string`); emits `sent(conversationId)`.
  - Nav badge (Task 7 stub) now driven by real data — `useApprovals` full implementation satisfies the interface AppShell already coded against (`pendingCount`, `oldest`).

- [ ] **Step 1: Write the failing tests**

`useApprovals.test.ts`:

```typescript
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useApprovals } from './useApprovals.js';

describe('useApprovals', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
    useApprovals().__setPendingForTests([]);
  });

  it('refresh() loads pending approvals from the tool', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            result: {
              status: 'success',
              data: [
                {
                  approvalId: 'a1',
                  conversationId: 'c1',
                  requesterId: 'agent-a',
                  tool: 'file_write',
                  args: {},
                  createdAt: '2026-10-08T00:00:00Z',
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const store = useApprovals();
    await store.refresh();
    expect(store.pendingCount.value).toBe(1);
    expect(store.oldest.value?.conversationId).toBe('c1');
    expect(store.pendingByConversation.value.get('c1')).toBe(1);
  });

  it('approval:requested event appends; approval:resolved removes', () => {
    const store = useApprovals();
    store.__handleEventForTests('approval:requested', {
      approvalId: 'a2',
      conversationId: 'c2',
      participantId: 'x',
      tool: 'shell',
    });
    expect(store.pendingCount.value).toBe(1);
    store.__handleEventForTests('approval:resolved', {
      approvalId: 'a2',
      conversationId: 'c2',
      approved: true,
      decidedByParticipantId: 'op',
    });
    expect(store.pendingCount.value).toBe(0);
  });
});
```

`ApprovalCard.test.ts`: mount with a fake approval; click Approve → fetch body is `tool: 'approval_response', args: { approvalId: 'a1', approved: true }`; Reject with reason text includes `message: 'reason'`; successful action emits `resolved`.

`Composer.test.ts`: Enter (without shift) emits `send`; Shift+Enter inserts newline; typing `@` shows the agent list and selecting inserts the name; Stop button calls the stream cancel (assert `useToolStream` cancel invoked via spy or emitted `stop`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/web -- src/composables/useApprovals.test.ts src/chat/ApprovalCard.test.ts src/chat/Composer.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

- `useApprovals.ts` per the Interfaces block; the WS subscription happens in a module-level `initApprovals()` called from AppShell mount (or lazily on first `useApprovals()` call — module-scoped, guarded by a boolean, mirroring `useTheme().initTheme()`); `__handleEventForTests` exposes the same reducer the real `onEvent` handlers call.
- `ApprovalCard.vue`: card with tool name + args summary (JSON.stringify truncated), reason textarea collapsed by default, Approve/Reject buttons disabled while in-flight.
- `Composer.vue`: follows `useConversation.ts` send mechanics (optimistic message + `communicateStream.start()`); expose `props: { conversationId: string | null; recipientId: string | null; branchLabel?: string }`.
- Thread: while loading/streaming, render pending approvals for THIS conversation inline at the message whose tool call matches `approval.tool` + `requesterId` (best-effort position; if the tool call is not visible in the loaded chain, render the card at thread tail — documented fallback); streaming tokens append to the in-flight assistant part; tool chips show running state until `tool:result` chunk arrives (chunk types per `useToolStream` / `watch-activity-tool.ts` union: `tool:call | tool:result | iteration | approval:* | error`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS — AppShell badge tests from Task 7 still green against the real composable (interface unchanged).

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): approvals card + composer + live streaming states (spec §4.4–4.6)"
```

### Task 13: Right dock — panel system + tool→panel registry (spec §5)

**Files:**

- Create: `packages/web/src/panels/registry.ts`
- Create: `packages/web/src/panels/registry.test.ts`
- Create: `packages/web/src/panels/DockPanel.vue`
- Create: `packages/web/src/panels/DockPanel.test.ts`
- Create: `packages/web/src/panels/ToolDetailPanel.vue`
- Create: `packages/web/src/panels/CommunicatePanel.vue`
- Modify: `packages/web/src/chat/ChatView.vue` (mount DockPanel; wire chip `open` events)
- Modify: `packages/web/src/chat/ToolCallChip.vue` (emit payload detail on click)
- Modify: `packages/web/src/composables/useConversations.ts` — NO change (dock state lives in its own composable here)

**Interfaces:**

- Consumes: Thread/ToolCallChip `open(tool, payload)` emissions (Task 10); `get_conversation` for CommunicatePanel; renderer registry (Task 10) inside ToolDetailPanel; `localStorage`.
- Produces:
  - Tab model: `interface DockTab { id: string; kind: 'tool-detail' | 'communicate'; title: string; icon: string; payload: Record<string, unknown> }`. `id` = `${kind}:${tool or conversationId}` — duplicates focus the existing tab (spec §5.1).
  - `registry.ts`:
    ```typescript
    import type { Component } from 'vue';
    import ToolDetailPanel from './ToolDetailPanel.vue';
    import CommunicatePanel from './CommunicatePanel.vue';

    export interface PanelEntry {
      component: Component;
      title: (payload: Record<string, unknown>) => string;
    }
    const panels = new Map<string, PanelEntry>();
    export function registerPanel(toolName: string, entry: PanelEntry): void {
      panels.set(toolName, entry);
    }
    export function lookupPanel(toolName: string): PanelEntry {
      return (
        panels.get(toolName) ?? {
          component: ToolDetailPanel,
          title: (p) => String(p['tool'] ?? 'tool'),
        }
      );
    }
    registerPanel('communicate', {
      component: CommunicatePanel,
      title: (p) => `@${String(p['conversationId'] ?? 'chat')}`,
    });
    ```
    Adding a panel for a new tool = one `registerPanel` line (spec §5.2).
  - `useDock()` (exported from `registry.ts`): `{ tabs: Ref<DockTab[]>; activeId: Ref<string | null>; open(tab: Omit<DockTab, 'id'> & { id?: string }): void; close(id: string): void; reorder(from: number, to: number): void; width: Ref<number>; open: boolean }` — module-scoped; `open()` dedupes by id and focuses; persisted per conversation in localStorage key `legion-dock-<conversationId>` (tabs, order, width); `width` resizable via drag handle (min 280px); narrow screens: dock renders full-viewport overlay (`max-md:fixed max-md:inset-0 max-md:z-40`).
  - `DockPanel.vue` — renders the tab strip (icon+title, × close, drag to reorder via native HTML5 DnD — no dependency) + active panel component + resize handle.
  - `ToolDetailPanel.vue` — props `{ payload }`; renders request args, status, duration, and result via `lookupRenderer(payload.tool)` in a collapsible; the fallback panel for most tools.
  - `CommunicatePanel.vue` — props `{ payload }`; fetches the target conversation (`get_conversation`) and renders it with the SAME `Thread` component (props `highlight: { outboundMessageId?: string; replyMessageId?: string }`); highlighted messages get `data-highlight` + accent ring; live streaming included (it mounts its own `communicate` stream listener for that conversation); "jump to message in main thread" breadcrumb emits `jump(messageId)` → ChatView switches route focus.

- [ ] **Step 1: Write the failing tests**

`registry.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { useDock, lookupPanel } from './registry.js';

describe('panel registry', () => {
  it('falls back to ToolDetailPanel for unregistered tools', () => {
    expect(lookupPanel('mystery_tool').component.name).toBeDefined();
    expect(lookupPanel('mystery_tool')).toEqual(lookupPanel('another_unknown'));
  });
});

describe('useDock', () => {
  beforeEach(() => {
    localStorage.clear();
    useDock().__resetForTests();
  });

  it('open() dedupes by id and focuses the existing tab', () => {
    const dock = useDock();
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    expect(dock.tabs.value.length).toBe(1);
    expect(dock.activeId.value).toBe('tool-detail:a');
  });

  it('close() removes a tab and picks a neighbor as active', () => {
    const dock = useDock();
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    dock.open({ kind: 'tool-detail', title: 'B', icon: 'T', payload: { tool: 'b' } });
    dock.close('tool-detail:b');
    expect(dock.tabs.value.length).toBe(1);
    expect(dock.activeId.value).toBe('tool-detail:a');
  });

  it('reorder() moves tabs', () => {
    const dock = useDock();
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    dock.open({ kind: 'tool-detail', title: 'B', icon: 'T', payload: { tool: 'b' } });
    dock.reorder(1, 0);
    expect(dock.tabs.value[0].id).toBe('tool-detail:b');
  });

  it('persists state per conversation', () => {
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    expect(JSON.parse(localStorage.getItem('legion-dock-c1')!)).toEqual(
      expect.objectContaining({ tabs: [expect.objectContaining({ id: 'tool-detail:a' })] }),
    );
  });
});
```

`DockPanel.test.ts`: mount with seeded tabs → strip shows titles; close button calls `dock.close`; narrow viewport class assertions (`max-md:fixed` present in rendered class list); slot renders active panel component (stub component via `lookupPanel` override).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/web -- src/panels/registry.test.ts src/panels/DockPanel.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

- `registry.ts` + `useDock()` exactly per Interfaces; persistence = `watch(tabs/width, …, { deep: true })` writing localStorage; `setConversation(id)` loads that conversation's saved state (or empty).
- `DockPanel.vue`: strip + panel area + resize handle (`@mousedown` → track `mousemove` → set `width`); DnD: `draggable` tab buttons, `dragover` indices, `drop` → `reorder`.
- `ToolDetailPanel.vue`: sections Inputs (pretty-printed args JSON), Status (success/error/pending chip), Timing (from payload result metadata if present), Result (renderer component).
- `CommunicatePanel.vue`: mount `<Thread :conversation-id="payload.conversationId" :highlight="payload">`; Thread gains an optional `highlight` prop this task (`data-highlight` ring + scroll-into-view on mount).
- ChatView integration: right column hosts `<DockPanel v-if="dock.open">`; Thread `@open="onChipOpen"` handler → `dock.open({ kind: entry.component === CommunicatePanel ? 'communicate' : 'tool-detail', title: entry.title(payload), icon: '🔧', payload })`; toggle button on the chat pane edge.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): right dock panel system with tool→panel registry (spec §5)"
```

### Task 14: Participants master-detail — list + agent editor (spec §6.1 part 1)

**Files:**

- Create: `packages/web/src/views/ParticipantsView.vue` (REPLACES the old slide-over-based view of the same name)
- Create: `packages/web/src/views/ParticipantsList.vue`
- Create: `packages/web/src/views/AgentEditor.vue`
- Create: `packages/web/src/views/ParticipantsList.test.ts`
- Create: `packages/web/src/views/AgentEditor.test.ts`
- Delete: `packages/web/src/components/participants/ParticipantSlideOver.vue` (+ test) — replaced by master-detail

**Interfaces:**

- Consumes: `useParticipants` (Task 8); `create_agent`/`modify_agent`/`retire_agent`/`set_tool_policy`/`remove_tool_policy`/`set_participant_middleware` (all existing); `MiddlewareEditor` + `MiddlewareSchemaForm` + `ToolPolicyEditor` + `SkillsSelector` + `middleware-ui-types.ts` (carried over — they are view-agnostic editors); `list_tools`/`list_models` (existing) for editor dropdowns; `set_approval_authority` (Task 2).
- Produces:
  - `ParticipantsView` — master-detail: left `ParticipantsList` (~18rem), right detail pane switching on selected type: `AgentEditor` / `UserEditor` (Task 15) / view-only `ParticipantDetail` (services + mocks; simple config readout). Selection state module-scoped `useParticipantSelection()` in this file or its own module: `{ selectedId: Ref<string | null>; select(id): void }`.
  - `ParticipantsList` — searchable rows: name, `TypeBadge` (agent/user/service/operator styling from the carried-over `TypeBadge.vue`), status dot, model (agents), last activity; "＋ New agent" button opens AgentEditor in create mode.
  - `AgentEditor` — props `{ participantId: string | 'new' }`; form: name, model (from `list_models` grouped by provider, free-text fallback), systemPrompt (textarea), maxIterations, tools/policies (`ToolPolicyEditor` against `list_tools`), middleware (`MiddlewareEditor`), approval authority (Task 2's `set_approval_authority` — wildcard toggle + scoped map editor); Save → `create_agent` or `modify_agent`; Retire button (hidden when `participant.protected`, disabled for self — Task 15 shares this rule; enforce here for agents too).

- [ ] **Step 1: Write the failing tests**

`ParticipantsList.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ParticipantsList from './ParticipantsList.vue';
import { useParticipants } from '../composables/useParticipants.js';

const PARTICIPANTS = [
  {
    id: 'agent-a',
    name: 'Agent A',
    type: 'agent',
    status: 'active',
    tools: {},
    model: { model: 'gpt-4o' },
    systemPrompt: 'x',
    maxIterations: 20,
  },
  { id: 'svc', name: 'Scheduler', type: 'service', status: 'active', tools: {}, module: 'cron' },
  {
    id: 'operator',
    name: 'Operator',
    type: 'user',
    status: 'active',
    tools: {},
    operator: true,
    protected: true,
  },
];

describe('ParticipantsList', () => {
  beforeEach(() => {
    // seed via the composable's test helper (SFC files cannot export helpers)
    useParticipants().__setParticipantsForTests(PARTICIPANTS);
  });

  it('renders rows with type badges and status', () => {
    const wrapper = mount(ParticipantsList);
    const rows = wrapper.findAll('[data-test="participant-row"]');
    expect(rows.length).toBe(3);
    expect(rows[0].text()).toContain('Agent A');
    expect(rows[0].find('[data-test="type-badge"]').text()).toBe('agent');
  });

  it('search filters by name', async () => {
    const wrapper = mount(ParticipantsList);
    await wrapper.find('input[type="search"]').setValue('sched');
    expect(wrapper.findAll('[data-test="participant-row"]').length).toBe(1);
  });

  it('emits select with the participant id', async () => {
    const wrapper = mount(ParticipantsList);
    await wrapper.findAll('[data-test="participant-row"]')[0].trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['agent-a']);
  });

  it('emits create for the new-agent button', async () => {
    const wrapper = mount(ParticipantsList);
    await wrapper.find('[data-test="new-agent"]').trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['new']);
  });
});
```

`AgentEditor.test.ts` — mount with mocked `get_participant` fetch (payload = PARTICIPANTS[0]) + mocked `list_tools`/`list_models`; assert: fields prefill; editing name + Save → fetch body `tool: 'modify_agent'` with `{ id, name, … }`; Save on `participantId === 'new'` → `create_agent`; retire button hidden when `protected: true` fixture, present otherwise.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/web -- src/views/ParticipantsList.test.ts src/views/AgentEditor.test.ts`
Expected: FAIL — components not found.

- [ ] **Step 3: Implement**

- Build per Interfaces; reuse the carried-over editors unchanged (import paths unchanged); `ParticipantsView` wires selection ↔ detail pane with `<component :is="detailFor(selected)">`.
- Delete `ParticipantSlideOff` files; grep for leftover imports (`grep -rn "ParticipantSlideOver" packages/web/src` → empty).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS. `npm run build --workspace=packages/web` — succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): Participants master-detail + agent editor (spec §6.1)"
```

### Task 15: User management — UserEditor + user CRUD rules (spec §6.1 part 2)

**Files:**

- Create: `packages/web/src/views/UserEditor.vue`
- Create: `packages/web/src/views/UserEditor.test.ts`
- Modify: `packages/web/src/views/ParticipantsView.vue` (route `type: 'user'` to UserEditor)
- Delete: `packages/web/src/views/ParticipantsView.vue.bak`-style leftovers — none expected; keep the task clean

**Interfaces:**

- Consumes: `create_user`/`modify_user` (Task 1), `set_credential` (existing), `retire_agent` (existing, applies to users too — spec §6.1), `set_approval_authority` (Task 2), `useAuth().participantId` (self checks), Task 1's exact contracts (full-replacement `tools`, `operator` flag).
- Produces:
  - `UserEditor.vue` — props `{ participantId: string | 'new' }`. Form: name; password set/reset (new + confirm, min 8 + match → `set_credential`; empty fields = leave unchanged); identities read-only list (`participant.identities` → `connector: externalId` rows, no editing — spec §6.1); operator checkbox; tool policies (`ToolPolicyEditor` full-replacement map → `modify_user { tools }`); approval authority (same editor as AgentEditor — extract the shared fragment into `components/common/ApprovalAuthorityEditor.vue` this task and use it in BOTH editors); Retire button with the spec's guard rules.
  - Retire guard rules (spec §6.1, implement as a computed): hidden when `participant.protected === true`; disabled (tooltip "cannot retire yourself") when `participantId === myParticipantId`; disabled (tooltip "last active operator") when `participant.operator && participants.filter(p => p.type === 'user' && p.operator && p.status === 'active').length <= 1`.
  - "＋ New user" button on ParticipantsList (mirror of new-agent) → UserEditor `new` mode → `create_user` (+ optional immediate `set_credential`).

- [ ] **Step 1: Write the failing tests**

`UserEditor.test.ts`:

```typescript
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import UserEditor from './UserEditor.vue';

const USER = {
  id: 'alice',
  name: 'Alice',
  type: 'user',
  status: 'active',
  tools: { communicate: 'auto' },
  operator: false,
  identities: [{ connector: 'web', externalId: 'alice' }],
};

// helper: every test stubs get_participant → USER and seeds the auth token
// (pattern from Tasks 6/8; token participantId seeded as 'operator').

describe('UserEditor', () => {
  beforeEach(() => {
    /* token seed + fetch stub default */
  });

  it('prefills name, operator flag and read-only identities', async () => {
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await vi.waitFor(() =>
      expect((wrapper.find('input[name="name"]').element as HTMLInputElement).value).toBe('Alice'),
    );
    expect(wrapper.find('[data-test="identities"]').text()).toContain('web: alice');
    expect((wrapper.find('input[name="operator"]').element as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('save calls modify_user with full-replacement tools', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'success', data: USER } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await vi.waitFor(() => wrapper.find('form').exists());
    await wrapper.find('button[data-test="save"]').trigger('click');
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(body.tool).toBe('modify_user');
    expect(body.args.tools).toEqual({ communicate: 'auto' });
  });

  it('password fields enforce min 8 + match before calling set_credential', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'success', data: {} } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await vi.waitFor(() => wrapper.find('form').exists());
    await wrapper.find('input[name="new-password"]').setValue('short');
    await wrapper.find('button[data-test="save"]').trigger('click');
    // no set_credential call happened
    expect(
      fetchMock.mock.calls.some(([, init]) => JSON.parse(init.body).tool === 'set_credential'),
    ).toBe(false);
    await wrapper.find('input[name="new-password"]').setValue('long-enough-pass');
    await wrapper.find('input[name="confirm-password"]').setValue('long-enough-pass');
    await wrapper.find('button[data-test="save"]').trigger('click');
    const cred = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(init.body))
      .find((b) => b.tool === 'set_credential');
    expect(cred.args).toEqual({ participantId: 'alice', secret: 'long-enough-pass' });
  });

  it('retire is hidden for protected and disabled for self', async () => {
    const wrapper = mount(UserEditor, { props: { participantId: 'operator' } });
    // operator fixture: protected: true, operator: true, and token participantId is 'operator'
    await vi.waitFor(() => wrapper.find('form').exists());
    expect(wrapper.find('[data-test="retire"]').exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/web -- src/views/UserEditor.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement**

- Extract `components/common/ApprovalAuthorityEditor.vue` (props `modelValue: ApprovalAuthority | null`, wildcard toggle + per-tool booleans + participant-id list; emits `update:modelValue`) and refactor AgentEditor to use it — one shared editor, both consumers (spec §6.1 lists authority on both editors).
- Implement UserEditor per Interfaces; the three retire guards are pure computeds over `useParticipants().participants` + `useAuth().participantId` — test the third rule by seeding two operator users and flipping one to `status: 'retired'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): user editor + user management rules (spec §6.1, §7)"
```

### Task 16: Topology map (spec §6.1)

**Files:**

- Create: `packages/web/src/views/TopologyMap.vue`
- Create: `packages/web/src/views/TopologyMap.test.ts`
- Modify: `packages/web/src/views/ParticipantsView.vue` (toggle between List view / Map view — segmented control at the top of the master column)

**Interfaces:**

- Consumes: `list_participants` (Task 8 composable), `list_mcp_sources` (Task 4), connectors (from... see Decision note), live edges from `watch_activity` chunks (`tool:call` events carry `{ conversationId, participantId, tool }`-shaped data — verified union in `watch-activity-tool.ts:6`).
- Produces:
  - `TopologyMap.vue` — SVG diagram: node per agent/service/user/mock (shape by type: rounded-rect agents, circle users, hexagon services), node for each MCP source, node per connector; edges = message activity (an edge lights up between the conversation's participants on `tool:call`/message events, decaying after ~5s); hovering a node shows name/type/status tooltip; click emits `select(participantId)` → ParticipantsView switches to the detail pane for it.
  - **Decision (planner's recommendation, Chris can veto at plan-approve time):** build with plain SVG + a small force-simulation helper hand-rolled (~60 lines, simple repulsion + spring relaxation in a `requestAnimationFrame` loop) rather than adding D3/cytoscape (spec §3.4 "zero extra dependencies" spirit). Node count in a collective is small (tens); a full graph lib is overkill. If layout proves unstable in review, revisit with a stable circular layout fallback (deterministic, no physics): type-grouped arcs around a center hub.
  - Connectors: the config shape (`WorkspaceConfig.connectors`) is loaded by the process but not yet exposed via any tool. **Within scope:** render connectors only if the data is already reachable; otherwise omit the connector node type and record it in "Open questions for Chris" (do NOT add a seventh backend tool).

- [ ] **Step 1: Write the failing tests**

`TopologyMap.test.ts`:

```typescript
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import TopologyMap from './TopologyMap.vue';

// seed fetch: list_participants → 2 agents + 1 user; list_mcp_sources → 1 server

describe('TopologyMap', () => {
  beforeEach(() => {
    /* token + fetch stubs */
  });

  it('renders one node per participant and per MCP source', async () => {
    const wrapper = mount(TopologyMap, { props: { participants: [], mcpSources: [] } });
    await vi.waitFor(() =>
      expect(wrapper.findAll('[data-test="topo-node"]').length).toBeGreaterThan(0),
    );
    // with the seeded payloads: 3 participant nodes + 1 mcp node
    expect(wrapper.findAll('[data-test="topo-node"]').length).toBe(4);
  });

  it('clicking a node emits select', async () => {
    const wrapper = mount(TopologyMap, { props: { participants: [], mcpSources: [] } });
    await vi.waitFor(() => wrapper.find('[data-test="topo-node"]').exists());
    await wrapper.findAll('[data-test="topo-node"]')[0].trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['agent-a']);
  });

  it('activity events add a transient edge', async () => {
    const wrapper = mount(TopologyMap, { props: { participants: [], mcpSources: [] } });
    await vi.waitFor(() => wrapper.find('[data-test="topo-node"]').exists());
    wrapper.vm.__handleActivityForTests({
      conversationId: 'c1',
      participantId: 'agent-a',
      tool: 'communicate',
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-test="topo-edge"]').length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/web -- src/views/TopologyMap.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement**

- Node positions: deterministic circular layout (type-grouped) as the default; the physics helper is optional polish behind the same interface — ship the deterministic layout first, keep the review checkpoint for whether to add simulation.
- Edge store: module-scoped `Map<edgeKey, lastSeen>`; `watch_activity` subscription via `useLegionApi().onEvent`-equivalent through the existing `useToolStream('watch_activity', …)` chunk handler (same consumption pattern as `ConversationsView.vue:150` today); prune entries older than 5s on a 1s interval; render `<line>` per live edge with opacity = age decay.
- MCP nodes from `list_mcp_sources` (safe if Task 4 landed; if executing before Task 4, stub empty and note it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): topology map on Participants page (spec §6.1)"
```

### Task 17: Processes page on the new shell (spec §6.2 — carried over, no feature additions)

**Files:**

- Modify: `packages/web/src/views/ProcessesView.vue` (re-host on AppShell + tokens; logic carried over)
- Modify: `packages/web/src/composables/useProcesses.ts` (port to `useLegionApi` foundation; keep its public surface)
- Modify: tests: `packages/web/src/composables/useProcesses.test.ts` (port mocks), keep component tests green (`ProcessList`, `ProcessDetail`, `ProcessStartForm`, `AnsiOutput`, `ProcessStatusDot` all stay)

**Interfaces:**

- Consumes: existing process tools (whatever `useProcesses.ts` calls today — `start_process`-family; verify in-file), `watch_process` stream (existing), `useLegionApi.execute`.
- Produces: same feature set as today (list, start form, detail with live ANSI output) rendered with token utilities (`bg-surface`, `border-line`, `text-ink`…) instead of navy/raw classes; no new features (spec §6.2: "No feature additions").

- [ ] **Step 1: Write the failing test**

Add one token-conformance test (the substantive behavior tests already exist and must keep passing):

```typescript
// packages/web/src/views/ProcessesView.test.ts (new assertions appended to the existing file)
describe('ProcessesView theming', () => {
  it('uses token utilities, not raw colors', async () => {
    const wrapper = mount(ProcessesView, { global: { plugins: [router] } });
    const html = wrapper.html();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html).not.toContain('navy-');
  });
});
```

(If the file doesn't exist yet, create it with this describe block plus a minimal mount harness like Task 7's.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/web -- src/views/ProcessesView.test.ts`
Expected: FAIL — raw color classes still present.

- [ ] **Step 3: Implement**

- Swap every raw/navy Tailwind class in the four process components + view to the token vocabulary (Task 5 utility names). Port `useProcesses.ts` internals from direct `fetch`/`useExecute` to `useLegionApi().execute` — public function signatures unchanged so component tests need no behavioral edits.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS — new conformance test green; all carried-over process tests green.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "refactor(web): Processes page on new shell + token layer (spec §6.2)"
```

### Task 18: Config page — providers/routing carried over + token conformance (spec §6.3 part 1)

**Files:**

- Modify: `packages/web/src/views/ConfigView.vue` (re-host, tokens; add section slot for Task 19)
- Modify: `packages/web/src/components/config/{ProviderSlideOver,RoutingEditor}.vue` (token classes only; logic unchanged — note ProviderSlideOver's provider `type` enum gained `openai-responses` on main, keep it)
- Modify: `packages/web/src/components/config/ProviderSlideOver.test.ts` (port mocks to foundation if they stub `useExecute`)

**Interfaces:**

- Consumes: `list_providers`/`save_provider`/`delete_provider`/`get_routing`/`save_routing` (existing), `useLegionApi`.
- Produces: same feature set as today under the new shell/tokens; sections laid out as: Providers, Model routing, MCP sources (placeholder heading + "coming with Task 19" comment).

- [ ] **Step 1: Write the failing test**

Append to `ConfigView.test.ts` (or create like Task 17):

```typescript
describe('ConfigView theming', () => {
  it('uses token utilities, not raw colors', async () => {
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });
    const html = wrapper.html();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html).not.toContain('navy-');
  });

  it('renders Providers and Model routing sections', () => {
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });
    expect(wrapper.text()).toContain('Providers');
    expect(wrapper.text()).toContain('Model routing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/web -- src/views/ConfigView.test.ts`
Expected: FAIL on the raw-color assertion.

- [ ] **Step 3: Implement**

Token-class sweep over ConfigView + the two config components (same mechanical swap as Task 17); port any `useExecute` usages to `useLegionApi`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "refactor(web): Config page on new shell + token layer (spec §6.3)"
```

### Task 19: Config page — MCP sources section (spec §6.3 part 2)

**Files:**

- Create: `packages/web/src/views/McpSourcesEditor.vue`
- Create: `packages/web/src/views/McpSourcesEditor.test.ts`
- Modify: `packages/web/src/views/ConfigView.vue` (mount the editor in its section)

**Interfaces:**

- Consumes: `list_mcp_sources`/`save_mcp_sources` (Task 4, exact contracts incl. validation errors: name required, command XOR url, duplicate names).
- Produces:
  - `McpSourcesEditor.vue` — list of server cards (name, transport badge stdio/http, command+args or url, enabled-by-edit-only); Add button appends a blank card; per-card fields: name, transport toggle (stdio ↔ http), command, args (one per line textarea → string[]), env (key=value rows) OR url, headers (key=value rows); Save → `save_mcp_sources { servers: <full list> }` with client-side validation mirroring the tool's errors (fail fast, same messages); restart notice banner: "Changes take effect after process restart" (spec §7's behavior, verbatim in UI copy).
  - Load: `list_mcp_sources` on mount; reload after save.

- [ ] **Step 1: Write the failing test**

`McpSourcesEditor.test.ts`:

```typescript
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import McpSourcesEditor from './McpSourcesEditor.vue';

// fixture: stub fetch — list_mcp_sources returns [{ name: 'fs', command: 'npx', args: ['-y', 'fs-mcp'] }]

describe('McpSourcesEditor', () => {
  beforeEach(() => {
    /* token + fetch stubs */
  });

  it('loads and renders existing servers', async () => {
    const wrapper = mount(McpSourcesEditor);
    await vi.waitFor(() => expect(wrapper.findAll('[data-test="mcp-card"]').length).toBe(1));
    expect(wrapper.text()).toContain('fs');
    expect(wrapper.text()).toContain('stdio');
  });

  it('add creates a blank card; save sends the full list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'success', data: { saved: 2 } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(McpSourcesEditor);
    await vi.waitFor(() => wrapper.find('[data-test="add-server"]').exists());
    await wrapper.find('[data-test="add-server"]').trigger('click');
    const cards = wrapper.findAll('[data-test="mcp-card"]');
    await cards[1].find('input[name="name"]').setValue('websearch');
    await cards[1].find('input[name="url"]').setValue('http://localhost:3000/mcp');
    await wrapper.find('button[data-test="mcp-save"]').trigger('click');
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(body.tool).toBe('save_mcp_sources');
    expect(body.args.servers.length).toBe(2);
    expect(body.args.servers[1]).toEqual({ name: 'websearch', url: 'http://localhost:3000/mcp' });
  });

  it('client-side duplicate name check blocks save', async () => {
    const fetchMock = vi.fn(); // nothing should be sent
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(McpSourcesEditor);
    await vi.waitFor(() => wrapper.find('[data-test="add-server"]').exists());
    await wrapper.find('[data-test="add-server"]').trigger('click');
    const cards = wrapper.findAll('[data-test="mcp-card"]');
    await cards[1].find('input[name="name"]').setValue('fs');
    await cards[1].find('input[name="command"]').setValue('x');
    await wrapper.find('button[data-test="mcp-save"]').trigger('click');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('duplicate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/web -- src/views/McpSourcesEditor.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement**

Per Interfaces; keep validation messages byte-identical to the tool's (`servers[i].name must be a non-empty string`, `duplicate MCP server name: x`, `command and url are mutually exclusive`, `needs either command (stdio) or url (HTTP)`) so client and server never disagree.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): MCP sources editor on Config page (spec §6.3, §7)"
```

### Task 20: Login re-skin + composer/creator wiring — "New conversation" flow (spec §3.1, §4.4)

**Files:**

- Modify: `packages/web/src/views/LoginView.vue` (token re-skin only — logic unchanged; existing e2e `login.spec.ts` selectors MUST keep passing: `input[autocomplete="username"]`, `input[type="password"]`, `Sign in` button)
- Modify: `packages/web/src/chat/ChatView.vue` (draft mode: no `:id` → recipient picker + Composer; selecting a participant creates the conversation via first `communicate` — the existing optimistic-send flow in `useConversation.ts` already supports `conversationId: null`)
- Modify: `packages/web/src/chat/ChatView.test.ts` (draft flow assertions)

**Interfaces:**

- Consumes: Task 9 layout, Task 12 Composer, existing login mechanics.
- Produces: `/chat` (no id) with no conversation selected on desktop shows the recipient picker (SearchableCombobox over active agents, carried over) + Composer underneath; on mobile it's the drawer-first empty state. Sending from draft → `communicate` creates the conversation → router replaces to `/chat/<newId>` (existing `sent(conversationId)` event path).

- [ ] **Step 1: Write the failing test**

```typescript
// appended to packages/web/src/chat/ChatView.test.ts
describe('draft flow', () => {
  it('shows recipient picker and composer on /chat with no id', async () => {
    await router.push('/chat');
    await router.isReady();
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    expect(wrapper.find('[data-test="recipient-picker"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="composer"]').exists()).toBe(true);
  });

  it('routes to /chat/:id after the first send', async () => {
    // stub communicate stream POST to return { streamId, conversationId: 'new-conv' }
    await router.push('/chat');
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    await wrapper.find('[data-test="composer"] textarea').setValue('hello');
    await wrapper.find('[data-test="composer"] textarea').trigger('keydown.enter');
    // optimistic send starts; on sent event the view pushes the route
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/chat/new-conv'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/web -- src/chat/ChatView.test.ts`
Expected: FAIL — draft UI not implemented.

- [ ] **Step 3: Implement**

Wire the draft state in ChatView (recipient ref → Composer props; `@sent` → `router.replace`); re-skin LoginView with token utilities only (keep the `autocomplete` attributes and button text byte-identical for e2e stability).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): draft conversation flow + login re-skin (spec §4.4)"
```

### Task 21: Legacy cleanup — delete the old-console remnants (spec §2, §10)

**Files:**

- Delete: `packages/web/src/composables/useExecute.ts` (+ `useExecute.test.ts`) — nothing imports it after Tasks 6–19 (verify first)
- Delete: `packages/web/src/components/layout/` (AppLayout.vue, AppSidebar.vue — replaced by shell/)
- Delete: `packages/web/src/components/conversations/CompactDialog.vue` (+ test) if nothing references it after the Thread rebuild
- Sweep: `grep -rn "navy-\|#[0-9a-fA-F]\{6\}" packages/web/src --include="*.vue" --include="*.ts" | grep -v theme/ | grep -v test` → must be EMPTY (every component on tokens; theme files are the only color definitions)
- Sweep: `grep -rn "EventStream\|EventDetailPanel\|renderers/index" packages/web/src` → EMPTY

**Interfaces:**

- Consumes: everything before it.
- Produces: a clean tree — no dead modules, no raw colors outside `theme/`. This is the task that makes "one coherent visual system" true (spec §1 success criteria).

- [ ] **Step 1: Verify zero importers before each deletion**

```bash
grep -rn "useExecute" packages/web/src --include="*.ts" --include="*.vue" | grep -v "composables/useExecute"
grep -rn "components/layout" packages/web/src --include="*.ts" --include="*.vue"
```

Each must return nothing (or only the deletion-candidate lines). If an importer survives, fix it to use the replacement FIRST, in this same task.

- [ ] **Step 2: Delete + sweep**

Delete the files; run both greps from the task description; fix any stragglers.

- [ ] **Step 3: Full web test suite + build**

Run: `npm run test --workspace=packages/web && npm run build --workspace=packages/web`
Expected: PASS / build succeeds.

- [ ] **Step 4: Commit**

```bash
git add -A packages/web
git commit -m "chore(web): remove legacy console remnants; token-conformance sweep (spec §2, §10)"
```

### Task 22: Playwright e2e suite (spec §8)

**Files:**

- Create: `packages/e2e/tests/web-ui/chat.spec.ts`
- Create: `packages/e2e/tests/web-ui/dock.spec.ts`
- Create: `packages/e2e/tests/web-ui/forks.spec.ts`
- Create: `packages/e2e/tests/web-ui/approvals.spec.ts`
- Create: `packages/e2e/tests/web-ui/participants-users.spec.ts`
- Create: `packages/e2e/tests/web-ui/config-mcp.spec.ts`
- Modify: `packages/e2e/fixtures/index.ts` (add an `authPage`-style fixture if a page-object helper helps; keep existing fixtures untouched)
- Modify: `packages/e2e/mock-provider/server.ts` ONLY if a scripted tool call needs a deterministic mock tool result (prefer existing mock behaviors first)

**Interfaces:**

- Consumes: existing global-setup (Legion on :4000 + mock provider on :4001, `LEGION_BOOTSTRAP_PASSWORD=legion-e2e-test`, base URL `/`), `authPage` fixture pattern (`tests/auth/login.spec.ts`), `ApiClient` helper for API-side arrangement (create users/agents via `execute` before UI assertions).
- Produces: the spec §8 journey as six specs. E2E runs AFTER `npm run build` (global-setup uses built assets).

Key flows (each test asserts against stable `data-test` attributes planted in Tasks 7–20):

- [ ] **Step 1: `chat.spec.ts` — login → chat → send → tool chip**

```typescript
import { test, expect } from '../../fixtures/index.js';

test.describe('Chat UI', () => {
  test('landing route is /#/chat after login', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/');
    await expect(page).toHaveURL(/#\/chat/);
  });

  test('send a message and see the assistant reply stream in', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/chat');
    await page.locator('[data-test="recipient-picker"]').click();
    // pick the mock agent (deterministic responses — check mock participants in global-setup)
    await page.getByRole('option', { name: /mock/i }).first().click();
    await page.locator('[data-test="composer"] textarea').fill('hello collective');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-test="msg"]').last()).toBeVisible();
    // mock agent echoes → its reply appears
    await expect(page.locator('.md-content').last()).toContainText(/hello/i, { timeout: 15_000 });
  });
});
```

(Executor note: verify what participants global-setup seeds — if no mock agent exists, create one via `ApiClient` `execute('create_agent', …)` with a systemPrompt that echoes, or extend the fixture. Do not depend on a live LLM.)

- [ ] **Step 2: `dock.spec.ts` — tool chip opens dock tab**

Arrange a conversation containing a tool call via API (`communicate` with an agent whose tools include a mock MCP tool, or seed a message directly through `execute('get_conversation')`-visible state). UI: open that conversation → click its tool chip → dock opens with the tab titled by the registry → close works.

- [ ] **Step 3: `forks.spec.ts` — edit creates a sibling; arrows navigate**

In a seeded conversation: hover last user message → Edit → change text → save → pager `‹ 1/2 ›` appears → click `›` → original content shows. Asserts `edit_message` → `alternates` → `switch_branch` round trip through real backend.

- [ ] **Step 4: `approvals.spec.ts` — approve/reject round trip**

Arrange: agent with `tools: { shell: 'requires_approval' }` prompted to run a command. UI: nav badge shows 1 → click badge → deep-links to the conversation → inline ApprovalCard visible → Approve → badge clears → the tool runs (its result chip appears). Repeat variant with Reject.

- [ ] **Step 5: `participants-users.spec.ts` — user CRUD**

Via UI: Participants → New user → name + password → save → appears in list; open user → set tool policy → save; retire guard checks: self (operator) retire disabled; new user retire works. Password change on own account via avatar → Account slide-over → change password → logout → login with the new password.

- [ ] **Step 6: `config-mcp.spec.ts` — MCP round trip**

Config → MCP section: existing list renders → Add server (name `e2e-mcp`, command `echo`) → Save → success + banner → reload page → server persists (`list_mcp_sources` reads back). Invalid case: duplicate name → client-side error, no network call (assert via `page.on('request')` filter).

- [ ] **Step 7: Run the suite**

Prereqs: `npm install && npm run build && npx playwright install chromium` (RAM check first — see Global Constraints).

Run: `npm run test:e2e`
Expected: all specs pass (existing API/auth specs unaffected).

- [ ] **Step 8: Commit**

```bash
git add -A packages/e2e
git commit -m "test(e2e): chat-first UI journey specs (spec §8)"
```

### Task 23: Final gate — full pipeline + plan sign-off (spec §8 gates)

**Files:**

- Modify: `docs/superpowers/plans/2026-10-07-web-ui-rewrite.md` (tick all checkboxes as tasks complete — the executor's tracker)

**Interfaces:**

- Consumes: all tasks.
- Produces: the five gates green on the finished branch.

- [ ] **Step 1: Run the full gate, in order**

```bash
free -h   # ensure MemAvailable > 4 GiB before the suite
npm run format:check || npm run format
npm run typecheck
npm test
npm run test --workspace=packages/web
npm run build && npx playwright install chromium && npm run test:e2e
```

Expected: all five green. Any failure → fix in the owning task's scope, re-run the gate from the top.

- [ ] **Step 2: Spec coverage cross-check**

Walk spec §3–§8 against the merged tree: shell (§3.1) ✓ Task 7 · layout/mobile (§3.2) ✓ Tasks 7/9 · state composables (§3.3) ✓ Tasks 6/8/12 · theming (§3.4) ✓ Task 5 · chat list/thread/renderers/forks/composer/approvals/streaming (§4) ✓ Tasks 9–12/20 · dock (§5) ✓ Task 13 · participants+users+topology (§6.1) ✓ Tasks 14–16 · processes (§6.2) ✓ Task 17 · config+MCP (§6.3) ✓ Tasks 18–19 · six tools (§7) ✓ Tasks 1–4 · tests (§8) ✓ Tasks 22–23. Record the checklist output in the task event log.

- [ ] **Step 3: Commit the ticked plan**

```bash
git add docs/superpowers/plans/2026-10-07-web-ui-rewrite.md
git commit -m "docs(plan): tick web UI rewrite plan checkboxes (complete)"
```

---

## Task dependency order (summary)

| #   | Task                                | Depends on  | Size |
| --- | ----------------------------------- | ----------- | ---- |
| 1   | create_user + modify_user           | —           | M    |
| 2   | set_approval_authority              | —           | S    |
| 3   | list_pending_approvals              | —           | S    |
| 4   | list/save_mcp_sources               | —           | M    |
| 5   | Theme token layer                   | —           | M    |
| 6   | useLegionApi                        | 5           | M    |
| 7   | Router + AppShell + badge + account | 5, 6        | L    |
| 8   | useConversations + useParticipants  | 6           | M    |
| 9   | ChatView + ConversationList         | 7, 8        | L    |
| 10  | Thread + renderer registry          | 8           | L    |
| 11  | Forks + message actions             | 10          | M    |
| 12  | Approvals + Composer + streaming    | 3, 7, 8, 10 | L    |
| 13  | Dock panel system                   | 10          | L    |
| 14  | Participants list + agent editor    | 8, 2        | L    |
| 15  | User editor + rules                 | 1, 2, 14    | M    |
| 16  | Topology map                        | 4, 8        | M    |
| 17  | Processes page tokens               | 6, 7        | S    |
| 18  | Config page tokens                  | 6, 7        | S    |
| 19  | MCP sources editor                  | 4, 18       | M    |
| 20  | Draft flow + login re-skin          | 9, 12       | S    |
| 21  | Legacy cleanup sweep                | 9–20        | S    |
| 22  | Playwright e2e suite                | all         | L    |
| 23  | Final gate                          | 22          | S    |

Backend tasks 1–4 are independent of the web tasks and can run in any slot (subagent-driven execution can parallelize 1–4 against 5–8, reconvening at 12/14 which consume both). Tasks 17/18 are safe filler anytime after 7.

## Open questions for Chris (veto at approve time — none block execution)

1. **Topology connectors** (Task 16): no tool currently exposes configured connectors; plan renders connector nodes only if data is reachable without a seventh backend tool — otherwise topology ships with participants + MCP nodes and connector nodes land later. OK?
2. **Topology layout** (Task 16): deterministic type-grouped circular layout first (no new deps); optional force-simulation polish only if review wants it. OK?
3. **MCP `config.local.json` shadowing** (Task 4/19): the save tool writes `config.json`; if `config.local.json` overrides `mcpServers`, saved changes won't take effect on next boot. Plan warns in the UI; alternative is a merge/precedence rule in core (out of the six-tool scope). OK to warn-only?
4. **`@`-mention tool hints** (spec §4.4): hints are shown only from the current user's own `tools` map (via `/api/auth/me` session info). If `me` lacks the tools list in its payload, hints hide rather than widening the auth surface. OK?
