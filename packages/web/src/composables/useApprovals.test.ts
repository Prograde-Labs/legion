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
    const store = useApprovals();
    store.__handleEventForTests('approval:requested', {
      approvalId: 'a2',
      conversationId: 'c2',
      participantId: 'x',
      tool: 'shell',
    });
    expect(store.pendingCount.value).toBe(1);
    store.__handleEventForTests('approval:resolved', {
      approvalId: 'a2',
      conversationId: 'c2',
      approved: true,
      decidedByParticipantId: 'op',
    });
    expect(store.pendingCount.value).toBe(0);
  });
});
