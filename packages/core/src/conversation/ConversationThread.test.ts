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
    const msg = await thread.append({
      senderId: 'u',
      recipientId: 'a',
      role: 'user',
      content: 'x',
    });
    expect(thread.latest?.id).toBe(msg.id);
  });

  it('preserves concurrent appends', async () => {
    const data = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const thread = new ConversationThread(data, store);

    await Promise.all([
      thread.append({ senderId: 'u', recipientId: 'a', role: 'user', content: 'first' }),
      thread.append({ senderId: 'a', recipientId: 'u', role: 'assistant', content: 'second' }),
    ]);

    expect(Object.values((await store.load(data.id))?.messages ?? {})).toHaveLength(2);
  });

  it('updates only the addressed middleware state namespace and persists it', async () => {
    const data = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      middlewareState: {
        operator: { first: { existing: true }, second: 'keep' },
        agent: { first: 42 },
      },
    });
    const thread = new ConversationThread(data, store);

    await thread.updateMiddlewareState('operator', 'first', { changed: true });

    expect(thread.data.middlewareState).toEqual({
      operator: { first: { changed: true }, second: 'keep' },
      agent: { first: 42 },
    });
    expect((await store.load(data.id))?.middlewareState).toEqual(thread.data.middlewareState);
  });
});
