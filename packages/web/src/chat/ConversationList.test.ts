import { describe, expect, it, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ConversationList from './ConversationList.vue';
import { useConversations } from '../composables/useConversations.js';
import { useApprovals } from '../composables/useApprovals.js';
import type { ConversationMeta } from '@legion-collective/types';

// The list component reads module-scoped composable state; tests seed that state
// through the composables' test helpers (helpers live in the composable modules —
// .vue SFC files cannot carry named exports).
// DEVIATION(9a, minimal): fixture typed as ConversationMeta[] with createdAt/messageCount
// added — required by vue-tsc (web build gate) since __setConversationsForTests is typed;
// useConversations.ts is out of scope for 9a. Assertions remain verbatim.
const CONVS: ConversationMeta[] = [
  {
    id: 'c1',
    title: 'Deploy chat',
    participants: ['operator', 'agent-a'],
    status: 'active',
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T01:00:00Z',
    tags: [],
    messageCount: 0,
  },
  {
    id: 'c2',
    title: 'Research',
    participants: ['agent-b'],
    status: 'active',
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:30:00Z',
    tags: [],
    messageCount: 0,
  },
];

describe('ConversationList', () => {
  beforeEach(() => {
    // DEVIATION(9a, minimal): brief's beforeEach omitted filter reset; the module-scoped
    // filter leaks across tests (search test leaves search='research'). Repo convention
    // (useConversations.test.ts) resets singleton state here. Assertions remain verbatim.
    useConversations().__resetForTests();
    useConversations().__setConversationsForTests(CONVS);
    useApprovals().__setPendingForTests([]);
  });

  it('renders rows newest-first with title and participants', () => {
    const wrapper = mount(ConversationList);
    const rows = wrapper.findAll('[data-test="conv-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].text()).toContain('Deploy chat');
    expect(rows[0].text()).toContain('agent-a');
  });

  it('marks conversations with pending approvals', () => {
    useApprovals().__setPendingForTests([{ conversationId: 'c2', approvalId: 'a1' }]);
    const wrapper = mount(ConversationList);
    const flagged = wrapper.findAll('[data-test="conv-row"][data-pending="true"]');
    expect(flagged.length).toBe(1);
    expect(flagged[0].attributes('data-id')).toBe('c2');
  });

  it('search input filters rows', async () => {
    const wrapper = mount(ConversationList);
    await wrapper.find('input[type="search"]').setValue('research');
    expect(wrapper.findAll('[data-test="conv-row"]').length).toBe(1);
  });

  it('emits select(null) from the new-conversation button', async () => {
    const wrapper = mount(ConversationList);
    await wrapper.find('[data-test="new-conv"]').trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual([null]);
  });

  it('emits select(id) on row click', async () => {
    const wrapper = mount(ConversationList);
    await wrapper.findAll('[data-test="conv-row"]')[0].trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['c1']);
  });
});
