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

  it('renders assistant reasoning collapsed before answer content', () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: { ...agentMessage, reasoning: 'private analysis' },
        isOwn: true,
        senderName: 'You',
      },
    });

    const reasoning = wrapper.get('[data-reasoning]');
    const answer = wrapper.get('[data-answer]');
    expect(reasoning.element.tagName).toBe('DETAILS');
    expect(reasoning.attributes('open')).toBeUndefined();
    expect(
      reasoning.element.compareDocumentPosition(answer.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('hides whitespace-only reasoning', () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: { ...agentMessage, reasoning: '  \n ' },
        isOwn: false,
        senderName: 'Atlas',
      },
    });

    expect(wrapper.find('[data-reasoning]').exists()).toBe(false);
    expect(wrapper.get('[data-answer]').text()).toContain('Hello human');
  });

  it('renders assistant reasoning when answer content is empty', () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: { ...agentMessage, content: '', reasoning: 'reasoning only' },
        isOwn: false,
        senderName: 'Atlas',
      },
    });

    expect(wrapper.get('[data-reasoning]').text()).toContain('reasoning only');
    expect(wrapper.find('[data-answer]').exists()).toBe(false);
  });

  it('does not render reasoning for user messages', () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: { ...userMessage, reasoning: 'not assistant reasoning' },
        isOwn: true,
        senderName: 'You',
      },
    });

    expect(wrapper.find('[data-reasoning]').exists()).toBe(false);
    expect(wrapper.get('[data-answer]').text()).toContain('Hello agent');
  });

  it('does not render an empty body for blank user content with reasoning', () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: { ...userMessage, content: '  ', reasoning: 'not assistant reasoning' },
        isOwn: true,
        senderName: 'You',
      },
    });
    const body = wrapper
      .findAll('[data-bubble] > div')
      .find((element) => element.classes().includes('leading-relaxed'));

    expect(wrapper.find('[data-reasoning]').exists()).toBe(false);
    expect(wrapper.find('[data-answer]').exists()).toBe(false);
    expect(body).toBeUndefined();
  });

  it('emits edit with save mode from inline editor', async () => {
    const wrapper = mount(MessageBubble, {
      props: { message: userMessage, isOwn: true, senderName: 'You' },
    });

    await wrapper.get('button[data-menu]').trigger('click');
    await wrapper.get('button[data-edit]').trigger('click');
    await wrapper.get('textarea').setValue('Changed text');
    await wrapper.get('button[data-save-only]').trigger('click');

    expect(wrapper.emitted('edit')?.[0]).toEqual(['m1', 'Changed text', false]);
  });

  it('emits prune after confirmation', async () => {
    const wrapper = mount(MessageBubble, {
      props: { message: userMessage, isOwn: true, senderName: 'You' },
    });

    await wrapper.get('button[data-menu]').trigger('click');
    await wrapper.get('button[data-prune]').trigger('click');
    await wrapper.get('button[data-confirm-prune]').trigger('click');

    expect(wrapper.emitted('prune')?.[0]).toEqual(['m1']);
  });

  it('shows branch navigator and emits switchBranch', async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: {
          ...userMessage,
          timestamp: '2026-01-01T00:00:01Z',
          alternates: [
            {
              id: 'old',
              content: 'Old text',
              timestamp: '2026-01-01T00:00:00Z',
              status: 'superseded',
            },
          ],
        },
        isOwn: true,
        senderName: 'You',
      },
    });

    expect(wrapper.text()).toContain('2/2');
    await wrapper.get('button[data-branch-prev]').trigger('click');
    expect(wrapper.emitted('switchBranch')?.[0]).toEqual(['old']);
  });

  it('shows previously-pruned badge when message has prunedAt set', () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: {
          ...userMessage,
          prunedAt: '2026-01-01T00:00:00Z',
          prunedBy: 'operator',
        },
        isOwn: true,
        senderName: 'You',
      },
    });

    expect(wrapper.text()).toContain('previously pruned');
  });

  it('emits regenerate for non-own (agent) message', async () => {
    const wrapper = mount(MessageBubble, {
      props: { message: agentMessage, isOwn: false, senderName: 'Agent' },
    });

    await wrapper.get('button[data-menu]').trigger('click');
    await wrapper.get('button[data-regenerate]').trigger('click');

    expect(wrapper.emitted('regenerate')?.[0]).toEqual(['m2']);
  });
});
