import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CompactDialog from './CompactDialog.vue';
import type { MessageWithAlternates } from '../../composables/useConversation.js';

const messages: MessageWithAlternates[] = [
  {
    id: 'm1', parentId: null, conversationId: 'c1', senderId: 'operator', recipientId: 'agent-x',
    role: 'user', content: 'hello world', status: 'active', timestamp: '2026-01-01T00:00:00Z',
  },
  {
    id: 'm2', parentId: 'm1', conversationId: 'c1', senderId: 'agent-x', recipientId: 'operator',
    role: 'assistant', content: 'reply text', status: 'active', timestamp: '2026-01-01T00:00:01Z',
  },
];

describe('CompactDialog', () => {
  it('shows message count and disables compact until an agent is selected', () => {
    const wrapper = mount(CompactDialog, { props: { messages, agents: [{ id: 'agent-x', name: 'Agent X' }] } });
    expect(wrapper.text()).toContain('Compacting 2 messages');
    expect(wrapper.get('button[data-compact]').attributes('disabled')).toBeDefined();
  });

  it('emits compact with selected agent and instruction', async () => {
    const wrapper = mount(CompactDialog, { props: { messages, agents: [{ id: 'agent-x', name: 'Agent X' }] } });
    const advancedBtn = wrapper.findAll('button[type="button"]').find((b) => b.text().includes('Advanced'));
    await advancedBtn!.trigger('click');
    await wrapper.get('select').setValue('agent-x');
    await wrapper.get('textarea').setValue('custom instruction');
    await wrapper.get('button[data-compact]').trigger('click');
    expect(wrapper.emitted('compact')?.[0]).toEqual(['agent-x', 'custom instruction']);
  });
});
