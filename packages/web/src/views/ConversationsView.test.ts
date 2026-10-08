import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConversationsView from './ConversationsView.vue';

const execute = vi.fn();
const streamCalls: Array<{
  name: string;
  args: () => Record<string, unknown>;
  start: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}> = [];
vi.mock('../composables/useExecute.js', () => ({ useExecute: () => ({ execute }) }));
vi.mock('../composables/useAuth.js', () => ({
  useAuth: () => ({ participantId: ref('operator') }),
}));
vi.mock('../composables/useWebSocket.js', () => ({
  useWebSocket: () => ({ getConnectionId: () => 'c' }),
}));
vi.mock('../composables/useToolStream.js', () => ({
  useToolStream: (name: string, args: () => Record<string, unknown>) => {
    const start = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockResolvedValue(undefined);
    streamCalls.push({ name, args, start, cancel });
    return { start, cancel };
  },
}));
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/conversations', params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}));

describe('ConversationsView filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamCalls.length = 0;
    execute.mockImplementation((tool: string) =>
      Promise.resolve(tool === 'list_conversations' ? { conversations: [] } : []),
    );
  });

  it('sends identical status and tags to listing and watching', async () => {
    const wrapper = mount(ConversationsView, {
      global: {
        stubs: { ConversationThread: true },
      },
    });
    await flushPromises();
    await wrapper.get('[data-status="archived"]').trigger('click');
    await wrapper.get('[data-tag-filter]').setValue('helper, compaction');
    await wrapper.get('[data-tag-filter]').trigger('change');
    await flushPromises();

    expect(execute).toHaveBeenLastCalledWith('list_conversations', {
      participantId: 'operator',
      status: 'archived',
      tags: ['helper', 'compaction'],
    });
    expect(streamCalls.find((call) => call.name === 'watch_conversations')?.args()).toEqual({
      participantId: 'operator',
      status: 'archived',
      tags: ['helper', 'compaction'],
    });
    const conversationWatch = streamCalls.find((call) => call.name === 'watch_conversations')!;
    expect(conversationWatch.cancel).toHaveBeenCalledTimes(2);
    expect(conversationWatch.start).toHaveBeenCalledTimes(3);
  });

  it('serializes filter restarts so the latest request wins', async () => {
    const staleConv = {
      id: 'stale',
      title: 'Stale list',
      createdAt: '',
      updatedAt: '',
      messageCount: 0,
      participants: ['operator'],
      status: 'archived' as const,
      tags: [],
    };
    const latestConv = { ...staleConv, id: 'latest', title: 'Latest list' };
    const deferreds: Array<(value: { conversations: unknown[] }) => void> = [];
    execute.mockImplementation((tool: string) => {
      if (tool !== 'list_conversations') return Promise.resolve([]);
      return new Promise((resolve) => deferreds.push(resolve));
    });
    const wrapper = mount(ConversationsView, {
      global: {
        stubs: { ConversationThread: true },
      },
    });
    await flushPromises();
    deferreds[0]!({ conversations: [] });
    await flushPromises();

    // Rapid successive filter changes.
    await wrapper.get('[data-status="archived"]').trigger('click');
    await wrapper.get('[data-status="all"]').trigger('click');
    await flushPromises();

    // Serialized: second request not issued until first completes.
    expect(deferreds.length).toBe(2);
    deferreds[1]!({ conversations: [staleConv] });
    await flushPromises();
    expect(deferreds.length).toBe(3);
    deferreds[2]!({ conversations: [latestConv] });
    await flushPromises();

    expect(execute).toHaveBeenLastCalledWith('list_conversations', {
      participantId: 'operator',
      status: 'all',
      tags: [],
    });
    const titles = wrapper.findAll('[data-conversation-title]').map((node) => node.text());
    expect(titles).toEqual(['Latest list']);
  });
});
