import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ConversationList from './ConversationList.vue';

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const conversation = {
  id: 'c1',
  title: 'Resolved for operator',
  createdAt: '',
  updatedAt: '',
  messageCount: 2,
  participants: ['operator', 'agent'],
  status: 'active' as const,
  tags: ['alpha'],
};

describe('ConversationList', () => {
  it('renders resolved title before participant fallback', () => {
    const wrapper = mount(ConversationList, {
      props: {
        conversations: [conversation],
        activeId: null,
        myParticipantId: 'operator',
        mode: 'mine',
        status: 'active',
        tags: [],
      },
    });
    expect(wrapper.get('[data-conversation-title]').text()).toBe('Resolved for operator');
  });

  it('emits lifecycle and normalized tag filters', async () => {
    const wrapper = mount(ConversationList, {
      props: {
        conversations: [],
        activeId: null,
        myParticipantId: 'operator',
        mode: 'mine',
        status: 'active',
        tags: [],
      },
    });
    await wrapper.get('[data-status="archived"]').trigger('click');
    await wrapper.get('[data-tag-filter]').setValue(' alpha, beta, alpha ');
    await wrapper.get('[data-tag-filter]').trigger('change');
    expect(wrapper.emitted('update:status')?.[0]).toEqual(['archived']);
    expect(wrapper.emitted('update:tags')?.[0]).toEqual([['alpha', 'beta']]);
  });

  it('preserves in-progress tag typing across re-renders', async () => {
    const wrapper = mount(ConversationList, {
      props: {
        conversations: [],
        activeId: null,
        myParticipantId: 'operator',
        mode: 'mine',
        status: 'active',
        tags: [],
      },
    });
    const input = wrapper.get('[data-tag-filter]');
    await input.setValue('helper, com');
    await wrapper.setProps({ conversations: [conversation] });
    expect((wrapper.get('[data-tag-filter]').element as HTMLInputElement).value).toBe(
      'helper, com',
    );
  });
});
