import { beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from './index.js';
import { useAuth } from '../composables/useAuth.js';

/** Seed an authenticated session via the composable (mirrors AppShell.test.ts). */
async function seedAuth(): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'tok-1', participantId: 'p1', expiresAt: 9999999999 }),
    } as Response),
  );
  await useAuth().login('admin', 'secret');
}

describe('router', () => {
  beforeEach(() => {
    useAuth().logout();
    vi.restoreAllMocks();
  });

  it('redirects unknown routes to chat', async () => {
    await seedAuth();
    await router.push('/does-not-exist');
    expect(router.currentRoute.value.path).toBe('/chat');
  });

  it('redirects an authenticated user away from /login', async () => {
    await seedAuth();
    await router.push('/login');
    expect(router.currentRoute.value.path).toBe('/chat');
  });

  it('keeps unauthenticated users on /login', async () => {
    await router.push('/login');
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('sends unauthenticated users from protected routes to /login', async () => {
    await router.push('/participants');
    expect(router.currentRoute.value.path).toBe('/login');
  });
});
