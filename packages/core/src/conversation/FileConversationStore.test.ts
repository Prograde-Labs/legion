import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { FileStorage } from '../storage/FileStorage.js';
import { EventBus } from '../events/EventBus.js';
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
    const created = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
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

  it('round-trips optional message reasoning', async () => {
    const created = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await store.appendMessage(created.id, {
      id: 'm1',
      parentId: null,
      conversationId: created.id,
      senderId: 'a',
      recipientId: 'u',
      role: 'assistant',
      content: 'answer',
      reasoning: 'analysis',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    expect((await store.load(created.id))?.messages['m1'].reasoning).toBe('analysis');
  });

  it('loads legacy conversations without reasoning', async () => {
    const storage = new MemoryStorage();
    const legacyStore = new FileConversationStore(storage);
    await storage.writeJson('conversations/conv-old.json', {
      id: 'conv-old',
      schemaVersion: '2.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      activeBranchHead: 'm1',
      messages: {
        m1: {
          id: 'm1',
          parentId: null,
          conversationId: 'conv-old',
          senderId: 'u',
          recipientId: 'a',
          role: 'user',
          content: 'legacy',
          status: 'active',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    expect((await legacyStore.load('conv-old'))?.messages['m1'].reasoning).toBeUndefined();
  });

  it('patches a message in place', async () => {
    const created = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
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
    await store.updateMessage(created.id, 'm1', { status: 'pruned', prunedBy: 'op' });
    const loaded = await store.load(created.id);
    expect(loaded?.messages['m1'].status).toBe('pruned');
    expect(loaded?.messages['m1'].prunedBy).toBe('op');
  });

  it('serializes mutations across stores sharing storage', async () => {
    const storage = new MemoryStorage();
    const first = new FileConversationStore(storage);
    const second = new FileConversationStore(storage);
    const conversation = await first.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    await Promise.all([
      first.mutate(conversation.id, (current) => ({
        ...current,
        tags: [...(current.tags ?? []), 'first'],
      })),
      second.mutate(conversation.id, (current) => ({
        ...current,
        tags: [...(current.tags ?? []), 'second'],
      })),
    ]);

    expect((await first.load(conversation.id))?.tags).toEqual(['first', 'second']);
  });

  it('serializes mutations across MemoryStorage scope aliases', async () => {
    const storage = new MemoryStorage();
    const first = new FileConversationStore(storage.scope('workspace'));
    const second = new FileConversationStore(storage.scope('workspace'));
    const conversation = await first.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    await Promise.all([
      first.mutate(conversation.id, (current) => ({
        ...current,
        tags: [...(current.tags ?? []), 'first'],
      })),
      second.mutate(conversation.id, (current) => ({
        ...current,
        tags: [...(current.tags ?? []), 'second'],
      })),
    ]);

    expect((await first.load(conversation.id))?.tags).toEqual(['first', 'second']);
  });

  it('serializes mutations across FileStorage instances sharing a root', async () => {
    const first = new FileConversationStore(new FileStorage(dir));
    const second = new FileConversationStore(new FileStorage(dir));
    const conversation = await first.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    await Promise.all([
      first.mutate(conversation.id, (current) => ({
        ...current,
        tags: [...(current.tags ?? []), 'first'],
      })),
      second.mutate(conversation.id, (current) => ({
        ...current,
        tags: [...(current.tags ?? []), 'second'],
      })),
    ]);

    expect((await first.load(conversation.id))?.tags).toEqual(['first', 'second']);
  });

  it('rejects a stale active branch guard before writing', async () => {
    const conversation = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: 'new-head',
      messages: {},
      title: 'unchanged',
    });

    await expect(
      store.mutate(conversation.id, (current) => ({ ...current, title: 'changed' }), {
        expectedActiveBranchHead: 'old-head',
      }),
    ).rejects.toThrow();
    expect((await store.load(conversation.id))?.title).toBe('unchanged');
  });

  it('rejects origin mutations', async () => {
    const conversation = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      origin: { kind: 'participant', participantId: 'operator' },
    });

    await expect(
      store.mutate(conversation.id, (current) => ({
        ...current,
        origin: { kind: 'participant', participantId: 'other' },
      })),
    ).rejects.toThrow('Conversation origin is immutable');
  });

  it('rejects id mutations without writing another conversation key', async () => {
    const eventBus = new EventBus();
    const invariantStore = new FileConversationStore(new MemoryStorage(), eventBus);
    const updatedEvents: unknown[] = [];
    eventBus.on('conversation:updated', (event) => updatedEvents.push(event));
    const conversation = await invariantStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });

    await expect(
      invariantStore.mutate(conversation.id, (current) => ({ ...current, id: 'conv-other' })),
    ).rejects.toThrow('Conversation id is immutable');
    expect(await invariantStore.exists(conversation.id)).toBe(true);
    expect(await invariantStore.exists('conv-other')).toBe(false);
    expect(updatedEvents).toEqual([]);
  });

  it('emits normalized metadata for creation and metadata updates', async () => {
    const eventBus = new EventBus();
    const eventStore = new FileConversationStore(new MemoryStorage(), eventBus);
    const createdEvents: unknown[] = [];
    const updatedEvents: unknown[] = [];
    eventBus.on('conversation:created', (event) => createdEvents.push(event));
    eventBus.on('conversation:updated', (event) => updatedEvents.push(event));

    const conversation = await eventStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      title: 'Original',
    });
    await eventStore.mutate(conversation.id, (current) => ({
      ...current,
      title: 'Updated',
      tags: ['important'],
    }));
    const beforeNoop = await eventStore.load(conversation.id);
    const noop = await eventStore.mutate(conversation.id, (current) => current);

    expect(createdEvents).toEqual([
      {
        conversation: expect.objectContaining({
          id: conversation.id,
          title: 'Original',
          status: 'active',
          tags: [],
          participants: [],
        }),
      },
    ]);
    expect(updatedEvents).toEqual([
      {
        conversationId: conversation.id,
        before: expect.objectContaining({ title: 'Original', status: 'active', tags: [] }),
        after: expect.objectContaining({ title: 'Updated', status: 'active', tags: ['important'] }),
      },
    ]);
    expect(noop.changed).toBe(false);
    expect((await eventStore.load(conversation.id))?.updatedAt).toBe(beforeNoop?.updatedAt);
  });

  it('lists conversation metadata', async () => {
    const a = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      title: 'A',
    });
    await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {}, title: 'B' });
    const metas = await store.list();
    expect(metas.length).toBe(2);
    expect(metas.find((m) => m.id === a.id)?.title).toBe('A');
  });

  it('normalizes legacy conversation metadata when listing', async () => {
    const storage = new MemoryStorage();
    const legacyStore = new FileConversationStore(storage);
    await storage.writeJson('conversations/conv-legacy.json', {
      id: 'conv-legacy',
      schemaVersion: '2.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Legacy',
      activeBranchHead: '',
      messages: {},
    });

    expect(await legacyStore.list()).toEqual([
      expect.objectContaining({
        title: 'Legacy',
        sharedTitle: 'Legacy',
        status: 'active',
        tags: [],
      }),
    ]);
  });

  it('lists active conversations by default and supports status and every-tag filters', async () => {
    const active = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      tags: ['one', 'two'],
    });
    const archived = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      status: 'archived',
      tags: ['one'],
    });

    expect((await store.list()).map(({ id }) => id)).toEqual([active.id]);
    expect((await store.list({ status: 'archived' })).map(({ id }) => id)).toEqual([archived.id]);
    expect((await store.list({ status: 'all' })).map(({ id }) => id).sort()).toEqual(
      [active.id, archived.id].sort(),
    );
    expect((await store.list({ tags: ['one', 'two'] })).map(({ id }) => id)).toEqual([active.id]);
  });

  it('list() includes participants from both senderId and recipientId', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const conv = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await store.appendMessage(conv.id, {
      id: 'm1',
      parentId: null,
      conversationId: conv.id,
      senderId: 'agent-1',
      recipientId: 'operator',
      role: 'user',
      content: 'hello',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    const list = await store.list();
    expect(list[0].participants).toContain('agent-1');
    expect(list[0].participants).toContain('operator');
  });

  it('create persists parentConversationId and parentToolCallId', async () => {
    const parent = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const conv = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: parent.id,
      parentToolCallId: 'tc-1',
    });
    expect(conv.parentConversationId).toBe(parent.id);
    expect(conv.parentToolCallId).toBe('tc-1');

    const loaded = await store.load(conv.id);
    expect(loaded?.parentConversationId).toBe(parent.id);
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
    expect(ids).toHaveLength(1);
  });

  it('delete removes a childless conversation', async () => {
    const created = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    expect(await store.exists(created.id)).toBe(true);
    await store.delete(created.id);
    expect(await store.exists(created.id)).toBe(false);
    expect(await store.load(created.id)).toBeNull();
  });

  it('delete cascades to direct children', async () => {
    const parent = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const child = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: parent.id,
      parentToolCallId: 'tc-a',
    });
    await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    await store.delete(parent.id);
    expect(await store.exists(parent.id)).toBe(false);
    expect(await store.exists(child.id)).toBe(false);
    const remaining = await store.list({ includeSubThreads: true });
    expect(remaining.map((m) => m.id)).not.toContain(parent.id);
    expect(remaining.map((m) => m.id)).not.toContain(child.id);
  });

  it('delete cascades recursively to grandchildren', async () => {
    const root = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const child = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: root.id,
      parentToolCallId: 'tc-1',
    });
    const grandchild = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: child.id,
      parentToolCallId: 'tc-2',
    });
    await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    await store.delete(root.id);
    expect(await store.exists(root.id)).toBe(false);
    expect(await store.exists(child.id)).toBe(false);
    expect(await store.exists(grandchild.id)).toBe(false);
  });

  it('delete is idempotent when the id does not exist', async () => {
    await expect(store.delete('conv-missing')).resolves.toBeUndefined();
  });

  it('delete leaves unrelated conversations intact', async () => {
    const a = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const b = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    await store.delete(a.id);
    expect(await store.exists(b.id)).toBe(true);
  });

  it('does not leave an orphan when child creation races parent deletion', async () => {
    const storage = new MemoryStorage();
    const raceStore = new FileConversationStore(storage);
    const parent = await raceStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const originalDelete = storage.delete.bind(storage);
    let deletionReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      deletionReached = resolve;
    });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    storage.delete = async (key) => {
      if (key === `conversations/${parent.id}.json`) {
        deletionReached();
        await deleteGate;
      }
      await originalDelete(key);
    };

    const deletion = raceStore.delete(parent.id);
    await reached;
    const childCreation = raceStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: parent.id,
      parentToolCallId: 'tc-race',
    });
    await Promise.resolve();
    releaseDelete();
    const [childResult, deletionResult] = await Promise.allSettled([childCreation, deletion]);

    expect(deletionResult.status).toBe('fulfilled');
    expect(childResult.status).toBe('rejected');
    expect(await raceStore.exists(parent.id)).toBe(false);
    expect(await raceStore.listByParent(parent.id)).toEqual([]);
  });
});
