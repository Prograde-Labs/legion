# Conversations & Message Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the branching conversation model — keyed message maps, active-chain reconstruction, edit/prune/compaction operations, and a `ConversationStore` with a file backend.

**Architecture:** Conversations are persistent threads stored as one JSON file each (`.legion/conversations/<id>.json`). Messages are a keyed map; order is recovered by walking `parentId` links from `activeBranchHead` to the root. Pure functions in `conversation-ops.ts` operate on `ConversationData` immutably-in-spirit (mutate a working copy, return it); the `ConversationStore` persists. A `ConversationThread` wrapper gives runtimes a convenient handle. Depends on Plan 1 (`@legion/core` types, `Storage`, `FileStorage`, ids, errors).

**Tech Stack:** `@legion/core`, Node fs (via `FileStorage`), Vitest.

---

## File Structure

```
packages/core/src/conversation/
  conversation-ops.ts          — pure functions: getActiveChain, createMessage, edit, prune, compact, validate
  conversation-ops.test.ts
  ConversationStore.ts         — interface
  FileConversationStore.ts     — file-backed impl over FileStorage
  FileConversationStore.test.ts
  ConversationThread.ts        — convenience wrapper handed to runtimes
  ConversationThread.test.ts
```

All exported from `packages/core/src/index.ts`.

---

## Task 1: getActiveChain + createConversation/createMessage

**Files:**
- Create: `packages/core/src/conversation/conversation-ops.ts`
- Test: `packages/core/src/conversation/conversation-ops.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import {
  createConversation,
  appendMessage,
  getActiveChain,
} from './conversation-ops.js';

describe('conversation-ops: creation and active chain', () => {
  it('createConversation seeds an empty thread with no head', () => {
    const conv = createConversation();
    expect(conv.id).toMatch(/^conv-\d+-[a-z0-9]{5}$/);
    expect(conv.schemaVersion).toBe('2.0');
    expect(conv.activeBranchHead).toBe('');
    expect(conv.messages).toEqual({});
  });

  it('appendMessage links to the current head and advances it', () => {
    let conv = createConversation();
    conv = appendMessage(conv, {
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hello',
    });
    const rootId = conv.activeBranchHead;
    expect(conv.messages[rootId].parentId).toBeNull();

    conv = appendMessage(conv, {
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'hi back',
    });
    const headId = conv.activeBranchHead;
    expect(conv.messages[headId].parentId).toBe(rootId);
  });

  it('getActiveChain returns messages root-first', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    conv = appendMessage(conv, { senderId: 'a', recipientId: 'u', role: 'assistant', content: 'two' });
    const chain = getActiveChain(conv);
    expect(chain.map((m) => m.content)).toEqual(['one', 'two']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts`
Expected: FAIL — `Cannot find module './conversation-ops.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { ConversationData, MessageData } from '@legion/types';
import { createConversationId, createId, nowIso } from '../util/ids.js';

export function createConversation(title?: string): ConversationData {
  const now = nowIso();
  return {
    id: createConversationId(),
    schemaVersion: '2.0',
    createdAt: now,
    updatedAt: now,
    title,
    activeBranchHead: '',
    messages: {},
  };
}

export type NewMessageInput = Pick<MessageData, 'senderId' | 'recipientId' | 'role' | 'content'> &
  Partial<
    Pick<MessageData, 'replyTo' | 'type' | 'toolCalls' | 'toolResults' | 'parentId' | 'id'>
  >;

export function createMessage(
  conversationId: string,
  parentId: string | null,
  input: NewMessageInput,
): MessageData {
  return {
    id: input.id ?? createId('msg'),
    parentId,
    conversationId,
    senderId: input.senderId,
    recipientId: input.recipientId,
    replyTo: input.replyTo,
    role: input.role,
    content: input.content,
    type: input.type ?? 'message',
    status: 'active',
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
    timestamp: nowIso(),
  };
}

export function appendMessage(
  conversation: ConversationData,
  input: NewMessageInput,
): ConversationData {
  const parentId = conversation.activeBranchHead || null;
  const message = createMessage(conversation.id, parentId, input);
  return {
    ...conversation,
    updatedAt: nowIso(),
    activeBranchHead: message.id,
    messages: { ...conversation.messages, [message.id]: message },
  };
}

export function getActiveChain(conversation: ConversationData): MessageData[] {
  const chain: MessageData[] = [];
  if (!conversation.activeBranchHead) return chain;
  let current: MessageData | undefined = conversation.messages[conversation.activeBranchHead];
  while (current) {
    chain.unshift(current);
    current = current.parentId ? conversation.messages[current.parentId] : undefined;
  }
  return chain;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conversation/conversation-ops.ts packages/core/src/conversation/conversation-ops.test.ts
git commit -m "feat(core): add conversation creation and active-chain reconstruction"
```

---

## Task 2: Edit + re-run operation

**Files:**
- Modify: `packages/core/src/conversation/conversation-ops.ts`
- Test: `packages/core/src/conversation/conversation-ops.test.ts` (add cases)

- [ ] **Step 1: Add the failing test** (append inside the file, new `describe`)

```typescript
import { editMessage } from './conversation-ops.js';

describe('conversation-ops: edit + re-run', () => {
  it('supersedes the original and links the edit to the same parent', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'orig' });
    const originalId = conv.activeBranchHead;

    conv = editMessage(conv, originalId, 'edited');
    const editId = conv.activeBranchHead;

    expect(conv.messages[originalId].status).toBe('superseded');
    expect(conv.messages[originalId].supersededBy).toBe(editId);
    expect(conv.messages[editId].editOf).toBe(originalId);
    expect(conv.messages[editId].parentId).toBe(conv.messages[originalId].parentId);
    expect(conv.messages[editId].content).toBe('edited');
  });

  it('excludes the superseded node from the active chain', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'orig' });
    const originalId = conv.activeBranchHead;
    conv = editMessage(conv, originalId, 'edited');
    const chain = getActiveChain(conv);
    expect(chain.map((m) => m.content)).toEqual(['edited']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts -t "edit"`
Expected: FAIL — `editMessage` is not exported.

- [ ] **Step 3: Implement `editMessage`** (append to `conversation-ops.ts`)

```typescript
import { ConversationNotFoundError } from '../errors/LegionError.js';

function requireMessage(conversation: ConversationData, messageId: string): MessageData {
  const message = conversation.messages[messageId];
  if (!message) {
    throw new ConversationNotFoundError(`${conversation.id}#${messageId}`);
  }
  return message;
}

export function editMessage(
  conversation: ConversationData,
  messageId: string,
  newContent: string,
): ConversationData {
  const original = requireMessage(conversation, messageId);
  const edit = createMessage(conversation.id, original.parentId, {
    senderId: original.senderId,
    recipientId: original.recipientId,
    role: original.role,
    content: newContent,
  });
  edit.editOf = original.id;

  const messages: Record<string, MessageData> = {
    ...conversation.messages,
    [original.id]: { ...original, status: 'superseded', supersededBy: edit.id },
    [edit.id]: edit,
  };

  return {
    ...conversation,
    updatedAt: nowIso(),
    activeBranchHead: edit.id,
    messages,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts -t "edit"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conversation/conversation-ops.ts packages/core/src/conversation/conversation-ops.test.ts
git commit -m "feat(core): add edit + re-run conversation operation"
```

---

## Task 3: Manual prune operation

**Files:**
- Modify: `packages/core/src/conversation/conversation-ops.ts`
- Test: `packages/core/src/conversation/conversation-ops.test.ts` (add cases)

- [ ] **Step 1: Add the failing test**

```typescript
import { pruneMessage } from './conversation-ops.js';

describe('conversation-ops: prune', () => {
  it('marks the node pruned and rolls head back when pruning the head', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    const firstId = conv.activeBranchHead;
    conv = appendMessage(conv, { senderId: 'a', recipientId: 'u', role: 'assistant', content: 'two' });
    const headId = conv.activeBranchHead;

    conv = pruneMessage(conv, headId, 'operator-1');

    expect(conv.messages[headId].status).toBe('pruned');
    expect(conv.messages[headId].prunedBy).toBe('operator-1');
    expect(conv.messages[headId].prunedAt).toBeDefined();
    expect(conv.activeBranchHead).toBe(firstId);
    expect(getActiveChain(conv).map((m) => m.content)).toEqual(['one']);
  });

  it('excludes descendants of a pruned middle node from the chain', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    const midId = conv.activeBranchHead;
    conv = appendMessage(conv, { senderId: 'a', recipientId: 'u', role: 'assistant', content: 'two' });
    // Prune the middle node; head stays at 'two' but chain cannot route through pruned parent.
    conv = pruneMessage(conv, midId, 'op');
    expect(getActiveChain(conv).map((m) => m.content)).toEqual([]);
  });
});
```

> Note on the second case: per spec §2, traversal "cannot route through a pruned
> parent". `getActiveChain` must stop (and discard the partial chain) if it reaches a
> non-active node that is not the requested head's valid ancestor. Implement chain
> traversal to treat a pruned node as a dead end.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts -t "prune"`
Expected: FAIL — `pruneMessage` not exported.

- [ ] **Step 3: Implement `pruneMessage` and harden `getActiveChain`**

Add to `conversation-ops.ts`:

```typescript
export function pruneMessage(
  conversation: ConversationData,
  messageId: string,
  prunedBy: string,
): ConversationData {
  const target = requireMessage(conversation, messageId);
  const messages: Record<string, MessageData> = {
    ...conversation.messages,
    [target.id]: {
      ...target,
      status: 'pruned',
      prunedAt: nowIso(),
      prunedBy,
    },
  };

  let head = conversation.activeBranchHead;
  if (head === target.id) {
    head = target.parentId ?? '';
  }

  return {
    ...conversation,
    updatedAt: nowIso(),
    activeBranchHead: head,
    messages,
  };
}
```

Replace the existing `getActiveChain` body so pruned/superseded/compacted ancestors break the chain:

```typescript
export function getActiveChain(conversation: ConversationData): MessageData[] {
  const chain: MessageData[] = [];
  if (!conversation.activeBranchHead) return chain;
  let current: MessageData | undefined = conversation.messages[conversation.activeBranchHead];
  while (current) {
    if (current.status !== 'active') {
      // A non-active node in the line of ancestry invalidates this path.
      return [];
    }
    chain.unshift(current);
    current = current.parentId ? conversation.messages[current.parentId] : undefined;
  }
  return chain;
}
```

> The edit test from Task 2 still passes: after an edit the head points at the *active*
> edit node whose ancestors are all active; the superseded node is never an ancestor of
> the head.

- [ ] **Step 4: Run the full ops test file**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts`
Expected: PASS — all prune + edit + creation tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conversation/conversation-ops.ts packages/core/src/conversation/conversation-ops.test.ts
git commit -m "feat(core): add manual prune and pruned-ancestor chain handling"
```

---

## Task 4: Compaction operation

**Files:**
- Modify: `packages/core/src/conversation/conversation-ops.ts`
- Test: `packages/core/src/conversation/conversation-ops.test.ts` (add cases)

- [ ] **Step 1: Add the failing test**

```typescript
import { compactRange } from './conversation-ops.js';

describe('conversation-ops: compaction', () => {
  it('replaces a contiguous range with a summary node', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'm1' });
    const id1 = conv.activeBranchHead;
    conv = appendMessage(conv, { senderId: 'a', recipientId: 'u', role: 'assistant', content: 'm2' });
    const id2 = conv.activeBranchHead;
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'm3' });
    const id3 = conv.activeBranchHead;

    conv = compactRange(conv, [id1, id2], 'summary of m1+m2');

    // m1 and m2 are compacted
    expect(conv.messages[id1].status).toBe('compacted');
    expect(conv.messages[id2].status).toBe('compacted');

    // a summary node exists with parentId = parent of first compacted (null here)
    const summary = Object.values(conv.messages).find((m) => m.type === 'summary');
    expect(summary).toBeDefined();
    expect(summary!.parentId).toBeNull();
    expect(summary!.compacts).toEqual([id1, id2]);

    // m3 now points at the summary node
    expect(conv.messages[id3].parentId).toBe(summary!.id);

    // active chain is [summary, m3]
    expect(getActiveChain(conv).map((m) => m.content)).toEqual(['summary of m1+m2', 'm3']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts -t "compaction"`
Expected: FAIL — `compactRange` not exported.

- [ ] **Step 3: Implement `compactRange`**

Add to `conversation-ops.ts`:

```typescript
export function compactRange(
  conversation: ConversationData,
  compactedIds: string[],
  summaryContent: string,
): ConversationData {
  if (compactedIds.length === 0) return conversation;
  const first = requireMessage(conversation, compactedIds[0]);
  const last = requireMessage(conversation, compactedIds[compactedIds.length - 1]);

  const summary = createMessage(conversation.id, first.parentId, {
    senderId: first.senderId,
    recipientId: first.recipientId,
    role: 'assistant',
    content: summaryContent,
    type: 'summary',
  });
  summary.compacts = [...compactedIds];

  const messages: Record<string, MessageData> = { ...conversation.messages };
  messages[summary.id] = summary;
  for (const id of compactedIds) {
    messages[id] = { ...messages[id], status: 'compacted' };
  }

  // Re-point the message that followed the last compacted node to the summary.
  for (const message of Object.values(messages)) {
    if (message.parentId === last.id && !compactedIds.includes(message.id)) {
      messages[message.id] = { ...message, parentId: summary.id };
    }
  }

  // If the head itself was the last compacted node, advance head to the summary.
  let head = conversation.activeBranchHead;
  if (head === last.id) head = summary.id;

  return {
    ...conversation,
    updatedAt: nowIso(),
    activeBranchHead: head,
    messages,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts -t "compaction"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conversation/conversation-ops.ts packages/core/src/conversation/conversation-ops.test.ts
git commit -m "feat(core): add compaction operation"
```

---

## Task 5: Invariant validation

**Files:**
- Modify: `packages/core/src/conversation/conversation-ops.ts`
- Test: `packages/core/src/conversation/conversation-ops.test.ts` (add cases)

> Implements the storage invariants from spec §2: single root, valid parent refs,
> head exists, no cycles, compacted-in-exactly-one-summary, superseded-has-ref.

- [ ] **Step 1: Add the failing test**

```typescript
import { validateConversation } from './conversation-ops.js';

describe('conversation-ops: invariants', () => {
  it('passes for a well-formed conversation', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    conv = appendMessage(conv, { senderId: 'a', recipientId: 'u', role: 'assistant', content: 'two' });
    expect(validateConversation(conv)).toEqual([]);
  });

  it('flags a dangling parentId', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    const id = conv.activeBranchHead;
    conv.messages[id] = { ...conv.messages[id], parentId: 'ghost' };
    const errors = validateConversation(conv);
    expect(errors.some((e) => e.includes('ghost'))).toBe(true);
  });

  it('flags a missing activeBranchHead reference', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    conv.activeBranchHead = 'nope';
    expect(validateConversation(conv).some((e) => e.includes('activeBranchHead'))).toBe(true);
  });

  it('flags multiple roots', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    const extra = { ...conv.messages[conv.activeBranchHead], id: 'root2', parentId: null };
    conv.messages['root2'] = extra;
    expect(validateConversation(conv).some((e) => e.includes('root'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts -t "invariants"`
Expected: FAIL — `validateConversation` not exported.

- [ ] **Step 3: Implement `validateConversation`**

Add to `conversation-ops.ts`:

```typescript
export function validateConversation(conversation: ConversationData): string[] {
  const errors: string[] = [];
  const ids = Object.keys(conversation.messages);

  // activeBranchHead must reference an existing key (empty allowed for new threads).
  if (conversation.activeBranchHead && !conversation.messages[conversation.activeBranchHead]) {
    errors.push(`activeBranchHead references missing message: ${conversation.activeBranchHead}`);
  }

  // Exactly one root (parentId null) when there is at least one message.
  const roots = ids.filter((id) => conversation.messages[id].parentId === null);
  if (ids.length > 0 && roots.length !== 1) {
    errors.push(`expected exactly one root message, found ${roots.length}`);
  }

  // Parent references must exist.
  for (const id of ids) {
    const parentId = conversation.messages[id].parentId;
    if (parentId !== null && !conversation.messages[parentId]) {
      errors.push(`message ${id} has dangling parentId: ${parentId}`);
    }
  }

  // No cycles reachable from any message walking up to root.
  for (const id of ids) {
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push(`cycle detected involving message: ${cursor}`);
        break;
      }
      seen.add(cursor);
      cursor = conversation.messages[cursor]?.parentId ?? null;
    }
  }

  // superseded => valid supersededBy reference.
  for (const id of ids) {
    const m = conversation.messages[id];
    if (m.status === 'superseded' && (!m.supersededBy || !conversation.messages[m.supersededBy])) {
      errors.push(`superseded message ${id} has invalid supersededBy`);
    }
  }

  // compacted => appears in exactly one summary's compacts array.
  const summaries = ids.map((id) => conversation.messages[id]).filter((m) => m.type === 'summary');
  for (const id of ids) {
    if (conversation.messages[id].status !== 'compacted') continue;
    const count = summaries.filter((s) => s.compacts?.includes(id)).length;
    if (count !== 1) {
      errors.push(`compacted message ${id} appears in ${count} summary nodes (expected 1)`);
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/conversation/conversation-ops.test.ts -t "invariants"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conversation/conversation-ops.ts packages/core/src/conversation/conversation-ops.test.ts
git commit -m "feat(core): add conversation invariant validation"
```

---

## Task 6: ConversationStore interface + FileConversationStore

**Files:**
- Create: `packages/core/src/conversation/ConversationStore.ts`
- Create: `packages/core/src/conversation/FileConversationStore.ts`
- Test: `packages/core/src/conversation/FileConversationStore.test.ts`

- [ ] **Step 1: Create the interface** (spec §10)

`packages/core/src/conversation/ConversationStore.ts`:

```typescript
import type {
  ConversationData,
  ConversationFilter,
  ConversationMeta,
  MessageData,
} from '@legion/types';

export interface ConversationStore {
  create(
    data: Omit<ConversationData, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ConversationData>;
  load(conversationId: string): Promise<ConversationData | null>;
  save(data: ConversationData): Promise<void>;
  appendMessage(conversationId: string, message: MessageData): Promise<void>;
  updateMessage(
    conversationId: string,
    messageId: string,
    patch: Partial<MessageData>,
  ): Promise<void>;
  updateHead(conversationId: string, newHeadId: string): Promise<void>;
  list(filter?: ConversationFilter): Promise<ConversationMeta[]>;
  exists(conversationId: string): Promise<boolean>;
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/conversation/FileConversationStore.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from './FileConversationStore.js';

describe('FileConversationStore', () => {
  let dir: string;
  let store: FileConversationStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-conv-'));
    store = new FileConversationStore(new FileStorage(dir));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates, persists, and reloads a conversation', async () => {
    const created = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    expect(created.id).toMatch(/^conv-/);
    expect(await store.exists(created.id)).toBe(true);

    const loaded = await store.load(created.id);
    expect(loaded?.id).toBe(created.id);
  });

  it('returns null loading a missing conversation', async () => {
    expect(await store.load('conv-missing')).toBeNull();
  });

  it('appends a message and updates the head', async () => {
    const created = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    await store.appendMessage(created.id, {
      id: 'm1',
      parentId: null,
      conversationId: created.id,
      senderId: 'u',
      recipientId: 'a',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    await store.updateHead(created.id, 'm1');
    const loaded = await store.load(created.id);
    expect(loaded?.messages['m1'].content).toBe('hi');
    expect(loaded?.activeBranchHead).toBe('m1');
  });

  it('patches a message in place', async () => {
    const created = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    await store.appendMessage(created.id, {
      id: 'm1', parentId: null, conversationId: created.id, senderId: 'u', recipientId: 'a',
      role: 'user', content: 'hi', status: 'active', timestamp: new Date().toISOString(),
    });
    await store.updateMessage(created.id, 'm1', { status: 'pruned', prunedBy: 'op' });
    const loaded = await store.load(created.id);
    expect(loaded?.messages['m1'].status).toBe('pruned');
    expect(loaded?.messages['m1'].prunedBy).toBe('op');
  });

  it('lists conversation metadata', async () => {
    const a = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {}, title: 'A' });
    await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {}, title: 'B' });
    const metas = await store.list();
    expect(metas.length).toBe(2);
    expect(metas.find((m) => m.id === a.id)?.title).toBe('A');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/conversation/FileConversationStore.test.ts`
Expected: FAIL — `Cannot find module './FileConversationStore.js'`.

- [ ] **Step 4: Write minimal implementation**

`packages/core/src/conversation/FileConversationStore.ts`:

```typescript
import type { Storage } from '../storage/Storage.js';
import type {
  ConversationData,
  ConversationFilter,
  ConversationMeta,
  MessageData,
} from '@legion/types';
import { ConversationNotFoundError } from '../errors/LegionError.js';
import { createConversationId, nowIso } from '../util/ids.js';
import type { ConversationStore } from './ConversationStore.js';

export class FileConversationStore implements ConversationStore {
  constructor(private storage: Storage) {}

  private key(conversationId: string): string {
    return `conversations/${conversationId}.json`;
  }

  async create(
    data: Omit<ConversationData, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ConversationData> {
    const now = nowIso();
    const conversation: ConversationData = {
      ...data,
      id: createConversationId(),
      createdAt: now,
      updatedAt: now,
    };
    await this.save(conversation);
    return conversation;
  }

  async load(conversationId: string): Promise<ConversationData | null> {
    return this.storage.readJson<ConversationData>(this.key(conversationId));
  }

  async save(data: ConversationData): Promise<void> {
    await this.storage.writeJson(this.key(data.id), { ...data, updatedAt: nowIso() });
  }

  private async loadOrThrow(conversationId: string): Promise<ConversationData> {
    const conversation = await this.load(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);
    return conversation;
  }

  async appendMessage(conversationId: string, message: MessageData): Promise<void> {
    const conversation = await this.loadOrThrow(conversationId);
    conversation.messages[message.id] = message;
    await this.save(conversation);
  }

  async updateMessage(
    conversationId: string,
    messageId: string,
    patch: Partial<MessageData>,
  ): Promise<void> {
    const conversation = await this.loadOrThrow(conversationId);
    const existing = conversation.messages[messageId];
    if (!existing) throw new ConversationNotFoundError(`${conversationId}#${messageId}`);
    conversation.messages[messageId] = { ...existing, ...patch };
    await this.save(conversation);
  }

  async updateHead(conversationId: string, newHeadId: string): Promise<void> {
    const conversation = await this.loadOrThrow(conversationId);
    conversation.activeBranchHead = newHeadId;
    await this.save(conversation);
  }

  async list(filter?: ConversationFilter): Promise<ConversationMeta[]> {
    const files = await this.storage.list('conversations');
    const metas: ConversationMeta[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      const conversation = await this.load(id);
      if (!conversation) continue;
      if (filter?.since && conversation.updatedAt < filter.since) continue;
      if (
        filter?.participantId &&
        !Object.values(conversation.messages).some(
          (m) => m.senderId === filter.participantId || m.recipientId === filter.participantId,
        )
      ) {
        continue;
      }
      metas.push({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: Object.keys(conversation.messages).length,
      });
    }
    return metas;
  }

  async exists(conversationId: string): Promise<boolean> {
    return this.storage.exists(this.key(conversationId));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/conversation/FileConversationStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/conversation/ConversationStore.ts packages/core/src/conversation/FileConversationStore.ts packages/core/src/conversation/FileConversationStore.test.ts
git commit -m "feat(core): add ConversationStore interface and file backend"
```

---

## Task 7: ConversationThread wrapper

**Files:**
- Create: `packages/core/src/conversation/ConversationThread.ts`
- Test: `packages/core/src/conversation/ConversationThread.test.ts`

> `RuntimeContext.conversation` is typed `ConversationThread` (spec §4). It wraps
> `ConversationData` + the store, giving runtimes read access to the active chain and a
> persist-through append. It holds the in-memory snapshot and writes through the store.

- [ ] **Step 1: Write the failing test**

`packages/core/src/conversation/ConversationThread.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from './FileConversationStore.js';
import { ConversationThread } from './ConversationThread.js';

describe('ConversationThread', () => {
  let dir: string;
  let store: FileConversationStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-thread-'));
    store = new FileConversationStore(new FileStorage(dir));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends through to the store and exposes the active chain', async () => {
    const data = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const thread = new ConversationThread(data, store);

    await thread.append({ senderId: 'u', recipientId: 'a', role: 'user', content: 'hello' });
    await thread.append({ senderId: 'a', recipientId: 'u', role: 'assistant', content: 'hi' });

    expect(thread.activeChain.map((m) => m.content)).toEqual(['hello', 'hi']);

    const reloaded = await store.load(data.id);
    expect(reloaded && Object.keys(reloaded.messages).length).toBe(2);
    expect(reloaded?.activeBranchHead).toBe(thread.data.activeBranchHead);
  });

  it('exposes id and the latest message', async () => {
    const data = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const thread = new ConversationThread(data, store);
    expect(thread.id).toBe(data.id);
    const msg = await thread.append({ senderId: 'u', recipientId: 'a', role: 'user', content: 'x' });
    expect(thread.latest?.id).toBe(msg.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/conversation/ConversationThread.test.ts`
Expected: FAIL — `Cannot find module './ConversationThread.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/conversation/ConversationThread.ts`:

```typescript
import type { ConversationData, MessageData } from '@legion/types';
import type { ConversationStore } from './ConversationStore.js';
import { appendMessage, getActiveChain, type NewMessageInput } from './conversation-ops.js';

export class ConversationThread {
  constructor(
    public data: ConversationData,
    private store: ConversationStore,
  ) {}

  get id(): string {
    return this.data.id;
  }

  get activeChain(): MessageData[] {
    return getActiveChain(this.data);
  }

  get latest(): MessageData | undefined {
    return this.data.activeBranchHead
      ? this.data.messages[this.data.activeBranchHead]
      : undefined;
  }

  async append(input: NewMessageInput): Promise<MessageData> {
    this.data = appendMessage(this.data, input);
    const message = this.data.messages[this.data.activeBranchHead];
    await this.store.appendMessage(this.data.id, message);
    await this.store.updateHead(this.data.id, message.id);
    return message;
  }

  async reload(): Promise<void> {
    const fresh = await this.store.load(this.data.id);
    if (fresh) this.data = fresh;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/conversation/ConversationThread.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Export conversation module from the core barrel**

Append to `packages/core/src/index.ts`:

```typescript
export * from './conversation/conversation-ops.js';
export * from './conversation/ConversationStore.js';
export * from './conversation/FileConversationStore.js';
export * from './conversation/ConversationThread.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/conversation/ConversationThread.ts packages/core/src/conversation/ConversationThread.test.ts packages/core/src/index.ts
git commit -m "feat(core): add ConversationThread wrapper"
```

---

## Task 8: Full build + test gate

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — Plan 1 + Plan 2 tests all green.

- [ ] **Step 3: Format check + commit any fixes**

```bash
npm run format
git add -A
git commit -m "chore: format conversation sources" || echo "nothing to format"
```

---

## Self-Review Checklist

- **Spec §2 keyed message map + activeBranchHead:** `ConversationData`/`appendMessage` — Task 1. ✅
- **Spec §2 getActiveChain (active-only, breaks on non-active ancestor):** Tasks 1, 3. ✅
- **Spec §2 edit + re-run:** Task 2. ✅
- **Spec §2 manual prune (head rollback, pruned-ancestor exclusion):** Task 3. ✅
- **Spec §2 compaction (summary node, re-point following message):** Task 4. ✅
- **Spec §2 storage invariants (single root, parent refs, head exists, no cycles, compacted-once, superseded-ref):** Task 5. ✅
- **Spec §10 ConversationStore full interface + FileConversationStore at `.legion/conversations/<id>.json`:** Task 6. ✅
- **Spec §4 ConversationThread type for RuntimeContext:** Task 7. ✅
- **Placeholder scan:** all steps contain full code/commands. ✅
- **Type consistency:** uses `ConversationData`, `MessageData`, `Storage`, `ConversationNotFoundError`, `createConversationId` from Plan 1 verbatim; `ConversationStore`, `ConversationThread`, `NewMessageInput` are consumed by Plan 5. ✅
