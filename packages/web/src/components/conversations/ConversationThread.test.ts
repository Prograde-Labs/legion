import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import ConversationThread from './ConversationThread.vue';

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
    ]),
    subThreads: ref({}),
    loading: ref(false),
    isThinking: ref(false),
    streamingText: ref(''),
    streamingReasoning: ref(''),
    sentConversationId: ref(null),
    markSent: vi.fn(),
    send: vi.fn(),
    editMessage: vi.fn(),
    generate: vi.fn(),
    pruneMessage: vi.fn(),
    compactConversation: vi.fn(),
    switchBranch: vi.fn(),
  }),
}));

describe('ConversationThread', () => {
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
});
