import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useApprovals } from './useApprovals.js';

function approval(id: string): Record<string, unknown> {
  return {
    approvalId: id,
    conversationId: 'c1',
    requesterId: 'agent-a',
    tool: 'file_write',
    args: {},
    createdAt: '2026-10-08T00:00:00Z',
  };
}

function responseWith(data: unknown): Response {
  return new Response(JSON.stringify({ result: { status: 'success', data } }), { status: 200 });
}

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

  it('applies the newest refresh even when an older response lands last', async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValueOnce(
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
        )
        .mockReturnValueOnce(
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          }),
        ),
    );
    const store = useApprovals();
    const first = store.refresh();
    const second = store.refresh();

    // Newer request resolves first and wins.
    resolveSecond(responseWith([approval('a2')]));
    await second;
    expect(store.pending.value.map((p) => p.approvalId)).toEqual(['a2']);

    // Older request lands last: it must not overwrite the newer snapshot.
    resolveFirst(responseWith([approval('a1')]));
    await first;
    expect(store.pending.value.map((p) => p.approvalId)).toEqual(['a2']);
  });

  it('ingest dedupes a repeated approval:requested chunk', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const store = useApprovals();
    const chunk = {
      approvalId: 'a1',
      conversationId: 'c1',
      participantId: 'agent-a',
      tool: 'file_write',
    };
    store.ingest('approval:requested', chunk);
    store.ingest('approval:requested', chunk);
    expect(store.pendingCount.value).toBe(1);
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
