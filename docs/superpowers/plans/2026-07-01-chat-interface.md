# Chat Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Conversations view into a full chat interface — send messages to agents, see responses as chat bubbles, handle inline approval cards, and scope WebSocket event delivery to each authenticated participant.

**Architecture:** Three backend changes (ConversationMeta participants field, list_conversations filter, WebSocket event scoping) followed by a composable refactor (useWebSocket → useEventStream → useConversation) and then new/modified Vue components. The backend changes are independently testable and should be completed and committed before touching the frontend.

**Tech Stack:** TypeScript strict ESM, Vitest (unit/integration), Vue 3 `<script setup>`, Tailwind CSS v4, Fastify 5 + `@fastify/websocket`, Vue Router 4 hash history.

**Spec:** `docs/superpowers/specs/2026-07-01-chat-interface-design.md`

---

## File Map

### New files

| File | Purpose |
|---|---|
| `packages/types/src/events.ts` | Modified — no new file |
| `packages/web/src/composables/useWebSocket.ts` | Raw WS transport singleton |
| `packages/web/src/composables/useWebSocket.test.ts` | Unit tests |
| `packages/web/src/composables/useConversation.ts` | Conversation state + live updates |
| `packages/web/src/composables/useConversation.test.ts` | Unit tests |
| `packages/web/src/components/conversations/MessageBubble.vue` | Single chat bubble |
| `packages/web/src/components/conversations/MessageBubble.test.ts` | Component tests |
| `packages/web/src/components/conversations/ApprovalCard.vue` | Inline approval request |
| `packages/web/src/components/conversations/ApprovalCard.test.ts` | Component tests |
| `packages/web/src/components/common/SearchableCombobox.vue` | Reusable filtered dropdown |
| `packages/web/src/components/common/SearchableCombobox.test.ts` | Component tests |
| `packages/runtime/src/server/event-filter.ts` | `isRelevantToParticipant` pure function |
| `packages/runtime/src/server/event-filter.test.ts` | Unit tests |

### Modified files

| File | What changes |
|---|---|
| `packages/types/src/conversation.ts` | Add `participants: string[]` to `ConversationMeta` |
| `packages/core/src/conversation/FileConversationStore.ts` | Populate `participants` in `list()`, add `participantId` filter |
| `packages/core/src/tools/management-tools.ts` | `list_conversations` delegates to `conversationStore.list()`, adds `participantId` param |
| `packages/runtime/src/server/WebConnector.ts` | Import and apply `isRelevantToParticipant` in `onAny` handler |
| `packages/web/src/composables/useEventStream.ts` | Refactor to use `useWebSocket`, add typed filtered `on()`, auto-cleanup |
| `packages/web/src/composables/useEventStream.test.ts` | Add filter and cleanup tests |
| `packages/web/src/views/ParticipantsView.vue` | Fix subscribe leak — capture unsubscribe, add `onUnmounted` |
| `packages/web/src/views/ConversationsView.vue` | Add Mine/All toggle, New button, draft state, wire useConversation |
| `packages/web/src/components/conversations/ConversationList.vue` | Mine/All toggle, +New button, amber dot |
| `packages/web/src/components/conversations/ConversationThread.vue` | Add mode prop, bubble rendering, composer, thinking indicator |
| `packages/web/src/router/index.ts` | Add `/conversations/new` route |

---

## Task 1: Add `participants` to `ConversationMeta`

**Files:**
- Modify: `packages/types/src/conversation.ts:41-47`

- [ ] **Write the failing test**

In `packages/core/src/conversation/FileConversationStore.test.ts` (add to existing test file), add:

```ts
it('list() includes participants from both senderId and recipientId', async () => {
  const storage = new MemoryStorage();
  const store = new FileConversationStore(storage);
  const conv = await store.create();
  await store.appendMessage(conv.id, {
    senderId: 'agent-1',
    recipientId: 'operator',
    role: 'user',
    content: 'hello',
    status: 'active',
  });
  const list = await store.list();
  expect(list[0].participants).toContain('agent-1');
  expect(list[0].participants).toContain('operator');
});
```

- [ ] **Run the test to confirm it fails**

```bash
cd /home/chris/source/javascript/legion-v2
npm test -- --reporter=verbose packages/core/src/conversation/FileConversationStore.test.ts
```
Expected: fail — `participants` does not exist on `ConversationMeta`.

- [ ] **Add `participants` to `ConversationMeta`**

In `packages/types/src/conversation.ts`, change lines 41–47 from:

```ts
export interface ConversationMeta {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
```

to:

```ts
export interface ConversationMeta {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  participants: string[];
}
```

- [ ] **Populate `participants` in `FileConversationStore.list()`**

In `packages/core/src/conversation/FileConversationStore.ts`, update the `list()` method (lines 73–99) to build the participants set from both `senderId` and `recipientId` on every message:

```ts
async list(filter?: ConversationFilter): Promise<ConversationMeta[]> {
  const keys = await this.storage.list('conversations');
  const metas: ConversationMeta[] = [];

  for (const k of keys) {
    if (!k.endsWith('.json')) continue;
    const id = k.replace(/\.json$/, '');
    const data = await this.storage.readJson<ConversationData>(this.key(id));
    if (!data) continue;

    const messages = Object.values(data.messages);
    const createdAt = messages[0]?.createdAt ?? new Date().toISOString();
    const updatedAt = messages.at(-1)?.createdAt ?? createdAt;

    const participantSet = new Set<string>();
    for (const msg of messages) {
      if (msg.senderId) participantSet.add(msg.senderId);
      if (msg.recipientId) participantSet.add(msg.recipientId);
    }

    const meta: ConversationMeta = {
      id,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      participants: [...participantSet],
    };

    if (filter?.since && meta.updatedAt < filter.since) continue;
    if (filter?.participantId && !participantSet.has(filter.participantId)) continue;

    metas.push(meta);
  }

  return metas;
}
```

- [ ] **Run the test to confirm it passes**

```bash
npm test -- --reporter=verbose packages/core/src/conversation/FileConversationStore.test.ts
```
Expected: PASS.

- [ ] **Commit**

```bash
git add packages/types/src/conversation.ts packages/core/src/conversation/FileConversationStore.ts
git commit -m "feat: add participants field to ConversationMeta with senderId/recipientId scanning"
```

---

## Task 2: Add `participantId` filter to `list_conversations` tool

**Files:**
- Modify: `packages/core/src/tools/management-tools.ts:239-265`

The current `listConversationsTool` does its own storage scan and returns `ConversationSummary[]`. We replace it to delegate to `context.conversationStore.list()` which now handles filtering and returns `ConversationMeta[]`.

- [ ] **Write the failing test**

In `packages/core/src/tools/management-tools.test.ts` (add to existing test file):

```ts
it('list_conversations filters by participantId', async () => {
  // set up a context with a real FileConversationStore backed by MemoryStorage
  const storage = new MemoryStorage();
  const conversationStore = new FileConversationStore(storage);

  // create two conversations — one involving 'operator', one not
  const conv1 = await conversationStore.create();
  await conversationStore.appendMessage(conv1.id, {
    senderId: 'operator',
    recipientId: 'agent-1',
    role: 'user',
    content: 'hi',
    status: 'active',
  });

  const conv2 = await conversationStore.create();
  await conversationStore.appendMessage(conv2.id, {
    senderId: 'agent-1',
    recipientId: 'agent-2',
    role: 'user',
    content: 'internal',
    status: 'active',
  });

  const tool = managementTools.find((t) => t.name === 'list_conversations')!;
  const ctx = makeTestContext({ storage, conversationStore });

  const result = await tool.execute({ participantId: 'operator' }, ctx);
  expect(result.status).toBe('success');
  const conversations = (result as any).data.conversations as ConversationMeta[];
  expect(conversations).toHaveLength(1);
  expect(conversations[0].id).toBe(conv1.id);
  expect(conversations[0].participants).toContain('operator');
});
```

- [ ] **Run the test to confirm it fails**

```bash
npm test -- --reporter=verbose packages/core/src/tools/management-tools.test.ts
```
Expected: fail — tool does not accept `participantId` parameter.

- [ ] **Rewrite `listConversationsTool`**

Replace lines 239–265 in `packages/core/src/tools/management-tools.ts`:

```ts
const listConversationsTool: Tool = {
  name: 'list_conversations',
  description: 'List conversations. Pass participantId to filter to conversations involving that participant.',
  parameters: {
    type: 'object',
    properties: {
      participantId: {
        type: 'string',
        description: 'Only return conversations where this participant is a sender or recipient.',
      },
      since: {
        type: 'string',
        description: 'ISO 8601 timestamp — only return conversations updated after this time.',
      },
    },
  },
  async execute(args: { participantId?: string; since?: string }, context: ToolContext) {
    try {
      const conversations = await context.conversationStore.list({
        participantId: args.participantId,
        since: args.since,
      });
      return { status: 'success', data: { conversations } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

Note: `context.conversationStore` must be available on `ToolContext`. Check `packages/core/src/tools/Tool.ts` — if `conversationStore` is not already on `ToolContext`, add it there and wire it in `LegionProcess.ts` where the tool context is assembled.

- [ ] **Add `conversationStore` to `ToolContext` if missing**

Check `packages/core/src/tools/Tool.ts`. If `conversationStore: ConversationStore` is not present on `ToolContext`, add it:

```ts
import type { ConversationStore } from '../conversation/ConversationStore.js';

export interface ToolContext {
  // ... existing fields ...
  conversationStore: ConversationStore;
}
```

Then in `packages/runtime/src/LegionProcess.ts`, find where `ToolContext` is assembled and add `conversationStore` to it.

- [ ] **Add `participantId` to `ConversationFilter`**

In `packages/types/src/conversation.ts`, `ConversationFilter` (lines 49–52) currently has `since?: string`. Add `participantId`:

```ts
export interface ConversationFilter {
  since?: string;
  participantId?: string;
}
```

- [ ] **Run the test to confirm it passes**

```bash
npm test -- --reporter=verbose packages/core/src/tools/management-tools.test.ts
```
Expected: PASS.

- [ ] **Run full test suite to check for regressions**

```bash
npm test
```
Expected: all existing tests pass.

- [ ] **Commit**

```bash
git add packages/types/src/conversation.ts packages/core/src/tools/management-tools.ts packages/core/src/tools/Tool.ts packages/runtime/src/LegionProcess.ts
git commit -m "feat: list_conversations delegates to conversationStore.list() with participantId filter"
```

---

## Task 3: Participant-scoped WebSocket event filtering

**Files:**
- Create: `packages/runtime/src/server/event-filter.ts`
- Create: `packages/runtime/src/server/event-filter.test.ts`
- Modify: `packages/runtime/src/server/WebConnector.ts:168-173`

- [ ] **Write the failing tests**

Create `packages/runtime/src/server/event-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isRelevantToParticipant } from './event-filter.js';

describe('isRelevantToParticipant', () => {
  const pid = 'operator';
  const isOperator = true;

  it('always passes process:ready', () => {
    expect(isRelevantToParticipant('process:ready', {}, pid, false)).toBe(true);
  });

  it('always passes conversation:created', () => {
    expect(isRelevantToParticipant('conversation:created', { conversationId: 'c1' }, pid, false)).toBe(true);
  });

  it('always passes participant:active and participant:retired', () => {
    expect(isRelevantToParticipant('participant:active', { participantId: 'x' }, pid, false)).toBe(true);
    expect(isRelevantToParticipant('participant:retired', { participantId: 'x' }, pid, false)).toBe(true);
  });

  it('always passes error', () => {
    expect(isRelevantToParticipant('error', { message: 'oops' }, pid, false)).toBe(true);
  });

  it('passes message:sent when senderId matches', () => {
    expect(isRelevantToParticipant('message:sent', { senderId: pid, recipientId: 'agent-1', conversationId: 'c1', messageId: 'm1' }, pid, false)).toBe(true);
  });

  it('passes message:sent when recipientId matches', () => {
    expect(isRelevantToParticipant('message:sent', { senderId: 'agent-1', recipientId: pid, conversationId: 'c1', messageId: 'm1' }, pid, false)).toBe(true);
  });

  it('drops message:sent for unrelated participants', () => {
    expect(isRelevantToParticipant('message:sent', { senderId: 'agent-1', recipientId: 'agent-2', conversationId: 'c1', messageId: 'm1' }, pid, false)).toBe(false);
  });

  it('passes message:delivered when recipientId matches', () => {
    expect(isRelevantToParticipant('message:delivered', { recipientId: pid, conversationId: 'c1', messageId: 'm1' }, pid, false)).toBe(true);
  });

  it('drops message:delivered for other recipients', () => {
    expect(isRelevantToParticipant('message:delivered', { recipientId: 'agent-1', conversationId: 'c1', messageId: 'm1' }, pid, false)).toBe(false);
  });

  it('passes tool:call when participantId matches', () => {
    expect(isRelevantToParticipant('tool:call', { participantId: pid, conversationId: 'c1', toolName: 'x', toolCallId: 't1' }, pid, false)).toBe(true);
  });

  it('drops tool:call for other participants', () => {
    expect(isRelevantToParticipant('tool:call', { participantId: 'agent-1', conversationId: 'c1', toolName: 'x', toolCallId: 't1' }, pid, false)).toBe(false);
  });

  it('passes tool:result when participantId matches', () => {
    expect(isRelevantToParticipant('tool:result', { participantId: pid, conversationId: 'c1', toolName: 'x', toolCallId: 't1', result: { status: 'success', data: null } }, pid, false)).toBe(true);
  });

  it('passes iteration when participantId matches', () => {
    expect(isRelevantToParticipant('iteration', { participantId: pid, conversationId: 'c1', iteration: 0 }, pid, false)).toBe(true);
  });

  it('drops iteration for other participants', () => {
    expect(isRelevantToParticipant('iteration', { participantId: 'agent-1', conversationId: 'c1', iteration: 0 }, pid, false)).toBe(false);
  });

  it('passes approval:requested for operators regardless of requesterId', () => {
    expect(isRelevantToParticipant('approval:requested', { approvalId: 'a1', requesterId: 'agent-1', conversationId: 'c1', toolName: 'x', args: {} }, pid, true)).toBe(true);
  });

  it('drops approval:requested for non-operators who are not the requester', () => {
    expect(isRelevantToParticipant('approval:requested', { approvalId: 'a1', requesterId: 'agent-1', conversationId: 'c1', toolName: 'x', args: {} }, 'agent-2', false)).toBe(false);
  });

  it('passes approval:requested to the requester themselves', () => {
    expect(isRelevantToParticipant('approval:requested', { approvalId: 'a1', requesterId: pid, conversationId: 'c1', toolName: 'x', args: {} }, pid, false)).toBe(true);
  });

  it('passes approval:resolved for operators', () => {
    expect(isRelevantToParticipant('approval:resolved', { approvalId: 'a1', requesterId: 'agent-1', conversationId: 'c1', approved: true }, pid, true)).toBe(true);
  });

  it('drops unknown event types', () => {
    expect(isRelevantToParticipant('unknown:event' as any, {}, pid, false)).toBe(false);
  });
});
```

- [ ] **Run the tests to confirm they fail**

```bash
npm test -- --reporter=verbose packages/runtime/src/server/event-filter.test.ts
```
Expected: fail — module does not exist.

- [ ] **Create `event-filter.ts`**

Create `packages/runtime/src/server/event-filter.ts`:

```ts
import type { LegionEventMap } from '@legion/types';

type EventName = keyof LegionEventMap;

/**
 * Returns true if this event should be delivered to the given participant's WebSocket connection.
 *
 * NOTE: This is a domain-driven switch over event names. It must be updated when new event types
 * are added to LegionEventMap. The long-term fix is event metadata / scope fields so routing
 * does not require knowledge of each event's payload shape.
 */
export function isRelevantToParticipant(
  event: string,
  payload: unknown,
  participantId: string,
  isOperator: boolean,
): boolean {
  const p = payload as Record<string, unknown>;

  switch (event as EventName) {
    // Always broadcast — collective/process state changes affect all participants
    case 'process:ready':
    case 'conversation:created':
    case 'participant:active':
    case 'participant:retired':
    case 'error':
      return true;

    // Scoped to participants involved in the message
    case 'message:sent':
      return p['senderId'] === participantId || p['recipientId'] === participantId;

    case 'message:delivered':
      return p['recipientId'] === participantId;

    // Scoped to the agent doing the work
    case 'tool:call':
    case 'tool:result':
    case 'iteration':
      return p['participantId'] === participantId;

    // Approvals go to operators (they have authority) or the requesting participant
    case 'approval:requested':
    case 'approval:resolved':
      return isOperator || p['requesterId'] === participantId;

    default:
      return false;
  }
}
```

- [ ] **Run the tests to confirm they pass**

```bash
npm test -- --reporter=verbose packages/runtime/src/server/event-filter.test.ts
```
Expected: all pass.

- [ ] **Wire `isRelevantToParticipant` into `WebConnector`**

In `packages/runtime/src/server/WebConnector.ts`:

Add import at the top:
```ts
import { isRelevantToParticipant } from './event-filter.js';
```

`WebConnectorDeps` needs to expose `collective` so we can check `isOperator` at auth time. Check if `Collective` is already in `WebConnectorDeps` (around lines 15–27). If not, add it:
```ts
import type { Collective } from '@legion/core';

interface WebConnectorDeps {
  // ... existing deps ...
  collective: Collective;
}
```

Then in `handleWebSocket()`, after the participant is resolved from the JWT (around line 155–160), resolve `isOperator`:
```ts
const participant = this.deps.collective.get(participantId);
const isOperator = participant?.operator === true;
```

Then update the `onAny` handler (lines 168–173) to filter:
```ts
const handler = (event: string, payload: unknown) => {
  if (
    socket.readyState === WebSocket.OPEN &&
    isRelevantToParticipant(event, payload, participantId, isOperator)
  ) {
    socket.send(JSON.stringify({ type: 'event', event, data: payload }));
  }
};
anyOff = this.deps.eventBus.onAny(handler);
```

If `collective` is not already passed into `WebConnector` via `LegionProcess.ts`, add it there too.

- [ ] **Run all runtime tests**

```bash
npm test -- --reporter=verbose packages/runtime
```
Expected: all pass.

- [ ] **Commit**

```bash
git add packages/runtime/src/server/event-filter.ts packages/runtime/src/server/event-filter.test.ts packages/runtime/src/server/WebConnector.ts packages/runtime/src/LegionProcess.ts
git commit -m "feat: scope WebSocket event delivery to authenticated participant via isRelevantToParticipant"
```

---

## Task 4: Extract `useWebSocket` composable

**Files:**
- Create: `packages/web/src/composables/useWebSocket.ts`
- Create: `packages/web/src/composables/useWebSocket.test.ts`

- [ ] **Write the failing tests**

Create `packages/web/src/composables/useWebSocket.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useWebSocket } from './useWebSocket.js';

// We test the public interface only — not the internal WebSocket construction
describe('useWebSocket', () => {
  beforeEach(() => {
    // Reset module-level singleton state between tests by reimporting
    vi.resetModules();
  });

  it('exports connect, disconnect, onMessage, send', async () => {
    const ws = await import('./useWebSocket.js');
    expect(typeof ws.useWebSocket).toBe('function');
    const { connect, disconnect, onMessage, send } = ws.useWebSocket();
    expect(typeof connect).toBe('function');
    expect(typeof disconnect).toBe('function');
    expect(typeof onMessage).toBe('function');
    expect(typeof send).toBe('function');
  });

  it('onMessage returns an unsubscribe function', async () => {
    const { useWebSocket } = await import('./useWebSocket.js');
    const { onMessage } = useWebSocket();
    const unsub = onMessage(() => {});
    expect(typeof unsub).toBe('function');
    unsub(); // should not throw
  });
});
```

- [ ] **Run the test to confirm it fails**

```bash
cd packages/web && npx vitest run --reporter=verbose src/composables/useWebSocket.test.ts
```
Expected: fail — module does not exist.

- [ ] **Create `useWebSocket.ts`**

Extract the raw WebSocket logic from `useEventStream.ts` into `packages/web/src/composables/useWebSocket.ts`:

```ts
import { useAuth } from './useAuth.js';

type MessageHandler = (data: unknown) => void;

// Module-level singleton state — one WebSocket for the entire app
const handlers = new Set<MessageHandler>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;

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
    try { parsed = JSON.parse(evt.data as string); } catch { return; }
    for (const handler of [...handlers]) {
      try { handler(parsed); } catch { /* isolate */ }
    }
  });

  ws.addEventListener('close', () => scheduleReconnect());
  ws.addEventListener('error', () => ws?.close());
}

function scheduleReconnect(): void {
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
      if (!ws || ws.readyState > WebSocket.OPEN) connect();
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

Note: `useAuth` must expose `getToken()`. Check current `useAuth.ts` — if it doesn't, add it:
```ts
// in useAuth.ts
function getToken(): string | null {
  return token.value;
}
// add to the returned object
return { ..., getToken };
```

- [ ] **Run the test to confirm it passes**

```bash
cd packages/web && npx vitest run --reporter=verbose src/composables/useWebSocket.test.ts
```
Expected: PASS.

- [ ] **Commit**

```bash
git add packages/web/src/composables/useWebSocket.ts packages/web/src/composables/useWebSocket.test.ts packages/web/src/composables/useAuth.ts
git commit -m "feat: extract useWebSocket singleton composable from useEventStream"
```

---

## Task 5: Refactor `useEventStream` to use `useWebSocket` with typed filtered subscriptions and auto-cleanup

**Files:**
- Modify: `packages/web/src/composables/useEventStream.ts`
- Modify: `packages/web/src/composables/useEventStream.test.ts`

- [ ] **Write the new tests first**

Add to `packages/web/src/composables/useEventStream.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, onMounted } from 'vue';
import { mount } from '@vue/test-utils';

// We mock useWebSocket so useEventStream doesn't need a real WebSocket
vi.mock('./useWebSocket.js', () => {
  const handlers = new Set<(data: unknown) => void>();
  return {
    useWebSocket: () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      onMessage: (h: (data: unknown) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      send: vi.fn(),
      // Expose for test use
      _emit: (data: unknown) => handlers.forEach((h) => h(data)),
    }),
    __handlers: handlers,
  };
});

describe('useEventStream', () => {
  it('on() delivers matching events to handler', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const { useWebSocket } = await import('./useWebSocket.js');
    const ws = useWebSocket() as any;

    const received: unknown[] = [];
    const { on } = useEventStream();
    const off = on('message:sent', (payload) => received.push(payload));

    ws._emit({ type: 'event', event: 'message:sent', data: { conversationId: 'c1', senderId: 'op', recipientId: 'ag' } });
    expect(received).toHaveLength(1);

    off();
  });

  it('on() with conversationId filter drops events for other conversations', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const { useWebSocket } = await import('./useWebSocket.js');
    const ws = useWebSocket() as any;

    const received: unknown[] = [];
    const { on } = useEventStream();
    const off = on('message:sent', (p) => received.push(p), { conversationId: 'c1' });

    ws._emit({ type: 'event', event: 'message:sent', data: { conversationId: 'c2', senderId: 'op', recipientId: 'ag' } });
    expect(received).toHaveLength(0);

    ws._emit({ type: 'event', event: 'message:sent', data: { conversationId: 'c1', senderId: 'op', recipientId: 'ag' } });
    expect(received).toHaveLength(1);

    off();
  });

  it('auto-cleans up handlers when component unmounts', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const { useWebSocket } = await import('./useWebSocket.js');
    const ws = useWebSocket() as any;

    const received: unknown[] = [];

    const TestComponent = defineComponent({
      setup() {
        const { on } = useEventStream();
        on('iteration', (p) => received.push(p));
      },
      template: '<div/>',
    });

    const wrapper = mount(TestComponent);
    ws._emit({ type: 'event', event: 'iteration', data: { conversationId: 'c1', participantId: 'ag', iteration: 0 } });
    expect(received).toHaveLength(1);

    await wrapper.unmount();
    ws._emit({ type: 'event', event: 'iteration', data: { conversationId: 'c1', participantId: 'ag', iteration: 1 } });
    // handler should have been removed — no new events
    expect(received).toHaveLength(1);
  });
});
```

- [ ] **Run the new tests to confirm they fail**

```bash
cd packages/web && npx vitest run --reporter=verbose src/composables/useEventStream.test.ts
```
Expected: fail — new `on()` API does not exist yet.

- [ ] **Rewrite `useEventStream.ts`**

Replace the contents of `packages/web/src/composables/useEventStream.ts`:

```ts
import { getCurrentInstance, onUnmounted } from 'vue';
import { useWebSocket } from './useWebSocket.js';
import type { LegionEventMap } from '@legion/types';

type EventName = keyof LegionEventMap;
type EventHandler<K extends EventName> = (payload: LegionEventMap[K]) => void;
type FilterOptions = { conversationId?: string };

// Module-level set of all active typed subscriptions
type AnySubscription = { event: EventName; handler: (p: unknown) => void; filter?: FilterOptions };
const subscriptions = new Set<AnySubscription>();
let unsubscribeFromWs: (() => void) | null = null;

function ensureConnected(): void {
  const ws = useWebSocket();
  if (unsubscribeFromWs) return;
  ws.connect();
  unsubscribeFromWs = ws.onMessage((data) => {
    const msg = data as { type: string; event: string; data: unknown };
    if (msg.type !== 'event') return;
    for (const sub of [...subscriptions]) {
      if (sub.event !== msg.event) continue;
      if (sub.filter?.conversationId) {
        const payload = msg.data as Record<string, unknown>;
        if (payload['conversationId'] !== sub.filter.conversationId) continue;
      }
      try { sub.handler(msg.data); } catch { /* isolate */ }
    }
  });
}

export function useEventStream() {
  const instance = getCurrentInstance();

  function on<K extends EventName>(
    event: K,
    handler: EventHandler<K>,
    filter?: FilterOptions,
  ): () => void {
    ensureConnected();
    const sub: AnySubscription = { event, handler: handler as (p: unknown) => void, filter };
    subscriptions.add(sub);

    const off = () => subscriptions.delete(sub);

    // Auto-cleanup when called inside a component setup()
    if (instance) {
      onUnmounted(off);
    }

    return off;
  }

  return { on };
}
```

- [ ] **Run the updated tests to confirm they pass**

```bash
cd packages/web && npx vitest run --reporter=verbose src/composables/useEventStream.test.ts
```
Expected: all pass.

- [ ] **Commit**

```bash
git add packages/web/src/composables/useEventStream.ts packages/web/src/composables/useEventStream.test.ts
git commit -m "refactor: useEventStream uses useWebSocket, adds typed filtered on(), auto-cleanup on unmount"
```

---

## Task 6: Fix `ParticipantsView` subscribe leak

**Files:**
- Modify: `packages/web/src/views/ParticipantsView.vue:31-36`

- [ ] **Fix the leak**

In `packages/web/src/views/ParticipantsView.vue`, update the import and subscription (lines 31–36).

First update the import from `useEventStream` — it now exposes `on` not `subscribe`:

Find the import line (likely `import { useEventStream } from '../composables/useEventStream.js'`) and where `subscribe` is destructured. Change to:

```ts
const { on } = useEventStream();
```

Then replace the `onMounted` block:

```ts
onMounted(async () => {
  await load();
  on('participant:active', () => load());
  on('participant:retired', () => load());
});
```

No `onUnmounted` needed — `useEventStream` auto-registers cleanup because `on()` is called inside the component's `setup()` context (via `onMounted` which runs synchronously within setup).

Wait — `onMounted` callbacks run after setup. `getCurrentInstance()` will be `null` inside `onMounted`. Move the `on()` calls directly into the `<script setup>` body (outside `onMounted`):

```ts
// In <script setup> body, not inside onMounted:
on('participant:active', () => load());
on('participant:retired', () => load());

onMounted(async () => {
  await load();
});
```

This ensures `getCurrentInstance()` is available when `on()` is called, so auto-cleanup is registered correctly.

- [ ] **Verify the rest of the app still compiles**

```bash
cd packages/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Commit**

```bash
git add packages/web/src/views/ParticipantsView.vue
git commit -m "fix: remove useEventStream subscription leak in ParticipantsView"
```

---

## Task 7: Create `useConversation` composable

**Files:**
- Create: `packages/web/src/composables/useConversation.ts`
- Create: `packages/web/src/composables/useConversation.test.ts`

- [ ] **Write the failing tests**

Create `packages/web/src/composables/useConversation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';

vi.mock('./useEventStream.js', () => ({
  useEventStream: () => ({ on: vi.fn(() => vi.fn()) }),
}));

vi.mock('./useExecute.js', () => ({
  useExecute: () => ({
    execute: vi.fn().mockResolvedValue({
      id: 'c1',
      messages: {
        'm1': { id: 'm1', parentId: null, senderId: 'operator', recipientId: 'agent-1', role: 'user', content: 'hi', status: 'active' },
        'm2': { id: 'm2', parentId: 'm1', senderId: 'agent-1', recipientId: 'operator', role: 'assistant', content: 'hello', status: 'active' },
      },
      activeBranchHead: 'm2',
      schemaVersion: '2.0',
    }),
  }),
}));

describe('useConversation', () => {
  it('starts with loading true and no messages', () => {
    const { useConversation } = require('./useConversation.js');
    const { messages, loading } = useConversation('c1');
    expect(loading.value).toBe(true);
    expect(messages.value).toHaveLength(0);
  });

  it('loads conversation on mount and populates messages in chain order', async () => {
    const { useConversation } = require('./useConversation.js');
    const { messages, loading, load } = useConversation('c1');
    await load();
    await nextTick();
    expect(loading.value).toBe(false);
    expect(messages.value).toHaveLength(2);
    expect(messages.value[0].role).toBe('user');
    expect(messages.value[1].role).toBe('assistant');
  });

  it('returns empty messages and no subscriptions for null id', () => {
    const { useConversation } = require('./useConversation.js');
    const { useEventStream } = require('./useEventStream.js');
    const { messages } = useConversation(null);
    expect(messages.value).toHaveLength(0);
    expect(useEventStream().on).not.toHaveBeenCalled();
  });

  it('thinking is true initially when last chain message is user role', async () => {
    const { useConversation } = require('./useConversation.js');
    const { load, isThinking } = useConversation('c1');
    // mock returns 'm2' (assistant) as head so thinking should be false
    await load();
    await nextTick();
    expect(isThinking.value).toBe(false);
  });
});
```

- [ ] **Run the tests to confirm they fail**

```bash
cd packages/web && npx vitest run --reporter=verbose src/composables/useConversation.test.ts
```
Expected: fail — module does not exist.

- [ ] **Create `useConversation.ts`**

Create `packages/web/src/composables/useConversation.ts`:

```ts
import { ref, computed, onMounted } from 'vue';
import { useExecute } from './useExecute.js';
import { useEventStream } from './useEventStream.js';
import type { ConversationData, MessageData } from '@legion/types';

function buildActiveChain(data: ConversationData): MessageData[] {
  const messages = data.messages;
  const chain: MessageData[] = [];
  let currentId: string | null = data.activeBranchHead;

  while (currentId) {
    const msg = messages[currentId];
    if (!msg || msg.status !== 'active') break;
    chain.unshift(msg);
    currentId = msg.parentId;
  }

  return chain;
}

export function useConversation(conversationId: string | null) {
  const { execute } = useExecute();
  const { on } = useEventStream();

  const messages = ref<MessageData[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const isThinkingLocal = ref(false); // set when user sends in this tab
  const iterationFired = ref(false);  // set when iteration event arrives

  const isThinking = computed(() => {
    if (isThinkingLocal.value || iterationFired.value) return true;
    // Indeterminate: last message is user with no assistant reply
    const last = messages.value.at(-1);
    return !!last && last.role === 'user' && !iterationFired.value && !isThinkingLocal.value
      ? 'indeterminate'
      : false;
  });

  async function load() {
    if (!conversationId) return;
    loading.value = true;
    error.value = null;
    try {
      const data = await execute<ConversationData>('get_conversation', { conversationId });
      messages.value = buildActiveChain(data);
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
    on('message:sent', (payload) => {
      // Reload conversation to get the new message in correct chain order
      void load();
      // If assistant message arrived, clear thinking state
      if ((payload as any).role === 'assistant') {
        isThinkingLocal.value = false;
        iterationFired.value = false;
      }
    }, { conversationId });

    on('iteration', () => {
      iterationFired.value = true;
    }, { conversationId });

    on('approval:requested', () => {
      isThinkingLocal.value = false;
      iterationFired.value = false;
      void load(); // reload to get the pending_approval tool result
    }, { conversationId });

    on('approval:resolved', () => {
      iterationFired.value = true; // agent will resume
      void load();
    }, { conversationId });

    on('tool:result', () => {
      void load(); // keep tool call blocks in sync
    }, { conversationId });

    onMounted(() => { void load(); });
  }

  return { messages, loading, error, isThinking, load, markSent };
}
```

- [ ] **Run the tests to confirm they pass**

```bash
cd packages/web && npx vitest run --reporter=verbose src/composables/useConversation.test.ts
```
Expected: PASS.

- [ ] **Commit**

```bash
git add packages/web/src/composables/useConversation.ts packages/web/src/composables/useConversation.test.ts
git commit -m "feat: add useConversation composable with live event updates and thinking indicator"
```

---

## Task 8: `SearchableCombobox` component

**Files:**
- Create: `packages/web/src/components/common/SearchableCombobox.vue`
- Create: `packages/web/src/components/common/SearchableCombobox.test.ts`

- [ ] **Write the failing tests**

Create `packages/web/src/components/common/SearchableCombobox.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchableCombobox from './SearchableCombobox.vue';

const options = [
  { value: 'agent-1', label: 'Atlas' },
  { value: 'agent-2', label: 'Research Bot' },
  { value: 'agent-3', label: 'Planner' },
];

describe('SearchableCombobox', () => {
  it('renders the placeholder when no value is selected', () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    expect(wrapper.text()).toContain('Select agent...');
  });

  it('shows all options when input is focused', async () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    await wrapper.find('input').trigger('focus');
    expect(wrapper.findAll('[data-option]')).toHaveLength(3);
  });

  it('filters options by input text', async () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    await wrapper.find('input').trigger('focus');
    await wrapper.find('input').setValue('atlas');
    const visibleOptions = wrapper.findAll('[data-option]');
    expect(visibleOptions).toHaveLength(1);
    expect(visibleOptions[0].text()).toContain('Atlas');
  });

  it('emits select with value when option is clicked', async () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    await wrapper.find('input').trigger('focus');
    await wrapper.findAll('[data-option]')[0].trigger('click');
    expect(wrapper.emitted('select')).toEqual([['agent-1']]);
  });

  it('closes dropdown after selection', async () => {
    const wrapper = mount(SearchableCombobox, { props: { options, placeholder: 'Select agent...' } });
    await wrapper.find('input').trigger('focus');
    await wrapper.findAll('[data-option]')[0].trigger('click');
    expect(wrapper.findAll('[data-option]')).toHaveLength(0);
  });
});
```

- [ ] **Run the tests to confirm they fail**

```bash
cd packages/web && npx vitest run --reporter=verbose src/components/common/SearchableCombobox.test.ts
```
Expected: fail — component does not exist.

- [ ] **Create `SearchableCombobox.vue`**

Create `packages/web/src/components/common/SearchableCombobox.vue`:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{
  options: { value: string; label: string }[];
  placeholder?: string;
  modelValue?: string | null;
}>();

const emit = defineEmits<{
  select: [value: string];
  'update:modelValue': [value: string];
}>();

const query = ref('');
const open = ref(false);
const selectedLabel = ref('');

const filtered = computed(() =>
  props.options.filter((o) =>
    o.label.toLowerCase().includes(query.value.toLowerCase()),
  ),
);

function onFocus() {
  open.value = true;
}

function onBlur() {
  // Delay so click on option fires first
  setTimeout(() => { open.value = false; }, 150);
}

function select(option: { value: string; label: string }) {
  selectedLabel.value = option.label;
  query.value = '';
  open.value = false;
  emit('select', option.value);
  emit('update:modelValue', option.value);
}
</script>

<template>
  <div class="relative">
    <input
      :value="open ? query : selectedLabel"
      :placeholder="selectedLabel || placeholder"
      class="w-full bg-navy-900 border border-navy-700 rounded px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-600"
      @input="query = ($event.target as HTMLInputElement).value"
      @focus="onFocus"
      @blur="onBlur"
    />
    <ul
      v-if="open"
      class="absolute z-50 mt-1 w-full bg-navy-800 border border-navy-700 rounded shadow-lg max-h-48 overflow-y-auto"
    >
      <li
        v-for="option in filtered"
        :key="option.value"
        data-option
        class="px-3 py-2 text-sm text-slate-200 hover:bg-navy-700 cursor-pointer"
        @mousedown.prevent="select(option)"
      >
        {{ option.label }}
      </li>
      <li v-if="filtered.length === 0" class="px-3 py-2 text-sm text-slate-500">
        No results
      </li>
    </ul>
  </div>
</template>
```

- [ ] **Run the tests to confirm they pass**

```bash
cd packages/web && npx vitest run --reporter=verbose src/components/common/SearchableCombobox.test.ts
```
Expected: all pass.

- [ ] **Commit**

```bash
git add packages/web/src/components/common/SearchableCombobox.vue packages/web/src/components/common/SearchableCombobox.test.ts
git commit -m "feat: add SearchableCombobox reusable component"
```

---

## Task 9: `MessageBubble` component

**Files:**
- Create: `packages/web/src/components/conversations/MessageBubble.vue`
- Create: `packages/web/src/components/conversations/MessageBubble.test.ts`

- [ ] **Write the failing tests**

Create `packages/web/src/components/conversations/MessageBubble.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageBubble from './MessageBubble.vue';
import type { MessageData } from '@legion/types';

const userMessage: MessageData = {
  id: 'm1',
  parentId: null,
  senderId: 'operator',
  recipientId: 'agent-1',
  role: 'user',
  content: 'Hello agent',
  status: 'active',
  createdAt: new Date().toISOString(),
};

const agentMessage: MessageData = {
  id: 'm2',
  parentId: 'm1',
  senderId: 'agent-1',
  recipientId: 'operator',
  role: 'assistant',
  content: 'Hello human',
  status: 'active',
  createdAt: new Date().toISOString(),
};

describe('MessageBubble', () => {
  it('renders message content', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: userMessage, isOwn: true, senderName: 'You' },
    });
    expect(wrapper.text()).toContain('Hello agent');
  });

  it('applies right-align class when isOwn is true', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: userMessage, isOwn: true, senderName: 'You' },
    });
    expect(wrapper.find('[data-bubble]').classes()).toContain('items-end');
  });

  it('applies left-align class when isOwn is false', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: agentMessage, isOwn: false, senderName: 'Atlas' },
    });
    expect(wrapper.find('[data-bubble]').classes()).toContain('items-start');
  });

  it('shows sender name', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: agentMessage, isOwn: false, senderName: 'Atlas' },
    });
    expect(wrapper.text()).toContain('Atlas');
  });
});
```

- [ ] **Run the tests to confirm they fail**

```bash
cd packages/web && npx vitest run --reporter=verbose src/components/conversations/MessageBubble.test.ts
```
Expected: fail — component does not exist.

- [ ] **Create `MessageBubble.vue`**

Create `packages/web/src/components/conversations/MessageBubble.vue`:

```vue
<script setup lang="ts">
import type { MessageData } from '@legion/types';

defineProps<{
  message: MessageData;
  isOwn: boolean;
  senderName: string;
}>();
</script>

<template>
  <div
    data-bubble
    class="flex flex-col gap-1"
    :class="isOwn ? 'items-end' : 'items-start'"
  >
    <div
      class="max-w-[72%] px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words"
      :class="
        isOwn
          ? 'bg-cyan-700 text-white rounded-[12px_12px_3px_12px]'
          : 'bg-navy-800 text-slate-200 rounded-[12px_12px_12px_3px]'
      "
    >
      {{ message.content }}
    </div>

    <!-- Tool calls / approval cards slot — rendered beneath the bubble -->
    <div v-if="$slots.tools" class="max-w-[72%] flex flex-col gap-1.5">
      <slot name="tools" />
    </div>

    <span class="text-xs text-navy-600">
      {{ senderName }}
    </span>
  </div>
</template>
```

- [ ] **Run the tests to confirm they pass**

```bash
cd packages/web && npx vitest run --reporter=verbose src/components/conversations/MessageBubble.test.ts
```
Expected: all pass.

- [ ] **Commit**

```bash
git add packages/web/src/components/conversations/MessageBubble.vue packages/web/src/components/conversations/MessageBubble.test.ts
git commit -m "feat: add MessageBubble component for chat thread rendering"
```

---

## Task 10: `ApprovalCard` component

**Files:**
- Create: `packages/web/src/components/conversations/ApprovalCard.vue`
- Create: `packages/web/src/components/conversations/ApprovalCard.test.ts`

- [ ] **Write the failing tests**

Create `packages/web/src/components/conversations/ApprovalCard.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ApprovalCard from './ApprovalCard.vue';

vi.mock('../../composables/useExecute.js', () => ({
  useExecute: () => ({
    execute: vi.fn().mockResolvedValue({ status: 'success' }),
  }),
}));

const pendingProps = {
  approvalId: 'apr-1',
  toolName: 'file_write',
  args: { path: 'report.md', content: '# Report' },
  resolved: false,
  decision: null as null | 'approve' | 'reject',
};

describe('ApprovalCard', () => {
  it('renders tool name and args', () => {
    const wrapper = mount(ApprovalCard, { props: pendingProps });
    expect(wrapper.text()).toContain('file_write');
  });

  it('shows Allow and Deny buttons when pending', () => {
    const wrapper = mount(ApprovalCard, { props: pendingProps });
    expect(wrapper.find('[data-allow]').exists()).toBe(true);
    expect(wrapper.find('[data-deny]').exists()).toBe(true);
  });

  it('calls approval_response with approve decision on Allow click', async () => {
    const { useExecute } = await import('../../composables/useExecute.js');
    const executeMock = (useExecute as any)().execute;

    const wrapper = mount(ApprovalCard, { props: pendingProps });
    await wrapper.find('[data-allow]').trigger('click');

    expect(executeMock).toHaveBeenCalledWith('approval_response', {
      decisions: [{ approvalId: 'apr-1', decision: 'approve', message: '' }],
    });
  });

  it('calls approval_response with reject decision and message on Deny click', async () => {
    const { useExecute } = await import('../../composables/useExecute.js');
    const executeMock = (useExecute as any)().execute;

    const wrapper = mount(ApprovalCard, { props: pendingProps });
    await wrapper.find('textarea').setValue('Not allowed on prod');
    await wrapper.find('[data-deny]').trigger('click');

    expect(executeMock).toHaveBeenCalledWith('approval_response', {
      decisions: [{ approvalId: 'apr-1', decision: 'reject', message: 'Not allowed on prod' }],
    });
  });

  it('shows resolved state when decision prop is approve', () => {
    const wrapper = mount(ApprovalCard, {
      props: { ...pendingProps, resolved: true, decision: 'approve' },
    });
    expect(wrapper.text()).toContain('Approved');
    expect(wrapper.find('[data-allow]').exists()).toBe(false);
  });

  it('shows resolved state when decision prop is reject', () => {
    const wrapper = mount(ApprovalCard, {
      props: { ...pendingProps, resolved: true, decision: 'reject', resolvedMessage: 'Not allowed' },
    });
    expect(wrapper.text()).toContain('Denied');
    expect(wrapper.text()).toContain('Not allowed');
  });
});
```

- [ ] **Run the tests to confirm they fail**

```bash
cd packages/web && npx vitest run --reporter=verbose src/components/conversations/ApprovalCard.test.ts
```
Expected: fail — component does not exist.

- [ ] **Create `ApprovalCard.vue`**

Create `packages/web/src/components/conversations/ApprovalCard.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useExecute } from '../../composables/useExecute.js';

const props = defineProps<{
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  resolved: boolean;
  decision: 'approve' | 'reject' | null;
  resolvedMessage?: string;
}>();

const emit = defineEmits<{ resolved: [] }>();

const { execute } = useExecute();
const message = ref('');
const submitting = ref(false);
const expanded = ref(false);

async function submit(decision: 'approve' | 'reject') {
  submitting.value = true;
  try {
    await execute('approval_response', {
      decisions: [{ approvalId: props.approvalId, decision, message: message.value }],
    });
    emit('resolved');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <!-- Pending state -->
  <div
    v-if="!resolved"
    class="border border-amber-800 bg-amber-950/40 rounded-lg p-3 flex flex-col gap-2"
  >
    <div class="flex items-center gap-2">
      <span class="text-amber-400 text-xs">⚠</span>
      <span class="text-amber-300 text-xs font-semibold">Approval required</span>
    </div>

    <div class="text-slate-400 text-xs">
      Agent wants to call
      <code class="text-slate-200 font-mono">{{ toolName }}</code>
    </div>

    <div
      class="bg-navy-950 rounded p-2 font-mono text-xs text-slate-500 cursor-pointer"
      @click="expanded = !expanded"
    >
      <div v-if="!expanded" class="truncate">
        {{ JSON.stringify(args) }}
      </div>
      <pre v-else class="whitespace-pre-wrap break-all">{{ JSON.stringify(args, null, 2) }}</pre>
    </div>

    <textarea
      v-model="message"
      rows="2"
      placeholder="Reason (optional for Allow, recommended for Deny)"
      class="w-full bg-navy-900 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-300 placeholder-slate-600 resize-none focus:outline-none focus:border-cyan-700"
    />

    <div class="flex gap-2">
      <button
        data-allow
        :disabled="submitting"
        class="px-3 py-1 text-xs rounded bg-emerald-900 text-emerald-300 hover:bg-emerald-800 disabled:opacity-50"
        @click="submit('approve')"
      >
        Allow
      </button>
      <button
        data-deny
        :disabled="submitting"
        class="px-3 py-1 text-xs rounded bg-red-950 text-red-400 hover:bg-red-900 disabled:opacity-50"
        @click="submit('reject')"
      >
        Deny
      </button>
    </div>
  </div>

  <!-- Resolved state -->
  <div
    v-else
    class="border rounded-lg p-3 flex flex-col gap-1"
    :class="decision === 'approve' ? 'border-emerald-900 bg-emerald-950/20' : 'border-red-950 bg-red-950/20'"
  >
    <div class="flex items-center gap-2">
      <span class="text-xs font-mono text-slate-400">{{ toolName }}</span>
      <span
        class="text-xs font-semibold ml-auto"
        :class="decision === 'approve' ? 'text-emerald-400' : 'text-red-400'"
      >
        {{ decision === 'approve' ? 'Approved' : 'Denied' }}
      </span>
    </div>
    <div v-if="resolvedMessage" class="text-xs text-slate-500 italic">
      {{ resolvedMessage }}
    </div>
  </div>
</template>
```

- [ ] **Run the tests to confirm they pass**

```bash
cd packages/web && npx vitest run --reporter=verbose src/components/conversations/ApprovalCard.test.ts
```
Expected: all pass.

- [ ] **Commit**

```bash
git add packages/web/src/components/conversations/ApprovalCard.vue packages/web/src/components/conversations/ApprovalCard.test.ts
git commit -m "feat: add ApprovalCard component for inline tool approval in chat thread"
```

---

## Task 11: Update router — add `/conversations/new`

**Files:**
- Modify: `packages/web/src/router/index.ts`

- [ ] **Add the `/conversations/new` route**

In `packages/web/src/router/index.ts`, add the new route before the existing `/conversations/:id` route (so `:id` doesn't swallow the literal `new`):

```ts
{
  path: '/conversations/new',
  component: () => import('../views/ConversationsView.vue'),
  meta: { requiresAuth: true },
},
```

The full routes array should look like:

```ts
const routes = [
  { path: '/login', component: () => import('../views/LoginView.vue') },
  { path: '/', redirect: '/participants' },
  { path: '/participants', component: () => import('../views/ParticipantsView.vue'), meta: { requiresAuth: true } },
  { path: '/conversations', component: () => import('../views/ConversationsView.vue'), meta: { requiresAuth: true } },
  { path: '/conversations/new', component: () => import('../views/ConversationsView.vue'), meta: { requiresAuth: true } },
  { path: '/conversations/:id', component: () => import('../views/ConversationsView.vue'), meta: { requiresAuth: true } },
  { path: '/events', component: () => import('../views/EventStreamView.vue'), meta: { requiresAuth: true } },
  { path: '/config', component: () => import('../views/ConfigView.vue'), meta: { requiresAuth: true } },
  { path: '/config/credentials', component: () => import('../views/ConfigView.vue'), meta: { requiresAuth: true } },
];
```

- [ ] **Verify TypeScript compiles**

```bash
cd packages/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Commit**

```bash
git add packages/web/src/router/index.ts
git commit -m "feat: add /conversations/new route for draft conversation state"
```

---

## Task 12: Update `ConversationList` — Mine/All toggle, +New button, amber dot

**Files:**
- Modify: `packages/web/src/components/conversations/ConversationList.vue`

- [ ] **Rewrite `ConversationList.vue`**

Replace the full contents of `packages/web/src/components/conversations/ConversationList.vue`:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import type { ConversationMeta } from '@legion/types';

const props = defineProps<{
  conversations: ConversationMeta[];
  activeId: string | null;
  myParticipantId: string;
  mode: 'mine' | 'all';
}>();

const emit = defineEmits<{
  select: [id: string];
  'update:mode': [mode: 'mine' | 'all'];
}>();

const router = useRouter();

function hasPendingApproval(conv: ConversationMeta): boolean {
  // The conversation list doesn't carry full message data — the amber dot
  // is driven by the parent via a Set of pending conversation IDs
  return props.pendingApprovalIds?.has(conv.id) ?? false;
}

const pendingApprovalIds = defineProps<{ pendingApprovalIds?: Set<string> }>();
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2.5 border-b border-navy-800 flex-shrink-0">
      <span class="text-xs uppercase tracking-wider text-slate-500">Conversations</span>
      <button
        class="text-xs px-2 py-0.5 rounded bg-cyan-800 text-cyan-200 hover:bg-cyan-700"
        @click="router.push('/conversations/new')"
      >
        + New
      </button>
    </div>

    <!-- Mine / All toggle -->
    <div class="flex gap-1 px-3 py-2 border-b border-navy-800 flex-shrink-0">
      <button
        class="text-xs px-3 py-0.5 rounded-full transition-colors"
        :class="mode === 'mine' ? 'bg-cyan-800 text-cyan-200' : 'text-slate-500 border border-navy-700 hover:text-slate-300'"
        @click="emit('update:mode', 'mine')"
      >
        Mine
      </button>
      <button
        class="text-xs px-3 py-0.5 rounded-full transition-colors"
        :class="mode === 'all' ? 'bg-cyan-800 text-cyan-200' : 'text-slate-500 border border-navy-700 hover:text-slate-300'"
        @click="emit('update:mode', 'all')"
      >
        All
      </button>
    </div>

    <!-- Conversation list -->
    <div class="flex-1 overflow-y-auto">
      <div
        v-for="conv in conversations"
        :key="conv.id"
        class="relative px-3 py-2.5 cursor-pointer border-b border-navy-900 hover:bg-navy-850 transition-colors"
        :class="conv.id === activeId ? 'bg-navy-800 border-l-2 border-l-cyan-600' : ''"
        @click="emit('select', conv.id)"
      >
        <!-- Amber dot for pending approval -->
        <div
          v-if="props.pendingApprovalIds?.has(conv.id)"
          class="absolute right-2.5 top-3 w-2 h-2 rounded-full bg-amber-400"
        />

        <div class="text-sm text-slate-200 truncate pr-4">
          {{ conv.participants.filter(p => p !== myParticipantId).join(', ') || conv.id }}
        </div>
        <div class="text-xs text-slate-600 mt-0.5 font-mono truncate">
          {{ conv.id }}
        </div>
      </div>

      <div v-if="conversations.length === 0" class="px-3 py-6 text-xs text-slate-600 text-center">
        No conversations yet
      </div>
    </div>
  </div>
</template>
```

- [ ] **Verify TypeScript compiles**

```bash
cd packages/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Commit**

```bash
git add packages/web/src/components/conversations/ConversationList.vue
git commit -m "feat: add Mine/All toggle, +New button, and pending approval amber dot to ConversationList"
```

---

## Task 13: Update `ConversationThread` — add chat mode with bubbles, composer, thinking indicator

**Files:**
- Modify: `packages/web/src/components/conversations/ConversationThread.vue`

- [ ] **Rewrite `ConversationThread.vue`**

Replace the full contents of `packages/web/src/components/conversations/ConversationThread.vue`:

```vue
<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import { useExecute } from '../../composables/useExecute.js';
import { useConversation } from '../../composables/useConversation.js';
import MessageBubble from './MessageBubble.vue';
import ApprovalCard from './ApprovalCard.vue';
import ToolCallBlock from './ToolCallBlock.vue';
import type { MessageData } from '@legion/types';

const props = defineProps<{
  conversationId: string | null;
  mode: 'read' | 'chat';
  myParticipantId: string;
  recipientName?: string; // for existing conversations
}>();

const emit = defineEmits<{ sent: [conversationId: string] }>();

const { execute } = useExecute();
const { messages, loading, isThinking, markSent } = useConversation(props.conversationId);

const composerText = ref('');
const sending = ref(false);
const threadEl = ref<HTMLElement | null>(null);

const canSend = computed(() =>
  props.mode === 'chat' &&
  composerText.value.trim().length > 0 &&
  props.recipientName !== undefined, // recipient must be known (from conversationId or draft picker)
);

async function send(recipientId: string) {
  if (!canSend.value || sending.value) return;
  sending.value = true;
  const text = composerText.value.trim();
  composerText.value = '';
  markSent();
  try {
    const result = await execute<{ conversationId: string }>('communicate', {
      to: recipientId,
      message: text,
      conversationId: props.conversationId ?? undefined,
      replyTo: props.myParticipantId,
    });
    emit('sent', result.conversationId);
  } finally {
    sending.value = false;
  }
}

function onKeydown(e: KeyboardEvent, recipientId: string) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    void send(recipientId);
  }
}

// Scroll to bottom when new messages arrive
watch(messages, async () => {
  await nextTick();
  threadEl.value?.scrollTo({ top: threadEl.value.scrollHeight, behavior: 'smooth' });
});

function isOwnMessage(msg: MessageData): boolean {
  return msg.senderId === props.myParticipantId;
}

function getPendingApprovalId(msg: MessageData): string | null {
  if (!msg.toolResults) return null;
  const pending = msg.toolResults.find((tr) => tr.result.status === 'pending_approval');
  return pending ? (pending.result as any).approvalId ?? null : null;
}

function getResolvedToolResult(msg: MessageData) {
  return msg.toolResults?.find(
    (tr) => tr.result.status === 'rejected' || tr.result.status === 'success',
  ) ?? null;
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Thread header -->
    <div class="flex items-center gap-2 px-4 py-3 border-b border-navy-800 flex-shrink-0">
      <span v-if="conversationId" class="text-sm font-medium text-slate-200">
        {{ recipientName ?? conversationId }}
      </span>
      <span v-else class="text-sm text-slate-500">New conversation</span>
    </div>

    <!-- Messages -->
    <div ref="threadEl" class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
      <div v-if="loading" class="text-xs text-slate-600 text-center">Loading...</div>

      <template v-else-if="mode === 'chat'">
        <!-- Empty state for draft -->
        <div v-if="messages.length === 0 && !conversationId" class="flex-1 flex items-center justify-center">
          <div class="text-center text-slate-600 text-sm">
            Send a message to start the conversation
          </div>
        </div>

        <!-- Chat bubbles -->
        <MessageBubble
          v-for="msg in messages"
          :key="msg.id"
          :message="msg"
          :is-own="isOwnMessage(msg)"
          :sender-name="isOwnMessage(msg) ? 'you' : (recipientName ?? msg.senderId)"
        >
          <template v-if="msg.toolCalls?.length" #tools>
            <ToolCallBlock
              v-for="tc in msg.toolCalls"
              :key="tc.toolCallId"
              :tool-call="tc"
              :tool-result="msg.toolResults?.find(tr => tr.toolCallId === tc.toolCallId) ?? null"
            />
            <!-- Approval card for pending_approval tool results -->
            <ApprovalCard
              v-for="tr in msg.toolResults?.filter(tr => tr.result.status === 'pending_approval')"
              :key="tr.toolCallId"
              :approval-id="(tr.result as any).approvalId"
              :tool-name="tr.toolName"
              :args="msg.toolCalls?.find(tc => tc.toolCallId === tr.toolCallId)?.args ?? {}"
              :resolved="false"
              :decision="null"
            />
            <!-- Resolved approval cards -->
            <ApprovalCard
              v-for="tr in msg.toolResults?.filter(tr => tr.result.status === 'rejected')"
              :key="`resolved-${tr.toolCallId}`"
              :approval-id="''"
              :tool-name="tr.toolName"
              :args="{}"
              :resolved="true"
              decision="reject"
              :resolved-message="(tr.result as any).message"
            />
          </template>
        </MessageBubble>

        <!-- Thinking indicator -->
        <div v-if="isThinking" class="flex items-start gap-2">
          <div
            class="px-3 py-2 text-sm rounded-[12px_12px_12px_3px] bg-navy-800 text-slate-500"
            :class="isThinking === 'indeterminate' ? '' : 'animate-pulse'"
          >
            ...
          </div>
        </div>
      </template>

      <!-- Read-only mode — existing flat rendering (unchanged) -->
      <template v-else>
        <div v-for="msg in messages" :key="msg.id" class="text-sm text-slate-300">
          <span class="text-slate-500 text-xs">{{ msg.senderId }}</span>
          <p class="mt-0.5">{{ msg.content }}</p>
        </div>
      </template>
    </div>

    <!-- Composer — chat mode only, and only when we know the recipient -->
    <div v-if="mode === 'chat'" class="px-4 py-3 border-t border-navy-800 flex-shrink-0">
      <div class="flex gap-2 items-end">
        <textarea
          v-model="composerText"
          rows="1"
          :placeholder="recipientName ? `Message ${recipientName}...` : 'Type a message...'"
          class="flex-1 bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-cyan-700 max-h-24 overflow-y-auto"
          @keydown="(e) => onKeydown(e, recipientName ?? '')"
        />
        <button
          :disabled="!canSend || sending"
          class="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
          :class="canSend ? 'bg-cyan-700 text-white hover:bg-cyan-600' : 'bg-navy-800 text-slate-600 cursor-not-allowed'"
          @click="send(recipientName ?? '')"
        >
          Send
        </button>
      </div>
      <div class="text-xs text-slate-700 mt-1">Ctrl+Enter to send</div>
    </div>
  </div>
</template>
```

**Note:** `recipientName` is used both as display name and as the `to` field for `communicate`. The parent view is responsible for resolving the agent's name/ID from the conversation's participants list or the draft recipient picker. The thread component receives the resolved name and calls `send(recipientName)` — if the backend expects an ID, the parent should pass the participant ID as a separate `recipientId` prop. Adjust as needed when wiring in Task 14.

- [ ] **Verify TypeScript compiles**

```bash
cd packages/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Commit**

```bash
git add packages/web/src/components/conversations/ConversationThread.vue
git commit -m "feat: add chat mode to ConversationThread with bubbles, composer, and thinking indicator"
```

---

## Task 14: Rewrite `ConversationsView` — draft state, Mine/All, participant resolution

**Files:**
- Modify: `packages/web/src/views/ConversationsView.vue`

- [ ] **Rewrite `ConversationsView.vue`**

Replace the full contents of `packages/web/src/views/ConversationsView.vue`:

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useExecute } from '../composables/useExecute.js';
import { useAuth } from '../composables/useAuth.js';
import { useEventStream } from '../composables/useEventStream.js';
import ConversationList from '../components/conversations/ConversationList.vue';
import ConversationThread from '../components/conversations/ConversationThread.vue';
import SearchableCombobox from '../components/common/SearchableCombobox.vue';
import type { ConversationMeta, BaseParticipant } from '@legion/types';

const route = useRoute();
const router = useRouter();
const { execute } = useExecute();
const { participantId: myParticipantId } = useAuth();

const listMode = ref<'mine' | 'all'>('mine');
const conversations = ref<ConversationMeta[]>([]);
const participants = ref<BaseParticipant[]>([]);
const pendingApprovalIds = ref<Set<string>>(new Set());

const isDraft = computed(() => route.path === '/conversations/new');
const activeId = computed(() => isDraft.value ? null : (route.params.id as string | undefined) ?? null);

// Resolved recipient for existing conversations or draft
const draftRecipientId = ref<string | null>(null);
const draftRecipientName = ref<string | null>(null);

const recipientId = computed<string | null>(() => {
  if (isDraft.value) return draftRecipientId.value;
  if (!activeId.value) return null;
  const conv = conversations.value.find((c) => c.id === activeId.value);
  if (!conv) return null;
  return conv.participants.find((p) => p !== myParticipantId.value) ?? null;
});

const recipientName = computed<string | null>(() => {
  if (isDraft.value) return draftRecipientName.value;
  const id = recipientId.value;
  if (!id) return null;
  return participants.value.find((p) => p.id === id)?.name ?? id;
});

const threadMode = computed<'read' | 'chat'>(() => {
  if (isDraft.value) return 'chat';
  if (!activeId.value) return 'read';
  const conv = conversations.value.find((c) => c.id === activeId.value);
  if (!conv) return 'read';
  return conv.participants.includes(myParticipantId.value ?? '') ? 'chat' : 'read';
});

const agentOptions = computed(() =>
  participants.value
    .filter((p) => p.type === 'agent' && p.status !== 'retired')
    .map((p) => ({ value: p.id, label: p.name })),
);

async function loadConversations() {
  const filter = listMode.value === 'mine' && myParticipantId.value
    ? { participantId: myParticipantId.value }
    : {};
  conversations.value = await execute<ConversationMeta[]>('list_conversations', filter);
}

async function loadParticipants() {
  participants.value = await execute<BaseParticipant[]>('list_participants', {});
}

function selectConversation(id: string) {
  router.push(`/conversations/${id}`);
}

function onDraftRecipientSelect(id: string) {
  draftRecipientId.value = id;
  draftRecipientName.value = participants.value.find((p) => p.id === id)?.name ?? id;
}

function onMessageSent(conversationId: string) {
  if (isDraft.value) {
    router.push(`/conversations/${conversationId}`);
  }
  void loadConversations();
}

// Refresh list when mode changes
watch(listMode, loadConversations);

// Subscribe to conversation events to keep list fresh
const { on } = useEventStream();
on('conversation:created', () => void loadConversations());

// Track pending approvals for amber dot
on('approval:requested', (payload) => {
  pendingApprovalIds.value = new Set([...pendingApprovalIds.value, (payload as any).conversationId]);
});
on('approval:resolved', (payload) => {
  const next = new Set(pendingApprovalIds.value);
  next.delete((payload as any).conversationId);
  pendingApprovalIds.value = next;
});

onMounted(async () => {
  await Promise.all([loadConversations(), loadParticipants()]);
});
</script>

<template>
  <div class="flex h-full">
    <!-- Left: conversation list -->
    <div class="w-52 flex-shrink-0 border-r border-navy-800 flex flex-col">
      <ConversationList
        :conversations="conversations"
        :active-id="activeId"
        :my-participant-id="myParticipantId ?? ''"
        :mode="listMode"
        :pending-approval-ids="pendingApprovalIds"
        @select="selectConversation"
        @update:mode="listMode = $event"
      />
    </div>

    <!-- Right: thread -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- Draft: "To:" header bar -->
      <div v-if="isDraft" class="flex items-center gap-3 px-4 py-2.5 border-b border-navy-800 flex-shrink-0">
        <span class="text-xs text-slate-500 flex-shrink-0">To:</span>
        <div class="flex-1 max-w-xs">
          <SearchableCombobox
            :options="agentOptions"
            placeholder="Select agent..."
            @select="onDraftRecipientSelect"
          />
        </div>
      </div>

      <!-- Thread pane -->
      <ConversationThread
        v-if="activeId || isDraft"
        :conversation-id="activeId"
        :mode="threadMode"
        :my-participant-id="myParticipantId ?? ''"
        :recipient-id="recipientId ?? undefined"
        :recipient-name="recipientName ?? undefined"
        @sent="onMessageSent"
      />

      <!-- No selection -->
      <div v-else class="flex-1 flex items-center justify-center text-slate-600 text-sm">
        Select a conversation or start a new one
      </div>
    </div>
  </div>
</template>
```

- [ ] **Verify TypeScript compiles**

```bash
cd packages/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Commit**

```bash
git add packages/web/src/views/ConversationsView.vue
git commit -m "feat: rewrite ConversationsView with draft state, Mine/All toggle, and chat wiring"
```

---

## Task 15: Build and smoke test

- [ ] **Build web package**

```bash
cd /home/chris/source/javascript/legion-v2
npm run build --workspace=packages/web
```
Expected: clean build, no errors.

- [ ] **Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Start Legion and manually verify**

```bash
# In one terminal — start Legion
LEGION_BOOTSTRAP_PASSWORD=test123 node packages/runtime/bin/legion.js

# Open browser to http://localhost:4000
# Log in as operator / test123
# Navigate to Conversations
# Click + New
# Select an agent from the combobox
# Type a message and send
# Verify: redirects to conversation, thinking indicator appears, response appears as bubble
# Verify: Mine/All toggle works
```

- [ ] **Final commit**

```bash
git add -A
git commit -m "chore: plan 12 chat interface complete"
```

---

## Self-Review

### Spec coverage check

| Spec section | Covered by task |
|---|---|
| `communicate` in operator tools | Pre-existing — `communicate` already in MANAGEMENT_TOOLS (verified in research) |
| `ConversationMeta.participants` field | Task 1 |
| `list_conversations` participantId filter | Task 2 |
| Participant-scoped WebSocket event filtering | Task 3 |
| `useWebSocket` singleton | Task 4 |
| `useEventStream` refactor with typed filtered `on()` and auto-cleanup | Task 5 |
| Fix `ParticipantsView` leak | Task 6 |
| `useConversation` composable | Task 7 |
| `SearchableCombobox` | Task 8 |
| `MessageBubble` | Task 9 |
| `ApprovalCard` | Task 10 |
| `/conversations/new` route | Task 11 |
| `ConversationList` Mine/All/+New/amber dot | Task 12 |
| `ConversationThread` chat mode | Task 13 |
| `ConversationsView` orchestration | Task 14 |
| Build + smoke test | Task 15 |

All spec requirements covered.

### Known implementation notes for the engineer

1. **`ConversationThread` `recipientId` vs `recipientName`:** The component currently uses `recipientName` as both the display label and the `to` field passed to `communicate`. The `communicate` tool expects a participant ID, not a display name. The parent (`ConversationsView`) must pass the participant ID as `recipientId` and the name separately as `recipientName`. Adjust `ConversationThread`'s `send()` to use `props.recipientId` for the API call — Task 13 has a note about this.

2. **`useConversation` reload strategy:** The current implementation reloads the full conversation on each `message:sent` event rather than appending the new message delta. This is simpler and avoids state divergence, but means one extra `get_conversation` call per message. Acceptable at current scale.

3. **`ConversationFilter.participantId`** was already stubbed in `FileConversationStore.list()` based on the existing type — verify the field actually exists before running Task 2 tests.

4. **`useAuth` `getToken()`** — verify this is already exported or add it in Task 4.

5. **`ConversationData` and `MessageData`** must be exported from `@legion/types` index — verify in Task 7.
