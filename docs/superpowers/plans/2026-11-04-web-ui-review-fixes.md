# Web UI Review-Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the high/medium findings from the 2026-11-04 web-UI code review, with regression tests, then run the full gate.

**Architecture:** Keep the existing tool-call architecture. Fix the model/config editors, dock persistence, chat actions, WebSocket lifecycle, live approvals, editor privilege guards, theme/token conformance, management-page error handling, and backend hardening. No new CRUD endpoints; no new runtime dependencies unless explicitly listed.

**Tech Stack:** TypeScript strict + Vue 3 + Vite + Vitest (happy-dom for web) + Fastify + WebSocket (`ws`) + Node 22.

**Spec:** `docs/superpowers/specs/2026-10-07-web-ui-rewrite-design.md`
**Review:** `docs/reviews/2026-11-04-web-ui-code-review.md`

## Global Constraints

- Node >= 20, npm workspaces, pure ESM. Relative imports in `.ts` use `.js` extensions.
- TypeScript strict, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`; `import type` for type-only imports.
- Prettier: single quotes, semicolons, trailing commas, 100 cols, 2 spaces.
- Do not edit `dist/` or `tsconfig*.tsbuildinfo`.
- Test commands MUST run through `./scripts/docker-node.sh` (host has no Node):
  - unit: `./scripts/docker-node.sh npx vitest run <path>`
  - web: `./scripts/docker-node.sh npm run test --workspace=packages/web`
  - all: `./scripts/docker-node.sh npm test`
  - typecheck: `./scripts/docker-node.sh npm run typecheck`
  - format: `./scripts/docker-node.sh npm run format:check`
- Web tests are separate from root vitest. Do not add web tests to the root config.
- Every task ends with a commit. Use `fix(web): ...`, `fix(core): ...`, `fix(runtime): ...`, or `test(...)` as appropriate.
- No new npm dependencies. Rate limiting and security headers must be implemented in-repo.

---

### Task 1: Model configuration — AgentEditor model picker + RoutingEditor hydration

**Files:**

- Modify: `packages/web/src/views/AgentEditor.vue`
- Modify: `packages/web/src/views/AgentEditor.test.ts`
- Modify: `packages/web/src/components/config/RoutingEditor.vue`
- Create: `packages/web/src/components/config/RoutingEditor.test.ts`
- Modify: `packages/web/src/views/ConfigView.test.ts`

**Interfaces:**

- `list_models` returns `{ provider: string; model: { id: string; name?: string } }[]` (source: `packages/runtime/src/server/runtime-tools.ts:106-113`, `packages/types/src/config.ts:58-65`).
- `RoutingEditor` props: `{ scope: 'system' | 'workspace'; routing: RoutingConfig; providerNames: string[] }`; emits `saved`.

- [ ] **Step 1: Add a failing AgentEditor test using the real `list_models` shape**

In `packages/web/src/views/AgentEditor.test.ts`, add `flushPromises` to the `@vue/test-utils` import and add:

```ts
it('renders model ids from list_models and saves the selected id', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tool === 'get_participant')
        return toolResponse('get_participant', {
          ...AGENT,
          model: { model: 'DeepSeek-V4.1-Flash-1017' },
        });
      if (body.tool === 'list_tools')
        return toolResponse('list_tools', { tools: ['communicate'], callerPolicy: {} });
      if (body.tool === 'list_models')
        return toolResponse('list_models', [
          {
            provider: 'local',
            model: { id: 'DeepSeek-V4.1-Flash-1017', name: 'DeepSeek V4.1 Flash' },
          },
        ]);
      if (body.tool === 'list_middleware')
        return toolResponse('list_middleware', { definitions: [] });
      if (body.tool === 'modify_agent') return toolResponse('modify_agent', { id: 'agent-a' });
      return toolResponse(body.tool, {});
    }),
  );
  const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
  await vi.waitFor(() =>
    expect((wrapper.find('[data-test="agent-model"]').element as HTMLSelectElement).value).toBe(
      'DeepSeek-V4.1-Flash-1017',
    ),
  );
  const options = wrapper.findAll('[data-test="agent-model"] option');
  expect(options.map((o) => o.attributes('value'))).toContain('DeepSeek-V4.1-Flash-1017');
  await wrapper.find('[data-test="agent-save"]').trigger('click');
  await flushPromises();
  const saveCall = (vi.mocked(fetch).mock.calls as Array<[string, RequestInit]>).find(
    ([, init]) => JSON.parse(String(init?.body)).tool === 'modify_agent',
  );
  expect(JSON.parse(String(saveCall?.[1].body)).args.model).toEqual({
    model: 'DeepSeek-V4.1-Flash-1017',
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/views/AgentEditor.test.ts`
Expected: FAIL — select value is empty / no option value.

- [ ] **Step 3: Implement the model-picker fix**

In `AgentEditor.vue`:

```ts
const modelOptions = ref<{ provider: string; model: { id: string; name?: string } }[]>([]);

// list_models returns ProviderModel.id, not a nested model.model.
void execute<{ provider: string; model: { id: string; name?: string } }[]>('list_models', {})
  .then((models) => (modelOptions.value = models))
  .catch(() => {});
```

Replace `groupedModels`:

```ts
const groupedModels = computed(() => {
  const groups = new Map<string, { id: string; label: string }[]>();
  for (const entry of modelOptions.value) {
    const id = entry.model.id;
    const list = groups.get(entry.provider) ?? [];
    list.push({ id, label: entry.model.name ?? id });
    groups.set(entry.provider, list);
  }
  // Keep an unknown existing model selectable rather than silently dropping it.
  if (
    modelText.value &&
    ![...groups.values()].some((list) => list.some((m) => m.id === modelText.value))
  ) {
    groups.set('current', [{ id: modelText.value, label: modelText.value }]);
  }
  return [...groups.entries()];
});
```

Update the template:

```vue
<option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
```

Add a model guard to `canSave`:

```ts
const canSave = computed(() =>
  props.participantId === 'new'
    ? toolAccess.can('create_agent') === 'auto' && modelText.value.trim().length > 0
    : toolAccess.can('modify_agent') === 'auto' && modelText.value.trim().length > 0,
);
```

- [ ] **Step 4: Add a failing RoutingEditor hydration test**

Create `packages/web/src/components/config/RoutingEditor.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import RoutingEditor from './RoutingEditor.vue';

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  localStorage.setItem('legion-token', 'tok');
  localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
});

describe('RoutingEditor', () => {
  it('hydrates rows when the routing prop arrives after mount', async () => {
    const wrapper = mount(RoutingEditor, {
      props: { scope: 'system', routing: {}, providerNames: ['local'] },
    });
    expect(wrapper.findAll('[data-test="routing-row"]')).toHaveLength(0);
    await wrapper.setProps({
      routing: { models: { 'DeepSeek-V4.1-Flash-1017': ['local'] } },
    });
    expect(wrapper.findAll('[data-test="routing-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="routing-row"]').text()).toContain('DeepSeek-V4.1-Flash-1017');
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/components/config/RoutingEditor.test.ts`
Expected: FAIL — 0 rows after `setProps`.

- [ ] **Step 6: Implement the RoutingEditor fix**

In `RoutingEditor.vue`, replace the one-time `rows` initialization with a deep immediate watcher:

```ts
const rows = ref<Array<{ model: string; providers: string[] }>>([]);

watch(
  () => props.routing,
  (routing) => {
    rows.value = Object.entries(routing.models ?? {}).map(([model, providers]) => ({
      model,
      providers: [...providers],
    }));
  },
  { deep: true, immediate: true },
);
```

Add `data-test="routing-row"` to the row container (`<div v-for="(row, rowIndex) in rows" ...>`).

- [ ] **Step 7: Add a ConfigView integration assertion**

In `ConfigView.test.ts`, add:

```ts
it('renders existing system routing after load', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tool === 'list_providers') return toolResponse('list_providers', []);
      if (body.tool === 'get_routing')
        return toolResponse('get_routing', {
          system: { models: { 'DeepSeek-V4.1-Flash-1017': ['local'] } },
          workspace: {},
        });
      return toolResponse(body.tool, {});
    }),
  );
  const wrapper = mount(ConfigView, { global: { plugins: [router] } });
  await vi.waitFor(() => expect(wrapper.text()).toContain('DeepSeek-V4.1-Flash-1017'));
  wrapper.unmount();
});
```

Add a `toolResponse` helper to that file if one does not exist:

```ts
function toolResponse(_tool: string, data: unknown): Response {
  return new Response(JSON.stringify({ result: { status: 'success', data } }), { status: 200 });
}
```

- [ ] **Step 8: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/views/AgentEditor.test.ts packages/web/src/components/config/RoutingEditor.test.ts packages/web/src/views/ConfigView.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/views/AgentEditor.vue packages/web/src/views/AgentEditor.test.ts \
  packages/web/src/components/config/RoutingEditor.vue \
  packages/web/src/components/config/RoutingEditor.test.ts \
  packages/web/src/views/ConfigView.test.ts
git commit -m "fix(web): use ProviderModel.id in the agent model picker; hydrate routing rows"
```

---

### Task 2: Dock persistence, mobile width, and jump-to-message

**Files:**

- Modify: `packages/web/src/panels/registry.ts`
- Modify: `packages/web/src/panels/registry.test.ts`
- Modify: `packages/web/src/panels/DockPanel.vue`
- Modify: `packages/web/src/panels/DockPanel.test.ts`
- Modify: `packages/web/src/panels/CommunicatePanel.vue`
- Modify: `packages/web/src/chat/ChatView.vue`
- Modify: `packages/web/src/chat/Thread.vue`

**Interfaces:**

- `useDock()` keeps `tabs`, `activeId`, `width`, `isOpen`, `setConversation(id)`.
- `DockPanel` emits `jump: [messageId: string]`.
- `Thread` exposes `scrollToMessage(messageId: string): void`.

- [ ] **Step 1: Add a failing dock-restore test**

In `packages/web/src/panels/registry.test.ts`:

```ts
it('restores persisted tabs when switching to a conversation', () => {
  localStorage.setItem(
    'legion-dock-c1',
    JSON.stringify({
      tabs: [
        {
          id: 'tool-detail:a',
          kind: 'tool-detail',
          title: 'A',
          icon: 'T',
          payload: { tool: 'a' },
        },
      ],
      activeId: 'tool-detail:a',
      width: 500,
    }),
  );
  const dock = useDock();
  dock.setConversation('c1');
  expect(dock.tabs.value).toHaveLength(1);
  expect(dock.activeId.value).toBe('tool-detail:a');
  expect(dock.width.value).toBe(500);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/panels/registry.test.ts`
Expected: FAIL — tabs length 0 (restore wipes before reading).

- [ ] **Step 3: Implement restore-before-write**

In `registry.ts`, add a `restoring` flag and read the stored value before assigning:

```ts
let restoring = false;

function persist(): void {
  if (restoring || conversationId.value === null) return;
  localStorage.setItem(
    storageKey(),
    JSON.stringify({ tabs: tabs.value, activeId: activeId.value, width: width.value }),
  );
}

function restore(): void {
  restoring = true;
  try {
    tabs.value = [];
    activeId.value = null;
    if (conversationId.value === null) return;
    const raw = localStorage.getItem(storageKey());
    if (!raw) return;
    const saved = JSON.parse(raw) as {
      tabs?: DockTab[];
      activeId?: string | null;
      width?: number;
    };
    tabs.value = saved.tabs ?? [];
    activeId.value = saved.activeId ?? tabs.value[0]?.id ?? null;
    if (saved.width !== undefined) width.value = saved.width;
  } catch {
    // corrupted state: start empty
  } finally {
    restoring = false;
  }
}
```

- [ ] **Step 4: Add mobile-width and jump tests**

In `DockPanel.test.ts`:

```ts
it('uses a full-viewport width on narrow screens', () => {
  const dock = useDock();
  dock.setConversation('c1');
  dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
  const wrapper = mount(DockPanel);
  expect(wrapper.find('[data-test="dock-root"]').classes()).toContain('max-md:!w-full');
});

it('forwards the sub-chat jump event', async () => {
  executeMock.mockResolvedValue({
    id: 'sub-1',
    messages: [
      {
        id: 'm1',
        parentId: null,
        conversationId: 'sub-1',
        senderId: 'user-1',
        recipientId: 'agent-a',
        role: 'user',
        content: 'hi',
        timestamp: '2026-10-13T00:00:00Z',
        status: 'active',
      },
    ],
  });
  const dock = useDock();
  dock.setConversation('c1');
  dock.open({
    kind: 'communicate',
    title: '@subchat',
    icon: '💬',
    payload: {
      tool: 'communicate',
      args: {},
      result: { status: 'success', data: { conversationId: 'sub-1' } },
      replyMessageId: 'm1',
    },
  });
  const wrapper = mount(DockPanel);
  await flushPromises();
  await wrapper.find('[data-test="jump-to-message"]').trigger('click');
  expect(wrapper.emitted('jump')?.[0]).toEqual(['m1']);
});
```

- [ ] **Step 5: Run to verify they fail**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/panels/DockPanel.test.ts`
Expected: FAIL — no `max-md:!w-full`, no `jump` emit.

- [ ] **Step 6: Implement mobile width and jump forwarding**

In `DockPanel.vue`:

```ts
const emit = defineEmits<{ jump: [messageId: string] }>();
```

Add `max-md:!w-full` to the root class and bind the panel event:

```vue
<aside
  data-test="dock-root"
  class="flex flex-col border-l border-line bg-bg max-md:fixed max-md:inset-0 max-md:z-40 max-md:!w-full"
  :style="{ width: `${dock.width.value}px` }"
>
...
<component
  v-if="activeTab && activeEntry"
  :is="activeEntry.component"
  :payload="activeTab.payload"
  @jump="emit('jump', $event)"
/>
```

- [ ] **Step 7: Wire the jump to the main thread**

In `Thread.vue`, add `data-message-id` to the message wrapper:

```vue
<div v-for="m in messages" :key="m.id" class="flex flex-col gap-2" :data-message-id="m.id">
```

Expose a scroll method:

```ts
scrollToMessage: (messageId: string): void => {
  const target = tailEl.value?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  target?.scrollIntoView({ block: 'center' });
},
```

In `ChatView.vue`:

```ts
function onDockJump(messageId: string): void {
  threadRef.value?.scrollToMessage(messageId);
}
```

`ChatView` already listens `@jump="onDockJump"` on `DockPanel`; verify the binding remains.

- [ ] **Step 8: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/panels/registry.test.ts packages/web/src/panels/DockPanel.test.ts packages/web/src/chat/Thread.test.ts packages/web/src/chat/ChatView.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/panels/registry.ts packages/web/src/panels/registry.test.ts \
  packages/web/src/panels/DockPanel.vue packages/web/src/panels/DockPanel.test.ts \
  packages/web/src/panels/CommunicatePanel.vue packages/web/src/chat/ChatView.vue \
  packages/web/src/chat/Thread.vue
git commit -m "fix(web): restore dock state, full-screen mobile dock, working jump breadcrumb"
```

---

### Task 3: Chat actions — Re-run, approval matching, streaming sender

**Files:**

- Modify: `packages/web/src/chat/MessageActions.vue`
- Modify: `packages/web/src/chat/MessageActions.test.ts`
- Modify: `packages/web/src/chat/Thread.vue`
- Modify: `packages/web/src/chat/Thread.test.ts`

**Interfaces:**

- `MessageActions` message prop becomes `{ id: string; content?: string; role?: 'user' | 'assistant'; senderId?: string; recipientId?: string }`.
- `generate` requires `{ conversationId: string; agentId: string }`.

- [ ] **Step 1: Add a failing Re-run test**

In `MessageActions.test.ts`:

```ts
it('re-run passes the message agent id to generate', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'success', data: {} } }), { status: 200 }),
    );
  vi.stubGlobal('fetch', fetchMock);
  mockCan(() => 'auto');
  useParticipants().__setParticipantsForTests([
    { id: 'agent-a', name: 'Agent A', type: 'agent', tools: {}, status: 'active' },
  ]);
  const wrapper = mount(MessageActions, {
    props: {
      conversationId: 'c1',
      message: { id: 'm1', content: 'hi', role: 'user', recipientId: 'agent-a' },
    },
  });
  await wrapper.find('[data-test="actions-toggle"]').trigger('click');
  await wrapper.find('[data-test="action-rerun"]').trigger('click');
  await flushPromises();
  const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
  expect(body.tool).toBe('generate');
  expect(body.args).toEqual({ conversationId: 'c1', agentId: 'agent-a' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/chat/MessageActions.test.ts`
Expected: FAIL — args lack `agentId`.

- [ ] **Step 3: Implement the agent-id derivation**

In `MessageActions.vue`:

```ts
import { useParticipants } from '../composables/useParticipants.js';

const { participants, byId } = useParticipants();

const agentId = computed<string | null>(() => {
  const candidate =
    props.message.role === 'user' ? props.message.recipientId : props.message.senderId;
  if (candidate && byId(candidate)?.type === 'agent') return candidate;
  return participants.value.find((p) => p.type === 'agent' && p.status !== 'retired')?.id ?? null;
});

function rerun(): void {
  if (!agentId.value) {
    error.value = 'No agent available to re-run this message.';
    return;
  }
  void run(() =>
    execute('generate', { conversationId: props.conversationId, agentId: agentId.value }),
  );
}
```

Expand the prop type as above. `Thread.vue` already passes the full `msg` to `MessageActions`; ensure `MessageActions.test.ts` mocks `useParticipants` correctly (it already imports it in the file; if not, add the mock).

- [ ] **Step 4: Add a failing approval-matching test**

In `Thread.test.ts`:

```ts
it('attaches a pending approval to only the first matching tool call', async () => {
  const chain = [
    {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: '2026-10-08T01:00:00Z',
      status: 'complete',
      toolCalls: [{ id: 'tc1', name: 'file_write', arguments: {} }],
    },
    {
      id: 'm2',
      role: 'assistant',
      content: '',
      timestamp: '2026-10-08T01:00:05Z',
      status: 'complete',
      toolCalls: [{ id: 'tc2', name: 'file_write', arguments: {} }],
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: chain } } }),
          { status: 200 },
        ),
      ),
  );
  const { useApprovals } = await import('../composables/useApprovals.js');
  useApprovals().__setPendingForTests([
    {
      approvalId: 'a1',
      conversationId: 'c1',
      requesterId: 'agent-a',
      tool: 'file_write',
      args: {},
      createdAt: '2026-10-08T01:00:00Z',
    },
  ]);
  const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
  await vi.waitFor(() => expect(wrapper.findAll('[data-test="msg"]').length).toBe(2));
  expect(wrapper.findAll('[data-test="approval-card"]')).toHaveLength(1);
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/chat/Thread.test.ts`
Expected: FAIL — two approval cards (one per message).

- [ ] **Step 6: Implement the approval map**

In `Thread.vue`, replace `approvalsFor` with a computed map:

```ts
const approvalsByMessage = computed(() => {
  const map = new Map<string, PendingApproval[]>();
  if (!props.conversationId) return map;
  const used = new Set<string>();
  for (const message of messages.value) {
    for (const call of message.toolCalls ?? []) {
      const matches = approvals.pending.value.filter(
        (pending) =>
          pending.conversationId === props.conversationId &&
          pending.tool === call.name &&
          !used.has(pending.approvalId),
      );
      if (matches.length === 0) continue;
      map.set(message.id, matches);
      for (const match of matches) used.add(match.approvalId);
    }
  }
  return map;
});

function approvalsFor(message: MessageWithAlternates): PendingApproval[] {
  return approvalsByMessage.value.get(message.id) ?? [];
}
```

Update `inlineApprovalIds` to flatten `approvalsByMessage` values. `tailApprovals` remains pending not in that set.

- [ ] **Step 7: Fix the streaming sender label**

In `Thread.vue` template, replace `senderId: 'assistant'` with:

```ts
senderId: pendingArgs.to || 'assistant',
```

- [ ] **Step 8: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/chat/MessageActions.test.ts packages/web/src/chat/Thread.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/chat/MessageActions.vue packages/web/src/chat/MessageActions.test.ts \
  packages/web/src/chat/Thread.vue packages/web/src/chat/Thread.test.ts
git commit -m "fix(web): re-run passes agentId; attach approvals once; correct streaming sender"
```

---

### Task 4: WebSocket lifecycle and identity reset

**Files:**

- Modify: `packages/web/src/composables/useWebSocket.ts`
- Modify: `packages/web/src/composables/useWebSocket.test.ts`
- Modify: `packages/web/src/App.vue`
- Create: `packages/web/src/App.test.ts`
- Modify: `packages/web/src/composables/useApprovals.ts`
- Modify: `packages/web/src/composables/useApprovals.test.ts`
- Modify: `packages/web/src/composables/useParticipants.ts`
- Modify: `packages/web/src/composables/useParticipants.test.ts`
- Modify: `packages/web/src/composables/useConversations.ts`
- Modify: `packages/web/src/composables/useConversations.test.ts`
- Modify: `packages/web/src/composables/useReadState.ts`
- Modify: `packages/web/src/composables/useReadState.test.ts`

**Interfaces:**

- `useWebSocket().connect()` is idempotent while `CONNECTING`/`OPEN`; `disconnect()` never schedules a reconnect.
- Each module store exposes a public `reset()`; `App.vue` calls all of them on logout.

- [ ] **Step 1: Add failing WebSocket tests**

In `useWebSocket.test.ts`, add:

```ts
it('does not create a second socket while the first is connecting', async () => {
  vi.resetModules();
  vi.doMock('./useAuth.js', () => ({
    useAuth: () => ({ getToken: () => 'tok', logout: () => {} }),
  }));
  vi.doMock('../router/index.js', () => ({ router: { push: vi.fn() } }));
  class FakeWS {
    static instances: FakeWS[] = [];
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });
  const { useWebSocket } = await import('./useWebSocket.js');
  const api = useWebSocket();
  api.connect();
  api.connect();
  expect(FakeWS.instances).toHaveLength(1);
  vi.unstubAllGlobals();
});

it('does not reconnect after an intentional disconnect', async () => {
  vi.resetModules();
  vi.doMock('./useAuth.js', () => ({
    useAuth: () => ({ getToken: () => 'tok', logout: () => {} }),
  }));
  vi.doMock('../router/index.js', () => ({ router: { push: vi.fn() } }));
  class FakeWS {
    static instances: FakeWS[] = [];
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    listeners: Record<string, EventListener[]> = {};
    constructor() {
      FakeWS.instances.push(this);
    }
    addEventListener(type: string, listener: EventListener) {
      (this.listeners[type] ??= []).push(listener);
    }
    dispatchEvent(event: Event) {
      for (const listener of this.listeners[event.type] ?? []) listener(event);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });
  vi.useFakeTimers();
  const { useWebSocket } = await import('./useWebSocket.js');
  const api = useWebSocket();
  api.connect();
  api.disconnect();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(FakeWS.instances).toHaveLength(1);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/composables/useWebSocket.test.ts`
Expected: FAIL — two instances / a reconnect instance.

- [ ] **Step 3: Implement the WebSocket lifecycle fix**

In `useWebSocket.ts`:

```ts
function connect(): void {
  const token = useAuth().getToken();
  if (!token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  ws = socket;

  socket.addEventListener('open', () => {
    backoff = 1000;
    socket.send(JSON.stringify({ type: 'auth', token }));
  });

  socket.addEventListener('message', (evt) => {
    // unchanged frame handling
  });

  socket.addEventListener('close', (evt) => {
    if (socket !== ws) return; // stale socket: ignore
    connectionId.value = null;
    for (const handler of [...streamHandlers.values()]) {
      try {
        handler({ type: 'stream:error', error: 'WebSocket disconnected' });
      } catch {
        /* isolate */
      }
    }
    streamHandlers.clear();
    pendingStreamChunks.length = 0;
    if (evt.code === 4401) {
      stoppedByAuth = true;
      useAuth().logout();
      router.push('/login');
      return;
    }
    if (!stoppedByAuth) scheduleReconnect();
  });

  socket.addEventListener('error', () => socket.close());
}
```

In `disconnect()`:

```ts
disconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stoppedByAuth = true;
  const socket = ws;
  ws = null;
  connectionId.value = null;
  for (const handler of [...streamHandlers.values()]) {
    try {
      handler({ type: 'stream:error', error: 'WebSocket disconnected' });
    } catch {
      /* isolate */
    }
  }
  streamHandlers.clear();
  pendingStreamChunks.length = 0;
  socket?.close();
},
```

The exported `connect()` becomes:

```ts
connect() {
  stoppedByAuth = false;
  connect();
},
```

- [ ] **Step 4: Add failing reset tests**

In each store test, add a reset assertion, for example:

```ts
it('reset clears pending approvals', () => {
  const store = useApprovals();
  store.__setPendingForTests([{ conversationId: 'c1' }]);
  store.reset();
  expect(store.pending.value).toHaveLength(0);
});
```

Add `reset()` to `useParticipants`, `useConversations`, and `useReadState` and test the same shape (conversations empty, participants empty, last-read empty).

- [ ] **Step 5: Implement public resets**

- `useApprovals`: return `reset()` that sets `pending.value = []`.
- `useParticipants`: return `reset()` that calls the existing `__resetForTests` body.
- `useConversations`: return `reset()` that clears conversations/loading/activeId/filter.
- `useReadState`: return `reset()` that clears `lastRead` and removes the storage key.

- [ ] **Step 6: Wire resets into App.vue**

```ts
import { useApprovals } from './composables/useApprovals.js';
import { useParticipants } from './composables/useParticipants.js';
import { useConversations } from './composables/useConversations.js';
import { useReadState } from './composables/useReadState.js';

const { reset: resetApprovals } = useApprovals();
const { reset: resetParticipants } = useParticipants();
const { reset: resetConversations } = useConversations();
const { reset: resetReadState } = useReadState();

// in the watch, on logout:
resetApprovals();
resetParticipants();
resetConversations();
resetReadState();
```

- [ ] **Step 7: Add an App.vue logout-reset test**

Create `packages/web/src/App.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import { useAuth } from './composables/useAuth.js';
import { useApprovals } from './composables/useApprovals.js';
import { useParticipants } from './composables/useParticipants.js';

vi.mock('./composables/useWebSocket.js', () => ({
  useWebSocket: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnectionId: () => null,
    onMessage: () => () => undefined,
    onStreamChunk: () => () => undefined,
  }),
}));

it('clears module stores when the session ends', async () => {
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  });
  await router.push('/');
  await router.isReady();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ token: 'tok', participantId: 'p1', expiresAt: 9999999999 }),
  } as Response);
  await useAuth().login('op', 'pw');
  useApprovals().__setPendingForTests([{ conversationId: 'c1' }]);
  useParticipants().__setParticipantsForTests([
    { id: 'agent-a', name: 'A', type: 'agent', tools: {} },
  ]);
  mount(App, { global: { plugins: [router] } });
  useAuth().logout();
  await Promise.resolve();
  expect(useApprovals().pending.value).toHaveLength(0);
  expect(useParticipants().participants.value).toHaveLength(0);
});
```

- [ ] **Step 8: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/composables/useWebSocket.test.ts packages/web/src/composables/useApprovals.test.ts packages/web/src/composables/useParticipants.test.ts packages/web/src/composables/useConversations.test.ts packages/web/src/composables/useReadState.test.ts packages/web/src/App.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/composables/useWebSocket.ts packages/web/src/composables/useWebSocket.test.ts \
  packages/web/src/App.vue packages/web/src/App.test.ts \
  packages/web/src/composables/useApprovals.ts packages/web/src/composables/useApprovals.test.ts \
  packages/web/src/composables/useParticipants.ts packages/web/src/composables/useParticipants.test.ts \
  packages/web/src/composables/useConversations.ts packages/web/src/composables/useConversations.test.ts \
  packages/web/src/composables/useReadState.ts packages/web/src/composables/useReadState.test.ts
git commit -m "fix(web): idempotent WebSocket lifecycle; reset client stores on logout"
```

---

### Task 5: Live approvals/activity, approval outcomes, and pending-approval scoping

**Files:**

- Modify: `packages/web/src/composables/useApprovals.ts`
- Modify: `packages/web/src/composables/useApprovals.test.ts`
- Modify: `packages/web/src/shell/AppShell.vue`
- Modify: `packages/web/src/shell/AppShell.test.ts`
- Modify: `packages/web/src/chat/Thread.vue`
- Modify: `packages/web/src/chat/Thread.test.ts`
- Modify: `packages/web/src/views/TopologyMap.vue`
- Modify: `packages/web/src/views/TopologyMap.test.ts`
- Modify: `packages/web/src/chat/ApprovalCard.vue`
- Modify: `packages/web/src/chat/ApprovalCard.test.ts`
- Modify: `packages/runtime/src/server/runtime-tools.ts`
- Modify: `packages/runtime/src/server/runtime-tools.test.ts`
- Modify: `packages/runtime/src/LegionProcess.ts`
- Modify: `packages/web/src/App.test.ts` (mock the new activity stream methods)
- Modify: `packages/web/src/shell/AppShell.test.ts` (mock the new activity stream methods)

**Interfaces:**

- `useApprovals()` exposes `ingest(type: 'approval:requested' | 'approval:resolved', data: Record<string, unknown>): void`.
- `approval_response` result data: `{ results: Array<{ approvalId: string; outcome: string }> }`.
- `list_pending_approvals` filters by `authEngine.hasAuthority(context.participant.approvalAuthority, record.requesterId, record.tool, record.args)`.

- [ ] **Step 1: Add a failing useApprovals ingest test**

In `useApprovals.test.ts`:

```ts
it('ingest appends a requested approval and refreshes args', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
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
              args: { path: '/tmp/x' },
              createdAt: '2026-10-08T00:00:00Z',
            },
          ],
        },
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const store = useApprovals();
  store.ingest('approval:requested', {
    approvalId: 'a1',
    conversationId: 'c1',
    participantId: 'agent-a',
    tool: 'file_write',
  });
  await Promise.resolve();
  expect(store.pending.value[0].args).toEqual({ path: '/tmp/x' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/composables/useApprovals.test.ts`
Expected: FAIL — no `ingest` / args stay `{}`.

- [ ] **Step 3: Implement ingest and remove the dead WS subscription**

In `useApprovals.ts`:

```ts
function ingest(type: string, data: Record<string, unknown>): void {
  if (type === 'approval:requested') {
    const approvalId = data['approvalId'];
    if (typeof approvalId !== 'string') return;
    if (pending.value.some((p) => p.approvalId === approvalId)) return;
    pending.value = [
      ...pending.value,
      {
        approvalId,
        conversationId: String(data['conversationId'] ?? ''),
        requesterId: String(data['participantId'] ?? ''),
        tool: String(data['tool'] ?? ''),
        args: (data['args'] as Record<string, unknown> | undefined) ?? {},
        createdAt: new Date().toISOString(),
      },
    ];
    void refresh().catch(() => {});
    return;
  }
  if (type === 'approval:resolved') {
    const approvalId = data['approvalId'];
    if (typeof approvalId !== 'string') return;
    pending.value = pending.value.filter((p) => p.approvalId !== approvalId);
  }
}
```

Delete the `initialized`/`onEvent` block. Return `ingest` and `reset`.

- [ ] **Step 4: Wire a global `watch_activity` stream in AppShell**

In `AppShell.vue`:

```ts
import { onMounted, watch } from 'vue';
import { useToolStream } from '../composables/useToolStream.js';
import { useWebSocket } from '../composables/useWebSocket.js';

const approvals = useApprovals();
const ws = useWebSocket();
const activity = useToolStream('watch_activity', () => ({}), {
  cancelOnUnmount: false,
  onChunk: (chunk) => {
    if (chunk.type === 'approval:requested' || chunk.type === 'approval:resolved') {
      approvals.ingest(chunk.type, (chunk.data ?? {}) as Record<string, unknown>);
    }
  },
});

onMounted(() => {
  void approvals.refresh().catch(() => {});
});

watch(
  () => ws.getConnectionId(),
  (id) => {
    if (id) void activity.start();
  },
  { immediate: true },
);
```

- [ ] **Step 5: Wire Thread to `watch_activity`**

In `Thread.vue`, add a conversation-scoped activity stream and a `thinking` ref:

```ts
const thinking = ref(false);

const activityStream = useToolStream(
  'watch_activity',
  () => ({ conversationId: props.conversationId ?? '' }),
  {
    onChunk: (chunk) => {
      if (chunk.type === 'iteration') {
        thinking.value = true;
      } else if (chunk.type === 'approval:requested' || chunk.type === 'approval:resolved') {
        void approvals.refresh().catch(() => {});
        void load();
      } else if (chunk.type === 'tool:result') {
        void load();
      }
    },
  },
);

watch(
  () => useWebSocket().getConnectionId(),
  (id) => {
    if (id && props.conversationId) void activityStream.start();
  },
  { immediate: true },
);

watch(stream.done, (done) => {
  if (done) thinking.value = false;
});
```

Render a typing indicator when `thinking`:

```vue
<div v-if="thinking" data-test="thinking-indicator" class="px-1 text-xs text-faint">Thinking…</div>
```

Reset `thinking` on `stream:error` and when `isStreaming` becomes true.

**Test-harness note:** the activity stream adds one `POST /api/execute` on mount when a `connectionId` exists. Update `Thread.test.ts`'s fetch stubs to return `{ streamId: 'activity', conversationId }` for the `watch_activity` POST and adjust any `toHaveBeenCalledTimes` assertions; alternatively mock `useToolStream` for `watch_activity`. `AppShell.test.ts` and `App.test.ts` must mock `getConnectionId`/`onStreamChunk` on the `useWebSocket` mock so the global activity stream does not throw.

- [ ] **Step 6: Wire TopologyMap to `watch_activity`**

Replace `onEvent('activity')` with:

```ts
const { getConnectionId } = useWebSocket();
const activityStream = useToolStream('watch_activity', () => ({}), {
  onChunk: (chunk) => {
    if (chunk.type === 'tool:call') {
      const data = (chunk.data ?? {}) as { participantId?: string };
      handleActivity(data);
    }
  },
});

watch(
  () => getConnectionId(),
  (id) => {
    if (id) void activityStream.start();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (pruneTimer) clearInterval(pruneTimer);
  void activityStream.cancel();
});
```

- [ ] **Step 7: Fix ApprovalCard outcome handling**

In `ApprovalCard.vue`:

```ts
const result = await execute<{ results: Array<{ approvalId: string; outcome: string }> }>(
  'approval_response',
  {
    decisions: [
      {
        approvalId: props.approval.approvalId,
        decision: approved ? 'approve' : 'reject',
        ...(reason.value ? { message: reason.value } : {}),
      },
    ],
  },
);
const outcome = result.results?.find((r) => r.approvalId === props.approval.approvalId)?.outcome;
if (!outcome || !['approve', 'reject', 'acknowledged', 'already_acknowledged'].includes(outcome)) {
  error.value = `Approval not applied: ${outcome ?? 'unknown'}`;
  return;
}
emit('resolved', approved);
```

- [ ] **Step 8: Add a failing ApprovalCard test**

In `ApprovalCard.test.ts`:

```ts
it('keeps the card when the decision is unauthorized', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        result: {
          status: 'success',
          data: { results: [{ approvalId: 'a1', outcome: 'unauthorized' }] },
        },
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(ApprovalCard, {
    props: {
      approval: {
        approvalId: 'a1',
        conversationId: 'c1',
        requesterId: 'agent-a',
        tool: 'file_write',
        args: {},
        createdAt: '2026-10-08T00:00:00Z',
      },
    },
  });
  await wrapper.find('[data-test="approval-approve"]').trigger('click');
  await flushPromises();
  expect(wrapper.emitted('resolved')).toBeUndefined();
  expect(wrapper.find('[data-test="approval-error"]').text()).toContain('unauthorized');
});
```

- [ ] **Step 9: Scope `list_pending_approvals`**

In `runtime-tools.ts`:

```ts
interface RuntimeToolDeps {
  // ...
  authEngine: AuthEngine;
}
```

In the tool:

```ts
execute: async (_rawArgs, context): Promise<ToolResult> => {
  const pending = pendingApprovalRegistry
    .listPending(conversationId)
    .filter((record) =>
      authEngine.hasAuthority(
        context.participant.approvalAuthority,
        record.requesterId,
        record.tool,
        record.args,
      ),
    );
  return { status: 'success', data: pending };
},
```

Pass `authEngine` from `LegionProcess.ts`:

```ts
const runtimeTools = createRuntimeTools({
  // ...
  authEngine,
});
```

Update `runtime-tools.test.ts`'s `makeRuntimeTools` helper to pass an `authEngine` stub whose `hasAuthority` returns true for the test records; add a test where it returns false and assert the record is omitted.

- [ ] **Step 10: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/composables/useApprovals.test.ts packages/web/src/chat/ApprovalCard.test.ts packages/web/src/shell/AppShell.test.ts packages/runtime/src/server/runtime-tools.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/web/src/composables/useApprovals.ts packages/web/src/composables/useApprovals.test.ts \
  packages/web/src/shell/AppShell.vue packages/web/src/shell/AppShell.test.ts \
  packages/web/src/chat/Thread.vue packages/web/src/views/TopologyMap.vue \
  packages/web/src/chat/ApprovalCard.vue packages/web/src/chat/ApprovalCard.test.ts \
  packages/runtime/src/server/runtime-tools.ts packages/runtime/src/server/runtime-tools.test.ts \
  packages/runtime/src/LegionProcess.ts
git commit -m "fix(web,runtime): live approvals/activity; honor approval outcomes; scope pending approvals"
```

---

### Task 6: Editor save gating and privilege guards

**Files:**

- Modify: `packages/web/src/views/AgentEditor.vue`
- Modify: `packages/web/src/views/AgentEditor.test.ts`
- Modify: `packages/web/src/views/UserEditor.vue`
- Modify: `packages/web/src/views/UserEditor.test.ts`
- Modify: `packages/core/src/tools/user-tools.ts`
- Modify: `packages/core/src/tools/user-tools.test.ts`
- Modify: `packages/core/src/tools/management-tools.ts`
- Modify: `packages/core/src/tools/management-tools.test.ts`
- Modify: `packages/core/src/tools/secret-tools.ts`
- Modify: `packages/core/src/tools/secret-tools.test.ts`

**Interfaces:**

- `create_user`/`modify_user` reject `operator: true` unless the caller is an operator.
- `set_credential`/`set_secret` reject a target other than the caller unless the caller is an operator.
- Editor save skips secondary calls the caller cannot invoke.

- [ ] **Step 1: Add failing core privilege tests**

In `user-tools.test.ts`:

```ts
it('refuses to grant operator unless the caller is an operator', async () => {
  const context = mkContext({ participant: mkParticipant({ id: 'u1', operator: false }) });
  const result = await createUserTool.execute({ id: 'u2', name: 'U2', operator: true }, context);
  expect(result.status).toBe('error');
  expect(result.error).toContain('operator');
});

it('allows an operator to grant operator', async () => {
  const context = mkContext({ participant: mkParticipant({ id: 'op', operator: true }) });
  const result = await createUserTool.execute({ id: 'u2', name: 'U2', operator: true }, context);
  expect(result.status).toBe('success');
});
```

Add analogous tests for `modify_user` self-promotion and for `set_credential`/`set_secret` targeting another participant.

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/docker-node.sh npx vitest run packages/core/src/tools/user-tools.test.ts packages/core/src/tools/management-tools.test.ts packages/core/src/tools/secret-tools.test.ts`
Expected: FAIL — no privilege checks.

- [ ] **Step 3: Implement the core guards**

In `user-tools.ts`:

```ts
function callerIsOperator(context: ToolContext): boolean {
  return context.participant.operator === true;
}
```

In `createUserTool.execute` and `modifyUserTool.execute`:

```ts
if (operator === true && !callerIsOperator(context)) {
  return { status: 'error', error: 'Only an operator can grant the operator flag' };
}
```

In `setCredentialTool.execute` (`management-tools.ts`):

```ts
if (participantId !== context.participant.id && !context.participant.operator) {
  return { status: 'error', error: 'Only an operator can set another participant’s credential' };
}
```

In `setSecretTool.execute` and `listSecretsTool.execute` (`secret-tools.ts`):

```ts
if (participantId !== context.participant.id && !context.participant.operator) {
  return { status: 'error', error: 'Only an operator can manage another participant’s secrets' };
}
```

- [ ] **Step 4: Add failing editor gating tests**

In `AgentEditor.test.ts`:

```ts
it('skips middleware save when the caller lacks set_participant_middleware', async () => {
  mockCan((tool) => (tool === 'modify_agent' ? 'auto' : 'hidden'));
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push(body.tool);
      if (body.tool === 'get_participant') return toolResponse('get_participant', AGENT);
      if (body.tool === 'list_tools')
        return toolResponse('list_tools', { tools: [], callerPolicy: {} });
      if (body.tool === 'list_models') return toolResponse('list_models', []);
      if (body.tool === 'list_middleware')
        return toolResponse('list_middleware', { definitions: [] });
      return toolResponse(body.tool, {});
    }),
  );
  const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
  await vi.waitFor(() => expect(wrapper.find('[data-test="agent-name"]').exists()).toBe(true));
  await wrapper.find('[data-test="agent-save"]').trigger('click');
  await flushPromises();
  expect(calls).toContain('modify_agent');
  expect(calls).not.toContain('set_participant_middleware');
  expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(false);
});
```

In `UserEditor.test.ts`:

```ts
it('skips authority save when the caller lacks set_approval_authority', async () => {
  mockCan((tool) => (tool === 'modify_user' ? 'auto' : 'hidden'));
  const calls: string[] = [];
  // stub fetch similarly; get_participant returns a user
  // ...
  expect(calls).toContain('modify_user');
  expect(calls).not.toContain('set_approval_authority');
  expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(false);
});

it('refuses to create a user with a password when set_credential is unavailable', async () => {
  mockCan((tool) => (tool === 'create_user' ? 'auto' : 'hidden'));
  const calls: string[] = [];
  // stub fetch
  // fill name + passwords, click save
  expect(calls).not.toContain('create_user');
  expect(wrapper.find('[data-test="editor-error"]').text()).toContain('credential');
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/views/AgentEditor.test.ts packages/web/src/views/UserEditor.test.ts`
Expected: FAIL — secondary calls still happen.

- [ ] **Step 6: Implement the editor gating**

In `AgentEditor.vue`:

```ts
const canSetMiddleware = computed(() => toolAccess.can('set_participant_middleware') === 'auto');

// in save(), after create/modify:
if (canSetMiddleware.value) {
  await execute('set_participant_middleware', {
    participantId: result.id,
    middleware: middleware.value,
  });
}
```

Same for the modify branch.

In `UserEditor.vue`:

```ts
const canSetAuthority = computed(() => toolAccess.can('set_approval_authority') === 'auto');

// in save(), before create/modify:
if (newPassword.value.length > 0 && !canSetCredential.value) {
  error.value = 'You do not have permission to set credentials.';
  busy.value = false;
  return;
}

// after create/modify:
if (
  canSetCredential.value &&
  newPassword.value.length >= 8 &&
  newPassword.value === confirmPassword.value
) {
  await execute('set_credential', { participantId: id, secret: newPassword.value });
}
if (canSetAuthority.value) {
  await execute('set_approval_authority', {
    participantId: id,
    authority: authority.value ?? { tools: {} },
  });
}
```

- [ ] **Step 7: Hide the operator checkbox for non-operators**

In `UserEditor.vue`:

```ts
const self = computed(() => participants.value.find((p) => p.id === auth.participantId.value));
const canGrantOperator = computed(() =>
  Boolean((self.value as { operator?: boolean } | undefined)?.operator),
);
```

Template:

```vue
<label v-if="canGrantOperator" class="flex items-center gap-2 text-xs">
  <input v-model="operator" type="checkbox" name="operator" data-test="operator" />
  Operator
</label>
<p v-else class="text-xs text-muted">
  Operator: {{ operator ? 'yes (read-only)' : 'no' }}
</p>
```

- [ ] **Step 8: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/core/src/tools/user-tools.test.ts packages/core/src/tools/management-tools.test.ts packages/core/src/tools/secret-tools.test.ts packages/web/src/views/AgentEditor.test.ts packages/web/src/views/UserEditor.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/tools/user-tools.ts packages/core/src/tools/user-tools.test.ts \
  packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts \
  packages/core/src/tools/secret-tools.ts packages/core/src/tools/secret-tools.test.ts \
  packages/web/src/views/AgentEditor.vue packages/web/src/views/AgentEditor.test.ts \
  packages/web/src/views/UserEditor.vue packages/web/src/views/UserEditor.test.ts
git commit -m "fix(core,web): guard operator grants and cross-participant credentials; gate editor secondary saves"
```

---

### Task 7: Approval authority participants + middleware wiring

**Files:**

- Modify: `packages/web/src/components/common/ApprovalAuthorityEditor.vue`
- Modify: `packages/web/src/components/common/ApprovalAuthorityEditor.test.ts`
- Modify: `packages/web/src/views/AgentEditor.vue`
- Modify: `packages/web/src/views/AgentEditor.test.ts`
- Modify: `packages/web/src/views/UserEditor.vue`
- Modify: `packages/web/src/views/UserEditor.test.ts`

**Interfaces:**

- `ApprovalAuthorityEditor` modelValue includes `participants`; emits must preserve it.
- `AgentEditor` loads `list_skills` (`{ skills: SkillInfo[] }`) and `list_secrets` (`{ keys: string[] }`) for middleware editing.

- [ ] **Step 1: Add a failing authority-preservation test**

In `ApprovalAuthorityEditor.test.ts`:

```ts
it('preserves the participants field when toggling a tool', async () => {
  const wrapper = mount(ApprovalAuthorityEditor, {
    props: {
      modelValue: { tools: { file_write: false }, participants: ['agent-a'] },
      availableTools: ['file_write'],
    },
  });
  await wrapper.find('[data-test="tool-file_write"]').setValue(true);
  expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual({
    tools: { file_write: true },
    participants: ['agent-a'],
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/components/common/ApprovalAuthorityEditor.test.ts`
Expected: FAIL — emitted object lacks `participants`.

- [ ] **Step 3: Implement preservation**

In `ApprovalAuthorityEditor.vue`:

```ts
function emitWildcard(value: boolean): void {
  emit('update:modelValue', {
    ...(props.modelValue ?? {}),
    tools: value ? '*' : {},
  });
}

function emitTool(tool: string, value: boolean): void {
  emit('update:modelValue', {
    ...(props.modelValue ?? {}),
    tools: { ...toolState.value, [tool]: value },
  });
}
```

In `AgentEditor.vue`, keep `participants` when hydrating:

```ts
const authority = p['approvalAuthority'] as {
  tools?: Record<string, boolean> | '*';
  participants?: string[] | '*';
} | null;
authorityModel.value = authority
  ? {
      tools: authority.tools === '*' ? '*' : (authority.tools ?? {}),
      ...(authority.participants === undefined ? {} : { participants: authority.participants }),
    }
  : null;
```

- [ ] **Step 4: Add failing middleware-hydration tests**

In `AgentEditor.test.ts`:

```ts
it('hydrates skills and credential keys for middleware editing', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tool === 'get_participant') return toolResponse('get_participant', AGENT);
      if (body.tool === 'list_tools')
        return toolResponse('list_tools', { tools: [], callerPolicy: {} });
      if (body.tool === 'list_models') return toolResponse('list_models', []);
      if (body.tool === 'list_middleware')
        return toolResponse('list_middleware', {
          definitions: [
            {
              type: 'builtin:skills',
              displayName: 'Skills',
              defaultFailureMode: 'open',
              configSchema: { type: 'object', properties: {} },
            },
          ],
        });
      if (body.tool === 'list_skills')
        return toolResponse('list_skills', {
          skills: [{ name: 'brainstorming', description: 'Brainstorm', scope: 'global' }],
          diagnostics: [],
        });
      if (body.tool === 'list_secrets')
        return toolResponse('list_secrets', { participantId: 'agent-a', keys: ['telegram-bot/x'] });
      return toolResponse(body.tool, {});
    }),
  );
  const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
  await vi.waitFor(() => expect(wrapper.text()).toContain('Skills'));
  expect(wrapper.text()).toContain('brainstorming');
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/views/AgentEditor.test.ts`
Expected: FAIL — skills list is empty.

- [ ] **Step 6: Implement middleware hydration**

In `AgentEditor.vue`:

```ts
import type { SkillInfo } from '../components/participants/middleware-ui-types.js';

const skills = ref<SkillInfo[]>([]);
const credentialKeys = ref<string[]>([]);
const middlewareErrors = ref<string[]>([]);

// in load(), after list_middleware:
void execute<{ skills: SkillInfo[] }>('list_skills', {})
  .then((data) => (skills.value = data.skills ?? []))
  .catch(() => {});
if (props.participantId !== 'new') {
  void execute<{ keys: string[] }>('list_secrets', { participantId: props.participantId })
    .then((data) => (credentialKeys.value = data.keys ?? []))
    .catch(() => {});
}
```

Pass them to `MiddlewareEditor`:

```vue
<MiddlewareEditor
  v-model="middleware"
  :definitions="middlewareDefinitions"
  :skills="skills"
  :credential-keys="credentialKeys"
  @validation="middlewareErrors = $event"
/>
```

Disable Save when validation errors exist:

```ts
const canSave = computed(() => {
  if (middlewareErrors.value.length > 0) return false;
  return props.participantId === 'new'
    ? toolAccess.can('create_agent') === 'auto' && modelText.value.trim().length > 0
    : toolAccess.can('modify_agent') === 'auto' && modelText.value.trim().length > 0;
});
```

- [ ] **Step 7: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/components/common/ApprovalAuthorityEditor.test.ts packages/web/src/views/AgentEditor.test.ts packages/web/src/views/UserEditor.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/common/ApprovalAuthorityEditor.vue \
  packages/web/src/components/common/ApprovalAuthorityEditor.test.ts \
  packages/web/src/views/AgentEditor.vue packages/web/src/views/AgentEditor.test.ts \
  packages/web/src/views/UserEditor.vue packages/web/src/views/UserEditor.test.ts
git commit -m "fix(web): preserve authority participants; hydrate middleware skills/credentials; block invalid saves"
```

---

### Task 8: Theme switching, token conformance, tool hints, TypeBadge, login landing

**Files:**

- Modify: `packages/web/src/shell/AccountSlideOver.vue`
- Create: `packages/web/src/shell/AccountSlideOver.test.ts`
- Modify: `packages/web/src/theme/useTheme.ts`
- Modify: `packages/web/src/theme/useTheme.test.ts`
- Modify: `packages/web/src/components/participants/ToolPolicyEditor.vue`
- Modify: `packages/web/src/components/participants/MiddlewareEditor.vue`
- Modify: `packages/web/src/components/participants/MiddlewareSchemaForm.vue`
- Modify: `packages/web/src/components/participants/SkillsSelector.vue`
- Modify: `packages/web/src/components/common/SearchableCombobox.vue`
- Modify: `packages/web/src/components/common/TypeBadge.vue`
- Create: `packages/web/src/components/common/TypeBadge.test.ts`
- Modify: `packages/web/src/components/common/StatusDot.vue`
- Modify: `packages/web/src/components/common/SlideOver.vue`
- Modify: `packages/web/src/assets/style.css`
- Modify: `packages/web/src/renderers/FileTreeRenderer.vue`
- Modify: `packages/web/src/renderers/SearchResultRenderer.vue`
- Modify: `packages/web/src/chat/Composer.vue`
- Modify: `packages/web/src/chat/Composer.test.ts`
- Modify: `packages/web/src/views/LoginView.vue`
- Modify: `packages/e2e/tests/auth/login.spec.ts`

**Interfaces:**

- `useTheme().setTheme(name)` is called from the Account slide-over.
- `Composer` tool hints derive from `useToolAccess().access` (caller policy), not `auth.tools`.
- `TypeBadge` keys are participant types.

- [ ] **Step 1: Add failing theme-toggle and TypeBadge tests**

In `AccountSlideOver.test.ts`:

```ts
it('switches the theme and persists it', async () => {
  const wrapper = mount(AccountSlideOver, { props: { open: true } });
  await wrapper.find('[data-test="theme-select"]').setValue('blueprint-light');
  expect(document.documentElement.dataset.theme).toBe('blueprint-light');
  expect(localStorage.getItem('legion-theme')).toBe('blueprint-light');
});
```

In `TypeBadge.test.ts`:

```ts
it('styles participant types distinctly', () => {
  expect(mount(TypeBadge, { props: { type: 'agent' } }).classes()).toContain('text-accent');
  expect(mount(TypeBadge, { props: { type: 'user' } }).classes()).toContain('text-success');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/shell/AccountSlideOver.test.ts packages/web/src/components/common/TypeBadge.test.ts`
Expected: FAIL — no theme select; badges neutral.

- [ ] **Step 3: Add the theme switch**

In `AccountSlideOver.vue`:

```ts
import { useTheme, type ThemeName } from '../theme/useTheme.js';

const { theme, setTheme } = useTheme();

function onThemeChange(event: Event): void {
  setTheme((event.target as HTMLSelectElement).value as ThemeName);
}
```

Template, above the password form:

```vue
<label class="block space-y-1">
  <span>Theme</span>
  <select
    data-test="theme-select"
    :value="theme"
    class="w-full rounded-md border border-line bg-surface px-2 py-1.5"
    @change="onThemeChange"
  >
    <option value="command-deck">Command deck (dark)</option>
    <option value="blueprint-light">Blueprint (light)</option>
  </select>
</label>
```

Remove the side-effect `apply(theme.value)` from `useTheme()`; `initTheme()` and `setTheme()` remain the only appliers.

- [ ] **Step 4: Replace raw colors with tokens**

Apply these exact replacements:

- `ToolPolicyEditor.vue`: `text-slate-100` → `text-ink`; `bg-amber-400/10 border-amber-400/30 text-amber-400` → `bg-warning/10 border-warning/30 text-warning`.
- `MiddlewareEditor.vue`: `text-slate-100`/`text-slate-200` → `text-ink`; `text-slate-400` → `text-muted`; `text-amber-400` → `text-warning`; `text-red-400` → `text-danger`; `bg-cyan-700 text-white` → `bg-accent text-on-accent`.
- `MiddlewareSchemaForm.vue`: `text-slate-200` → `text-ink`; `text-amber-400` → `text-warning`; `text-red-400` → `text-danger`.
- `SkillsSelector.vue`: `text-slate-200` → `text-ink`; `text-red-400` → `text-danger`.
- `SearchableCombobox.vue`: `text-slate-200` → `text-ink`; `placeholder-slate-600` → `placeholder:text-faint`; `focus:border-cyan-600` → `focus:border-accent`; `text-slate-500` → `text-muted`.
- `StatusDot.vue`: `bg-cyan-400` → `bg-accent`; `bg-green-400` → `bg-success`.
- `SlideOver.vue`: `text-slate-100` → `text-ink`; `text-slate-200` → `text-ink`.
- `FileTreeRenderer.vue` / `SearchResultRenderer.vue`: `text-slate-200`/`text-slate-400`/`text-slate-500` → `text-ink`/`text-muted`/`text-faint`; `text-cyan-300`/`text-cyan-400` → `text-accent`.
- `style.css`: replace `rgba(255, 255, 255, 0.15)` borders with `var(--color-border)`; `rgba(255, 255, 255, 0.2)` blockquote border with `var(--color-border-strong)`; `rgba(0, 0, 0, 0.25)` inline-code background with `var(--color-surface-raised)`; `rgba(0, 0, 0, 0.2)` table-header background with `var(--color-surface-raised)`; copy-button colors with `var(--color-surface-raised)` / `var(--color-ink)` / `var(--color-border)`.

- [ ] **Step 5: Fix TypeBadge**

```ts
const colours: Record<string, string> = {
  agent: 'bg-accent-soft text-accent border-accent/20',
  user: 'bg-success/10 text-success border-success/20',
  service: 'bg-warning/10 text-warning border-warning/20',
  mock: 'bg-surface-raised text-muted border-line',
};
```

- [ ] **Step 6: Fix Composer tool hints**

In `Composer.vue`:

```ts
import { useToolAccess } from '../composables/useToolAccess.js';

const toolAccess = useToolAccess();
const toolHints = computed<string[]>(() =>
  Object.keys(toolAccess.access.value).filter((tool) => toolAccess.can(tool) !== 'hidden'),
);
```

Remove the `auth.tools` read. Keep `auth` for `participantId` if used elsewhere.

- [ ] **Step 7: Add a failing Composer hints test**

In `Composer.test.ts`:

```ts
it('shows tool hints from the caller policy map', async () => {
  const access = ref<Record<string, 'auto' | 'requires_approval'>>({
    communicate: 'auto',
    file_read: 'auto',
  });
  vi.mock('../composables/useToolAccess.js', () => ({
    useToolAccess: () => ({
      access,
      can: (tool: string) => access.value[tool] ?? 'hidden',
    }),
  }));
  const wrapper = mount(Composer, { props: { conversationId: null, recipientId: 'agent-a' } });
  expect(wrapper.text()).toContain('communicate');
  expect(wrapper.text()).toContain('file_read');
});
```

Adjust the mock placement to match the file's existing hoisting pattern.

- [ ] **Step 8: Change the login landing route**

In `LoginView.vue`:

```ts
await router.push('/chat');
```

Update `packages/e2e/tests/auth/login.spec.ts` to expect `/#/chat`.

- [ ] **Step 9: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/shell/AccountSlideOver.test.ts packages/web/src/components/common/TypeBadge.test.ts packages/web/src/chat/Composer.test.ts packages/web/src/theme/useTheme.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/shell/AccountSlideOver.vue packages/web/src/shell/AccountSlideOver.test.ts \
  packages/web/src/theme/useTheme.ts packages/web/src/theme/useTheme.test.ts \
  packages/web/src/components/participants/ToolPolicyEditor.vue \
  packages/web/src/components/participants/MiddlewareEditor.vue \
  packages/web/src/components/participants/MiddlewareSchemaForm.vue \
  packages/web/src/components/participants/SkillsSelector.vue \
  packages/web/src/components/common/SearchableCombobox.vue \
  packages/web/src/components/common/TypeBadge.vue packages/web/src/components/common/TypeBadge.test.ts \
  packages/web/src/components/common/StatusDot.vue packages/web/src/components/common/SlideOver.vue \
  packages/web/src/assets/style.css packages/web/src/renderers/FileTreeRenderer.vue \
  packages/web/src/renderers/SearchResultRenderer.vue packages/web/src/chat/Composer.vue \
  packages/web/src/chat/Composer.test.ts packages/web/src/views/LoginView.vue \
  packages/e2e/tests/auth/login.spec.ts
git commit -m "fix(web): theme switch and token conformance; caller-policy tool hints; login lands on chat"
```

---

### Task 9: Management pages — error handling, provider types, new-agent authority, drawer/reply target

**Files:**

- Modify: `packages/web/src/views/ConfigView.vue`
- Modify: `packages/web/src/views/ConfigView.test.ts`
- Modify: `packages/web/src/components/config/ProviderSlideOver.vue`
- Modify: `packages/web/src/components/config/ProviderSlideOver.test.ts`
- Modify: `packages/web/src/components/config/RoutingEditor.vue`
- Modify: `packages/web/src/components/processes/ProcessDetail.vue`
- Create: `packages/web/src/components/processes/ProcessDetail.test.ts`
- Modify: `packages/web/src/views/ProcessesView.vue`
- Modify: `packages/web/src/views/ProcessesView.test.ts`
- Modify: `packages/web/src/views/AgentEditor.vue`
- Modify: `packages/web/src/views/AgentEditor.test.ts`
- Modify: `packages/web/src/chat/ChatView.vue`
- Modify: `packages/web/src/chat/ChatView.test.ts`
- Modify: `packages/runtime/src/server/runtime-tools.ts`
- Modify: `packages/runtime/src/server/runtime-tools.test.ts`

**Interfaces:**

- Config/process mutations surface failures in a banner and never reject silently.
- `save_provider` accepts `openai-responses`; unsupported types are disabled in the UI.
- `AgentEditor` hides “Save authority” for a new agent.
- ChatView closes the mobile drawer for a new conversation and prefers the thread’s last counterpart for the reply target.

- [ ] **Step 1: Add failing error-handling tests**

In `ConfigView.test.ts`:

```ts
it('does not delete a provider without confirmation', async () => {
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  );
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(ConfigView, { global: { plugins: [router] } });
  await wrapper.find('[data-test="provider-delete"]').trigger('click');
  expect(fetchMock).not.toHaveBeenCalledWith(
    '/api/execute?stream=false',
    expect.objectContaining({ body: expect.stringContaining('delete_provider') }),
  );
});
```

Add a provider row fixture so the delete button renders, or test the handler via a shallow mount with `providers` seeded.

In `ProcessDetail.test.ts`:

```ts
it('shows an error banner when stop fails', async () => {
  // stub get_process success; stop_process returns status:error
  // click stop; expect [data-test="process-error"] text
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/views/ConfigView.test.ts packages/web/src/components/processes/ProcessDetail.test.ts`
Expected: FAIL — no confirmation/error banner.

- [ ] **Step 3: Implement ConfigView delete confirmation and error banner**

```ts
const deleteError = ref<string | null>(null);

async function deleteProvider(name: string): Promise<void> {
  if (!window.confirm(`Delete provider “${name}”?`)) return;
  deleteError.value = null;
  try {
    await execute('delete_provider', { name });
    await load();
  } catch (err) {
    deleteError.value = friendlyToolError(err);
  }
}
```

Render `deleteError` near the table. Add `data-test="provider-delete"` to the delete button.

- [ ] **Step 4: Add error banners to ProviderSlideOver and RoutingEditor**

```ts
const error = ref<string | null>(null);
// save():
error.value = null;
try { await execute(...); emit('saved'); emit('close'); }
catch (err) { error.value = err instanceof Error ? err.message : String(err); }
finally { saving.value = false; }
```

Render `<p data-test="provider-error" class="text-xs text-danger">` / `data-test="routing-error"`.

- [ ] **Step 5: Add process action error handling**

In `ProcessDetail.vue`:

```ts
const actionError = ref<string | null>(null);

async function onSend(): Promise<void> {
  actionError.value = null;
  sending.value = true;
  try {
    await send(stdinInput.value);
    stdinInput.value = '';
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    sending.value = false;
  }
}
```

Same for `onStop`/`onDelete`. Render `<div data-test="process-error">`.

In `ProcessesView.vue`, destructure `loading, error` and render a banner / empty state:

```ts
const { processes, loading, error, refresh } = useProcesses();
```

- [ ] **Step 6: Fix provider types**

In `runtime-tools.ts`, add `'openai-responses'` to the `save_provider` enum:

```ts
type: { type: 'string', enum: ['openai-compatible', 'openai-responses', 'anthropic', 'copilot', 'codex'] },
```

In `ProviderSlideOver.vue`, disable unimplemented types:

```vue
<option value="anthropic" disabled>anthropic (not implemented)</option>
<option value="copilot" disabled>copilot (not implemented)</option>
<option value="codex" disabled>codex (not implemented)</option>
```

Add a `ProviderSlideOver.test.ts` assertion that the disabled options are disabled and `openai-responses` is selectable.

- [ ] **Step 7: Hide new-agent authority and close the drawer**

In `AgentEditor.vue`, change the authority-save button to:

```vue
<button v-if="canSetAuthority && participantId !== 'new'" ...>
```

In `ChatView.vue`, close the drawer on any selection:

```ts
function onSelect(id: string | null): void {
  drawerOpen.value = false;
  void router.push(id ? `/chat/${id}` : '/chat');
}
```

Also set `drawerOpen.value = false` in the route watcher for `id === null` (currently only for truthy ids).

- [ ] **Step 8: Prefer the thread’s counterpart for the reply target**

In `ChatView.vue`:

```ts
const conversationRecipient = computed<string | null>(() => {
  if (isDraft.value) return recipientId.value;
  const fromThread = threadRef.value?.threadRecipient ?? null;
  if (fromThread && useParticipants().byId(fromThread)?.type === 'agent') return fromThread;
  const conv = store.conversations.value.find((c) => c.id === activeId.value);
  const others = (conv?.participants ?? []).filter((p) => p !== auth.participantId.value);
  const agent = others.find((p) => useParticipants().byId(p)?.type === 'agent');
  return agent ?? others[0] ?? null;
});
```

Add a ChatView test with a conversation containing two agents and a thread whose last message is from the second agent; assert the composer recipient is the second agent.

- [ ] **Step 9: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/views/ConfigView.test.ts packages/web/src/components/config/ProviderSlideOver.test.ts packages/web/src/components/processes/ProcessDetail.test.ts packages/web/src/views/ProcessesView.test.ts packages/web/src/views/AgentEditor.test.ts packages/web/src/chat/ChatView.test.ts packages/runtime/src/server/runtime-tools.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/views/ConfigView.vue packages/web/src/views/ConfigView.test.ts \
  packages/web/src/components/config/ProviderSlideOver.vue \
  packages/web/src/components/config/ProviderSlideOver.test.ts \
  packages/web/src/components/config/RoutingEditor.vue \
  packages/web/src/components/processes/ProcessDetail.vue \
  packages/web/src/components/processes/ProcessDetail.test.ts \
  packages/web/src/views/ProcessesView.vue packages/web/src/views/ProcessesView.test.ts \
  packages/web/src/views/AgentEditor.vue packages/web/src/views/AgentEditor.test.ts \
  packages/web/src/chat/ChatView.vue packages/web/src/chat/ChatView.test.ts \
  packages/runtime/src/server/runtime-tools.ts packages/runtime/src/server/runtime-tools.test.ts
git commit -m "fix(web,runtime): management-page error handling; provider type surface; drawer/reply fixes"
```

---

### Task 10: Backend hardening — MCP confirmation, secret lock, connector cleanup, WebConnector, stream ownership

**Files:**

- Modify: `packages/web/src/views/McpSourcesEditor.vue`
- Modify: `packages/web/src/views/McpSourcesEditor.test.ts`
- Modify: `packages/core/src/secrets/FileSecretStore.ts`
- Modify: `packages/core/src/secrets/FileSecretStore.test.ts`
- Modify: `packages/core/src/connectors/loader.ts`
- Modify: `packages/core/src/connectors/loader.test.ts`
- Modify: `packages/runtime/src/LegionProcess.ts`
- Modify: `packages/runtime/src/server/WebConnector.ts`
- Modify: `packages/runtime/src/server/WebConnector.test.ts`
- Modify: `packages/runtime/src/server/routes/execute.ts`
- Create: `packages/runtime/src/server/routes/execute.test.ts`
- Modify: `packages/core/src/streaming/StreamRegistry.ts`
- Modify: `packages/core/src/streaming/StreamRegistry.test.ts`
- Modify: `packages/core/src/credentials/FileCredentialStore.ts`

**Interfaces:**

- `StreamRegistry.register(streamId, connectionId, participantId)` and `cancelForParticipant(streamId, participantId)`.
- `FileSecretStore` uses `storage.withLock('secrets.json', ...)` for mutations.
- `save_mcp_sources` UI requires explicit confirmation.

- [ ] **Step 1: Add failing tests**

`FileSecretStore.test.ts`:

```ts
it('does not lose concurrent writes', async () => {
  const store = new FileSecretStore(storage, 'x'.repeat(32));
  await Promise.all([store.setSecret('p1', 'a', 'one'), store.setSecret('p1', 'b', 'two')]);
  expect(await store.listKeys('p1')).toEqual(expect.arrayContaining(['a', 'b']));
});
```

`loader.test.ts`:

```ts
it('stops a connector that loses the duplicate-name race', async () => {
  const stopped: string[] = [];
  const make = (name: string) => ({
    name,
    start: async () => {},
    deliver: async () => {},
    stop: async () => {
      stopped.push(name);
    },
  });
  const { loaded } = await loadExternalConnectors(
    [
      { name: 'a', module: 'mod-a', enabled: true },
      { name: 'b', module: 'mod-b', enabled: true },
    ],
    '/workspace',
    deps,
    context,
  );
  expect(loaded).toHaveLength(1);
  expect(stopped.length).toBe(1);
});
```

`StreamRegistry.test.ts`:

```ts
it('cancels only when the participant owns the stream', () => {
  const registry = new StreamRegistry();
  registry.register('s1', 'conn-1', 'p1');
  expect(registry.cancelForParticipant('s1', 'p2')).toBe(false);
  expect(registry.cancelForParticipant('s1', 'p1')).toBe(true);
});
```

`McpSourcesEditor.test.ts`:

```ts
it('requires confirmation before saving commands', async () => {
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  );
  // mount with one server, click save, assert no save_mcp_sources request
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/docker-node.sh npx vitest run packages/core/src/secrets/FileSecretStore.test.ts packages/core/src/connectors/loader.test.ts packages/core/src/streaming/StreamRegistry.test.ts packages/web/src/views/McpSourcesEditor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement FileSecretStore locking**

Wrap `setSecret`/`removeSecret` in `this.storage.withLock(SECRETS_FILE, async () => { const file = await this.readAll(); ... await this.writeAll(file); })`.

- [ ] **Step 4: Stop duplicate/dropped connectors**

In `loader.ts`, before returning, for each dropped connector in the dedupe loop, call `await entry.connector.stop().catch(() => undefined)`.

In `LegionProcess.ts` `startExternalConnectors`, when `register` throws, call `await connector.stop().catch(() => undefined)`.

- [ ] **Step 5: Add stream ownership**

In `StreamRegistry.ts`:

```ts
private streams = new Map<string, { connectionId: string; participantId: string; abort: AbortController }>();

register(streamId: string, connectionId: string, participantId: string): AbortSignal {
  const controller = new AbortController();
  this.streams.set(streamId, { connectionId, participantId, abort: controller });
  return controller.signal;
}

cancelForParticipant(streamId: string, participantId: string): boolean {
  const entry = this.streams.get(streamId);
  if (!entry || entry.participantId !== participantId) return false;
  entry.abort.abort();
  this.streams.delete(streamId);
  return true;
}
```

Update call sites: `WebConnector.ts` `register(streamId, connectionId, participantId)`; `execute.ts` buffered mode `cancelStream: (sid) => streamRegistry.cancelForParticipant(sid, participantId)`.

- [ ] **Step 6: Harden WebConnector**

- SPA fallback: in `setNotFoundHandler`, if `req.url.startsWith('/api/')` reply `404` JSON `{ error: 'Not found' }`; else `sendFile('index.html')`.
- Double auth: add `let authStarted = false;` in `handleWebSocket`; on `msg.type === 'auth' && !participantId`, if `authStarted` return; set `authStarted = true` before `verifyToken`.
- Heartbeat: add a `setInterval` per socket sending `{type:'ping'}` every 30s and clear on close (optional; if it complicates tests, omit and note in the review doc).

- [ ] **Step 7: Add MCP confirmation**

In `McpSourcesEditor.save()`:

```ts
if (servers.value.some((s) => s.command !== undefined)) {
  if (!window.confirm('Save MCP servers that run shell commands?')) return;
}
```

Add a test that cancellation prevents the request.

- [ ] **Step 8: Remove `FileCredentialStore.set`**

Delete the raw `set()` method (unused) to avoid a plaintext footgun. Update any tests that used it; none in production code.

- [ ] **Step 9: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/core/src/secrets/FileSecretStore.test.ts packages/core/src/connectors/loader.test.ts packages/core/src/streaming/StreamRegistry.test.ts packages/web/src/views/McpSourcesEditor.test.ts packages/runtime/src/server/WebConnector.test.ts packages/runtime/src/server/routes/execute.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/views/McpSourcesEditor.vue packages/web/src/views/McpSourcesEditor.test.ts \
  packages/core/src/secrets/FileSecretStore.ts packages/core/src/secrets/FileSecretStore.test.ts \
  packages/core/src/connectors/loader.ts packages/core/src/connectors/loader.test.ts \
  packages/runtime/src/LegionProcess.ts packages/runtime/src/server/WebConnector.ts \
  packages/runtime/src/server/WebConnector.test.ts packages/runtime/src/server/routes/execute.ts \
  packages/runtime/src/server/routes/execute.test.ts \
  packages/core/src/streaming/StreamRegistry.ts packages/core/src/streaming/StreamRegistry.test.ts \
  packages/core/src/credentials/FileCredentialStore.ts
git commit -m "fix(core,runtime,web): harden MCP saves, secret writes, connector cleanup, stream ownership, SPA fallback"
```

---

### Task 11: Security hardening — login rate limiting and security headers

**Files:**

- Create: `packages/runtime/src/server/LoginRateLimiter.ts`
- Create: `packages/runtime/src/server/LoginRateLimiter.test.ts`
- Modify: `packages/runtime/src/server/routes/auth.ts`
- Modify: `packages/runtime/src/server/routes/auth.test.ts`
- Modify: `packages/runtime/src/server/WebConnector.ts`
- Modify: `packages/runtime/src/server/WebConnector.test.ts`

**Interfaces:**

- `LoginRateLimiter` allows 5 failed attempts per 60s per IP; successful login resets.
- Security headers are applied to every response.

- [ ] **Step 1: Add a failing rate-limiter test**

```ts
import { LoginRateLimiter } from './LoginRateLimiter.js';

it('blocks the sixth attempt within the window', () => {
  const limiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
  for (let i = 0; i < 5; i += 1) limiter.recordFailure('127.0.0.1');
  expect(limiter.allow('127.0.0.1')).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/docker-node.sh npx vitest run packages/runtime/src/server/LoginRateLimiter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the limiter**

```ts
export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly options = { maxAttempts: 5, windowMs: 60_000 }) {}

  allow(ip: string): boolean {
    const entry = this.attempts.get(ip);
    if (!entry || Date.now() >= entry.resetAt) return true;
    return entry.count < this.options.maxAttempts;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now >= entry.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + this.options.windowMs });
      return;
    }
    entry.count += 1;
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
  }
}
```

- [ ] **Step 4: Wire it into the login route**

In `auth.ts`, add a limiter instance in `registerAuthRoutes` deps or module scope:

```ts
const limiter = new LoginRateLimiter();

// at the top of POST /api/auth/login:
if (!limiter.allow(req.ip)) {
  return reply.status(429).send({ error: 'Too many login attempts. Try again later.' });
}
// on any 401:
limiter.recordFailure(req.ip);
// on success:
limiter.reset(req.ip);
```

Add a route test using `app.inject` if the existing auth test harness supports it; otherwise test the limiter class only.

- [ ] **Step 5: Add security headers**

In `WebConnector.ts`:

```ts
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:",
} as const;

app.addHook('onSend', async (_req, reply, payload) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  return payload;
});
```

Export `SECURITY_HEADERS` for a unit test that asserts the keys/values.

- [ ] **Step 6: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/runtime/src/server/LoginRateLimiter.test.ts packages/runtime/src/server/routes/auth.test.ts packages/runtime/src/server/WebConnector.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/server/LoginRateLimiter.ts packages/runtime/src/server/LoginRateLimiter.test.ts \
  packages/runtime/src/server/routes/auth.ts packages/runtime/src/server/routes/auth.test.ts \
  packages/runtime/src/server/WebConnector.ts packages/runtime/src/server/WebConnector.test.ts
git commit -m "fix(runtime): login rate limiting and security headers"
```

---

### Task 12: Cleanup — dead code and stale e2e specs

**Files:**

- Delete: `packages/web/src/composables/useConversation.ts`
- Delete: `packages/web/src/composables/useConversation.test.ts`
- Delete: `packages/web/src/components/conversations/ConversationList.vue`
- Delete: `packages/web/src/components/conversations/ApprovalCard.vue`
- Delete: `packages/web/src/components/common/ApprovalBadge.vue`
- Delete: `packages/web/src/components/common/ApprovalBadge.test.ts`
- Delete: `packages/web/src/renderers/ToolResultRenderer.vue`
- Delete: `packages/e2e/tests/config/credentials.spec.ts`
- Delete: `packages/e2e/tests/participants/participants.spec.ts`
- Rewrite: `packages/e2e/tests/config/providers.spec.ts` for the new Config page
- Modify: `docs/reviews/2026-11-04-web-ui-code-review.md` (mark M15/M16 fixed)

- [ ] **Step 1: Verify the files are unreferenced**

Run:

```bash
grep -rn "useConversation\|components/conversations/ConversationList\|components/conversations/ApprovalCard\|common/ApprovalBadge\|renderers/ToolResultRenderer" packages --include='*.ts' --include='*.vue' | grep -v '\.test\.'
```

Expected: only the definitions themselves and comments. If any production import remains, update it before deleting.

- [ ] **Step 2: Delete the dead files**

```bash
git rm packages/web/src/composables/useConversation.ts \
  packages/web/src/composables/useConversation.test.ts \
  packages/web/src/components/conversations/ConversationList.vue \
  packages/web/src/components/conversations/ApprovalCard.vue \
  packages/web/src/components/common/ApprovalBadge.vue \
  packages/web/src/components/common/ApprovalBadge.test.ts \
  packages/web/src/renderers/ToolResultRenderer.vue \
  packages/e2e/tests/config/credentials.spec.ts \
  packages/e2e/tests/participants/participants.spec.ts
```

- [ ] **Step 3: Rewrite the provider e2e spec for the new UI**

`packages/e2e/tests/config/providers.spec.ts`:

```ts
import { test, expect } from '../../fixtures/index.js';

test.describe('Config — Providers', () => {
  test('adds a provider through the new Config page and shows it in the table', async ({
    authPage,
    connInfo,
  }) => {
    const { page } = authPage;
    const name = `e2e-provider-${Date.now()}`;
    await page.goto('/#/config');
    await page.locator('[data-test="add-provider"]').click();
    await page.locator('[data-test="provider-name"]').fill(name);
    await page.locator('[data-test="provider-base-url"]').fill(`${connInfo.mockProviderUrl}/v1`);
    await page.locator('[data-test="provider-api-key"]').fill('test-key');
    await page.locator('[data-test="provider-save"]').click();
    await expect(page.locator('[data-test="provider-row"]', { hasText: name })).toBeVisible();
  });
});
```

Add the matching `data-test` attributes in `ProviderSlideOver.vue` (`provider-name`, `provider-base-url`, `provider-api-key`, `provider-save`) and `ConfigView.vue` (`add-provider`, `provider-row`).

- [ ] **Step 4: Run the affected unit tests and the new e2e spec**

```bash
./scripts/docker-node.sh npm run test --workspace=packages/web
./scripts/docker-node.sh npx playwright test --config packages/e2e/playwright.config.ts packages/e2e/tests/config/providers.spec.ts --project=chromium
```

Expected: web tests pass; provider e2e passes (requires the e2e global setup/mock provider; run it if the environment supports Playwright).

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src packages/e2e/tests docs/reviews
git commit -m "chore(web,e2e): remove dead legacy code and stale console specs; cover new provider UI"
```

---

### Task 13: Low-severity batch — shell, router, process polling, accessibility, provider path validation

**Files:**

- Modify: `packages/web/src/shell/AppShell.vue`
- Modify: `packages/web/src/shell/AppShell.test.ts`
- Modify: `packages/web/src/router/index.ts`
- Modify: `packages/web/src/composables/useProcesses.ts`
- Modify: `packages/web/src/composables/useProcess.ts`
- Modify: `packages/web/src/views/TopologyMap.vue`
- Modify: `packages/web/src/views/ParticipantsView.vue`
- Modify: `packages/web/src/views/LoginView.vue`
- Modify: `packages/web/src/composables/useReadState.ts`
- Modify: `packages/core/src/providers/SystemProviderStore.ts`
- Modify: `packages/core/src/providers/SystemProviderStore.test.ts`
- Modify: `packages/runtime/src/server/runtime-tools.ts`
- Modify: `packages/runtime/src/server/runtime-tools.test.ts`
- Modify: `packages/runtime/src/server/WebConnector.ts`

**Interfaces:**

- Router catch-all redirects to `/chat`; authenticated users on `/login` redirect to `/chat`.
- `useProcesses` pauses polling when `document.hidden`; `useProcess` surfaces `procStream.error`.
- `SystemProviderStore.save` validates names; `save_provider` validates `baseUrl` is `http(s)`.
- Hashed assets get a long cache header.

- [ ] **Step 1: Add failing tests**

`AppShell.test.ts`:

```ts
it('closes the avatar menu on outside click and Escape', async () => {
  await seedAuth();
  const wrapper = await mountShellAt('/');
  await wrapper.find('[data-test="avatar"]').trigger('click');
  expect(wrapper.text()).toContain('Account…');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await wrapper.vm.$nextTick();
  expect(wrapper.text()).not.toContain('Account…');
});
```

`router` test (new `router/index.test.ts` or AppShell test):

```ts
it('redirects unknown routes to chat', async () => {
  await router.push('/does-not-exist');
  await router.isReady();
  expect(router.currentRoute.value.path).toBe('/chat');
});
```

`SystemProviderStore.test.ts`:

```ts
it('rejects provider names that escape the provider directory', async () => {
  await expect(
    store.save({ name: '../evil', type: 'openai-compatible', priority: 1 }),
  ).rejects.toThrow();
});
```

`runtime-tools.test.ts`:

```ts
it('rejects a non-http baseUrl', async () => {
  const result = await tool(tools, 'save_provider').execute({
    name: 'x',
    type: 'openai-compatible',
    baseUrl: 'file:///etc/passwd',
    priority: 1,
  });
  expect(result.status).toBe('error');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/shell/AppShell.test.ts packages/core/src/providers/SystemProviderStore.test.ts packages/runtime/src/server/runtime-tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the batch**

- AppShell: add a document click listener and Escape handler that closes `menuOpen`; remove listeners on unmount.
- Router: add `{ path: '/:pathMatch(.*)*', redirect: '/chat' }`; in the guard, if `to.path === '/login' && isAuthenticated.value` return `/chat`.
- `useProcesses`: in the interval callback, `if (typeof document !== 'undefined' && document.hidden) return;` before `refresh`.
- `useProcess`: watch `procStream.error` and set `error.value`.
- `TopologyMap`: add `tabindex="0"` and `@keydown.enter`/`@keydown.space.prevent` to each node `<g>`.
- `ParticipantsView`: render a `data-test="participants-empty"` message when `!loading && participants.length === 0`.
- `LoginView`: replace the bootstrap-password note with “Ask an operator for credentials.” (or remove it).
- `useReadState`: key storage by participant (`legion-last-read-${participantId}`) or clear on logout (already done in Task 4). If keying, update the composable to take `participantId`; otherwise leave the reset.
- `SystemProviderStore.save`: validate `config.name` against `/^[A-Za-z0-9._-]+$/` and throw `Invalid provider name`.
- `runtime-tools.ts` `save_provider`: if `baseUrl` is present and does not match `/^https?:\/\//`, return `{ status:'error', error:'baseUrl must be http(s)' }`.
- `WebConnector.ts`: add `Cache-Control: public, max-age=31536000, immutable` for `/assets/` responses (in the `onSend` hook, if `req.url.startsWith('/assets/')`).

- [ ] **Step 4: Run the focused tests**

Run: `./scripts/docker-node.sh npx vitest run packages/web/src/shell/AppShell.test.ts packages/core/src/providers/SystemProviderStore.test.ts packages/runtime/src/server/runtime-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/shell/AppShell.vue packages/web/src/shell/AppShell.test.ts \
  packages/web/src/router/index.ts packages/web/src/composables/useProcesses.ts \
  packages/web/src/composables/useProcess.ts packages/web/src/views/TopologyMap.vue \
  packages/web/src/views/ParticipantsView.vue packages/web/src/views/LoginView.vue \
  packages/web/src/composables/useReadState.ts packages/core/src/providers/SystemProviderStore.ts \
  packages/core/src/providers/SystemProviderStore.test.ts \
  packages/runtime/src/server/runtime-tools.ts packages/runtime/src/server/runtime-tools.test.ts \
  packages/runtime/src/server/WebConnector.ts
git commit -m "chore(web,core,runtime): shell/router/process/a11y/provider-path hardening and cache headers"
```

---

### Task 14: Final gate and review-doc status update

**Files:**

- Modify: `docs/reviews/2026-11-04-web-ui-code-review.md` (mark statuses)
- No production code unless the gate reveals failures.

- [ ] **Step 1: Run the full gate in order**

```bash
./scripts/docker-node.sh npm run format:check
./scripts/docker-node.sh npm run typecheck
./scripts/docker-node.sh npm test
./scripts/docker-node.sh npm run test --workspace=packages/web
```

Expected: all green. If a suite fails, fix it in a new commit before continuing.

- [ ] **Step 2: Run the web e2e suite if the environment supports it**

```bash
./scripts/docker-node.sh npx playwright test --config packages/e2e/playwright.config.ts packages/e2e/tests/web-ui --project=chromium
```

If Playwright browsers are unavailable in the Docker wrapper, record that in the review doc as an environment limitation and run the unit/web gates only.

- [ ] **Step 3: Update the review doc statuses**

Mark fixed findings `[x]`; mark deferred findings `[-]` with a one-line reason. Deferred items should include at least:

- Token storage/revocation (M9): moving JWTs to HttpOnly cookies or adding token versioning is a larger auth change; rate limiting and CSP are shipped in Task 11.
- Current-password confirmation in AccountSlideOver (L10): needs a backend verify-current-password tool; defer.
- `OpenAIResponsesProvider` retry/timeout (L20): provider hardening follow-up.
- Composer draft restore on failed send (L5): needs a send-result contract; defer.

- [ ] **Step 4: Commit the status update**

```bash
git add docs/reviews/2026-11-04-web-ui-code-review.md
git commit -m "docs(review): mark web UI review findings fixed/deferred after the fix wave"
```

---

## Self-review notes

- **Spec coverage:** Task 1 fixes the model/routing config surfaces; Task 2 covers dock persistence/mobile/jump; Task 3 covers chat actions/approvals; Task 4 covers WS/identity; Task 5 covers live approvals/outcomes/scoping; Task 6 covers editor gating/privileges; Task 7 covers authority/middleware; Task 8 covers theme/tokens/hints/type badges/login; Task 9 covers management-page errors/provider types; Task 10 covers backend hardening; Task 11 covers security; Task 12/13 cover cleanup/low nits; Task 14 is the gate.
- **Deferred with rulings:** token storage/revocation, current-password confirmation, Responses retry/timeout, Composer draft restore. These are recorded in the review doc at Task 14.
- **Type consistency:** `list_models` uses `model.id`; `ApprovalAuthorityEditor` preserves `participants`; `useApprovals.ingest` uses the `watch_activity` chunk shape (`chunk.data`); `StreamRegistry.register` gains `participantId` and all call sites are updated in Task 10.
- **Test harness:** every command uses `./scripts/docker-node.sh`; no host Node dependency.
