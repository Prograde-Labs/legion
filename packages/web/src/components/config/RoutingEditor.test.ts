import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import RoutingEditor from './RoutingEditor.vue';

const execute = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useLegionApi.js', () => ({ useLegionApi: () => ({ execute }) }));

beforeEach(() => {
  vi.clearAllMocks();
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

  it('shows an error banner when save fails', async () => {
    execute.mockRejectedValueOnce(new Error('routing failed'));
    const wrapper = mount(RoutingEditor, {
      props: {
        scope: 'system',
        routing: { models: { 'DeepSeek-V4.1-Flash-1017': ['local'] } },
        providerNames: ['local'],
      },
    });
    await wrapper.find('[data-test="routing-save"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="routing-error"]').text()).toContain('routing failed'),
    );
  });

  it('clears the error banner when the routing prop changes', async () => {
    execute.mockRejectedValueOnce(new Error('routing failed'));
    const wrapper = mount(RoutingEditor, {
      props: {
        scope: 'system',
        routing: { models: { 'DeepSeek-V4.1-Flash-1017': ['local'] } },
        providerNames: ['local'],
      },
    });
    await wrapper.find('[data-test="routing-save"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-test="routing-error"]').exists()).toBe(true));
    await wrapper.setProps({ routing: { models: { other: ['local'] } } });
    expect(wrapper.find('[data-test="routing-error"]').exists()).toBe(false);
  });
});
