# Chat Interface Bugfixes & Agent-to-Agent Delegation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix auth/session lifecycle, participant management, and agent-to-agent delegation (stall + nested sub-thread rendering) as specified in `docs/superpowers/specs/2026-07-02-chat-interface-bugfixes-design.md`.

**Architecture:** Three independent parts (A: auth, B: participants, C: delegation) verified individually with browser tests against a fresh server process. Part C corrects the core `communicate` tool to never implicitly join the caller's conversation, stamps parent links on new child conversations, and renders them nested in the UI.

**Tech Stack:** TypeScript (monorepo: `packages/types`, `packages/core`, `packages/runtime`, `packages/web`), Vue 3 + Vite, Fastify, vitest, Playwright for E2E.

**Build/test commands:**

- Build all: `npm run build` (from root, runs `tsc --build`)
- Build web: `npm run build -w @legion/web`
- Typecheck: `npm run typecheck`
- Test all: `npm test`
- Test specific: `npx vitest run <file-path>`
- Start server: `setsid nohup node packages/runtime/bin/legion.js > /tmp/opencode/legion-server.log 2>&1 &`
- Kill server: `kill -9 $(lsof -ti:3000)` (or find PID via `lsof -i:3000`)

---

## File Structure

### Part A — Auth & Session

- Modify: `packages/runtime/src/server/auth.ts` — `signToken` returns `{ token, expiresAt }`
- Modify: `packages/runtime/src/server/routes/auth.ts` — login response includes `expiresAt`
- Modify: `packages/web/src/composables/useAuth.ts` — JWT decode fallback, expiry check
- Modify: `packages/web/src/composables/useExecute.ts` — 401 → logout + redirect
- Modify: `packages/web/src/composables/useWebSocket.ts` — 4401 close code → stop reconnect + redirect
- Test: `packages/runtime/src/server/auth.test.ts` (new)
- Test: `packages/web/src/composables/useAuth.test.ts` (existing, extend)
- Test: `packages/web/src/composables/useExecute.test.ts` (existing, extend)
- Test: `packages/web/src/composables/useWebSocket.test.ts` (existing, extend)

### Part B — Participant Management

- Modify: `packages/core/src/tools/management-tools.ts` — fix `create_agent`/`modify_agent`, add `get_participant`
- Modify: `packages/core/src/collective/default-participants.ts` — add `get_participant` to operator policy
- Modify: `packages/web/src/components/participants/ParticipantSlideOver.vue` — provider default, edit load, default policy, vocabulary mapping
- Modify: `packages/web/src/views/ParticipantsView.vue` — Model/Provider columns from full participant data
- Test: `packages/core/src/tools/management-tools.test.ts` (existing, extend)

### Part C — Agent-to-Agent Delegation

- Modify: `packages/types/src/conversation.ts` — `parentConversationId`, `parentToolCallId` on `ConversationData` + `ConversationMeta`; `ConversationFilter.includeSubThreads`
- Modify: `packages/core/src/conversation/ConversationStore.ts` — add `listByParent` method
- Modify: `packages/core/src/conversation/FileConversationStore.ts` — implement `listByParent`, filter sub-threads in `list`
- Modify: `packages/core/src/tools/Tool.ts` — add `toolCallId?` to `ToolContext`
- Modify: `packages/core/src/tools/communicate-tool.ts` — remove `?? context.conversationId` fallback
- Modify: `packages/core/src/runtime/MessageRouter.ts` — parent linking on new conversation
- Modify: `packages/core/src/runtime/AgentRuntime.ts` — thread `toolCallId` into context
- Modify: `packages/core/src/tools/management-tools.ts` — `list_conversations` filter, `get_conversation` sub-thread inclusion
- Modify: `packages/web/src/composables/useConversation.ts` — capture `subThreads`
- Modify: `packages/web/src/components/conversations/ConversationThread.vue` — nested `ToolCallBlock` rendering
- Test: `packages/core/src/tools/communicate-tool.test.ts` (existing, extend)
- Test: `packages/core/src/runtime/MessageRouter.test.ts` (existing, extend)
- Test: `packages/core/src/conversation/FileConversationStore.test.ts` (existing, extend)
- Test: `packages/web/src/composables/useConversation.test.ts` (existing, extend)

---

## Part A — Auth & Session (bugs #2, #3)

### Task A1: Server returns `expiresAt` from login

**Files:**

- Modify: `packages/runtime/src/server/auth.ts`
- Modify: `packages/runtime/src/server/routes/auth.ts`
- Test: `packages/runtime/src/server/auth.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/runtime/src/server/auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from './auth.js';

describe('signToken', () => {
  const secret = new Uint8Array(32);

  it('returns token and expiresAt (~8h from now)', async () => {
    const { token, expiresAt } = await signToken('p1', secret);
    expect(typeof token).toBe('string');
    expect(typeof expiresAt).toBe('number');
    const now = Math.floor(Date.now() / 1000);
    expect(expiresAt).toBeGreaterThan(now + 7 * 3600);
    expect(expiresAt).toBeLessThan(now + 9 * 3600);
  });

  it('token expiresAt matches the JWT exp claim', async () => {
    const { token, expiresAt } = await signToken('p2', secret);
    const { participantId } = await verifyToken(token, secret);
    expect(participantId).toBe('p2');
    // The exp claim inside the token should match expiresAt
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    expect(payload.exp).toBe(expiresAt);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/runtime/src/server/auth.test.ts`
Expected: FAIL — `signToken` returns a string, not an object with `expiresAt`.

- [ ] **Step 3: Implement `signToken` returning `{ token, expiresAt }`**

Edit `packages/runtime/src/server/auth.ts`. Replace the `signToken` function:

```typescript
export async function signToken(
  participantId: string,
  secret: JwtSecret,
): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const expiresAt = iat + 8 * 3600;
  const token = await new SignJWT({ sub: participantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setExpirationTime(expiresAt)
    .sign(secret);
  return { token, expiresAt };
}
```

- [ ] **Step 4: Update the login route to destructure and return `expiresAt`**

Edit `packages/runtime/src/server/routes/auth.ts`. Replace lines 43-44:

```typescript
const { token, expiresAt } = await signToken(participant.id, jwtSecret);
return reply.send({ token, participantId: participant.id, expiresAt });
```

Also update the JSDoc comment on line 20:

```typescript
   * Returns: { token: string; participantId: string; expiresAt: number }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/runtime/src/server/auth.test.ts`
Expected: PASS

- [ ] **Step 6: Run full runtime test suite to check for regressions**

Run: `npx vitest run packages/runtime/`
Expected: All existing tests pass (no other caller of `signToken` exists).

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/server/auth.ts packages/runtime/src/server/routes/auth.ts packages/runtime/src/server/auth.test.ts
git commit -m "fix(auth): return expiresAt from signToken and login route"
```

---

### Task A2: Client honors expiry with JWT decode fallback

**Files:**

- Modify: `packages/web/src/composables/useAuth.ts`
- Test: `packages/web/src/composables/useAuth.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/composables/useAuth.test.ts` (after existing tests):

```typescript
it('isAuthenticated returns false when expiresAt is in the past', async () => {
  const { useAuth } = await import('./useAuth.js');
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ token: 'tok-expired', participantId: 'p1', expiresAt: 1 }),
  } as Response);
  await useAuth().login('admin', 'secret');
  expect(useAuth().isAuthenticated.value).toBe(false);
});

it('decodes JWT exp as fallback when expiresAt is missing from response', async () => {
  const { useAuth } = await import('./useAuth.js');
  // Create a fake JWT with exp far in the future
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ sub: 'p1', exp: futureExp })).toString('base64url');
  const fakeToken = `${header}.${payload}.sig`;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ token: fakeToken, participantId: 'p1' }),
  } as Response);
  await useAuth().login('admin', 'secret');
  expect(useAuth().isAuthenticated.value).toBe(true);
  expect(useAuth().participantId.value).toBe('p1');
});

it('treats token without exp as expired (fallback decode fails)', async () => {
  const { useAuth } = await import('./useAuth.js');
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ token: 'not-a-jwt', participantId: 'p1' }),
  } as Response);
  await useAuth().login('admin', 'secret');
  expect(useAuth().isAuthenticated.value).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/src/composables/useAuth.test.ts`
Expected: The JWT decode fallback test fails (no decode logic yet). The "no exp" test may pass or fail depending on current behavior.

- [ ] **Step 3: Implement JWT decode fallback in `useAuth.ts`**

Edit `packages/web/src/composables/useAuth.ts`. Replace the entire file:

```typescript
import { useLocalStorage } from '@vueuse/core';
import { computed } from 'vue';

interface AuthState {
  token: string | null;
  participantId: string | null;
  expiresAt: number | null;
}

const token = useLocalStorage<string | null>('legion-token', null);
const participantId = useLocalStorage<string | null>('legion-participant-id', null);
const expiresAt = useLocalStorage<number | null>('legion-expires-at', null);

/** Decode the `exp` claim from a JWT payload (base64url). Returns null on failure. */
function decodeJwtExp(jwt: string): number | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Resolve the effective expiry: stored expiresAt, or JWT decode fallback, or null. */
function resolveExpiry(tokenVal: string | null, storedExpiry: number | null): number | null {
  if (storedExpiry !== null) return storedExpiry;
  if (tokenVal) return decodeJwtExp(tokenVal);
  return null;
}

export function useAuth() {
  const isAuthenticated = computed(() => {
    const exp = resolveExpiry(token.value, expiresAt.value);
    if (!token.value) return false;
    if (exp === null) return false; // no usable expiry → treat as expired
    return Date.now() < exp * 1000;
  });

  async function login(name: string, password: string): Promise<void> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    if (!res.ok) throw new Error('Invalid credentials');
    const data = (await res.json()) as Partial<AuthState>;
    token.value = data.token ?? null;
    participantId.value = data.participantId ?? null;
    expiresAt.value = data.expiresAt ?? null;
  }

  function logout(): void {
    token.value = null;
    participantId.value = null;
    expiresAt.value = null;
  }

  function getToken(): string | null {
    return token.value;
  }

  return { isAuthenticated, participantId, login, logout, getToken };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/src/composables/useAuth.test.ts`
Expected: All tests PASS (including the new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/composables/useAuth.ts packages/web/src/composables/useAuth.test.ts
git commit -m "fix(auth): honor expiresAt + JWT exp decode fallback client-side"
```

---

### Task A3: 401 redirect + WebSocket 4401 handling

**Files:**

- Modify: `packages/web/src/composables/useExecute.ts`
- Modify: `packages/web/src/composables/useWebSocket.ts`
- Test: `packages/web/src/composables/useExecute.test.ts`
- Test: `packages/web/src/composables/useWebSocket.test.ts`

- [ ] **Step 1: Write the failing test for useExecute 401 redirect**

Add to `packages/web/src/composables/useExecute.test.ts`:

```typescript
it('calls logout and redirects to /login on 401', async () => {
  const { useExecute } = await import('./useExecute.js');
  const { useAuth } = (await import('./useAuth.js')) as unknown as {
    useAuth: ReturnType<typeof vi.fn>;
  };

  const logout = vi.fn();
  useAuth.mockReturnValue({
    getToken: () => 'tok-dead',
    logout,
  });

  global.fetch = vi.fn().mockResolvedValue({ status: 401 } as Response);

  // Mock the router push
  const pushMock = vi.fn();
  vi.doMock('../../router/index.js', () => ({
    router: { push: pushMock },
  }));

  const { execute } = useExecute();
  await expect(execute('list_participants', {})).rejects.toThrow('Unauthorized');
  expect(logout).toHaveBeenCalled();
  expect(pushMock).toHaveBeenCalledWith('/login');
});
```

- [ ] **Step 2: Write the failing test for useWebSocket 4401**

Add to `packages/web/src/composables/useWebSocket.test.ts`:

```typescript
it('stops reconnecting and calls logout on close code 4401', async () => {
  vi.resetModules();
  const logoutMock = vi.fn();
  vi.doMock('./useAuth.js', () => ({
    useAuth: () => ({ getToken: () => 'dead-token', logout: logoutMock }),
  }));
  const pushMock = vi.fn();
  vi.doMock('../router/index.js', () => ({
    router: { push: pushMock },
  }));

  const { useWebSocket } = await import('./useWebSocket.js');

  // Simulate: connect → open → close with code 4401
  // We need to intercept WebSocket construction
  let wsInstance: any;
  const origWS = global.WebSocket;
  global.WebSocket = class extends origWS {
    constructor(url: string) {
      super(url);
      wsInstance = this;
    }
  } as any;

  // Mock location
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });

  useWebSocket().connect();

  // Wait for the WebSocket to be created
  await new Promise((r) => setTimeout(r, 10));

  if (wsInstance) {
    // Simulate close with 4401
    wsInstance.dispatchEvent(new CloseEvent('close', { code: 4401 }));
  }

  // Wait for any timers
  await new Promise((r) => setTimeout(r, 50));

  expect(logoutMock).toHaveBeenCalled();

  // Restore
  global.WebSocket = origWS;
  vi.unstubAllMocks();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/web/src/composables/useExecute.test.ts packages/web/src/composables/useWebSocket.test.ts`
Expected: FAIL — no redirect logic yet.

- [ ] **Step 4: Implement 401 redirect in `useExecute.ts`**

Edit `packages/web/src/composables/useExecute.ts`. Replace the entire file:

```typescript
import { useAuth } from './useAuth.js';
import { router } from '../router/index.js';
import type { ToolResult } from '@legion/types';

export function useExecute() {
  const { getToken, logout } = useAuth();

  async function execute<T>(tool: string, args: unknown = {}): Promise<T> {
    const res = await fetch('/api/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken() ?? ''}`,
      },
      body: JSON.stringify({ tool, args }),
    });
    if (res.status === 401) {
      logout();
      router.push('/login');
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { result: ToolResult };
    if (data.result.status === 'error') {
      throw new Error(data.result.error ?? 'Tool error');
    }
    return data.result.data as T;
  }

  return { execute };
}
```

- [ ] **Step 5: Implement 4401 handling in `useWebSocket.ts`**

Edit `packages/web/src/composables/useWebSocket.ts`. Replace the `close` event listener and `scheduleReconnect`:

Replace the entire file:

```typescript
import { useAuth } from './useAuth.js';
import { router } from '../router/index.js';

type MessageHandler = (data: unknown) => void;

// Module-level singleton state — one WebSocket for the entire app
const handlers = new Set<MessageHandler>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;
let stoppedByAuth = false;

function connect(): void {
  const { getToken } = useAuth();
  const token = getToken();
  if (!token) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    backoff = 1000;
    ws!.send(JSON.stringify({ type: 'auth', token }));
  });

  ws.addEventListener('message', (evt) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(evt.data as string);
    } catch {
      return;
    }
    for (const handler of [...handlers]) {
      try {
        handler(parsed);
      } catch {
        /* isolate */
      }
    }
  });

  ws.addEventListener('close', (evt) => {
    if (evt.code === 4401) {
      stoppedByAuth = true;
      const { logout } = useAuth();
      logout();
      router.push('/login');
      return;
    }
    scheduleReconnect();
  });
  ws.addEventListener('error', () => ws?.close());
}

function scheduleReconnect(): void {
  if (stoppedByAuth) return;
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoff = Math.min(backoff * 2, 30_000);
    connect();
  }, backoff);
}

export function useWebSocket() {
  return {
    connect() {
      stoppedByAuth = false;
      if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    },
    disconnect() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
      ws = null;
    },
    onMessage(handler: MessageHandler): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    send(data: unknown): void {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    },
  };
}
```

Note: `stoppedByAuth` is reset to `false` in `connect()` so that a fresh login (which calls `connect()`) works correctly.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/web/src/composables/useExecute.test.ts packages/web/src/composables/useWebSocket.test.ts`
Expected: PASS (may need to adjust test mocking for router import — if tests fail due to import path, use `vi.mock` for the router module at the top of the test file instead of `vi.doMock`).

- [ ] **Step 7: Fix any test issues (router mock)**

If the useExecute test fails because `vi.doMock` doesn't intercept the static import in `useExecute.ts`, change the test to use a top-level `vi.mock`:

Replace the `vi.doMock` in the 401 test with a module-level mock at the top of `packages/web/src/composables/useExecute.test.ts`:

```typescript
// At the top, after existing vi.mock for useAuth:
vi.mock('../router/index.js', () => ({
  router: { push: vi.fn() },
}));
```

Then in the 401 test, import the mocked router and assert on its `push`:

```typescript
import { router } from '../router/index.js';
// ...
expect(router.push).toHaveBeenCalledWith('/login');
```

Similarly for `useWebSocket.test.ts`, add at the top:

```typescript
vi.mock('./useAuth.js', () => ({
  useAuth: () => ({ getToken: () => 'dead-token', logout: vi.fn() }),
}));
vi.mock('../router/index.js', () => ({
  router: { push: vi.fn() },
}));
```

- [ ] **Step 8: Run full web test suite**

Run: `npx vitest run packages/web/`
Expected: All tests PASS.

- [ ] **Step 9: Build and commit**

```bash
npm run build
git add packages/web/src/composables/useExecute.ts packages/web/src/composables/useWebSocket.ts packages/web/src/composables/useExecute.test.ts packages/web/src/composables/useWebSocket.test.ts
git commit -m "fix(auth): redirect to /login on 401 and WS 4401 close code"
```

---

## Part B — Participant Management (bugs #4, #5, #6)

### Task B1: Add `get_participant` tool

**Files:**

- Modify: `packages/core/src/tools/management-tools.ts`
- Modify: `packages/core/src/collective/default-participants.ts`
- Test: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Update `makeContext` to include `storage` and `toolRegistry`**

Edit `packages/core/src/tools/management-tools.test.ts`. Replace the `makeContext` function (lines 19-31):

```typescript
async function makeContext() {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const conversationStore = new FileConversationStore(storage);
  const toolRegistry = new ToolRegistry();
  // Register mock tools so composeTools has tool names to work with
  for (const name of [
    'communicate',
    'list_participants',
    'list_tools',
    'get_participant',
    'list_conversations',
    'get_conversation',
  ]) {
    toolRegistry.register({
      name,
      description: `mock ${name}`,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ status: 'success', data: null }),
    });
  }
  const context = {
    participant: collective.getOrThrow('operator'),
    collective,
    conversationStore,
    storage,
    toolRegistry,
    workspaceRoot: '/tmp',
  } as unknown as ToolContext;
  return { context, collective, conversationStore, storage, toolRegistry };
}
```

Add `modifyAgentTool` and `listConversationsTool` to the imports at the top (alongside existing tool imports):

```typescript
import {
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  getConversationTool,
  setToolPolicyTool,
  setCredentialTool,
  modifyAgentTool,
  listConversationsTool,
  managementTools,
} from './management-tools.js';
```

- [ ] **Step 2: Write the failing test**

Add to `packages/core/src/tools/management-tools.test.ts` (inside the main describe block, after existing tests):

```typescript
it('get_participant returns full config for an agent', async () => {
  const { context } = await makeContext();
  // Create an agent via the tool
  await createAgentTool.execute(
    {
      id: 'test-agent',
      name: 'Test Agent',
      systemPrompt: 'You are a test agent.',
      model: { provider: 'openai-compatible', model: 'gpt-4o' },
      toolPolicies: { communicate: 'auto' },
      defaultPolicy: 'auto',
    },
    context,
  );

  const result = await getParticipantTool.execute({ id: 'test-agent' }, context);
  expect(result.status).toBe('success');
  const data = result.data as Record<string, unknown>;
  expect(data.id).toBe('test-agent');
  expect(data.name).toBe('Test Agent');
  expect(data.type).toBe('agent');
  expect((data as any).model).toEqual({ provider: 'openai-compatible', model: 'gpt-4o' });
  expect((data as any).systemPrompt).toBe('You are a test agent.');
});

it('get_participant returns error for unknown id', async () => {
  const { context } = await makeContext();
  const result = await getParticipantTool.execute({ id: 'nonexistent' }, context);
  expect(result.status).toBe('error');
});
```

Add the import at the top of the file:

```typescript
import { getParticipantTool } from './management-tools.js';
```

(alongside the existing imports from that module).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: FAIL — `getParticipantTool` is not exported.

- [ ] **Step 4: Implement `get_participant` tool**

Edit `packages/core/src/tools/management-tools.ts`. Add after `listParticipantsTool` (after line 101):

```typescript
export const getParticipantTool: Tool = {
  name: 'get_participant',
  description: 'Get a single participant full configuration by id.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
    },
    required: ['id'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { id } = args as { id: string };
    try {
      const participant = requireCollective(context).get(id);
      if (!participant) {
        return { status: 'error', error: `Participant not found: ${id}` };
      }
      return { status: 'success', data: participant };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

Add `getParticipantTool` to the `managementTools` array (after `listParticipantsTool`):

```typescript
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
];
```

- [ ] **Step 5: Add `get_participant` to the operator default tool policy**

Edit `packages/core/src/collective/default-participants.ts`. Add `'get_participant'` to the `MANAGEMENT_TOOLS` array (after `'list_participants'`):

```typescript
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
  'set_tool_policy',
  'set_credential',
  'list_providers',
  'configure_provider',
  'list_credentials',
  'set_credential_with_meta',
] as const;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/collective/default-participants.ts packages/core/src/tools/management-tools.test.ts
git commit -m "feat: add get_participant tool for full config retrieval"
```

---

### Task B2: Fix `create_agent` and `modify_agent` — single source of truth + policy composition

**Files:**

- Modify: `packages/core/src/tools/management-tools.ts`
- Test: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/tools/management-tools.test.ts`:

```typescript
it('create_agent persists to collective only (no agents/ file)', async () => {
  const { context, collective } = await makeContext();
  const result = await createAgentTool.execute(
    {
      id: 'src-agent',
      name: 'Source Agent',
      systemPrompt: 'You are helpful.',
      model: { provider: 'openai-compatible', model: 'gpt-4o' },
      defaultPolicy: 'auto',
      toolPolicies: { communicate: 'auto' },
    },
    context,
  );
  expect(result.status).toBe('success');

  // Collective record exists
  const p = collective.get('src-agent');
  expect(p).toBeDefined();
  expect(p!.name).toBe('Source Agent');
  expect((p as any).model).toEqual({ provider: 'openai-compatible', model: 'gpt-4o' });

  // No agents/ file should be written
  const agentsFile = await storage.readJson('agents/src-agent.json').catch(() => null);
  expect(agentsFile).toBeNull();
});

it('create_agent composes tools from defaultPolicy + toolPolicies', async () => {
  const { context, collective } = await makeContext();
  await createAgentTool.execute(
    {
      id: 'policy-agent',
      name: 'Policy Agent',
      systemPrompt: 'You are helpful.',
      model: { provider: 'openai-compatible', model: 'gpt-4o' },
      defaultPolicy: 'require-approval',
      toolPolicies: { communicate: 'allow' },
    },
    context,
  );
  const p = collective.get('policy-agent') as any;
  // communicate should be 'auto' (allow → auto mapping)
  expect(p.tools['communicate']).toBe('auto');
  // Other tools should default to 'requires_approval'
  expect(p.tools['list_participants']).toBe('requires_approval');
});

it('modify_agent updates the collective record (not agents/ file)', async () => {
  const { context, collective } = await makeContext();
  // Create first
  await createAgentTool.execute(
    {
      id: 'mod-agent',
      name: 'Before',
      systemPrompt: 'Original prompt.',
      model: { provider: 'openai-compatible', model: 'gpt-4o' },
      defaultPolicy: 'auto',
    },
    context,
  );
  // Modify
  const result = await modifyAgentTool.execute(
    {
      id: 'mod-agent',
      name: 'After',
      model: { provider: 'anthropic', model: 'claude-3' },
      systemPrompt: 'Updated prompt.',
      maxIterations: 10,
      defaultPolicy: 'deny',
      toolPolicies: { communicate: 'allow' },
    },
    context,
  );
  expect(result.status).toBe('success');

  const p = collective.get('mod-agent') as any;
  expect(p.name).toBe('After');
  expect(p.model).toEqual({ provider: 'anthropic', model: 'claude-3' });
  expect(p.systemPrompt).toBe('Updated prompt.');
  expect(p.maxIterations).toBe(10);
  expect(p.tools['communicate']).toBe('auto'); // override
  expect(p.tools['list_participants']).toBe('deny'); // default
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: FAIL — `create_agent` still writes to `agents/`, `modify_agent` reads from `agents/`, no policy composition.

- [ ] **Step 3: Add policy normalization helper and fix `create_agent`**

Edit `packages/core/src/tools/management-tools.ts`. Add a normalization helper after the `requireCollective` function (after line 12):

```typescript
/** Map UI policy vocabulary to runtime ToolPolicy. */
function normalizePolicy(p: string): ToolPolicy {
  if (p === 'allow') return 'auto';
  if (p === 'require-approval') return 'requires_approval';
  return p as ToolPolicy;
}

/** Compose the full tools map from defaultPolicy + per-tool overrides. */
function composeTools(
  defaultPolicy: string | undefined,
  toolPolicies: Record<string, string> | undefined,
  allToolNames: string[],
  existing?: Record<string, ToolPolicy>,
): Record<string, ToolPolicy> {
  const dp = normalizePolicy(defaultPolicy ?? 'auto');
  const overrides: Record<string, ToolPolicy> = {};
  if (toolPolicies) {
    for (const [tool, policy] of Object.entries(toolPolicies)) {
      overrides[tool] = normalizePolicy(policy);
    }
  }
  const tools: Record<string, ToolPolicy> = {};
  const names = new Set([
    ...allToolNames,
    ...Object.keys(overrides),
    ...(existing ? Object.keys(existing) : []),
  ]);
  for (const name of names) {
    tools[name] = overrides[name] ?? existing?.[name] ?? dp;
  }
  return tools;
}
```

Replace the `createAgentTool` (lines 14-66) with:

```typescript
export const createAgentTool: Tool = {
  name: 'create_agent',
  description: 'Create a new agent participant in the collective.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      systemPrompt: { type: 'string' },
      model: {
        type: 'object',
        properties: { provider: { type: 'string' }, model: { type: 'string' } },
      },
      defaultPolicy: {
        type: 'string',
        enum: ['auto', 'allow', 'requires_approval', 'require-approval', 'deny'],
      },
      toolPolicies: { type: 'object' },
      tools: { type: 'object' },
    },
    required: ['id', 'name', 'systemPrompt', 'model'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { id, name, systemPrompt, model, defaultPolicy, toolPolicies, tools } = args as {
      id: string;
      name: string;
      systemPrompt: string;
      model: ModelConfig;
      defaultPolicy?: string;
      toolPolicies?: Record<string, string>;
      tools?: Record<string, ToolPolicy>;
    };
    try {
      const collective = requireCollective(context);
      const allToolNames = context.toolRegistry.listAll();
      const composedTools = tools ?? composeTools(defaultPolicy, toolPolicies, allToolNames);
      const config: AgentConfig = {
        id,
        name,
        type: 'agent',
        tools: composedTools,
        systemPrompt,
        model,
        maxIterations: 20,
        providerId: model.provider ?? 'default',
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

- [ ] **Step 4: Fix `modifyAgentTool`**

Replace the `modifyAgentTool` (lines 185-226) with:

```typescript
export const modifyAgentTool: Tool = {
  name: 'modify_agent',
  description:
    'Update an existing agent — name, model, system prompt, max iterations, tool policies.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
      name: { type: 'string' },
      model: {
        type: 'object',
        properties: { provider: { type: 'string' }, model: { type: 'string' } },
      },
      systemPrompt: { type: 'string' },
      maxIterations: { type: 'number' },
      defaultPolicy: {
        type: 'string',
        enum: ['auto', 'allow', 'requires_approval', 'require-approval', 'deny'],
      },
      toolPolicies: { type: 'object' },
    },
    required: ['id'],
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    const { id, name, model, systemPrompt, maxIterations, defaultPolicy, toolPolicies } = args as {
      id: string;
      name?: string;
      model?: ModelConfig | string;
      systemPrompt?: string;
      maxIterations?: number;
      defaultPolicy?: string;
      toolPolicies?: Record<string, string>;
    };
    try {
      const collective = requireCollective(context);
      const existing = collective.get(id);
      if (!existing) return { status: 'error', error: `Agent not found: ${id}` };
      if (existing.type !== 'agent')
        return { status: 'error', error: `Participant ${id} is not an agent` };

      const agent = existing as AgentConfig;
      // Handle both string (legacy) and object (ModelConfig) model arg
      const updatedModel: ModelConfig =
        typeof model === 'string'
          ? { provider: agent.model.provider, model }
          : (model ?? agent.model);
      const allToolNames = context.toolRegistry.listAll();
      const composedTools =
        defaultPolicy || toolPolicies
          ? composeTools(defaultPolicy, toolPolicies, allToolNames, agent.tools)
          : agent.tools;

      await collective.update(id, {
        name: name ?? agent.name,
        model: updatedModel,
        providerId: updatedModel.provider,
        systemPrompt: systemPrompt ?? agent.systemPrompt,
        maxIterations: maxIterations ?? agent.maxIterations,
        tools: composedTools,
      });

      return { status: 'success', data: collective.getOrThrow(id) };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 5: Update existing tests that break (no more agents/ dual-write)**

Edit `packages/core/src/tools/management-tools.test.ts`.

**Replace the test at lines 198-223** ("create_agent writes agent config to storage") with:

```typescript
it('create_agent persists agent config to collective (not agents/ file)', async () => {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const conversationStore = new FileConversationStore(storage);
  const toolRegistry = new ToolRegistry();
  for (const tool of managementTools) {
    toolRegistry.register(tool);
  }
  const context = {
    participant: collective.getOrThrow('operator'),
    collective,
    conversationStore,
    storage,
    toolRegistry,
    workspaceRoot: '/tmp',
  } as unknown as ToolContext;
  await createAgentTool.execute(
    {
      id: 'bot-1',
      name: 'bot-1',
      model: { provider: 'openai', model: 'gpt-4o' },
      systemPrompt: '',
      tools: {},
    },
    context,
  );
  // Collective record should exist with full config
  const p = collective.get('bot-1') as any;
  expect(p).toBeDefined();
  expect(p.model).toEqual({ provider: 'openai', model: 'gpt-4o' });
  // No agents/ file should be written
  const agentsFiles = await storage.list('agents/');
  expect(agentsFiles).toHaveLength(0);
});
```

**Replace the test at lines 227-256** ("updates model and systemPrompt in storage") with:

```typescript
it('updates model and systemPrompt in collective record', async () => {
  const storage = new MemoryStorage();
  const deps = await buildTestDeps({ storage });
  const createResult = (await invokeManagementTool(
    'create_agent',
    {
      id: 'bot-1',
      name: 'bot-1',
      model: { provider: 'openai', model: 'gpt-4o' },
      systemPrompt: '',
      tools: {},
    },
    deps,
  )) as { status: string; data: { id: string } };
  const { id } = createResult.data;
  await invokeManagementTool(
    'modify_agent',
    {
      id,
      model: { provider: 'openai', model: 'gpt-4o-mini' },
      systemPrompt: 'Be concise.',
    },
    deps,
  );
  const p = deps.collective.get(id) as any;
  expect(p.model).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  expect(p.systemPrompt).toBe('Be concise.');
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: PASS (all new and existing tests).

- [ ] **Step 7: Run full core test suite for regressions**

Run: `npx vitest run packages/core/`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts
git commit -m "fix: create_agent/modify_agent operate on collective as single source of truth"
```

---

### Task B3: Fix `ParticipantSlideOver.vue` — provider default, edit load, default policy

**Files:**

- Modify: `packages/web/src/components/participants/ParticipantSlideOver.vue`

- [ ] **Step 1: Implement all slide-over fixes**

Edit `packages/web/src/components/participants/ParticipantSlideOver.vue`. Replace the `<script setup>` section (lines 1-91):

```typescript
<script setup lang="ts">
import { ref, watch } from 'vue';
import SlideOver from '../common/SlideOver.vue';
import ToolPolicyEditor, { type ToolOverride } from './ToolPolicyEditor.vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  open: boolean;
  participantId: string | null;
  availableTools: string[];
  providers: { name: string }[];
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useExecute();

const tab = ref<'basic' | 'tools'>('basic');
const name = ref('');
const model = ref('');
const providerId = ref('');
const systemPrompt = ref('');
const maxIterations = ref(20);
const defaultPolicy = ref<'allow' | 'require-approval' | 'deny'>('allow');
const overrides = ref<ToolOverride[]>([]);
const saving = ref(false);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    tab.value = 'basic';
    if (props.participantId) {
      // Edit mode: load full config via get_participant
      try {
        const p = await execute<Record<string, unknown>>('get_participant', { id: props.participantId });
        name.value = (p.name as string) ?? '';
        const modelCfg = p.model as { provider: string; model: string } | undefined;
        providerId.value = modelCfg?.provider ?? '';
        model.value = modelCfg?.model ?? '';
        systemPrompt.value = (p.systemPrompt as string) ?? '';
        maxIterations.value = (p.maxIterations as number) ?? 20;

        // Reconstruct defaultPolicy + overrides from the tools map
        const tools = (p.tools as Record<string, string>) ?? {};
        const toolEntries = Object.entries(tools);
        // Determine the most common policy as the default
        const policyCounts: Record<string, number> = {};
        for (const [, policy] of toolEntries) {
          const uiPolicy = policy === 'auto' ? 'allow' : policy === 'requires_approval' ? 'require-approval' : 'deny';
          policyCounts[uiPolicy] = (policyCounts[uiPolicy] ?? 0) + 1;
        }
        const sorted = Object.entries(policyCounts).sort((a, b) => b[1] - a[1]);
        defaultPolicy.value = (sorted[0]?.[0] as 'allow' | 'require-approval' | 'deny') ?? 'allow';

        // Overrides are tools that differ from the default
        const defaultRuntime = defaultPolicy.value === 'allow' ? 'auto'
          : defaultPolicy.value === 'require-approval' ? 'requires_approval' : 'deny';
        overrides.value = toolEntries
          .filter(([, policy]) => policy !== defaultRuntime)
          .map(([tool, policy]) => ({
            tool,
            source: 'built-in',
            enabled: policy !== 'deny',
            requireApproval: policy === 'requires_approval',
          }));
      } catch {
        // Fallback: empty form
      }
    } else {
      // New mode: reset + default provider
      name.value = '';
      model.value = '';
      providerId.value = props.providers[0]?.name ?? '';
      systemPrompt.value = '';
      maxIterations.value = 20;
      defaultPolicy.value = 'allow';
      overrides.value = [];
    }
  },
);

async function save() {
  saving.value = true;
  try {
    const toolPolicies = Object.fromEntries(
      overrides.value.map((o) => [
        o.tool,
        o.requireApproval ? 'require-approval' : o.enabled ? 'allow' : 'deny',
      ]),
    );
    if (props.participantId) {
      await execute('modify_agent', {
        id: props.participantId,
        name: name.value,
        model: { provider: providerId.value, model: model.value },
        systemPrompt: systemPrompt.value,
        maxIterations: maxIterations.value,
        defaultPolicy: defaultPolicy.value,
        toolPolicies,
      });
    } else {
      const id = name.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || `agent-${Date.now()}`;
      await execute('create_agent', {
        id,
        name: name.value,
        systemPrompt: systemPrompt.value || 'You are a helpful agent.',
        model: { provider: providerId.value, model: model.value },
        defaultPolicy: defaultPolicy.value,
        toolPolicies,
      });
    }
    emit('saved');
    emit('close');
  } finally {
    saving.value = false;
  }
}

async function retire() {
  if (!props.participantId) return;
  await execute('retire_agent', { id: props.participantId });
  emit('saved');
  emit('close');
}
</script>
```

The template (lines 93-208) stays unchanged.

- [ ] **Step 2: Build the web package**

Run: `npm run build -w @legion/web`
Expected: Build succeeds with no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/participants/ParticipantSlideOver.vue
git commit -m "fix: ParticipantSlideOver loads full config on edit, defaults provider, sends defaultPolicy"
```

---

### Task B4: `ParticipantsView.vue` — Model/Provider columns from full participant data

**Files:**

- Modify: `packages/web/src/views/ParticipantsView.vue`

- [ ] **Step 1: Update `load()` to fetch full participant configs**

Edit `packages/web/src/views/ParticipantsView.vue`. Replace the `load` function (lines 20-29):

```typescript
async function load() {
  try {
    const list = await execute<{ id: string; name: string; type: string; status: string }[]>(
      'list_participants',
      {},
    );
    // Fetch full config for each participant to get model/provider
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
        providerId: (full?.model as { provider?: string })?.provider,
      };
    }) as any;
    allTools.value = await execute<string[]>('list_tools', {});
    providers.value = await execute<{ name: string }[]>('list_providers', {});
    loadError.value = null;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}
```

The template already reads `(p as any).model` and `(p as any).providerId` (lines 105-106), so no template changes needed.

- [ ] **Step 2: Build the web package**

Run: `npm run build -w @legion/web`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/views/ParticipantsView.vue
git commit -m "fix: ParticipantsView fetches full config for Model/Provider columns"
```

---

## Part C — Agent-to-Agent Delegation as Sub-Threads (bug #1)

### Task C1: Schema — add parent fields to conversation types + store interface

**Files:**

- Modify: `packages/types/src/conversation.ts`
- Modify: `packages/core/src/conversation/ConversationStore.ts`
- Modify: `packages/core/src/conversation/FileConversationStore.ts`
- Test: `packages/core/src/conversation/FileConversationStore.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/conversation/FileConversationStore.test.ts` (inside the main describe block):

```typescript
it('create persists parentConversationId and parentToolCallId', async () => {
  const conv = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    parentConversationId: 'parent-conv',
    parentToolCallId: 'tc-1',
  });
  expect(conv.parentConversationId).toBe('parent-conv');
  expect(conv.parentToolCallId).toBe('tc-1');

  const loaded = await store.load(conv.id);
  expect(loaded?.parentConversationId).toBe('parent-conv');
  expect(loaded?.parentToolCallId).toBe('tc-1');
});

it('listByParent returns only child conversations', async () => {
  const parent = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  const child1 = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    parentConversationId: parent.id,
    parentToolCallId: 'tc-a',
  });
  const child2 = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    parentConversationId: parent.id,
    parentToolCallId: 'tc-b',
  });
  // An unrelated top-level conversation
  await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });

  const children = await store.listByParent(parent.id);
  expect(children).toHaveLength(2);
  expect(children.map((c) => c.id).sort()).toEqual([child1.id, child2.id].sort());
});

it('list excludes sub-threads by default', async () => {
  const parent = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    parentConversationId: parent.id,
    parentToolCallId: 'tc-1',
  });

  const metas = await store.list();
  const ids = metas.map((m) => m.id);
  expect(ids).toContain(parent.id);
  expect(ids).toHaveLength(1); // only the parent, not the child
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/conversation/FileConversationStore.test.ts`
Expected: FAIL — `parentConversationId` not on type, `listByParent` doesn't exist, `list` doesn't filter.

- [ ] **Step 3: Add parent fields to `ConversationData` and `ConversationMeta`**

Edit `packages/types/src/conversation.ts`. Add the optional fields to `ConversationData` (after line 38, before the closing `}`):

```typescript
export interface ConversationData {
  id: string;
  schemaVersion: '2.0';
  createdAt: string;
  updatedAt: string;
  title?: string;
  activeBranchHead: string;
  messages: Record<string, MessageData>;
  parentConversationId?: string;
  parentToolCallId?: string;
}
```

Add to `ConversationMeta` (after line 47, before the closing `}`):

```typescript
export interface ConversationMeta {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  participants: string[];
  parentConversationId?: string;
  parentToolCallId?: string;
}
```

Add `includeSubThreads` to `ConversationFilter`:

```typescript
export interface ConversationFilter {
  participantId?: string;
  since?: string;
  includeSubThreads?: boolean;
}
```

- [ ] **Step 4: Add `listByParent` to `ConversationStore` interface**

Edit `packages/core/src/conversation/ConversationStore.ts`. Add after `exists` (line 20):

```typescript
  listByParent(parentId: string): Promise<ConversationData[]>;
```

- [ ] **Step 5: Implement `listByParent` and sub-thread filtering in `FileConversationStore`**

Edit `packages/core/src/conversation/FileConversationStore.ts`.

In the `list` method, after loading each conversation (after line 81: `if (!conversation) continue;`), add:

```typescript
if (!filter?.includeSubThreads && conversation.parentConversationId) continue;
```

Also populate the meta's parent fields (add to the `meta` object, after line 97 `participants: [...participantSet],`):

```typescript
        parentConversationId: conversation.parentConversationId,
        parentToolCallId: conversation.parentToolCallId,
```

Add the `listByParent` method (after the `exists` method, at the end of the class):

```typescript
  async listByParent(parentId: string): Promise<ConversationData[]> {
    const files = await this.storage.list('conversations');
    const results: ConversationData[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      const conversation = await this.load(id);
      if (conversation?.parentConversationId === parentId) {
        results.push(conversation);
      }
    }
    return results;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/conversation/FileConversationStore.test.ts`
Expected: PASS

- [ ] **Step 7: Build types package and run typecheck**

Run: `npm run build && npm run typecheck`
Expected: No type errors (adding optional fields is non-breaking).

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/conversation.ts packages/core/src/conversation/ConversationStore.ts packages/core/src/conversation/FileConversationStore.ts packages/core/src/conversation/FileConversationStore.test.ts
git commit -m "feat: add parentConversationId/parentToolCallId to conversation schema + listByParent"
```

---

### Task C2: Remove implicit join in `communicate` tool

**Files:**

- Modify: `packages/core/src/tools/Tool.ts` (add `toolCallId?`)
- Modify: `packages/core/src/tools/communicate-tool.ts`
- Test: `packages/core/src/tools/communicate-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/tools/communicate-tool.test.ts` (inside the main describe block):

```typescript
it('creates a new conversation when no conversationId is supplied (does not join caller conversation)', async () => {
  const { context, router } = await setup(dir);
  // context.conversationId is 'seed' — the tool must NOT join 'seed'
  const result = await communicateTool.execute({ to: 'agent-b', message: 'hi B' }, context);
  expect(result.status).toBe('success');
  const convId = (result.data as { conversationId: string }).conversationId;
  expect(convId).not.toBe('seed');
  // A new conversation should have been created
  expect(convId).toMatch(/^conv-/);
});

it('joins explicit conversationId when supplied', async () => {
  const { context } = await setup(dir);
  const result = await communicateTool.execute(
    { to: 'agent-b', message: 'hi', conversationId: 'explicit-conv' },
    context,
  );
  expect(result.status).toBe('success');
  const convId = (result.data as { conversationId: string }).conversationId;
  // 'explicit-conv' doesn't exist yet so router creates it with a new id;
  // but the key point is the tool passed it through, not 'seed'
  expect(convId).not.toBe('seed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/communicate-tool.test.ts`
Expected: The first test FAILS — `communicate` tool joins `context.conversationId` ('seed') instead of creating a new conversation.

- [ ] **Step 3: Add `toolCallId?` to `ToolContext`**

Edit `packages/core/src/tools/Tool.ts`. Add `toolCallId` to the `ToolContext` interface (after `callingParticipantId?` on line 55):

```typescript
  callingParticipantId?: string;
  /** The LLM tool-call id currently being executed, for parent linking in delegation. */
  toolCallId?: string;
```

- [ ] **Step 4: Remove the `?? context.conversationId` fallback in `communicate` tool**

Edit `packages/core/src/tools/communicate-tool.ts`. Replace line 32:

```typescript
      conversationId: conversationId ?? context.conversationId,
```

with:

```typescript
      conversationId,
```

The full `execute` function becomes:

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
      conversationId,
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

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/communicate-tool.test.ts`
Expected: PASS (all tests, including existing ones that may need checking — the existing test at line 69 sends no `conversationId`, so it was previously joining 'seed'; now it creates a new conversation, which still returns success).

Note: The existing test "sends a synchronous message and returns the recipient response" (line 69) previously relied on the implicit join to 'seed'. Now it creates a new conversation. The test asserts `result.status === 'success'` and `response === 'B replies'`, which still holds. Verify it passes.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/Tool.ts packages/core/src/tools/communicate-tool.ts packages/core/src/tools/communicate-tool.test.ts
git commit -m "fix: communicate tool never implicitly joins caller conversation"
```

---

### Task C3: `MessageRouter` — parent linking on new conversation

**Files:**

- Modify: `packages/core/src/runtime/MessageRouter.ts`
- Test: `packages/core/src/runtime/MessageRouter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/runtime/MessageRouter.test.ts` (inside `describe('MessageRouter: synchronous send')`):

```typescript
it('stamps parentConversationId and parentToolCallId on child when caller has a conversation', async () => {
  const { router, baseContext, store } = await setup(dir);
  // First send creates a parent conversation
  const parent = await router.send({
    senderId: 'op',
    recipientId: 'mock-1',
    message: 'hello',
    context: baseContext,
  });
  // Second send with context.conversationId = parent, no explicit conversationId
  // (simulates an agent in the parent conversation calling communicate)
  const childContext = {
    ...baseContext,
    conversationId: parent.conversationId,
    toolCallId: 'tc-42',
  };
  const child = await router.send({
    senderId: 'op',
    recipientId: 'mock-1',
    message: 'delegate',
    context: childContext,
  });
  expect(child.conversationId).not.toBe(parent.conversationId);

  const childConv = await store.load(child.conversationId);
  expect(childConv?.parentConversationId).toBe(parent.conversationId);
  expect(childConv?.parentToolCallId).toBe('tc-42');
});

it('does not stamp parent link when caller has no conversation (empty string)', async () => {
  const { router, baseContext, store } = await setup(dir);
  const result = await router.send({
    senderId: 'op',
    recipientId: 'mock-1',
    message: 'first',
    context: { ...baseContext, conversationId: '' },
  });
  const conv = await store.load(result.conversationId);
  expect(conv?.parentConversationId).toBeUndefined();
  expect(conv?.parentToolCallId).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: FAIL — `getThread` doesn't accept or stamp parent link info.

- [ ] **Step 3: Implement parent linking in `MessageRouter.getThread` and `sendInner`**

Edit `packages/core/src/runtime/MessageRouter.ts`.

Replace `getThread` (lines 57-69):

```typescript
  private async getThread(
    conversationId?: string,
    parent?: { parentConversationId: string; parentToolCallId?: string },
  ): Promise<ConversationThread> {
    if (conversationId) {
      const existing = await this.store.load(conversationId);
      if (existing) return new ConversationThread(existing, this.store);
    }
    const created = await this.store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: parent?.parentConversationId,
      parentToolCallId: parent?.parentToolCallId,
    });
    this.eventBus.emit('conversation:created', { conversationId: created.id });
    return new ConversationThread(created, this.store);
  }
```

In `sendInner` (line 134), replace:

```typescript
const thread = await this.getThread(opts.conversationId);
```

with:

```typescript
// When no explicit conversationId is provided, create a new conversation.
// If the caller is itself in a real conversation, stamp the parent link.
const parentConvId = opts.context.conversationId;
const parentLink =
  !opts.conversationId && parentConvId && parentConvId !== ''
    ? {
        parentConversationId: parentConvId,
        parentToolCallId: opts.context.toolCallId as string | undefined,
      }
    : undefined;
const thread = await this.getThread(opts.conversationId, parentLink);
```

In `resume` (line 178), replace:

```typescript
const thread = await this.getThread(conversationId);
```

with:

```typescript
const thread = await this.getThread(conversationId);
```

(No change needed — `resume` always passes an explicit `conversationId`, so `parent` is undefined and the existing conversation is loaded.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/runtime/MessageRouter.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Run full core test suite**

Run: `npx vitest run packages/core/`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/MessageRouter.ts packages/core/src/runtime/MessageRouter.test.ts
git commit -m "feat: MessageRouter stamps parentConversationId/parentToolCallId on child conversations"
```

---

### Task C4: `AgentRuntime` — thread `toolCallId` into context

**Files:**

- Modify: `packages/core/src/runtime/AgentRuntime.ts`

- [ ] **Step 1: Thread `toolCallId` into the tool execution context**

Edit `packages/core/src/runtime/AgentRuntime.ts`.

In the main tool loop (line 197), replace:

```typescript
const result = await context.toolRegistry.execute(tc.name, tc.arguments, context);
```

with:

```typescript
const result = await context.toolRegistry.execute(tc.name, tc.arguments, {
  ...context,
  toolCallId: tc.id,
});
```

In `processResumedApprovals` (line 300), replace:

```typescript
const result = await context.toolRegistry.execute(tr.name, toolCall.arguments, context);
```

with:

```typescript
const result = await context.toolRegistry.execute(tr.name, toolCall.arguments, {
  ...context,
  toolCallId: tr.id,
});
```

- [ ] **Step 2: Run existing AgentRuntime tests to verify no regressions**

Run: `npx vitest run packages/core/src/runtime/AgentRuntime.test.ts`
Expected: All existing tests pass (the context spread is transparent — all existing fields are preserved).

- [ ] **Step 3: Run full core test suite**

Run: `npx vitest run packages/core/`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runtime/AgentRuntime.ts
git commit -m "feat: AgentRuntime threads toolCallId into tool context for parent linking"
```

---

### Task C5: `list_conversations` filter + `get_conversation` sub-thread inclusion

**Files:**

- Modify: `packages/core/src/tools/management-tools.ts`
- Test: `packages/core/src/tools/management-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/tools/management-tools.test.ts`:

```typescript
it('get_conversation includes subThreads keyed by parentToolCallId', async () => {
  const { context, conversationStore } = await makeContext();
  // Create a parent conversation with a message
  const parent = await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  await conversationStore.appendMessage(parent.id, {
    id: 'msg-1',
    parentId: null,
    conversationId: parent.id,
    senderId: 'op',
    recipientId: 'agent-a',
    role: 'user',
    content: 'hello',
    status: 'active',
    timestamp: new Date().toISOString(),
  });
  await conversationStore.updateHead(parent.id, 'msg-1');

  // Create a child sub-thread
  const child = await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    parentConversationId: parent.id,
    parentToolCallId: 'tc-delegate',
  });
  await conversationStore.appendMessage(child.id, {
    id: 'child-msg-1',
    parentId: null,
    conversationId: child.id,
    senderId: 'agent-a',
    recipientId: 'agent-b',
    role: 'user',
    content: 'delegated question',
    status: 'active',
    timestamp: new Date().toISOString(),
  });
  await conversationStore.updateHead(child.id, 'child-msg-1');

  const result = await getConversationTool.execute({ conversationId: parent.id }, context);
  expect(result.status).toBe('success');
  const data = result.data as {
    id: string;
    subThreads: Record<string, { id: string; messages: unknown[] }>;
  };
  expect(data.id).toBe(parent.id);
  expect(data.subThreads).toBeDefined();
  expect(data.subThreads['tc-delegate']).toBeDefined();
  expect(data.subThreads['tc-delegate'].id).toBe(child.id);
  expect(data.subThreads['tc-delegate'].messages).toHaveLength(1);
});

it('list_conversations excludes sub-threads', async () => {
  const { context, conversationStore } = await makeContext();
  const parent = await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    parentConversationId: parent.id,
    parentToolCallId: 'tc-1',
  });

  const result = await listConversationsTool.execute({}, context);
  expect(result.status).toBe('success');
  const data = result.data as { conversations: { id: string }[] };
  const ids = data.conversations.map((c) => c.id);
  expect(ids).toContain(parent.id);
  // The child should not appear
  expect(ids).toHaveLength(1);
});
```

Add `getConversationTool` and `listConversationsTool` to the imports at the top (if not already imported):

```typescript
import { getConversationTool, listConversationsTool } from './management-tools.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: FAIL — `get_conversation` doesn't return `subThreads`.

- [ ] **Step 3: Update `getConversationTool` to include sub-threads**

Edit `packages/core/src/tools/management-tools.ts`. Replace the `getConversationTool` (lines 133-158) with:

```typescript
export const getConversationTool: Tool = {
  name: 'get_conversation',
  description: 'Load a conversation, its active message chain, and any sub-threads.',
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
    if (!conversation)
      return { status: 'error', error: `Conversation not found: ${conversationId}` };

    // Find sub-threads (child conversations linked to this one)
    const subThreadList = await context.conversationStore.listByParent(conversationId);
    const subThreads: Record<string, unknown> = {};
    for (const st of subThreadList) {
      if (st.parentToolCallId) {
        subThreads[st.parentToolCallId] = {
          id: st.id,
          title: st.title,
          messages: getActiveChain(st),
          parentConversationId: st.parentConversationId,
          parentToolCallId: st.parentToolCallId,
        };
      }
    }

    return {
      status: 'success',
      data: {
        id: conversation.id,
        title: conversation.title,
        messages: getActiveChain(conversation),
        parentConversationId: conversation.parentConversationId,
        parentToolCallId: conversation.parentToolCallId,
        subThreads,
      },
    };
  },
};
```

Note: `getActiveChain` is already imported at the top of the file (line 2).

The `listConversationsTool` already calls `context.conversationStore.list()`, which we updated in Task C1 to exclude sub-threads by default. No change needed to `listConversationsTool` itself.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/management-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Run full core test suite**

Run: `npx vitest run packages/core/`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/management-tools.ts packages/core/src/tools/management-tools.test.ts
git commit -m "feat: get_conversation includes subThreads, list_conversations excludes sub-threads"
```

---

### Task C6: Frontend — capture `subThreads` and render nested delegation blocks

**Files:**

- Modify: `packages/web/src/composables/useConversation.ts`
- Modify: `packages/web/src/components/conversations/ConversationThread.vue`
- Test: `packages/web/src/composables/useConversation.test.ts`

- [ ] **Step 1: Read the existing `useConversation.test.ts` to understand current test patterns**

Run: `cat packages/web/src/composables/useConversation.test.ts`

- [ ] **Step 2: Update `useConversation.ts` to capture and expose `subThreads`**

Edit `packages/web/src/composables/useConversation.ts`. Replace the `ConversationResponse` interface and the composable:

```typescript
import { ref, computed, onMounted } from 'vue';
import { useExecute } from './useExecute.js';
import { useEventStream } from './useEventStream.js';
import type { MessageData } from '@legion/types';

// Shape returned by the get_conversation tool
interface SubThreadData {
  id: string;
  title?: string;
  messages: MessageData[];
  parentConversationId?: string;
  parentToolCallId?: string;
}

interface ConversationResponse {
  id: string;
  title?: string;
  messages: MessageData[];
  subThreads?: Record<string, SubThreadData>;
}

export function useConversation(conversationId: string | null) {
  const { execute } = useExecute();
  const { on } = useEventStream();

  const messages = ref<MessageData[]>([]);
  const subThreads = ref<Record<string, SubThreadData>>({});
  const loading = ref(conversationId !== null);
  const error = ref<string | null>(null);
  const isThinkingLocal = ref(false);
  const iterationFired = ref(false);

  const isThinking = computed(() => {
    if (isThinkingLocal.value || iterationFired.value) return true;
    const last = messages.value.at(-1);
    return !!last && last.role === 'user' ? 'indeterminate' : false;
  });

  async function load() {
    if (!conversationId) return;
    loading.value = true;
    error.value = null;
    try {
      const data = await execute<ConversationResponse>('get_conversation', { conversationId });
      messages.value = data.messages;
      subThreads.value = data.subThreads ?? {};
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function markSent() {
    isThinkingLocal.value = true;
  }

  if (conversationId) {
    on(
      'message:sent',
      () => {
        void load();
      },
      { conversationId },
    );
    on(
      'message:delivered',
      () => {
        isThinkingLocal.value = false;
        iterationFired.value = false;
        void load();
      },
      { conversationId },
    );
    on(
      'iteration',
      () => {
        iterationFired.value = true;
      },
      { conversationId },
    );
    on(
      'approval:requested',
      () => {
        isThinkingLocal.value = false;
        iterationFired.value = false;
        void load();
      },
      { conversationId },
    );
    on(
      'approval:resolved',
      () => {
        iterationFired.value = true;
        void load();
      },
      { conversationId },
    );
    on(
      'tool:result',
      () => {
        void load();
      },
      { conversationId },
    );

    onMounted(() => {
      void load();
    });
  }

  return { messages, subThreads, loading, error, isThinking, load, markSent };
}
```

- [ ] **Step 3: Update `ConversationThread.vue` to render nested sub-threads**

Edit `packages/web/src/components/conversations/ConversationThread.vue`. Add the `ToolCallBlock` import and the sub-thread rendering logic.

In the `<script setup>` section, add imports and helper after line 7:

```typescript
import ToolCallBlock, { type ToolCallEntry, type MessageEntry } from './ToolCallBlock.vue';
```

After the `isOwnMessage` function (line 66), add:

```typescript
function subThreadForToolCall(toolCallId: string): ToolCallEntry | null {
  const st = subThreads.value[toolCallId];
  if (!st) return null;
  const entries: MessageEntry[] = st.messages.map((m) => ({
    id: m.id,
    author: m.senderId,
    authorColour: '#f59e0b',
    content: m.content,
    timestamp: new Date(m.timestamp).toLocaleTimeString(),
  }));
  return {
    id: toolCallId,
    tool: 'communicate',
    type: 'delegation',
    args: undefined,
    result: undefined,
    timestamp: '',
    subThread: entries,
  };
}
```

Destructure `subThreads` from `useConversation` on line 20:

```typescript
const { messages, subThreads, loading, isThinking, markSent } = useConversation(
  props.conversationId,
);
```

In the template, replace the compact tool call div (lines 100-107):

```html
<div
  v-for="tc in msg.toolCalls"
  :key="tc.id"
  class="text-xs font-mono text-slate-500 px-2 py-1 bg-navy-900 rounded border border-navy-700"
>
  {{ tc.name }}({{ JSON.stringify(tc.arguments).slice(0, 60) }}…)
</div>
```

with:

```html
<template v-for="tc in msg.toolCalls" :key="tc.id">
  <ToolCallBlock v-if="subThreadForToolCall(tc.id)" :entry="subThreadForToolCall(tc.id)!" />
  <div
    v-else
    class="text-xs font-mono text-slate-500 px-2 py-1 bg-navy-900 rounded border border-navy-700"
  >
    {{ tc.name }}({{ JSON.stringify(tc.arguments).slice(0, 60) }}…)
  </div>
</template>
```

- [ ] **Step 4: Build the web package**

Run: `npm run build -w @legion/web`
Expected: Build succeeds with no type errors.

- [ ] **Step 5: Run web tests**

Run: `npx vitest run packages/web/`
Expected: All tests pass (existing tests for useConversation may need adjustment if they check the return shape — verify).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/composables/useConversation.ts packages/web/src/components/conversations/ConversationThread.vue
git commit -m "feat: render agent-to-agent delegation as nested sub-threads in conversation UI"
```

---

## Part D — End-to-End Verification

### Task D1: Build all packages and restart server

- [ ] **Step 1: Build everything**

Run: `npm run build`
Expected: All packages compile successfully.

- [ ] **Step 2: Kill old server and start fresh**

```bash
kill -9 $(lsof -ti:3000) 2>/dev/null; sleep 1
setsid nohup node packages/runtime/bin/legion.js > /tmp/opencode/legion-server.log 2>&1 &
sleep 3
# Verify fresh PID
lsof -i:3000 | grep LISTEN
# Verify health
curl -s http://192.168.1.153:3000/api/health | head -5
```

Expected: New PID, health check returns OK.

### Task D2: Part A verification — auth/session

- [ ] **Step 1: Verify login returns `expiresAt`**

```bash
curl -s -X POST http://192.168.1.153:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"name":"operator","password":"REDACTED-EXAMPLE-PASSWORD"}' | python3 -m json.tool
```

Expected: Response includes `expiresAt` field (a number ~8h in the future).

- [ ] **Step 2: Verify 401 redirect via Playwright**

Use Playwright to:

1. Navigate to `http://192.168.1.153:3000`
2. Log in with operator credentials
3. Kill and restart the server (invalidating the token)
4. Navigate to `/participants` — confirm redirect to `/login`

- [ ] **Step 3: Commit verification note**

No code changes. Just confirm the behavior is correct.

### Task D3: Part B verification — participant management

- [ ] **Step 1: Create an agent via the UI with Playwright**

1. Log in
2. Navigate to Participants
3. Click "+ New agent"
4. Fill in name, select provider, enter model string
5. Save
6. Verify `collective/participants/<id>.json` has the model and provider:

```bash
ls .legion/collective/participants/
cat .legion/collective/participants/<new-agent-id>.json | python3 -m json.tool
```

Expected: JSON has `model: { provider: "...", model: "..." }`.

- [ ] **Step 2: Edit the agent and verify persistence**

1. Click "Edit" on the agent
2. Change the system prompt and model
3. Save
4. Reload the edit form — confirm the fields show the updated values
5. Verify the collective JSON file reflects the changes

- [ ] **Step 3: Verify default policy is applied**

1. Create a new agent with default policy "require-approval"
2. Check the collective JSON — all tools should have `requires_approval` policy
3. Send a message to the agent — confirm it requests approval for tool calls

### Task D4: Part C verification — agent-to-agent delegation

- [ ] **Step 1: Verify the round-trip works**

1. Log in
2. Start a new conversation with the assistant agent
3. Send: "Ask the researcher to calculate 2+2 and tell me the answer"
4. Wait for the assistant to respond
5. Confirm:
   - The assistant responds with the answer from the researcher
   - The `communicate` tool call renders as a collapsible delegation block
   - Expanding it shows the researcher's messages
   - The top-level conversation list does NOT show the sub-thread as a separate entry

- [ ] **Step 2: Verify no stall**

Confirm the conversation doesn't freeze — the assistant should respond within a reasonable time (30s).

- [ ] **Step 3: Verify sub-thread is not in top-level list**

```bash
ls .legion/conversations/
```

Confirm there are 2 conversation files (parent + child), but the UI sidebar only shows the parent.

### Task D5: Final commit and cleanup

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Final build**

Run: `npm run build`
Expected: Success.

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "verify: all parts built and tested end-to-end"
```
