import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ForkControls from './ForkControls.vue';
import { useToolAccess } from '../composables/useToolAccess.js';

vi.mock('../composables/useToolAccess.js', () => ({ useToolAccess: vi.fn() }));

function mockCan(can: (tool: string) => 'auto' | 'requires_approval' | 'hidden'): void {
  vi.mocked(useToolAccess).mockReturnValue({ can } as never);
}

const message = {
  id: 'm1',
  content: 'active version',
  alternates: [{ id: 'alt-1', content: 'other version', timestamp: '', status: 'active' }],
};

describe('ForkControls', () => {
  beforeEach(() => {
    mockCan(() => 'auto');
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
  });

  it('renders pager with correct position', () => {
    const wrapper = mount(ForkControls, { props: { conversationId: 'c1', message } });
    expect(wrapper.find('[data-test="fork-pager"]').text()).toBe('‹ 1/2 ›');
  });

  it('calls switch_branch and emits switched', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'success', data: {} } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ForkControls, { props: { conversationId: 'c1', message } });
    await wrapper.find('[data-test="fork-next"]').trigger('click');
    await flushPromises(); // emit('switched') fires after execute()'s fetch + json microtasks
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool).toBe('switch_branch');
    expect(wrapper.emitted('switched')).toBeTruthy();
  });

  it('renders nothing when there are no alternates', () => {
    const wrapper = mount(ForkControls, {
      props: { conversationId: 'c1', message: { id: 'm1', content: 'x' } },
    });
    expect(wrapper.find('[data-test="fork-pager"]').exists()).toBe(false);
  });

  it('hides pager buttons and disables chips without switch_branch access', () => {
    mockCan((t) => (t === 'switch_branch' ? 'hidden' : 'auto'));
    const wrapper = mount(ForkControls, { props: { conversationId: 'c1', message } });
    expect(wrapper.find('[data-test="fork-prev"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="fork-next"]').exists()).toBe(false);
    // Position stays readable; chips render inert.
    expect(wrapper.find('[data-test="fork-pager"]').text()).toBe('1/2');
    const chip = wrapper.find('[data-test="branch-chip"]');
    expect((chip.element as HTMLButtonElement).disabled).toBe(false);
    expect(chip.attributes('aria-disabled')).toBe('true');
  });

  it('ignores keyboard activation of chips without switch_branch access', async () => {
    mockCan((t) => (t === 'switch_branch' ? 'hidden' : 'auto'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ForkControls, { props: { conversationId: 'c1', message } });
    const chip = wrapper.find('[data-test="branch-chip"]');
    // Inert chips must not sit in the tab order (keyboard users tab past them).
    expect(chip.attributes('tabindex')).toBe('-1');
    // Enter on a focused button synthesizes a click in real browsers; happy-dom
    // fires neither automatically, so simulate both halves of the sequence.
    await chip.trigger('keydown', { key: 'Enter' });
    await chip.trigger('click');
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.emitted('switched')).toBeUndefined();
  });
});
