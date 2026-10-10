import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useConversations } from './useConversations.js';

const CONVS = [
  {
    id: 'c1',
    title: 'First',
    participants: ['operator', 'agent-a'],
    status: 'active',
    updatedAt: '2026-10-08T00:00:00Z',
    tags: [],
  },
  {
    id: 'c2',
    title: 'Second',
    participants: ['agent-a'],
    status: 'archived',
    updatedAt: '2026-10-07T00:00:00Z',
    tags: [],
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
});
