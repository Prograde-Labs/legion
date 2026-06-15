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
});
