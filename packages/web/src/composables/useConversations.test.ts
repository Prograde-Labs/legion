import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { ConversationMeta } from '@legion-collective/types';
import { useConversations } from './useConversations.js';

const CONVS: ConversationMeta[] = [
  {
    id: 'c1',
    title: 'First',
    participants: ['operator', 'agent-a'],
    status: 'active',
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    tags: [],
    messageCount: 2,
  },
  {
    id: 'c2',
    title: 'Second',
    participants: ['agent-a'],
    status: 'archived',
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    tags: [],
    messageCount: 1,
  },
];

describe('useConversations', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
    useConversations().__resetForTests();
  });

  it('loads conversations via list_conversations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { conversations: CONVS } } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const store = useConversations();
    await store.load();
    expect(store.conversations.value.length).toBe(2);
    expect(store.loading.value).toBe(false);
  });

  it('search filter narrows the visible list', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ result: { status: 'success', data: { conversations: CONVS } } }),
            { status: 200 },
          ),
        ),
    );
    const store = useConversations();
    await store.load();
    store.filter.value = { status: 'all', search: 'first' };
    expect(store.conversations.value.map((c) => c.id)).toEqual(['c1']);
  });

  it('select sets activeId on the shared module state', async () => {
    const store = useConversations();
    store.select('c2');
    expect(store.activeId.value).toBe('c2');
    expect(useConversations().activeId.value).toBe('c2');
  });

  it('reset clears conversations, active id and filter', () => {
    const store = useConversations();
    store.__setConversationsForTests(CONVS);
    store.select('c1');
    store.filter.value = { status: 'all', search: 'first' };
    store.reset();
    expect(store.conversations.value).toHaveLength(0);
    expect(store.activeId.value).toBeNull();
    expect(store.filter.value).toEqual({ status: 'active', search: '' });
  });

  it('discards a load that resolves after reset', async () => {
    let resolveResponse!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
      ),
    );
    const store = useConversations();
    const pending = store.load();
    expect(store.loading.value).toBe(true);
    store.reset();
    resolveResponse(
      new Response(
        JSON.stringify({ result: { status: 'success', data: { conversations: CONVS } } }),
        { status: 200 },
      ),
    );
    await pending;
    expect(store.conversations.value).toHaveLength(0);
    expect(store.loading.value).toBe(false);
  });
});
