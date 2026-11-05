import { describe, expect, it, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import ConfigView from './ConfigView.vue';
import { useToolAccess } from '../composables/useToolAccess.js';

vi.mock('../composables/useToolAccess.js', () => ({ useToolAccess: vi.fn() }));

function mockCan(can: (tool: string) => 'auto' | 'requires_approval' | 'hidden'): void {
  vi.mocked(useToolAccess).mockReturnValue({ can } as never);
}

function toolResponse(_tool: string, data: unknown): Response {
  return new Response(JSON.stringify({ result: { status: 'success', data } }), { status: 200 });
}

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
  mockCan(() => 'auto');
  localStorage.clear();
  vi.unstubAllGlobals();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
});

const PROVIDER = {
  name: 'local',
  type: 'openai-compatible' as const,
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'sk-secret',
  priority: 10,
};

function stubProviderFetch(
  handler: (tool: string) => Response = () => toolResponse('', []),
): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.tool === 'list_providers')
      return Promise.resolve(toolResponse('list_providers', [PROVIDER]));
    if (body.tool === 'get_routing')
      return Promise.resolve(toolResponse('get_routing', { system: {}, workspace: {} }));
    return Promise.resolve(handler(body.tool));
  });
}

describe('ConfigView provider errors', () => {
  it('does not delete a provider without confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    const fetchMock = stubProviderFetch();
    vi.stubGlobal('fetch', fetchMock);
    await router.push('/config');
    await router.isReady();
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="provider-delete"]').exists()).toBe(true),
    );
    await wrapper.find('[data-test="provider-delete"]').trigger('click');
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/execute?stream=false',
      expect.objectContaining({ body: expect.stringContaining('delete_provider') }),
    );
    wrapper.unmount();
  });

  it('shows an error banner when delete fails after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    vi.stubGlobal(
      'fetch',
      stubProviderFetch(() => {
        return new Response(
          JSON.stringify({ result: { status: 'error', error: 'delete failed' } }),
          {
            status: 200,
          },
        );
      }),
    );
    await router.push('/config');
    await router.isReady();
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="provider-delete"]').exists()).toBe(true),
    );
    await wrapper.find('[data-test="provider-delete"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="delete-error"]').text()).toContain('delete failed'),
    );
    wrapper.unmount();
  });
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

  it('renders existing system routing after load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'list_providers') return toolResponse('list_providers', []);
        if (body.tool === 'get_routing')
          return toolResponse('get_routing', {
            system: { models: { 'DeepSeek-V4.1-Flash-1017': ['local'] } },
            workspace: {},
          });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });
    await vi.waitFor(() => expect(wrapper.text()).toContain('DeepSeek-V4.1-Flash-1017'));
    wrapper.unmount();
  });

  it('hides provider save/delete affordances without write access', async () => {
    mockCan((t) => (t === 'list_providers' || t === 'get_routing' ? 'auto' : 'hidden'));
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
    await vi.waitFor(() => expect(wrapper.text()).toContain('Providers'));
    expect(wrapper.text()).not.toContain('+ Add provider');
    // Read-only table header row (no providers) still renders.
    expect(wrapper.text()).toContain('No providers configured');
    wrapper.unmount();
  });
});
