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
        stubs: { AppLayout: { template: '<main><slot /></main>' }, ConversationThread: true },
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
});
