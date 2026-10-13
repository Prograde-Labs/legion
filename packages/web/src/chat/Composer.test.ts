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

/** happy-dom provides matchMedia (always matches=false); override to control pointer modality. */
function stubCoarsePointer(coarse: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: coarse,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

describe('Composer', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
  });

  it('non-draft Enter hands off via streamSend; no communicate execute', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Composer, {
      props: { conversationId: 'c1', recipientId: 'agent-a' },
    });
    const area = wrapper.find('textarea');
    await area.setValue('hello');
    await area.trigger('keydown.enter', { key: 'Enter', shiftKey: false });
    await flushPromises();
    // Handoff, not a send: Thread.send owns the (streaming) communicate call.
    expect(wrapper.emitted('streamSend')?.[0]?.[0]).toEqual({ to: 'agent-a', message: 'hello' });
    expect(wrapper.emitted('sent')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(area.element.value).toBe('');
    // Shift+Enter does NOT send
    await area.setValue('line1');
    await area.trigger('keydown.enter', { key: 'Enter', shiftKey: true });
    expect(wrapper.emitted('streamSend')?.length).toBe(1);
  });

  it('draft Enter hands off via streamSend; no communicate execute', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Composer, {
      props: { conversationId: null, recipientId: 'agent-a' },
    });
    const area = wrapper.find('textarea');
    await area.setValue('first!');
    await area.trigger('keydown.enter', { key: 'Enter', shiftKey: false });
    await flushPromises();
    // Draft sends stream through Thread.send like every other send (the first
    // message of a new conversation must stream too). Composer never executes
    // communicate itself; the created conversation id arrives via Thread's
    // `created` emit, not a Composer `sent` event.
    expect(wrapper.emitted('streamSend')?.[0]?.[0]).toEqual({ to: 'agent-a', message: 'first!' });
    expect(wrapper.emitted('sent')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(area.element.value).toBe('');
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

  it('always renders the send button', () => {
    const wrapper = mount(Composer, {
      props: { conversationId: 'c1', recipientId: 'agent-a' },
    });
    expect(wrapper.find('[data-test="composer-send"]').exists()).toBe(true);
  });

  it('sends on Enter with fine pointer', async () => {
    stubCoarsePointer(false);
    const wrapper = mount(Composer, {
      props: { conversationId: 'c1', recipientId: 'agent-a' },
    });
    const area = wrapper.find('[data-test="composer-input"]');
    await area.setValue('hi');
    await area.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('streamSend')).toBeTruthy();
  });

  it('inserts newline on Enter with coarse pointer', async () => {
    stubCoarsePointer(true);
    const wrapper = mount(Composer, {
      props: { conversationId: 'c1', recipientId: 'agent-a' },
    });
    const input = wrapper.find('[data-test="composer-input"]');
    await input.setValue('line1');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('streamSend')).toBeFalsy();
    // happy-dom does not simulate the textarea's native Enter default action
    // (probed: value never changes even with no handler), so the newline
    // insertion itself is untestable here — assert instead that the handler
    // leaves Enter alone (no preventDefault), which is what produces the
    // newline in a real browser.
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('send button click emits streamSend', async () => {
    const wrapper = mount(Composer, {
      props: { conversationId: 'c1', recipientId: 'agent-a' },
    });
    await wrapper.find('[data-test="composer-input"]').setValue('hello');
    await wrapper.find('[data-test="composer-send"]').trigger('click');
    expect(wrapper.emitted('streamSend')?.[0]?.[0]).toEqual({ to: 'agent-a', message: 'hello' });
  });
});
