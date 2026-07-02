import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageBubble from './MessageBubble.vue';
import type { MessageData } from '@legion/types';

const userMessage: MessageData = {
  id: 'm1',
  parentId: null,
  conversationId: 'c1',
  senderId: 'operator',
  recipientId: 'agent-1',
  role: 'user',
  content: 'Hello agent',
  status: 'active',
  timestamp: new Date().toISOString(),
};

const agentMessage: MessageData = {
  id: 'm2',
  parentId: 'm1',
  conversationId: 'c1',
  senderId: 'agent-1',
  recipientId: 'operator',
  role: 'assistant',
  content: 'Hello human',
  status: 'active',
  timestamp: new Date().toISOString(),
};

describe('MessageBubble', () => {
  it('renders message content', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: userMessage, isOwn: true, senderName: 'You' },
    });
    expect(wrapper.text()).toContain('Hello agent');
  });

  it('applies right-align class when isOwn is true', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: userMessage, isOwn: true, senderName: 'You' },
    });
    expect(wrapper.find('[data-bubble]').classes()).toContain('items-end');
  });

  it('applies left-align class when isOwn is false', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: agentMessage, isOwn: false, senderName: 'Atlas' },
    });
    expect(wrapper.find('[data-bubble]').classes()).toContain('items-start');
  });

  it('shows sender name', () => {
    const wrapper = mount(MessageBubble, {
      props: { message: agentMessage, isOwn: false, senderName: 'Atlas' },
    });
    expect(wrapper.text()).toContain('Atlas');
  });
});
