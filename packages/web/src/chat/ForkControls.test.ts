import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ForkControls from './ForkControls.vue';

const message = {
  id: 'm1',
  content: 'active version',
  alternates: [{ id: 'alt-1', content: 'other version', timestamp: '', status: 'active' }],
};

describe('ForkControls', () => {
  beforeEach(() => {
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
});
