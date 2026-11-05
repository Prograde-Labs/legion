import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import AppShell from './AppShell.vue';
import { useAuth } from '../composables/useAuth.js';
import { useApprovals } from '../composables/useApprovals.js';

// Mounted shells stay subscribed to the module-scoped approval store; unmount
// every wrapper so watchers from one test cannot fire during the next.
enableAutoUnmount(afterEach);

const wsMocks = vi.hoisted(() => ({
  connectionId: null as { value: string | null } | null,
  streamChunkHandler: null as
    ((chunk: { type: string; data?: Record<string, unknown> }) => void) | null,
}));

// AppShell's global watch_activity stream reads getConnectionId and registers a
// chunk handler; capture the handler so tests can push real transport chunks.
// connectionId is a ref so the watch observes reconnects.
vi.mock('../composables/useWebSocket.js', async () => {
  const { ref } = await import('vue');
  const connectionId = ref<string | null>('conn-1');
  wsMocks.connectionId = connectionId;
  return {
    useWebSocket: () => ({
      getConnectionId: () => connectionId.value,
      onMessage: () => () => undefined,
      onStreamChunk: (
        _streamId: string,
        handler: (chunk: { type: string; data?: Record<string, unknown> }) => void,
      ) => {
        wsMocks.streamChunkHandler = handler;
        return () => undefined;
      },
    }),
  };
});

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

let serverApprovals: Array<Record<string, unknown>> = [];
let executeFetch: ReturnType<typeof vi.fn> | null = null;

/** Seed an authenticated session via the composable (mirrors useAuth.test.ts). */
async function seedAuth(expiresAt = 9999999999): Promise<void> {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ token: 'tok-1', participantId: 'p1', expiresAt }),
  } as Response);
  await useAuth().login('admin', 'secret');
}

/** Serve the two execute calls AppShell makes: the activity stream + refresh. */
function installExecuteFetch(): ReturnType<typeof vi.fn> {
  executeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { tool?: string };
    if (body.tool === 'watch_activity') {
      return new Response(JSON.stringify({ streamId: 'activity', conversationId: '' }), {
        status: 200,
      });
    }
    if (body.tool === 'list_pending_approvals') {
      return new Response(
        JSON.stringify({ result: { status: 'success', data: serverApprovals } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ result: { status: 'success', data: {} } }), {
      status: 200,
    });
  });
  vi.stubGlobal('fetch', executeFetch);
  return executeFetch;
}

async function mountShellAt(path: string) {
  await router.push(path);
  await router.isReady();
  installExecuteFetch();
  return mount(AppShell, { global: { plugins: [router] } });
}

describe('AppShell', () => {
  beforeEach(() => {
    useAuth().logout();
    useApprovals().reset();
    wsMocks.connectionId!.value = 'conn-1';
    wsMocks.streamChunkHandler = null;
    serverApprovals = [];
    executeFetch = null;
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
    wsMocks.connectionId!.value = null; // no socket without a session
    const wrapper = await mountShellAt('/login');
    expect(wrapper.find('nav').exists()).toBe(false);
    expect(wrapper.find('[data-test="avatar"]').exists()).toBe(false);
    // Router view content stays unconditional: only the chrome is hidden.
    expect(wrapper.find('#login-stub').exists()).toBe(true);
    // No approvals refresh while unauthenticated.
    expect(executeFetch).not.toHaveBeenCalled();
  });

  it('hides the nav when the token is expired', async () => {
    await seedAuth(1); // expiry in the past → isAuthenticated is false
    const wrapper = await mountShellAt('/');
    expect(wrapper.find('nav').exists()).toBe(false);
  });

  it('hides the badge at zero pending approvals', async () => {
    await seedAuth();
    const wrapper = await mountShellAt('/');
    await flushPromises();
    expect(wrapper.findComponent({ name: 'NavBadge' }).isVisible()).toBe(false);
  });

  it('shows a numeric badge and links to the oldest approval conversation', async () => {
    await seedAuth();
    serverApprovals = [
      {
        approvalId: 'a1',
        conversationId: 'conv-9',
        requesterId: 'agent-a',
        tool: 'file_write',
        args: {},
        createdAt: '2026-10-08T00:00:00Z',
      },
    ];
    const wrapper = await mountShellAt('/');
    await flushPromises();
    const badge = wrapper.findComponent({ name: 'NavBadge' });
    expect(badge.props('count')).toBe(1);
    expect(badge.props('targetConversationId')).toBe('conv-9');
  });

  it('resyncs approvals when the socket reconnects', async () => {
    await seedAuth();
    const wrapper = await mountShellAt('/');
    await flushPromises();

    const refreshCalls = () =>
      executeFetch!.mock.calls.filter((call) => {
        const init = call[1] as RequestInit | undefined;
        const body = JSON.parse(String(init?.body ?? '{}')) as { tool?: string };
        return body.tool === 'list_pending_approvals';
      }).length;
    const before = refreshCalls();

    serverApprovals = [
      {
        approvalId: 'a1',
        conversationId: 'conv-1',
        requesterId: 'agent-a',
        tool: 'file_write',
        args: {},
        createdAt: '2026-10-08T00:00:00Z',
      },
    ];
    wsMocks.connectionId!.value = null;
    await wrapper.vm.$nextTick();
    wsMocks.connectionId!.value = 'conn-2';
    await flushPromises();

    expect(refreshCalls()).toBeGreaterThan(before);
    expect(wrapper.findComponent({ name: 'NavBadge' }).props('count')).toBe(1);
  });

  it('falls back to polling approvals when watch_activity is hidden', async () => {
    await seedAuth();
    serverApprovals = [
      {
        approvalId: 'a1',
        conversationId: 'conv-fallback',
        requesterId: 'agent-a',
        tool: 'file_write',
        args: {},
        createdAt: '2026-10-08T00:00:00Z',
      },
    ];
    // A participant without watch_activity gets a 403 from the stream POST; the
    // shell must still surface approvals through the list_pending_approvals
    // fallback.
    executeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tool?: string };
      if (body.tool === 'watch_activity') return new Response('hidden', { status: 403 });
      if (body.tool === 'list_pending_approvals') {
        return new Response(
          JSON.stringify({ result: { status: 'success', data: serverApprovals } }),
          {
            status: 200,
          },
        );
      }
      return new Response(JSON.stringify({ result: { status: 'success', data: {} } }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', executeFetch);
    await router.push('/');
    await router.isReady();
    const wrapper = mount(AppShell, { global: { plugins: [router] } });

    await vi.waitFor(() =>
      expect(wrapper.findComponent({ name: 'NavBadge' }).props('count')).toBe(1),
    );
  });

  it('stops the approvals fallback when the activity stream recovers', async () => {
    await seedAuth();
    serverApprovals = [
      {
        approvalId: 'a1',
        conversationId: 'conv-fallback',
        requesterId: 'agent-a',
        tool: 'file_write',
        args: {},
        createdAt: '2026-10-08T00:00:00Z',
      },
    ];
    let activityHidden = true;
    executeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tool?: string };
      if (body.tool === 'watch_activity') {
        return activityHidden
          ? new Response('hidden', { status: 403 })
          : new Response(JSON.stringify({ streamId: 'activity', conversationId: '' }), {
              status: 200,
            });
      }
      if (body.tool === 'list_pending_approvals') {
        return new Response(
          JSON.stringify({ result: { status: 'success', data: serverApprovals } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ result: { status: 'success', data: {} } }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', executeFetch);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    await router.push('/');
    await router.isReady();
    const wrapper = mount(AppShell, { global: { plugins: [router] } });

    await vi.waitFor(() =>
      expect(wrapper.findComponent({ name: 'NavBadge' }).props('count')).toBe(1),
    );
    expect(clearSpy).not.toHaveBeenCalled();

    // A reconnect restarts watch_activity successfully; error resets to null and
    // the low-frequency polling interval must be cleared.
    activityHidden = false;
    wsMocks.connectionId!.value = null;
    await wrapper.vm.$nextTick();
    wsMocks.connectionId!.value = 'conn-2';
    await flushPromises();

    expect(clearSpy).toHaveBeenCalled();
  });

  it('ingests live approval chunks from the watch_activity stream', async () => {
    await seedAuth();
    const wrapper = await mountShellAt('/');
    await flushPromises(); // activity POST resolves → chunk handler registered

    // The global stream is a real watch_activity POST through the transport path.
    const activityCall = executeFetch?.mock.calls.find((call) => {
      const init = call[1] as RequestInit | undefined;
      const body = JSON.parse(String(init?.body ?? '{}')) as { tool?: string };
      return body.tool === 'watch_activity';
    });
    expect(activityCall).toBeTruthy();
    expect(wsMocks.streamChunkHandler).not.toBeNull();

    // The server list already contains the request the stream announces.
    serverApprovals = [
      {
        approvalId: 'a1',
        conversationId: 'conv-1',
        requesterId: 'agent-a',
        tool: 'file_write',
        args: {},
        createdAt: '2026-10-08T00:00:00Z',
      },
    ];
    wsMocks.streamChunkHandler?.({
      type: 'approval:requested',
      data: {
        approvalId: 'a1',
        conversationId: 'conv-1',
        participantId: 'agent-a',
        tool: 'file_write',
      },
    });
    // ingest() appends synchronously before its authoritative refresh lands.
    expect(useApprovals().pending.value.map((p) => p.approvalId)).toContain('a1');

    await flushPromises();
    expect(wrapper.findComponent({ name: 'NavBadge' }).props('count')).toBe(1);

    wsMocks.streamChunkHandler?.({ type: 'approval:resolved', data: { approvalId: 'a1' } });
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'NavBadge' }).props('count')).toBe(0);
  });

  it('closes the avatar menu on outside click and Escape', async () => {
    await seedAuth();
    const wrapper = await mountShellAt('/');
    await wrapper.find('[data-test="avatar"]').trigger('click');
    expect(wrapper.text()).toContain('Account…');

    // Outside click: the listener lives on document, the click target is outside
    // the avatar container.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('Account…');

    await wrapper.find('[data-test="avatar"]').trigger('click');
    expect(wrapper.text()).toContain('Account…');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('Account…');
  });

  it('removes its document listeners on unmount', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    await seedAuth();
    const wrapper = await mountShellAt('/');

    const clickHandler = addSpy.mock.calls.find(([type]) => type === 'click')?.[1];
    const keydownHandler = addSpy.mock.calls.find(([type]) => type === 'keydown')?.[1];
    expect(typeof clickHandler).toBe('function');
    expect(typeof keydownHandler).toBe('function');

    wrapper.unmount();
    expect(removeSpy).toHaveBeenCalledWith('click', clickHandler);
    expect(removeSpy).toHaveBeenCalledWith('keydown', keydownHandler);
  });
});
