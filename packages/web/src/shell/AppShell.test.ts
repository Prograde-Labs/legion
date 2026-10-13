import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import AppShell from './AppShell.vue';
import { useAuth } from '../composables/useAuth.js';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: { template: '<div id="chat-stub">chat</div>' } },
    { path: '/chat', component: { template: '<div id="chat-stub">chat</div>' } },
    { path: '/chat/:id', component: { template: '<div id="chat-stub">chat</div>' } },
    { path: '/login', component: { template: '<div id="login-stub">login</div>' } },
    { path: '/participants', component: { template: '<div>participants</div>' } },
    { path: '/processes', component: { template: '<div>processes</div>' } },
    { path: '/config', component: { template: '<div>config</div>' } },
  ],
});

async function mountShellAt(path: string) {
  await router.push(path);
  await router.isReady();
  return mount(AppShell, { global: { plugins: [router] } });
}

/** Seed an authenticated session via the composable (mirrors useAuth.test.ts). */
async function seedAuth(expiresAt = 9999999999): Promise<void> {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ token: 'tok-1', participantId: 'p1', expiresAt }),
  } as Response);
  await useAuth().login('admin', 'secret');
}

describe('AppShell', () => {
  beforeEach(() => {
    useAuth().logout();
    vi.restoreAllMocks();
  });

  it('renders the four nav tabs with labels', async () => {
    await seedAuth();
    const wrapper = await mountShellAt('/');
    const nav = wrapper.find('nav');
    expect(nav.exists()).toBe(true);
    expect(nav.text()).toContain('Chat');
    expect(nav.text()).toContain('Participants');
    expect(nav.text()).toContain('Processes');
    expect(nav.text()).toContain('Config');
  });

  it('renders the nav when authenticated', async () => {
    await seedAuth();
    const wrapper = await mountShellAt('/');
    expect(wrapper.find('nav').exists()).toBe(true);
  });

  it('renders no nav when unauthenticated on /login', async () => {
    const wrapper = await mountShellAt('/login');
    expect(wrapper.find('nav').exists()).toBe(false);
    expect(wrapper.find('[data-test="avatar"]').exists()).toBe(false);
    // Router view content stays unconditional: only the chrome is hidden.
    expect(wrapper.find('#login-stub').exists()).toBe(true);
  });

  it('hides the nav when the token is expired', async () => {
    await seedAuth(1); // expiry in the past → isAuthenticated is false
    const wrapper = await mountShellAt('/');
    expect(wrapper.find('nav').exists()).toBe(false);
  });

  it('hides the badge at zero pending approvals', async () => {
    await seedAuth();
    const wrapper = await mountShellAt('/');
    expect(wrapper.findComponent({ name: 'NavBadge' }).isVisible()).toBe(false);
  });

  it('shows a numeric badge and links to the oldest approval conversation', async () => {
    await seedAuth();
    // seed the module-scoped approvals state (helper on the composable, Task 7 stub provides it)
    const { useApprovals } = await import('../composables/useApprovals.js');
    useApprovals().__setPendingForTests([{ conversationId: 'conv-9' }]);
    const wrapper = await mountShellAt('/');
    const badge = wrapper.findComponent({ name: 'NavBadge' });
    expect(badge.props('count')).toBe(1);
    expect(badge.props('targetConversationId')).toBe('conv-9');
  });
});
