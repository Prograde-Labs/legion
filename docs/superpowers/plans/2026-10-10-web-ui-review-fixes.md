# Web UI Review-Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 13-point review feedback on the rewritten Legion web UI — tool-visibility gating (no affordance a user can't invoke, eliminating all 'hidden' errors), live streaming (first-send fix + reasoning deltas), role-styled chat bubbles + compaction rendering + compact action, blank editor-form hydration fix, mobile single-pane participants, always-visible composer send button, and a login screen without nav chrome.

**Architecture:** Four clusters. Cluster A adds caller-policy awareness: `list_tools` returns the caller's effective tool policy, a `useToolAccess` composable exposes `can(tool)` to all views, and every affordance is gated (auto → visible, requires_approval → visible+badge, absent → not rendered). Cluster C fixes first-send streaming at its root cause, streams reasoning deltas live into the existing disclosure component, and restyles messages as role-colored bubbles with a dedicated compaction renderer. Clusters D+E fix editor hydration and the subchat drawer at root cause, collapse master-detail to single-pane on narrow viewports, and map residual 'hidden' errors to quiet no-ops. A final gate task runs the full test gate, rebuilds and redeploys the container, and proves gating with a reduced-access test user.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Vue 3 + Vite + Tailwind, Fastify, vitest + happy-dom (web), Playwright (e2e), argon2 credentials, Docker deploy.

**Spec:** `docs/superpowers/specs/2026-10-07-web-ui-rewrite-design.md` (§3–§8 base design). This plan is the **review-feedback wave** on that spec: Chris's 13-point feedback from live testing (2026-10-10), with design decisions recorded in chat the same day. Cluster B (granting `operator` and `chris-web` all 57 tools, `operator: true`) was **already applied out-of-band** directly to `/workspace/.legion/collective/participants/*.json` + container restart — no task here redoes it.

## Global Constraints

- Branch: work directly on `web-ui-rewrite` (Chris's instruction — this branch cannot merge with these issues unresolved). No worktree.
- TS strict + `verbatimModuleSyntax`: `import type` for type-only imports; `.js` extensions on all relative imports (including `.ts` source files).
- No raw hex colors in components — theme tokens only (`packages/web/src/assets/tokens.css` AND `light.css` must both get any new token).
- Prettier: single quotes, semicolons, trailing commas, 100 cols, 2-space.
- Conventional commits (`feat:`, `fix:`, `test:`, `chore:`).
- Required gate order before claiming any task done: `npm run format:check` → `npm run typecheck` → `npm test` (root; excludes web) → `npm run test --workspace=packages/web` when web is touched.
- E2E env gotcha: session `PLAYWRIGHT_BROWSERS_PATH` must be unset — run as `env -u PLAYWRIGHT_BROWSERS_PATH -u AGENT_BROWSER_EXECUTABLE_PATH npx playwright test --config packages/e2e/playwright.config.ts packages/e2e/tests/web-ui --project=chromium`. All-crash "Target crashed" waves are box-level (pids cap 256): sleep 60 and rerun; genuine failures reproduce via precise assertions.
- Live instance: container `legion-collective` serves :3000 from image `legion:collective-git`; deploy/redeploy per `/workspace/legion-collective/deploy/README.md` (`docker build -t legion:collective-git /workspace/legion-web-ui` then `docker compose up -d` from the deploy dir). Workspace state (`.legion/`) is host-side — never baked into the image; a container restart is safe.
- AuthEngine is deliberately fail-closed with **no wildcard**: a tool absent from a participant's `tools` map is `hidden`. Do NOT weaken AuthEngine; gating hides absent tools in the UI instead.
- `get_participant` args are `{ id }` (NOT `{participantId}`); `set_credential` args are `{ participantId, secret }`; `create_user` args are `{ id, name, operator?, tools? }`.
- `list_tools` (as of plan-writing) returns a flat array of tool-name strings.

---

## Cluster A — Tool-visibility gating (plan tasks 1-4)

### Task 1: list_tools returns the caller's tool policy

**Files:**

- Modify: `packages/core/src/tools/management-tools.ts` (listToolsTool at :851-863)
- Modify: `packages/core/src/tools/management-tools.test.ts` (extend)
- Modify: `packages/web/src/views/AgentEditor.vue:81`, `packages/web/src/views/UserEditor.vue:70` (list_tools consumers — shape change)
- Modify: `packages/web/src/views/TopologyMap.vue:26` (consumer — uses list_mcp_sources, verify only)

**Interfaces:**

- Consumes: `ToolContext.participant` (packages/core/src/tools/Tool.ts:92-96 — the executing principal, carries its own `tools` policy map) and `ToolContext.toolRegistry.listAll(): string[]` (packages/core/src/tools/ToolRegistry.ts:52).
- Produces: `list_tools` returns `{ tools: string[], callerPolicy: Record<string, 'auto' | 'requires_approval'> }` — **breaking shape change** (was a flat string array). ALL in-repo consumers updated in this task (grep verified: AgentEditor.vue:81 and UserEditor.vue:70 are the only `.then((tools) =>` list_tools consumers in web; Composer.vue:39-45 toolHints reads `auth.tools`, not this tool).

- [ ] **Step 1: Write the failing tests** (extend management-tools.test.ts — reuse its existing harness for execute + context):

```ts
it('returns the registry tool list plus the caller policy map', async () => {
  const context = mkContext({
    participant: mkParticipant({
      id: 'restricted-user',
      tools: { communicate: 'auto', edit_message: 'requires_approval' },
    }),
    toolRegistry: mkRegistryWith(['communicate', 'edit_message', 'start_process']),
  });
  const result = await listToolsTool.execute({}, context);
  expect(result).toEqual({
    status: 'success',
    data: {
      tools: ['communicate', 'edit_message', 'start_process'],
      callerPolicy: { communicate: 'auto', edit_message: 'requires_approval' },
    },
  });
});
it('returns an empty callerPolicy when the participant has no tools map', async () => {
  const context = mkContext({
    participant: mkParticipant({ id: 'bare', tools: {} }),
    toolRegistry: mkRegistryWith(['communicate']),
  });
  const result = await listToolsTool.execute({}, context);
  expect(result).toEqual({ status: 'success', data: { tools: ['communicate'], callerPolicy: {} } });
});
```

(Adapt `mkContext`/`mkParticipant`/`mkRegistryWith` to the file's actual fixture helpers — read its existing list_tools coverage first and extend rather than duplicate.)

- [ ] **Step 2: Verify FAIL** — `npx vitest run packages/core/src/tools/management-tools.test.ts`
      Expected: FAIL — current data is a plain string array.

- [ ] **Step 3: Implement** — replace the execute body (management-tools.ts:858-862):

```ts
async execute(_rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
  const toolRegistry = context.toolRegistry;
  if (!toolRegistry) return { status: 'error', error: 'toolRegistry unavailable' };
  const callerPolicy: Record<string, 'auto' | 'requires_approval'> = {};
  for (const [tool, policy] of Object.entries(context.participant.tools ?? {})) {
    if (policy === 'auto' || policy === 'requires_approval') callerPolicy[tool] = policy;
  }
  return { status: 'success', data: { tools: toolRegistry.listAll(), callerPolicy } };
},
```

Update description: `'List all registered tool names plus the calling participant\u2019s own tool policy (for UI gating).'`

- [ ] **Step 4: Update web consumers** — AgentEditor.vue:81-83 and UserEditor.vue:70-72 change from

```ts
void execute<string[]>('list_tools', {}).then((tools) => { availableTools.value = tools; …
```

to

```ts
void execute<{ tools: string[]; callerPolicy: Record<string, string> }>('list_tools', {}).then(
  ({ tools }) => { availableTools.value = tools; …  // rest of the .then body unchanged
```

- [ ] **Step 5: Verify PASS** — core test file green; `npm run typecheck`; full web suite (AgentEditor/UserEditor tests mock list_tools — update their mocks to the new shape).
- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts packages/web/src/views/AgentEditor.vue packages/web/src/views/UserEditor.vue
git commit -m "feat(core): list_tools returns caller tool policy for UI gating"
```

### Task 2: useToolAccess composable

**Files:**

- Create: `packages/web/src/composables/useToolAccess.ts`
- Create: `packages/web/src/composables/useToolAccess.test.ts`

**Interfaces:**

- Consumes: `useLegionApi().execute<T>(tool, args)` (existing pattern — read useLegionApi.ts for the exact execute signature and how the token is attached). `list_tools` new return from Task 1.
- Produces: `useToolAccess(): { can: (tool: string) => 'auto' | 'requires_approval' | 'hidden'; refresh: () => Promise<void>; access: Ref<Record<string, 'auto' | 'requires_approval'>> }` — module-level singleton state (same pattern as useAuth/useParticipants: refs at module scope, function returns handles).

- [ ] **Step 1: Write the failing tests**:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeMock = vi.fn();
vi.mock('./useLegionApi.js', () => ({ useLegionApi: () => ({ execute: executeMock }) }));

import { useToolAccess } from './useToolAccess.js';

describe('useToolAccess', () => {
  beforeEach(() => {
    executeMock.mockReset();
    useToolAccess().__resetForTests?.();
  });
  it('can() defaults to hidden before any refresh', () => {
    expect(useToolAccess().can('communicate')).toBe('hidden');
  });
  it('refresh() stores the caller policy and can() maps it', async () => {
    executeMock.mockResolvedValue({
      tools: ['communicate', 'edit_message'],
      callerPolicy: { communicate: 'auto', edit_message: 'requires_approval' },
    });
    await useToolAccess().refresh();
    const access = useToolAccess();
    expect(access.can('communicate')).toBe('auto');
    expect(access.can('edit_message')).toBe('requires_approval');
    expect(access.can('start_process')).toBe('hidden');
  });
});
```

- [ ] **Step 2: Verify FAIL** — `npm run test --workspace=packages/web -- useToolAccess` (module does not exist).

- [ ] **Step 3: Implement**:

```ts
// packages/web/src/composables/useToolAccess.ts
import { ref } from 'vue';
import { useLegionApi } from './useLegionApi.js';

export type ToolAccessPolicy = 'auto' | 'requires_approval';

const access = ref<Record<string, ToolAccessPolicy>>({});
const loaded = ref(false);

export function useToolAccess() {
  async function refresh(): Promise<void> {
    const { execute } = useLegionApi();
    const data = await execute<{ tools: string[]; callerPolicy: Record<string, ToolAccessPolicy> }>(
      'list_tools',
      {},
    );
    access.value = data.callerPolicy ?? {};
    loaded.value = true;
  }
  function can(tool: string): 'auto' | 'requires_approval' | 'hidden' {
    if (!loaded.value) return 'hidden'; // fail closed before first fetch lands
    return access.value[tool] ?? 'hidden';
  }
  function __resetForTests(): void {
    access.value = {};
    loaded.value = false;
  }
  return { can, refresh, access, __resetForTests };
}
```

- [ ] **Step 4: Wire refresh on login** — read `packages/web/src/views/LoginView.vue` + `useAuth.ts` for the post-login flow; call `void useToolAccess().refresh().catch(() => {})` immediately after a successful login (and after session restore where `useAuth` finds a valid token at app boot — App.vue or AppShell setup). Add a test: refresh called with the list_tools shape (covered above); the call-site wiring is verified in Task 4's shell test.
- [ ] **Step 5: Verify PASS** — web tests green; typecheck.
- [ ] **Step 6: Commit**

```bash
git add packages/web/src/composables/useToolAccess.ts packages/web/src/composables/useToolAccess.test.ts
git commit -m "feat(web): useToolAccess composable for tool-visibility gating"
```

### Task 3: Gating sweep — hide every affordance the caller cannot invoke

**Files (all verified present):**

- Modify: `packages/web/src/shell/AppShell.vue` (nav), `packages/web/src/chat/ConversationList.vue` (delete), `packages/web/src/chat/MessageActions.vue` (edit/generate/prune), `packages/web/src/chat/ForkControls.vue` (switch_branch), `packages/web/src/views/ConfigView.vue` (list/save/delete provider), `packages/web/src/views/ProcessesView.vue` (start/stop process), `packages/web/src/views/McpSourcesEditor.vue` (list/save mcp sources), `packages/web/src/views/ParticipantsView.vue` (+ list/create affordances), `packages/web/src/views/AgentEditor.vue` + `UserEditor.vue` (save/retire/set_credential buttons), `packages/web/src/panels/DockPanel.vue` (open affordances)
- Create: `packages/web/src/components/common/ApprovalBadge.vue`
- Test: extend `MessageActions.test.ts`, `ConversationList.test.ts`, `McpSourcesEditor` tests (files verified to exist for the first two; check McpSourcesEditor's — create if missing)

**Interfaces:**

- Consumes: `useToolAccess().can()` (Task 2).
- Produces: `ApprovalBadge` — props `{}`; renders `<span data-test="approval-badge" class="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">needs approval</span>` (token classes; `bg-warning/15` opacity modifier — verify Tailwind config exposes the `warning` color, else use `text-warning border-warning/40 border`).

- [ ] **Step 1: Read each component and map affordance → tool.** Verified mapping to encode (from recon):

| Component                  | Affordance                                                                  | Tool                                                                                                |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| ConversationList           | per-conversation delete button (ADD — currently missing, fixes feedback #5) | `delete_conversation`                                                                               |
| MessageActions             | Edit / Re-run / Prune menu items                                            | `edit_message` / `generate` / `prune_message`                                                       |
| ForkControls               | branch switch buttons                                                       | `switch_branch`                                                                                     |
| ConfigView                 | provider list/save/delete                                                   | `list_providers` / `save_provider` / `delete_provider`                                              |
| ProcessesView              | start/stop/view process forms                                               | `start_process` / `stop_process` / `list_processes`                                                 |
| McpSourcesEditor           | editor + save                                                               | `list_mcp_sources` / `save_mcp_sources`                                                             |
| ParticipantsView + editors | create/edit/retire affordances                                              | `create_agent` / `modify_agent` / `retire_agent` / `create_user` / `modify_user` / `set_credential` |
| AppShell                   | nav entries Chat/Participants/Processes/Config                              | keep visible (read-mostly views degrade gracefully); gate only actions inside views                 |
| DockPanel                  | open/inspect affordances                                                    | keep (chip inspect is always allowed)                                                               |

- [ ] **Step 2: Write failing tests** (one pattern, three components):

```ts
// MessageActions.test.ts
it('hides menu actions the caller cannot invoke', async () => {
  vi.mocked(useToolAccess).mockReturnValue({
    can: (t: string) => (t === 'edit_message' ? 'auto' : 'hidden'),
  } as never);
  const w = mountMessageActions();
  await w.find('[data-test="actions-toggle"]').trigger('click');
  expect(w.find('[data-test="action-edit"]').exists()).toBe(true);
  expect(w.find('[data-test="action-rerun"]').exists()).toBe(false);
  expect(w.find('[data-test="action-prune"]').exists()).toBe(false);
});
// ConversationList.test.ts
it('shows delete only with delete_conversation access', async () => {
  vi.mocked(useToolAccess).mockReturnValue({ can: () => 'auto' } as never);
  const w = mountList();
  expect(w.find('[data-test="conv-delete"]').exists()).toBe(true);
});
// McpSourcesEditor test: save button hidden when can('save_mcp_sources') !== 'auto'
```

- [ ] **Step 3: Verify FAIL**, then implement: in each component `const toolAccess = useToolAccess();` and wrap the affordance in `v-if="toolAccess.can('<tool>') === 'auto'"` (add the missing ConversationList delete button: small trash icon button per row, `window.confirm('Delete conversation?')` before `execute('delete_conversation', { conversationId })` then remove from list state). For `requires_approval` policies render the affordance disabled + `<ApprovalBadge />` beside it (only where an approval flow actually exists — approvals UI already handles these; otherwise treat as hidden to avoid dead buttons; note this choice per site in the commit body).
- [ ] **Step 4: Verify PASS** — full web suite.
- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): gate UI affordances by caller tool policy"
```

### Task 4: No navbar on the login screen

**Files:**

- Modify: `packages/web/src/shell/AppShell.vue` (nav element :28; auth state via useAuth :12)
- Modify: `packages/web/src/App.vue` (:19 renders AppShell unconditionally)
- Test: `packages/web/src/shell/AppShell.test.ts` (create if absent)

**Interfaces:**

- Consumes: `useAuth()` — read the composable for the exact authenticated flag (`participantId` + token expiry; useAuth.ts:36-37 already computes a valid-session notion — reuse or expose it).
- Produces: login route renders bare.

- [ ] **Step 1: Write the failing test**:

```ts
it('renders no nav when unauthenticated on /login', async () => {
  // harness: router pushed to /login, useAuth localStorage empty (repo test pattern)
  const w = mountShellAt('/login');
  await flushPromises();
  expect(w.find('nav').exists()).toBe(false);
});
it('renders the nav when authenticated', async () => {
  const w = mountShellAt('/chat'); // with token in localStorage per harness
  await flushPromises();
  expect(w.find('nav').exists()).toBe(true);
});
```

- [ ] **Step 2: Verify FAIL** — `npm run test --workspace=packages/web -- AppShell`
- [ ] **Step 3: Implement** — AppShell.vue: wrap the `<nav>`…`</nav>` block (and the account slideover trigger) in `v-if="participantId"` (the same signal the avatar uses at :53; if useAuth exposes a stronger `isAuthenticated` computed, prefer it). The `<RouterView/>`/slot content below stays unconditional. Additionally guard the whole shell: on `/login` the only content should be the router view — the nav is the sole chrome today, so `v-if` on nav suffices; verify visually via the deployed build in Task 14.
- [ ] **Step 4: Verify PASS** — AppShell tests; full web suite.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/shell/AppShell.vue packages/web/src/App.vue packages/web/src/shell/AppShell.test.ts
git commit -m "fix(web): hide navigation chrome on the login screen"
```

---

## Cluster C — Chat rendering & streaming (plan tasks 5-9)

### Task 5: Composer send button + pointer-aware Enter behavior

**Files:**

- Create: `packages/web/src/composables/useCoarsePointer.ts`
- Modify: `packages/web/src/chat/Composer.vue` (keydown handler at :59-64; template actions row :130-140; textarea placeholder :125)
- Test: `packages/web/src/chat/Composer.test.ts` (exists — extend)

**Interfaces:**

- Consumes: nothing new.
- Produces: `useCoarsePointer(): { isCoarse: Ref<boolean> }` — reused by Task 12 (mobile single-pane). Composer template gains `data-test="composer-send"` button.

- [ ] **Step 1: Create the composable**

```ts
// packages/web/src/composables/useCoarsePointer.ts
import { onBeforeUnmount, ref } from 'vue';

/** True when the primary pointer is coarse (touch). SSR-safe: false without window. */
export function useCoarsePointer() {
  const isCoarse = ref(
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  );
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia('(pointer: coarse)');
    const onChange = (e: MediaQueryListEvent): void => {
      isCoarse.value = e.matches;
    };
    mq.addEventListener('change', onChange);
    onBeforeUnmount(() => mq.removeEventListener('change', onChange));
  }
  return { isCoarse };
}
```

- [ ] **Step 2: Write the failing tests** (add to Composer.test.ts; mock matchMedia like existing repo tests do — grep `matchMedia` in packages/web/src for the established stub):

```ts
// fine pointer: Enter sends, Shift+Enter newline
it('sends on Enter with fine pointer', async () => {
  stubMatchMedia('(pointer: coarse)', false); // repo's matchMedia stub helper
  const w = mountComposer(); // existing harness in this file
  await w.find('[data-test="composer-input"]').setValue('hi');
  await w.find('[data-test="composer-input"]').trigger('keydown', { key: 'Enter' });
  expect(w.emitted('streamSend')).toBeTruthy();
});
it('inserts newline on Enter with coarse pointer', async () => {
  stubMatchMedia('(pointer: coarse)', true);
  const w = mountComposer();
  const input = w.find('[data-test="composer-input"]');
  await input.setValue('line1');
  await input.trigger('keydown', { key: 'Enter' });
  expect(w.emitted('streamSend')).toBeFalsy();
  expect((input.element as HTMLTextAreaElement).value).toContain('\n');
});
it('always renders the send button', () => {
  const w = mountComposer();
  expect(w.find('[data-test="composer-send"]').exists()).toBe(true);
});
```

- [ ] **Step 3: Run to verify FAIL** — `npm run test --workspace=packages/web -- Composer`
      Expected: FAIL (`composer-send` not found; coarse Enter emits streamSend).

- [ ] **Step 4: Implement** — Composer.vue script: import `useCoarsePointer`, `const { isCoarse } = useCoarsePointer();`; replace onKeydown:

```ts
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  if (isCoarse.value) return; // touch: Enter is a newline; button sends
  if (!event.shiftKey) {
    event.preventDefault();
    send();
  }
}
```

Template: placeholder becomes `:placeholder="isCoarse ? 'Message…  (@ to mention)' : 'Message…  (@ to mention, Enter to send)'"`; actions row (:130-140) gains the always-visible Send button before the Stop button:

```html
<div class="flex items-center justify-end gap-2">
  <button
    v-if="streaming"
    type="button"
    data-test="composer-stop"
    class="rounded border border-line px-3 py-1 text-xs text-danger hover:bg-surface"
    @click="emit('stop')"
  >
    Stop
  </button>
  <button
    type="button"
    data-test="composer-send"
    class="rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent disabled:opacity-50"
    :disabled="!draft.trim() || streaming"
    @click="send()"
  >
    Send
  </button>
</div>
```

(Uses existing tokens — `bg-accent`, `text-on-accent`, `border-line`, `text-danger`; Tailwind maps `accent`/`on-accent` per the theme config used across the app.)

- [ ] **Step 5: Run to verify PASS** — same command; then full web suite.
- [ ] **Step 6: Commit**

```bash
git add packages/web/src/composables/useCoarsePointer.ts packages/web/src/chat/Composer.vue packages/web/src/chat/Composer.test.ts
git commit -m "feat(web): composer send button + pointer-aware enter behavior"
```

### Task 6: FIX — streaming on first send in a brand-new conversation

**Files:**

- Modify: `packages/web/src/chat/ChatView.vue` (:197 draft-mode `v-else`; onStreamSend :111-113; onSent :131-142)
- Modify: `packages/web/src/chat/Composer.vue` (:66-93 `send()` — draft branch uses non-streaming `execute`)
- Modify: `packages/web/src/chat/Thread.vue` (send() exposed at :147-150 — must emit the created conversation id)
- Test: `packages/web/src/chat/ChatView.test.ts` (extend; FakeWS harness already there)

**Interfaces:**

- Consumes: Thread's exposed `send()` (existing).
- Produces: Thread emits `created: [conversationId: string]` after a draft send completes; Composer emits ONLY `streamSend` (draft branch removed); ChatView replaces the route on `created`.

**Root cause (verified in recon):** In draft mode ChatView does not render `<Thread>` at all (ChatView.vue:197 `<Thread v-if="!isDraft" …>`), so `threadRef.value?.send()` inside `onStreamSend` (:111-113) is a silent no-op. Composer's draft branch (Composer.vue:78-93) therefore falls back to a non-streaming `execute('communicate')` — the first message of every new conversation never streams. The fix routes ALL sends through Thread's streaming POST; the conversation id created server-side arrives in the communicate result (`data.conversationId`, already unwrapped in useConversation.ts:204-210) and must bubble up so ChatView can transition the route.

- [ ] **Step 1: Write the failing test** (ChatView.test.ts, FakeWS harness):

```ts
it('streams the first send of a draft conversation', async () => {
  const w = mountChatView({ route: '/chat' }); // draft mode, existing harness
  await w.find('[data-test="recipient-picker"] input').setValue('assistant');
  // select recipient via combobox (existing pattern in this file's draft tests)
  await w.find('[data-test="composer-input"]').setValue('hello');
  await w.find('[data-test="composer-send"]').trigger('click');
  // FakeWS delivers a text_delta for the communicate stream
  await fakeWs.emitToolChunk('communicate', { type: 'text_delta', delta: 'hi there' });
  expect(w.find('[data-test="streaming-part"]').exists()).toBe(true);
});
```

- [ ] **Step 2: Verify FAIL** — `npm run test --workspace=packages/web -- ChatView`
      Expected: FAIL — no `streaming-part` renders (non-streaming execute path; Thread not mounted).

- [ ] **Step 3: Implement**

3a. Thread.vue — emit created id (script setup, near the done watch at :127):

```ts
const emit = defineEmits<{
  open: [tool: string, payload: Record<string, unknown>];
  created: [conversationId: string];
}>();
```

extend the existing `watch(stream.done, …)` (:127-132):

```ts
watch(stream.done, (isDone) => {
  if (isDone) {
    isStreaming.value = false;
    const result = stream.result.value as { data?: { conversationId?: string } } | null;
    const newConvId = result?.data?.conversationId;
    if (newConvId && !props.conversationId) emit('created', newConvId);
    void load();
  }
});
```

3b. Composer.vue — draft sends go through the same streaming handoff; replace `send()`'s conversationId branch AND draft branch:

```ts
async function send(): Promise<void> {
  const message = draft.value.trim();
  if (!message || !props.recipientId) return;
  draft.value = '';
  mentionQuery.value = null;
  // ALL sends — draft and existing — stream through Thread.send (ChatView wires
  // it). Composer never executes communicate itself.
  emit('streamSend', { to: props.recipientId, message });
}
```

3c. ChatView.vue — render Thread in draft mode too and handle `created` (replace :197-209 region): keep the recipient-picker block but mount Thread above it when streaming starts. Simplest correct structure:

```html
<Thread ref="threadRef" :conversation-id="activeId" @open="onChipOpen" @created="onCreated" />
<div
  v-if="isDraft && !streaming"
  class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
>
  <!-- existing recipient-picker block, unchanged -->
</div>
```

with:

```ts
function onCreated(conversationId: string): void {
  if (isDraft.value) {
    void router.replace(`/chat/${conversationId}`);
    void store.load();
  }
}
```

(`onSent`/Composer `@sent` wiring is removed — no draft `sent` events exist anymore. Remove `onStreamSend`'s no-op risk by keeping it; Thread is now always mounted so `threadRef.value?.send()` always binds.)

- [ ] **Step 4: Verify PASS** — `npm run test --workspace=packages/web -- ChatView`; then the full web suite (Composer/Thread tests may need the `sent`-event stubs updated to `streamSend`-only).
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/chat/ChatView.vue packages/web/src/chat/Composer.vue packages/web/src/chat/Thread.vue packages/web/src/chat/ChatView.test.ts packages/web/src/chat/Composer.test.ts
git commit -m "fix(web): stream first message of a new conversation"
```

### Task 7: Live-stream reasoning into the reasoning disclosure

**Files:**

- Modify: `packages/web/src/chat/Thread.vue` (chunk handler :104-119 — handles `text_delta` but drops `reasoning_delta`)
- Modify: `packages/web/src/chat/MessagePart.vue` (:35-39 renders ReasoningDisclosure only when `message.reasoning` — fine; no change expected unless streaming prop needs forcing)
- Modify: `packages/web/src/components/conversations/ReasoningDisclosure.vue` (raw `text-slate-400`/`text-cyan-500` classes → tokens; auto-open while streaming)
- Test: `packages/web/src/chat/Thread.test.ts` (FakeWS harness exists)

**Interfaces:**

- Consumes: `StreamChunk` union already includes `reasoning_delta` (`chunk.delta`) and `message_snapshot` (`chunk.reasoning`) — see useConversation.ts:130-142 for the reference handling.
- Produces: streaming message part carries live `reasoning` so `ReasoningDisclosure` renders it open.

- [ ] **Step 1: Write the failing test** (Thread.test.ts):

```ts
it('accumulates reasoning deltas into the streaming part', async () => {
  const w = mountThreadWithStream(); // existing FakeWS harness
  await w.vm.send('assistant', 'think then reply'); // exposed send
  await fakeWs.emitToolChunk('communicate', { type: 'iteration_start' });
  await fakeWs.emitToolChunk('communicate', { type: 'reasoning_delta', delta: 'step 1 ' });
  await fakeWs.emitToolChunk('communicate', { type: 'reasoning_delta', delta: 'step 2' });
  const reasoning = w.find('[data-reasoning][data-streaming-reasoning]');
  expect(reasoning.exists()).toBe(true);
  expect(reasoning.text()).toContain('step 1 step 2');
});
```

- [ ] **Step 2: Verify FAIL** — `npm run test --workspace=packages/web -- Thread`
      Expected: FAIL — reasoning text never accumulates (no `data-streaming-reasoning` node: `streamingReasoning` stays '').

- [ ] **Step 3: Implement** — Thread.vue chunk handler gains one branch (after the `text_delta` case at :113-115):

```ts
} else if (chunk.type === 'reasoning_delta') {
  isStreaming.value = true;
  streamingReasoning.value += chunk.delta;
}
```

ReasoningDisclosure.vue: replace raw classes with tokens (`text-muted` for body, `text-accent` for the label — matching the token names used across the app) and auto-open behavior is inherent: the `v-if="streaming"` branch renders expanded (already correct at :9-17). Swap `text-cyan-500` → `text-accent`, `text-slate-400` → `text-muted` in both branches.

- [ ] **Step 4: Verify PASS** — same run; full web suite.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/chat/Thread.vue packages/web/src/components/conversations/ReasoningDisclosure.vue packages/web/src/chat/Thread.test.ts
git commit -m "feat(web): live-stream reasoning into the reasoning disclosure"
```

### Task 8: Role-styled chat bubbles + compaction renderer

**Files:**

- Modify: `packages/web/src/theme/tokens.css` AND `packages/web/src/theme/light.css` (add bubble tokens to BOTH)
- Modify: `packages/web/src/chat/MessagePart.vue` (bubble wrapper + summary-type branch)
- Create: `packages/web/src/chat/CompactionNotice.vue`
- Test: `packages/web/src/chat/MessagePart.test.ts` (create if absent — check; MessagePart.vue currently has none listed in the dir listing, so create)

**Interfaces:**

- Consumes: `MessageData.role` (`'user' | 'assistant' | …`), `MessageData.type` (`'message' | 'summary'` — packages/types/src/conversation.ts:6).
- Produces: `CompactionNotice` component (`props: { message: MessageData }`, renders summary content muted/centered).

- [ ] **Step 1: Add tokens** (both files; dark values in tokens.css, light values in light.css — pick values consistent with each theme's surface scale):

```css
/* tokens.css (dark) */
--color-bubble-user: #1f2a3a; /* pick from the dark surface ramp */
--color-bubble-assistant: #1a1d23; /* near-surface, distinct from user */
/* light.css */
--color-bubble-user: #dbe7ff;
--color-bubble-assistant: #f1f3f6;
```

(Exact values must be read from the existing surface ramp in each file and chosen to be clearly distinct — the implementer picks harmonious values from the same ramps; the token NAMES are the contract.)

- [ ] **Step 2: Write failing tests** (MessagePart.test.ts):

```ts
it('renders user messages right-aligned in a user bubble', () => {
  const w = mount(MessagePart, { props: { message: mkMsg({ role: 'user', content: 'hi' }) } });
  expect(w.find('[data-test="msg"]').classes()).toContain('items-end');
  expect(w.find('[data-test="bubble"]').classes()).toContain('bg-bubble-user');
});
it('renders assistant messages left-aligned in an assistant bubble', () => {
  /* mirror: items-start + bg-bubble-assistant */
});
it('renders summary messages as CompactionNotice', () => {
  const w = mount(MessagePart, {
    props: { message: mkMsg({ type: 'summary', content: 'compacted 10 messages' }) },
  });
  expect(w.findComponent(CompactionNotice).exists()).toBe(true);
});
```

- [ ] **Step 3: Verify FAIL** — `npm run test --workspace=packages/web -- MessagePart`
- [ ] **Step 4: Implement** — MessagePart.vue template wraps content in a bubble container:

```html
<article
  data-test="msg"
  class="flex flex-col gap-2"
  :class="message.role === 'user' ? 'items-end' : 'items-start'"
>
  <CompactionNotice v-if="message.type === 'summary'" :message="message" />
  <template v-else>
    <ReasoningDisclosure … />
    <div
      data-test="bubble"
      class="max-w-[85%] rounded-lg px-3 py-2"
      :class="message.role === 'user' ? 'bg-bubble-user' : 'bg-bubble-assistant'"
    >
      <MarkdownContent v-if="message.content" … />
    </div>
    <div v-if="toolPairs.length" …><!-- tool chips unchanged, outside the bubble --></div>
  </template>
  <slot name="actions" :message="message" />
</article>
```

CompactionNotice.vue:

```vue
<script setup lang="ts">
import type { MessageData } from '@legion-collective/types';
import MarkdownContent from '../components/MarkdownContent.vue';
defineProps<{ message: MessageData }>();
</script>
<template>
  <div
    data-test="compaction-notice"
    class="mx-auto max-w-md rounded border border-line bg-surface/60 px-3 py-2 text-center text-xs text-muted"
  >
    <div class="font-medium">Conversation compacted</div>
    <MarkdownContent v-if="message.content" :content="message.content" class="mt-1 text-left" />
  </div>
</template>
```

(Keep tool chips/renderers outside the bubble for assistant messages — they are full-width affordances.)

- [ ] **Step 5: Verify PASS** — MessagePart tests; full web suite; `npm run format:check`.
- [ ] **Step 6: Commit**

```bash
git add packages/web/src/theme/tokens.css packages/web/src/theme/light.css packages/web/src/chat/MessagePart.vue packages/web/src/chat/MessagePart.test.ts packages/web/src/chat/CompactionNotice.vue
git commit -m "feat(web): role-styled chat bubbles and compaction renderer"
```

### Task 9: Compact-conversation action in the thread header

**Files:**

- Modify: `packages/web/src/chat/Thread.vue` (header actions row — add above the messages scroll region :189-194)
- Test: `packages/web/src/chat/Thread.test.ts`

**Interfaces:**

- Consumes: `compact_conversation` tool — args `{ conversationId: string, messageIds: string[], agentId?: string, instruction?: string }` (packages/core/src/tools/automation-tools.ts:46-78; manual compaction requires an `agentId` summarizer). `useToolAccess().can()` from Cluster A Task 2 — **cross-cluster dependency**: `can(tool): 'auto' | 'requires_approval' | 'hidden'`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**:

```ts
it('compacts the active conversation from the thread header', async () => {
  vi.mocked(useToolAccess).mockReturnValue({ can: () => 'auto' }); // repo's composable-mock pattern
  const w = mountThread(); // harness with loaded conversation + execute mock
  await w.find('[data-test="compact-btn"]').trigger('click');
  expect(w.find('[data-test="compact-confirm"]').exists()).toBe(true);
  await w.find('[data-test="compact-confirm"]').trigger('click');
  expect(executeMock).toHaveBeenCalledWith(
    'compact_conversation',
    expect.objectContaining({ conversationId: 'c1', agentId: expect.any(String) }),
  );
});
it('hides the compact action when access is not auto', () => {
  vi.mocked(useToolAccess).mockReturnValue({ can: () => 'hidden' });
  const w = mountThread();
  expect(w.find('[data-test="compact-btn"]').exists()).toBe(false);
});
```

- [ ] **Step 2: Verify FAIL** — `npm run test --workspace=packages/web -- Thread`
- [ ] **Step 3: Implement** — Thread.vue script adds:

```ts
import { useToolAccess } from '../composables/useToolAccess.js';
const toolAccess = useToolAccess();
const canCompact = computed(() => toolAccess.can('compact_conversation') === 'auto');
const compacting = ref(false);
const compactConfirm = ref(false);
// Summarizer: the assistant agent (first active agent participant) — same choice
// the auto-compaction middleware uses. Read via useParticipants().
async function compact(): Promise<void> {
  if (!props.conversationId) return;
  compacting.value = true;
  try {
    const agent = participants.value.find((p) => p.type === 'agent' && p.status === 'active');
    const messageIds = messages.value.filter((m) => m.type === 'message').map((m) => m.id);
    await execute('compact_conversation', {
      conversationId: props.conversationId,
      messageIds,
      ...(agent ? { agentId: agent.id } : {}),
    });
    await load();
  } finally {
    compacting.value = false;
    compactConfirm.value = false;
  }
}
```

Template (new header row above the messages region :194):

```html
<div
  v-if="conversationId && canCompact"
  class="flex items-center justify-end gap-2 border-b border-line px-4 py-1.5"
>
  <button
    v-if="!compactConfirm"
    type="button"
    data-test="compact-btn"
    class="rounded px-2 py-0.5 text-xs text-muted hover:bg-surface"
    :disabled="compacting"
    @click="compactConfirm = true"
  >
    Compact
  </button>
  <template v-else>
    <span class="text-xs text-muted">Compact history via summarizer?</span>
    <button
      type="button"
      data-test="compact-confirm"
      class="rounded bg-accent px-2 py-0.5 text-xs text-on-accent"
      @click="compact()"
    >
      Yes
    </button>
    <button
      type="button"
      class="rounded px-2 py-0.5 text-xs text-muted"
      @click="compactConfirm = false"
    >
      Cancel
    </button>
  </template>
</div>
```

(Note: `useParticipants()` import + `participants` ref; if Thread lacks it, import like ChatView does at :85.)

- [ ] **Step 4: Verify PASS** — Thread tests; full web suite.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/chat/Thread.vue packages/web/src/chat/Thread.test.ts
git commit -m "feat(web): compact-conversation action in thread header"
```

---

## Clusters D+E — forms, mobile, drawer (plan tasks 10-13)

> Recon finding (context for the executor): AgentEditor.vue:51-98 and UserEditor.vue:40-81
> already hydrate correctly — `get_participant` is called with the correct `{ id }` args and
> fields are mapped properly. The "blank forms + red 'hidden'" symptom was the ACCESS denial:
> restricted users lacked `get_participant`, so `load()` caught the 'hidden' error into the
> error banner and left fields at defaults. Cluster B (already applied) fixed the live
> symptom for operator/chris-web; Task 10 locks hydration in with regression tests and Task
> 11 makes the residual denial path humane.

### Task 10: Editor-form hydration regression tests + friendly load errors

**Files:**

- Test: `packages/web/src/views/AgentEditor.test.ts` (exists — extend)
- Test: `packages/web/src/views/UserEditor.test.ts` (exists — extend)
- Modify: `packages/web/src/views/AgentEditor.vue` (:78-80 error assignment), `packages/web/src/views/UserEditor.vue` (:67-69) — error display via Task 11's helper (cross-cluster dependency: `friendlyToolError`)

**Interfaces:**

- Consumes: `get_participant` result shape (full participant config), `list_tools` (string[]). `friendlyToolError(err): string` from Task 11.
- Produces: regression-proof editor hydration.

- [ ] **Step 1: Write failing tests** (AgentEditor.test.ts — mirror for UserEditor with its fields):

```ts
it('hydrates name, system prompt and tool overrides for an existing agent', async () => {
  executeMock.mockImplementation(async (tool: string) => {
    if (tool === 'get_participant')
      return {
        id: 'assistant',
        name: 'Assistant',
        type: 'agent',
        status: 'active',
        systemPrompt: 'You are helpful.',
        maxIterations: 25,
        model: { model: 'GLM-5.3-Flash-EXL3' },
        tools: { communicate: 'auto', file_read: 'requires_approval' },
      };
    if (tool === 'list_tools') return ['communicate', 'file_read', 'list_tools'];
    if (tool === 'list_models') return [];
    if (tool === 'list_middleware') return { definitions: [] };
    return undefined;
  });
  const w = mount(AgentEditor, { props: { participantId: 'assistant' } });
  await flushPromises();
  expect((w.find('input[data-test="agent-name"]').element as HTMLInputElement).value).toBe(
    'Assistant',
  );
  expect(
    (w.find('textarea[data-test="agent-system-prompt"]').element as HTMLTextAreaElement).value,
  ).toBe('You are helpful.');
  const overrides = w.findAll('[data-test="tool-override-row"]');
  expect(overrides.length).toBeGreaterThanOrEqual(3);
});
it('shows a friendly message when get_participant is denied', async () => {
  executeMock.mockRejectedValue(new Error('hidden'));
  const w = mount(AgentEditor, { props: { participantId: 'assistant' } });
  await flushPromises();
  expect(w.find('[data-test="editor-error"]').text()).not.toContain('hidden');
  expect(w.find('[data-test="editor-error"]').text()).toContain('access');
});
```

(Adjust selectors to the actual data-test attributes in the current templates — read them first; if `data-test="agent-name"` etc. do not exist, ADD them to the template inputs in this task. `data-test="editor-error"` is added here.)

- [ ] **Step 2: Verify FAIL** — `npm run test --workspace=packages/web -- AgentEditor UserEditor` (friendly-error test fails: banner shows raw 'hidden'; data-test attrs may be missing).
- [ ] **Step 3: Implement** — in both editors' load() catch:
      `error.value = friendlyToolError(err);` (import from `../composables/friendlyToolError.js`, Task 11). Add `data-test="editor-error"` to the existing error banner element in both templates (find the `v-if="error"` element).
- [ ] **Step 4: Verify PASS** — same run + full web suite.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/views/AgentEditor.vue packages/web/src/views/AgentEditor.test.ts packages/web/src/views/UserEditor.vue packages/web/src/views/UserEditor.test.ts
git commit -m "test(web): lock editor hydration with regressions; friendly denied-access message"
```

### Task 11: No unauthorized calls; map residual 'hidden' errors to quiet no-ops

**Files:**

- Create: `packages/web/src/composables/friendlyToolError.ts`
- Create: `packages/web/src/composables/friendlyToolError.test.ts`
- Modify: `packages/web/src/chat/Thread.vue` (:62, :190-193 error + streamError rendering), `packages/web/src/chat/MessageActions.vue` (:38 error assignment)
- Modify: `packages/web/src/views/ParticipantsView.vue` (:15 mount-load already swallows — keep, plus gate the mount call via Task 2's `useToolAccess`)

**Interfaces:**

- Consumes: `useToolAccess().can()` (Task 2).
- Produces: `friendlyToolError(err: unknown): string` — maps a denied tool result to human text: literal `'hidden'` (or whitespace variants) → `'You do not have access to this action.'`; anything else passes through unchanged.

- [ ] **Step 1: Write failing tests**:

```ts
// friendlyToolError.test.ts
it('maps a bare hidden denial to friendly text', () => {
  expect(friendlyToolError(new Error('hidden'))).toBe('You do not have access to this action.');
  expect(friendlyToolError('hidden')).toBe('You do not have access to this action.');
});
it('passes real errors through unchanged', () => {
  expect(friendlyToolError(new Error('boom'))).toBe('boom');
});
```

```ts
// MessageActions.test.ts addition
it('shows friendly text when edit_message is denied', async () => {
  executeMock.mockRejectedValue(new Error('hidden'));
  const w = mountMessageActions(); // existing harness
  await w.find('[data-test="actions-toggle"]').trigger('click');
  await w.find('[data-test="action-edit"]').trigger('click'); // adjust to real selectors
  await w.find('[data-test="action-save"]').trigger('click');
  await flushPromises();
  expect(w.text()).not.toContain('hidden');
});
```

- [ ] **Step 2: Verify FAIL** — `npm run test --workspace=packages/web -- friendlyToolError MessageActions`
- [ ] **Step 3: Implement** the helper:

```ts
// packages/web/src/composables/friendlyToolError.ts
const DENIED = 'You do not have access to this action.';
export function friendlyToolError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.trim().toLowerCase() === 'hidden' ? DENIED : msg;
}
```

Apply `friendlyToolError(err)` at: Thread.vue load-catch (:62) and `streamError` assignment (:135), MessageActions.vue run-catch (:38), both editors (Task 10), ConfigView.vue and McpSourcesEditor.vue catch sites. Gate ParticipantsView's mount load: `onMounted(() => { if (useToolAccess().can('list_participants') !== 'hidden') void load().catch(() => {}); })`.

- [ ] **Step 4: Verify PASS** — full web suite (all touched files).
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/composables/friendlyToolError.ts packages/web/src/composables/friendlyToolError.test.ts packages/web/src/chat/Thread.vue packages/web/src/chat/MessageActions.vue packages/web/src/views/ParticipantsView.vue packages/web/src/views/ConfigView.vue packages/web/src/views/McpSourcesEditor.vue
git commit -m "fix(web): no unauthorized calls; map hidden tool errors to quiet no-op"
```

### Task 12: Mobile single-pane participants

**Files:**

- Create: `packages/web/src/composables/useNarrowViewport.ts`
- Modify: `packages/web/src/views/ParticipantsView.vue` (master-detail template :58-146)
- Test: `packages/web/src/views/ParticipantsView.test.ts` (create if absent)

**Interfaces:**

- Consumes: nothing.
- Produces: `useNarrowViewport(): { isNarrow: Ref<boolean> }` — matchMedia('(max-width: 767px)'), listener-managed like useCoarsePointer (Task 5).

- [ ] **Step 1: Write failing tests**:

```ts
it('shows only the list when narrow and nothing is selected', () => {
  stubMatchMedia('(max-width: 767px)', true);
  const w = mountParticipantsView(); // harness with participants loaded
  expect(w.find('[data-test="participant-detail-pane"]').exists()).toBe(false);
  expect(w.find('[data-test="participants-list-pane"]').exists()).toBe(true);
});
it('swaps to the detail pane with a back button after selecting', async () => {
  stubMatchMedia('(max-width: 767px)', true);
  const w = mountParticipantsView();
  await w.find('[data-test="participant-row-assistant"]').trigger('click'); // adjust selector
  expect(w.find('[data-test="participant-detail-pane"]').exists()).toBe(true);
  expect(w.find('[data-test="participants-list-pane"]').exists()).toBe(false);
  await w.find('[data-test="mobile-back"]').trigger('click');
  expect(w.find('[data-test="participants-list-pane"]').exists()).toBe(true);
});
it('shows both panes on wide viewports', () => {
  stubMatchMedia('(max-width: 767px)', false);
  const w = mountParticipantsView();
  expect(w.find('[data-test="participants-list-pane"]').exists()).toBe(true);
  expect(w.find('[data-test="participant-detail-pane"]').exists()).toBe(true);
});
```

- [ ] **Step 2: Verify FAIL** — `npm run test --workspace=packages/web -- ParticipantsView`
- [ ] **Step 3: Implement** the composable (mirror useCoarsePointer structure from Task 5 with `(max-width: 767px)`), then ParticipantsView script:

```ts
const { isNarrow } = useNarrowViewport();
const mobileDetail = computed(() => isNarrow.value && selectedId.value !== null);
```

Template: list pane `<div v-if="!mobileDetail" data-test="participants-list-pane" …>` (keep existing classes; add the two pane data-tests); detail pane `<div v-show="!isNarrow || mobileDetail" data-test="participant-detail-pane" …>` wrapping the existing detail block, with a narrow-only back button as its first child:

```html
<button
  v-if="isNarrow"
  type="button"
  data-test="mobile-back"
  class="mb-2 rounded border border-line px-2 py-1 text-xs text-muted hover:bg-surface"
  @click="select(null)"
>
  ← Back to list
</button>
```

(`v-show` on desktop keeps the pane mounted — the `dl` empty-state logic is untouched inside.)

- [ ] **Step 4: Verify PASS** — ParticipantsView tests; full web suite.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/composables/useNarrowViewport.ts packages/web/src/views/ParticipantsView.vue packages/web/src/views/ParticipantsView.test.ts
git commit -m "feat(web): single-pane participants layout on narrow viewports"
```

### Task 13: FIX — subchat drawer renders empty

**Files:**

- Modify: `packages/web/src/panels/CommunicatePanel.vue` (:9 conversation-id resolution)
- Test: `packages/web/src/panels/DockPanel.test.ts` (exists — extend with a CommunicatePanel case)

**Interfaces:**

- Consumes: ToolCallChip payload contract `{ tool, args, result }` (MessagePart.vue:46-50) — `args` = communicate args `{to, message, conversationId?}`, `result` = ToolResult `{status, data: {conversationId}}` for a completed communicate.
- Produces: resolved conversation id for the embedded Thread.

**Root cause (verified in recon):** CommunicatePanel.vue:9 reads only `payload['conversationId']` — but the chip payload carries `args` and `result`, not a flattened `conversationId`. Communicate args contain a conversationId only when one already existed (side-conversations spawned by agents have none in args — the NEW id arrives in `result.data.conversationId`). With neither matched, the panel mounts `<Thread :conversation-id="''">`, Thread.load() bails on falsy id, and the drawer renders empty.

- [ ] **Step 1: Write the failing test** (DockPanel.test.ts):

```ts
it('resolves the subchat conversation id from args or result', async () => {
  executeMock.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
    if (tool === 'get_conversation')
      return {
        id: args['conversationId'],
        messages: [mkMsg({ id: 'm1', content: 'subchat line' })],
      };
    return undefined;
  });
  const w = mountDockWithPanel({
    kind: 'communicate',
    payload: {
      tool: 'communicate',
      args: { to: 'researcher', message: 'go' },
      result: { status: 'success', data: { conversationId: 'sub-1' } },
    },
  });
  await flushPromises();
  expect(executeMock).toHaveBeenCalledWith(
    'get_conversation',
    expect.objectContaining({ conversationId: 'sub-1' }),
  );
  expect(w.text()).toContain('subchat line');
});
it('shows a placeholder when no conversation id can be resolved', () => {
  const w = mountDockWithPanel({
    kind: 'communicate',
    payload: { tool: 'communicate', args: { to: 'x' }, result: null },
  });
  expect(w.find('[data-test="subchat-empty"]').exists()).toBe(true);
});
```

- [ ] **Step 2: Verify FAIL** — `npm run test --workspace=packages/web -- DockPanel`
- [ ] **Step 3: Implement** — CommunicatePanel.vue script:

```ts
const props = defineProps<{ payload: Record<string, unknown> }>();
const args = (props.payload['args'] ?? {}) as { conversationId?: string };
const result = props.payload['result'] as { data?: { conversationId?: string } } | null;
const conversationId = ref<string>(
  String(args.conversationId ?? result?.data?.conversationId ?? ''),
);
```

Template: wrap the Thread in `v-if="conversationId"` and add:

```html
<div v-else data-test="subchat-empty" class="p-6 text-sm text-faint">
  No sub-conversation yet — this message did not spawn one.
</div>
```

(Keep the header/jump block unchanged.)

- [ ] **Step 4: Verify PASS** — DockPanel tests; full web suite.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src/panels/CommunicatePanel.vue packages/web/src/panels/DockPanel.test.ts
git commit -m "fix(web): subchat drawer renders the forked conversation"
```

---

## Final gate — full test pass, redeploy, live verification (plan task 14)

### Task 14: Final gate, image rebuild + redeploy, live smoke, reduced-access proof

**Files:**

- Modify: none (ops + verification task)
- Ephemeral: test-user credentials reported to Chris in the completion message, never committed

**Interfaces:**

- Consumes: everything from tasks 1–13 (merged plan). `useToolAccess.can()` gating live in the deployed bundle. `list_tools` caller-policy return from task 1.
- Produces: deployed `legion:collective-git` image containing the fixed UI; a reduced-access user `limited-tester` proving gating; pushed `web-ui-rewrite`.

- [ ] **Step 1: Full gate in order**

```bash
npm run format:check && npm run typecheck && npm test && npm run test --workspace=packages/web
```

Expected: all four green. Fix anything red before continuing (fixes get their own `fix:` commits).

- [ ] **Step 2: Build the web SPA**

```bash
npm run build --workspace=packages/web
```

Expected: `vite build` succeeds; `packages/web/dist/index.html` + fresh `assets/*.js` hashes.

- [ ] **Step 3: E2E web-ui journeys**

```bash
env -u PLAYWRIGHT_BROWSERS_PATH -u AGENT_BROWSER_EXECUTABLE_PATH \
  npx playwright test --config packages/e2e/playwright.config.ts packages/e2e/tests/web-ui --project=chromium
```

Expected: all web-ui journeys pass. All-crash "Target crashed" waves = box pids cap (infra): `sleep 60` and rerun once; a genuine failure reproduces consistently and must be fixed before proceeding.

- [ ] **Step 4: Tag rollback point, rebuild image, redeploy**

```bash
docker tag legion:collective-git legion:collective-git-pre-review-fixes
docker build -t legion:collective-git /workspace/legion-web-ui
cd /workspace/legion-collective/deploy && docker compose up -d
```

Verify (from the deploy dir):

```bash
docker ps --filter name=legion-collective --format '{{.Status}}'
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:3000/   # 200 text/html
curl -s http://127.0.0.1:3000/api/health                                          # {"status":"ok"}
```

- [ ] **Step 5: Live smoke as operator**

Using the current operator password (provided in the task brief; NEVER write it into any committed file):
login `POST /api/auth/login {name:"Chris"}` → token; send a chat message via the UI API path and confirm the reply streams; confirm zero occurrences of the literal error `hidden` in any response during the smoke.

- [ ] **Step 6: Reduced-access gating proof (live)**

```bash
# as operator (execute tool): create_user {id:'limited-tester', name:'Limited Tester',
#   tools:{communicate:'auto', list_conversations:'auto'}}
# then set_credential {participantId:'limited-tester', secret:'<random 16+ chars>'}
```

Then: login as `Limited Tester` → `list_tools` must return `callerPolicy` with exactly the two `auto` entries. Generate a Playwright script (throwaway, `packages/e2e/` is fine but do NOT commit it — or run a standalone probe) that logs in as the limited user against :3000 and asserts the Participants/Processes/Config nav affordances are NOT rendered (proving client-side gating with real data, complementing the unit tests from tasks 2–3). Report the generated password to Chris in the completion message only.

- [ ] **Step 7: Push and wrap up**

```bash
git push origin web-ui-rewrite
```

Verify the push landed; PR #10 now contains the review-feedback wave. Post completion with: gate summary, deploy verification outputs, limited-tester password, any deferred items.

---
