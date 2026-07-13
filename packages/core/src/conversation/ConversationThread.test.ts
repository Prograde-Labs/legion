import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from './FileConversationStore.js';
import { ConversationThread, type AppendGuard } from './ConversationThread.js';

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

  it('preserves concurrent appends inside the append guard', async () => {
    const data = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const events: string[] = [];
    const originalMutate = store.mutate.bind(store);
    vi.spyOn(store, 'mutate').mockImplementation(async (conversationId, callback, guard) => {
      events.push('mutate:start');
      const result = await originalMutate(conversationId, callback, guard);
      events.push('mutate:end');
      return result;
    });
    let tail = Promise.resolve();
    const appendGuard: AppendGuard = async (_thread, append) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      events.push('guard:start');
      try {
        return await append();
      } finally {
        events.push('guard:end');
        release();
      }
    };
    const thread = new ConversationThread(data, store, appendGuard);

    await Promise.all([
      thread.append({ senderId: 'u', recipientId: 'a', role: 'user', content: 'first' }),
      thread.append({ senderId: 'a', recipientId: 'u', role: 'assistant', content: 'second' }),
    ]);

    expect(Object.values((await store.load(data.id))?.messages ?? {})).toHaveLength(2);
    expect(events).toEqual([
      'guard:start',
      'mutate:start',
      'mutate:end',
      'guard:end',
      'guard:start',
      'mutate:start',
      'mutate:end',
      'guard:end',
    ]);
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

  it('reactivates an archived conversation in the same mutation that appends', async () => {
    const data = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      status: 'archived',
    });
    const thread = new ConversationThread(data, store);
    const mutate = vi.spyOn(store, 'mutate');

    await thread.append(
      { senderId: 'u', recipientId: 'a', role: 'user', content: 'wake up' },
      { reactivate: true },
    );

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(thread.data.status).toBe('active');
    expect(thread.activeChain.map((message) => message.content)).toEqual(['wake up']);
    expect((await store.load(data.id))?.status).toBe('active');
  });

  it('does not reactivate an archived conversation for middleware state writes', async () => {
    const data = await store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      status: 'archived',
    });
    const thread = new ConversationThread(data, store);

    await thread.updateMiddlewareState('operator', 'instance', { state: 'stored' });

    expect(thread.data.status).toBe('archived');
    expect((await store.load(data.id))?.status).toBe('archived');
  });

  it('preserves fresh conversation data when updating tool results', async () => {
    const data = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    const thread = new ConversationThread(data, store);
    const original = await thread.append({
      senderId: 'u',
      recipientId: 'a',
      role: 'user',
      content: 'first',
    });
    const otherStore = new FileConversationStore(new FileStorage(dir));
    const fresh = await otherStore.load(data.id);
    const otherThread = new ConversationThread(fresh!, otherStore);
    const concurrent = await otherThread.append({
      senderId: 'a',
      recipientId: 'u',
      role: 'assistant',
      content: 'second',
    });

    await thread.updateToolResults(original.id, [
      { id: 'call-1', name: 'tool', result: { status: 'success', data: 'updated' } },
    ]);

    expect(thread.data.activeBranchHead).toBe(concurrent.id);
    expect(thread.data.messages[concurrent.id]?.content).toBe('second');
    expect(thread.data.messages[original.id]?.toolResults).toEqual([
      { id: 'call-1', name: 'tool', result: { status: 'success', data: 'updated' } },
    ]);
  });
});
