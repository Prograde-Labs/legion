import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage } from '../storage/MemoryStorage.js';
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
});
