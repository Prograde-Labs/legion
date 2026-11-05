import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import RoutingEditor from './RoutingEditor.vue';

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  localStorage.setItem('legion-token', 'tok');
  localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
});

describe('RoutingEditor', () => {
  it('hydrates rows when the routing prop arrives after mount', async () => {
    const wrapper = mount(RoutingEditor, {
      props: { scope: 'system', routing: {}, providerNames: ['local'] },
    });
    expect(wrapper.findAll('[data-test="routing-row"]')).toHaveLength(0);
    await wrapper.setProps({
      routing: { models: { 'DeepSeek-V4.1-Flash-1017': ['local'] } },
    });
    expect(wrapper.findAll('[data-test="routing-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="routing-row"]').text()).toContain('DeepSeek-V4.1-Flash-1017');
  });
});
