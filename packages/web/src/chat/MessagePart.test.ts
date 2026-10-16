import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MessageData } from '@legion-collective/types';
import MessagePart from './MessagePart.vue';
import CompactionNotice from './CompactionNotice.vue';

function mkMsg(overrides: Partial<MessageData> = {}): MessageData {
  return {
    id: 'm1',
    parentId: null,
    conversationId: 'c1',
    senderId: 'user-1',
    recipientId: 'agent-a',
    role: 'user',
    content: 'hi',
    timestamp: '2026-10-13T00:00:00Z',
    status: 'active',
    ...overrides,
  };
}

describe('MessagePart', () => {
  it('renders user messages right-aligned in a user bubble', () => {
    const w = mount(MessagePart, { props: { message: mkMsg({ role: 'user', content: 'hi' }) } });
    expect(w.find('[data-test="msg"]').classes()).toContain('items-end');
    expect(w.find('[data-test="bubble"]').classes()).toContain('bg-bubble-user');
  });

  it('renders assistant messages left-aligned in an assistant bubble', () => {
    const w = mount(MessagePart, {
      props: { message: mkMsg({ role: 'assistant', content: 'hello' }) },
    });
    expect(w.find('[data-test="msg"]').classes()).toContain('items-start');
    expect(w.find('[data-test="bubble"]').classes()).toContain('bg-bubble-assistant');
  });

  it('renders summary messages as CompactionNotice', () => {
    const w = mount(MessagePart, {
      props: { message: mkMsg({ type: 'summary', content: 'compacted 10 messages' }) },
    });
    expect(w.findComponent(CompactionNotice).exists()).toBe(true);
    // Compaction is a full-width system notice, not a role bubble.
    expect(w.find('[data-test="bubble"]').exists()).toBe(false);
    expect(w.text()).toContain('compacted 10 messages');
  });
});
