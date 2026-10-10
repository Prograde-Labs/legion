import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import AppShell from './AppShell.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: { template: '<div id="chat-stub">chat</div>' } },
    { path: '/participants', component: { template: '<div>participants</div>' } },
    { path: '/processes', component: { template: '<div>processes</div>' } },
    { path: '/config', component: { template: '<div>config</div>' } },
  ],
});

describe('AppShell', () => {
  it('renders the four nav tabs with labels', async () => {
    await router.push('/');
    await router.isReady();
    const wrapper = mount(AppShell, { global: { plugins: [router] } });
    const nav = wrapper.find('nav');
    expect(nav.text()).toContain('Chat');
    expect(nav.text()).toContain('Participants');
    expect(nav.text()).toContain('Processes');
    expect(nav.text()).toContain('Config');
  });

  it('hides the badge at zero pending approvals', () => {
    const wrapper = mount(AppShell, { global: { plugins: [router] } });
    expect(wrapper.findComponent({ name: 'NavBadge' }).isVisible()).toBe(false);
  });

  it('shows a numeric badge and links to the oldest approval conversation', async () => {
    // seed the module-scoped approvals state (helper on the composable, Task 7 stub provides it)
    const { useApprovals } = await import('../composables/useApprovals.js');
    useApprovals().__setPendingForTests([{ conversationId: 'conv-9' }]);
    const wrapper = mount(AppShell, { global: { plugins: [router] } });
    const badge = wrapper.findComponent({ name: 'NavBadge' });
    expect(badge.props('count')).toBe(1);
    expect(badge.props('targetConversationId')).toBe('conv-9');
  });
});
