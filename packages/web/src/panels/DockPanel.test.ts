import { describe, expect, it, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import DockPanel from './DockPanel.vue';
import { useDock, registerPanel } from './registry.js';

const Fake = { template: '<div data-test="fake-panel">fake</div>' };

describe('DockPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    useDock().__resetForTests();
  });

  it('renders the tab strip with titles and closes on ×', async () => {
    registerPanel('mystery_tool', { component: Fake, title: () => 'Mystery' });
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({
      kind: 'tool-detail',
      title: 'Mystery',
      icon: '🔧',
      payload: { tool: 'mystery_tool' },
    });
    dock.open({
      kind: 'tool-detail',
      title: 'Second',
      icon: '🔧',
      payload: { tool: 'other_tool' },
    });
    const wrapper = mount(DockPanel);
    const tabs = wrapper.findAll('[data-test="dock-tab"]');
    expect(tabs.length).toBe(2);
    expect(tabs[0].text()).toContain('Mystery');
    await wrapper.findAll('[data-test="dock-tab-close"]')[0].trigger('click');
    expect(useDock().tabs.value.length).toBe(1);
  });

  it('renders the active panel component', () => {
    registerPanel('mystery_tool', { component: Fake, title: () => 'Mystery' });
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({
      kind: 'tool-detail',
      title: 'Mystery',
      icon: '🔧',
      payload: { tool: 'mystery_tool' },
    });
    const wrapper = mount(DockPanel);
    expect(wrapper.find('[data-test="fake-panel"]').exists()).toBe(true);
  });

  it('narrow viewport: dock container carries the fixed overlay classes', () => {
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({
      kind: 'tool-detail',
      title: 'Mystery',
      icon: '🔧',
      payload: { tool: 'mystery_tool' },
    });
    const wrapper = mount(DockPanel);
    const root = wrapper.find('[data-test="dock-root"]');
    expect(root.classes().some((c) => c.startsWith('max-md:fixed'))).toBe(true);
  });
});
