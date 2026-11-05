import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useApprovals } from './useApprovals.js';

describe('useApprovals', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
    useApprovals().__setPendingForTests([]);
  });

  it('refresh() loads pending approvals from the tool', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            result: {
              status: 'success',
              data: [
                {
                  approvalId: 'a1',
                  conversationId: 'c1',
                  requesterId: 'agent-a',
                  tool: 'file_write',
                  args: {},
                  createdAt: '2026-10-08T00:00:00Z',
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const store = useApprovals();
    await store.refresh();
    expect(store.pendingCount.value).toBe(1);
    expect(store.oldest.value?.conversationId).toBe('c1');
    expect(store.pendingByConversation.value.get('c1')).toBe(1);
  });

  it('approval:requested event appends; approval:resolved removes', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const store = useApprovals();
    store.ingest('approval:requested', {
      approvalId: 'a2',
      conversationId: 'c2',
      participantId: 'x',
      tool: 'shell',
    });
    expect(store.pendingCount.value).toBe(1);
    store.ingest('approval:resolved', {
      approvalId: 'a2',
      conversationId: 'c2',
      approved: true,
      decidedByParticipantId: 'op',
    });
    expect(store.pendingCount.value).toBe(0);
  });

  it('ingest appends a requested approval and refreshes args', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            status: 'success',
            data: [
              {
                approvalId: 'a1',
                conversationId: 'c1',
                requesterId: 'agent-a',
                tool: 'file_write',
                args: { path: '/tmp/x' },
                createdAt: '2026-10-08T00:00:00Z',
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = useApprovals();
    store.ingest('approval:requested', {
      approvalId: 'a1',
      conversationId: 'c1',
      participantId: 'agent-a',
      tool: 'file_write',
    });
    await vi.waitFor(() => expect(store.pending.value[0]?.args).toEqual({ path: '/tmp/x' }));
  });

  it('reset clears pending approvals', () => {
    const store = useApprovals();
    store.__setPendingForTests([{ conversationId: 'c1' }]);
    expect(store.pendingCount.value).toBe(1);
    store.reset();
    expect(store.pending.value).toHaveLength(0);
  });

  it('discards a refresh that resolves after reset', async () => {
    let resolveResponse!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
      ),
    );
    const store = useApprovals();
    const pending = store.refresh();
    store.reset();
    resolveResponse(
      new Response(
        JSON.stringify({
          result: {
            status: 'success',
            data: [
              {
                approvalId: 'a1',
                conversationId: 'c1',
                requesterId: 'agent-a',
                tool: 'file_write',
                args: {},
                createdAt: '2026-10-08T00:00:00Z',
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    await pending;
    expect(store.pending.value).toHaveLength(0);
  });
});
