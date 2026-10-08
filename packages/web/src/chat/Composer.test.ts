import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import Composer from './Composer.vue';

const AGENTS = [
  { id: 'agent-a', name: 'Agent A', type: 'agent', tools: {} },
  { id: 'agent-b', name: 'Agent B', type: 'agent', tools: {} },
  { id: 'op', name: 'Operator', type: 'user', tools: {} },
];

function okFetch(): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'success', data: {} } }), { status: 200 }),
    );
}

describe('Composer', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
  });

  it('Enter sends; Shift+Enter inserts a newline', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Composer, {
      props: { conversationId: 'c1', recipientId: 'agent-a' },
    });
    const area = wrapper.find('textarea');
    await area.setValue('hello');
    await area.trigger('keydown.enter', { key: 'Enter', shiftKey: false });
    await flushPromises(); // emit('sent') fires after execute()'s fetch + json microtasks
    expect(wrapper.emitted('sent')?.length).toBe(1);
    expect(area.element.value).toBe('');
    // Shift+Enter does NOT send
    await area.setValue('line1');
    await area.trigger('keydown.enter', { key: 'Enter', shiftKey: true });
    expect(wrapper.emitted('sent')?.length).toBe(1);
  });

  it('@ opens the mention list filtered to agents; selecting inserts the name', async () => {
    const wrapper = mount(Composer, {
      props: { conversationId: 'c1', recipientId: 'agent-a' },
    });
    // seed participants through the composable helper (module-scoped state)
    const { useParticipants } = await import('../composables/useParticipants.js');
    useParticipants().__setParticipantsForTests(AGENTS as never);
    const area = wrapper.find('textarea');
    await area.setValue('@');
    const list = wrapper.find('[data-test="mention-list"]');
    expect(list.exists()).toBe(true);
    expect(list.text()).toContain('agent-a');
    expect(list.text()).not.toContain("'op'");
    await list.findAll('button')[0].trigger('click');
    expect((wrapper.find('textarea').element.value as string).startsWith('@agent-a')).toBe(true);
  });

  it('shows the branch indicator when branchLabel is provided', () => {
    const wrapper = mount(Composer, {
      props: { conversationId: 'c1', recipientId: 'agent-a', branchLabel: 'branch-x' },
    });
    expect(wrapper.find('[data-test="branch-indicator"]').text()).toContain('branch-x');
  });
});
