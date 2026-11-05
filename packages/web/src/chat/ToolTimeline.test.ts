import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ToolTimeline from './ToolTimeline.vue';

const calls = [
  { key: 0, index: 0, name: 'search_notes', args: '{"query":"legion"}' },
  { key: 1, index: 1, name: 'write_file', args: '{"path":"a.md"}' },
];

describe('ToolTimeline', () => {
  it('renders nothing at minimal detail', () => {
    const wrapper = mount(ToolTimeline, { props: { calls, detail: 'minimal' } });
    expect(wrapper.find('[data-test="tool-timeline"]').exists()).toBe(false);
  });

  it('renders tool names without arguments at standard detail', () => {
    const wrapper = mount(ToolTimeline, { props: { calls, detail: 'standard' } });
    expect(wrapper.findAll('[data-test="tool-call"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="tool-args"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('search_notes');
  });

  it('renders truncated arguments at full detail', () => {
    const wrapper = mount(ToolTimeline, { props: { calls, detail: 'full' } });
    expect(wrapper.find('[data-test="tool-args"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('legion');
  });
});
