import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConversationThread from './ConversationThread.vue';

const streamState = vi.hoisted(() => ({
  text: '',
  reasoning: '',
  thinking: false,
  streaming: false,
  cancelling: false,
  send: vi.fn(),
  error: null as string | null,
  stop: vi.fn(),
}));

vi.mock('../../composables/useExecute.js', () => ({
  useExecute: () => ({ execute: vi.fn() }),
}));

vi.mock('../../composables/useConversation.js', () => ({
  useConversation: () => ({
    messages: ref([
      {
        id: 'm1',
        parentId: null,
        conversationId: 'c1',
        senderId: 'agent-1',
        recipientId: 'viewer',
        role: 'assistant',
        content: 'visible answer',
        reasoning: 'visible reasoning',
        status: 'active',
        timestamp: '2026-01-01T00:00:00Z',
      },
      {
        id: 'm2',
        parentId: 'm1',
        conversationId: 'c1',
        senderId: 'agent-1',
        recipientId: 'viewer',
        role: 'assistant',
        content: '  ',
        reasoning: 'reasoning only',
        status: 'active',
        timestamp: '2026-01-01T00:00:01Z',
      },
      {
        id: 'm3',
        parentId: 'm2',
        conversationId: 'c1',
        senderId: 'blank-sender',
        recipientId: 'viewer',
        role: 'user',
        content: '  ',
        status: 'active',
        timestamp: '2026-01-01T00:00:02Z',
      },
    ]),
    subThreads: ref({}),
    loading: ref(false),
    error: ref(streamState.error),
    isThinking: ref(streamState.thinking),
    isStreaming: ref(streamState.streaming),
    isCancelling: ref(streamState.cancelling),
    streamingText: ref(streamState.text),
    streamingReasoning: ref(streamState.reasoning),
    sentConversationId: ref(null),
    markSent: vi.fn(),
    send: streamState.send,
    stop: streamState.stop,
    editMessage: vi.fn(),
    generate: vi.fn(),
    pruneMessage: vi.fn(),
    compactConversation: vi.fn(),
    switchBranch: vi.fn(),
  }),
}));

describe('ConversationThread', () => {
  beforeEach(() => {
    streamState.text = '';
    streamState.reasoning = '';
    streamState.thinking = false;
    streamState.streaming = false;
    streamState.cancelling = false;
    streamState.stop.mockClear();
    streamState.send.mockReset();
    streamState.error = null;
  });

  it('shows persisted assistant reasoning to authorized read-only viewers', () => {
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'read',
        myParticipantId: 'viewer',
      },
    });

    const details = wrapper.get('details[data-reasoning]');
    const bubble = details.element.parentElement;
    expect(details.attributes('open')).toBeUndefined();
    expect(details.text()).toContain('visible reasoning');
    expect(wrapper.text()).toContain('visible answer');
    expect([...(bubble?.classList ?? [])]).toEqual(
      expect.arrayContaining(['mt-0.5', 'max-w-[80%]', 'rounded', 'bg-navy-800', 'px-3', 'py-2']),
    );
  });

  it('shows read-only reasoning without an empty answer paragraph', () => {
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'read',
        myParticipantId: 'viewer',
      },
    });

    expect(wrapper.findAll('details[data-reasoning]')).toHaveLength(2);
    expect(wrapper.findAll('p').some((paragraph) => paragraph.text().trim() === '')).toBe(false);
  });

  it('does not render a read-only body bubble for a blank message without reasoning', () => {
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'read',
        myParticipantId: 'viewer',
      },
    });

    expect(wrapper.text()).toContain('blank-sender');
    expect(wrapper.findAll('[data-read-only-body]')).toHaveLength(2);
  });

  it('shows live reasoning without an answer or thinking indicator', () => {
    streamState.reasoning = 'live thought';
    streamState.thinking = true;
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'chat',
        myParticipantId: 'viewer',
        recipientName: 'Atlas',
      },
    });

    const liveMessage = wrapper.get('[data-streaming-message]');
    const reasoning = liveMessage.get('[data-streaming-reasoning]');
    expect(reasoning.element.tagName).toBe('DIV');
    expect(reasoning.text()).toContain('live thought');
    expect(liveMessage.find('details').exists()).toBe(false);
    expect(liveMessage.find('[data-streaming-answer]').exists()).toBe(false);
    expect(wrapper.find('.flex.items-start.gap-2').exists()).toBe(false);
  });

  it('shows a stop button instead of send while streaming', () => {
    streamState.streaming = true;
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'chat',
        myParticipantId: 'viewer',
        recipientName: 'Atlas',
      },
    });

    expect(wrapper.find('[data-stop-button]').exists()).toBe(true);
    expect(wrapper.find('[data-send-button]').exists()).toBe(false);
  });

  it('calls stop when the stop button is clicked', async () => {
    streamState.streaming = true;
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'chat',
        myParticipantId: 'viewer',
        recipientName: 'Atlas',
      },
    });

    await wrapper.get('[data-stop-button]').trigger('click');

    expect(streamState.stop).toHaveBeenCalledTimes(1);
  });

  it('shows send button when not streaming', () => {
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'chat',
        myParticipantId: 'viewer',
        recipientName: 'Atlas',
      },
    });

    expect(wrapper.find('[data-send-button]').exists()).toBe(true);
    expect(wrapper.find('[data-stop-button]').exists()).toBe(false);
  });

  it('keeps stop visible and send hidden while cancellation settles', () => {
    streamState.cancelling = true;
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'chat',
        myParticipantId: 'viewer',
        recipientName: 'Atlas',
      },
    });

    expect(wrapper.find('[data-stop-button]').exists()).toBe(true);
    expect(wrapper.find('[data-send-button]').exists()).toBe(false);
    expect(wrapper.get('[data-stop-button]').attributes('disabled')).toBeDefined();
  });

  it('does not send with Enter while cancellation settles', async () => {
    streamState.cancelling = true;
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'chat',
        myParticipantId: 'viewer',
        recipientName: 'Atlas',
      },
    });
    await wrapper.get('textarea').setValue('next message');

    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });

    expect(streamState.send).not.toHaveBeenCalled();
  });

  it('shows a cancellation failure beside the composer', () => {
    streamState.error = 'Cancel failed: 500';
    const wrapper = mount(ConversationThread, {
      props: {
        conversationId: 'c1',
        mode: 'chat',
        myParticipantId: 'viewer',
        recipientName: 'Atlas',
      },
    });

    expect(wrapper.get('[data-composer-error]').text()).toBe('Cancel failed: 500');
  });
});
