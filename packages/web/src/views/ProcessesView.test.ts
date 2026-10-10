import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import ProcessesView from './ProcessesView.vue';

// useLegionApi reads the auth token from localStorage-backed refs seeded
// at module init — seed at hoist time (before the module graph initializes).
vi.hoisted(() => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
});

const EXITED_HANDLE = {
  id: 'proc-1',
  command: 'sleep',
  args: ['30'],
  cwd: '/tmp',
  tty: false,
  shell: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  startedByParticipantId: 'op',
  pid: 9999,
  status: 'exited',
  exitCode: 0,
  exitedAt: '2026-01-01T00:00:30.000Z',
};

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/processes', component: ProcessesView },
    { path: '/processes/:id', component: ProcessesView },
  ],
});

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
});

// Tool-aware fetch stub: every call gets a fresh Response (bodies are single-read).
function stubFetch(dataFor: (tool: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url: unknown, init?: { body?: string }) => {
      const { tool } = JSON.parse(init?.body ?? '{}') as { tool: string };
      return Promise.resolve(
        new Response(JSON.stringify({ result: { status: 'success', data: dataFor(tool) } }), {
          status: 200,
        }),
      );
    }),
  );
}

describe('ProcessesView theming', () => {
  it('uses token utilities, not raw colors (list + start form)', async () => {
    stubFetch(() => []);
    await router.push('/processes');
    await router.isReady();
    const wrapper = mount(ProcessesView, { global: { plugins: [router] } });
    const html = wrapper.html();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html).not.toContain('navy-');
    wrapper.unmount();
  });

  it('uses token utilities, not raw colors (detail with ANSI output)', async () => {
    stubFetch((tool) => {
      if (tool === 'get_process') return EXITED_HANDLE;
      if (tool === 'list_processes') return [];
      return { data: btoa('log line'), totalBytes: 8, from: 0 };
    });
    await router.push('/processes/proc-1');
    await router.isReady();
    const wrapper = mount(ProcessesView, { global: { plugins: [router] } });
    await vi.waitFor(() => expect(wrapper.text()).toContain('log line'));
    const html = wrapper.html();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html).not.toContain('navy-');
    wrapper.unmount();
  });
});
