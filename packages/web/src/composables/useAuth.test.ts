import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(async () => {
  // Reset singleton between tests
  const mod = await import('./useAuth.js');
  mod.useAuth().logout();
  vi.restoreAllMocks();
});

describe('useAuth', () => {
  it('starts unauthenticated', async () => {
    const { useAuth } = await import('./useAuth.js');
    expect(useAuth().isAuthenticated.value).toBe(false);
  });

  it('login sets token and participantId', async () => {
    const { useAuth } = await import('./useAuth.js');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'tok-1', participantId: 'p1', expiresAt: 9999999999 }),
    } as Response);
    await useAuth().login('admin', 'secret');
    expect(useAuth().isAuthenticated.value).toBe(true);
    expect(useAuth().participantId.value).toBe('p1');
  });

  it('logout clears token', async () => {
    const { useAuth } = await import('./useAuth.js');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'tok-1', participantId: 'p1', expiresAt: 9999999999 }),
    } as Response);
    await useAuth().login('admin', 'secret');
    useAuth().logout();
    expect(useAuth().isAuthenticated.value).toBe(false);
  });
});
