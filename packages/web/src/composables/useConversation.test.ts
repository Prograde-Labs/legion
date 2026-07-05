import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';

vi.mock('./useEventStream.js', () => ({
  useEventStream: vi.fn(() => ({ on: vi.fn(() => vi.fn()) })),
}));

vi.mock('./useExecute.js', () => ({
  useExecute: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue({
      id: 'c1',
      messages: [
        {
          id: 'm1',
          parentId: null,
          conversationId: 'c1',
          senderId: 'operator',
          recipientId: 'agent-1',
          role: 'user',
          content: 'hi',
          status: 'active',
          timestamp: '2026-01-01T00:00:00Z',
        },
        {
          id: 'm2',
          parentId: 'm1',
          conversationId: 'c1',
          senderId: 'agent-1',
          recipientId: 'operator',
          role: 'assistant',
          content: 'hello',
          status: 'active',
          timestamp: '2026-01-01T00:00:01Z',
        },
      ],
      subThreads: {},
    }),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useConversation', () => {
  it('starts with loading true and no messages', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { messages, loading } = useConversation('c1');
    expect(loading.value).toBe(true);
    expect(messages.value).toHaveLength(0);
  });

  it('loads conversation on mount and populates messages in chain order', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { messages, loading, load } = useConversation('c1');
    await load();
    await nextTick();
    expect(loading.value).toBe(false);
    expect(messages.value).toHaveLength(2);
    expect(messages.value[0].role).toBe('user');
    expect(messages.value[1].role).toBe('assistant');
  });

  it('returns empty messages and no subscriptions for null id', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { useEventStream } = await import('./useEventStream.js');
    const { messages } = useConversation(null);
    expect(messages.value).toHaveLength(0);
    expect(useEventStream().on).not.toHaveBeenCalled();
  });

  it('thinking is false when last chain message is assistant', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { load, isThinking } = useConversation('c1');
    // mock returns 'm2' (assistant) as head so thinking should be false
    await load();
    await nextTick();
    expect(isThinking.value).toBe(false);
  });
});
