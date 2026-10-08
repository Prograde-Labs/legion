import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import ConfigView from './ConfigView.vue';

// useLegionApi reads the auth token from localStorage-backed refs seeded at module
// init — seed at hoist time (before the module graph initializes).
vi.hoisted(() => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
});

const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/config', component: ConfigView }],
});

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
});

describe('ConfigView theming', () => {
  it('uses token utilities, not raw colors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ result: { status: 'success', data: [] } }), {
            status: 200,
          }),
        ),
      ),
    );
    await router.push('/config');
    await router.isReady();
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });
    const html = wrapper.html();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html).not.toContain('navy-');
    wrapper.unmount();
  });

  it('renders Providers and Model routing sections', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ result: { status: 'success', data: [] } }), {
            status: 200,
          }),
        ),
      ),
    );
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });
    expect(wrapper.text()).toContain('Providers');
    expect(wrapper.text()).toContain('Model routing');
    wrapper.unmount();
  });
});
