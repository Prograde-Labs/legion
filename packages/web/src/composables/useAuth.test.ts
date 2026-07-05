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

  it('isAuthenticated returns false when expiresAt is in the past', async () => {
    const { useAuth } = await import('./useAuth.js');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'tok-expired', participantId: 'p1', expiresAt: 1 }),
    } as Response);
    await useAuth().login('admin', 'secret');
    expect(useAuth().isAuthenticated.value).toBe(false);
  });

  it('decodes JWT exp as fallback when expiresAt is missing from response', async () => {
    const { useAuth } = await import('./useAuth.js');
    // Create a fake JWT with exp far in the future
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ sub: 'p1', exp: futureExp })).toString(
      'base64url',
    );
    const fakeToken = `${header}.${payload}.sig`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: fakeToken, participantId: 'p1' }),
    } as Response);
    await useAuth().login('admin', 'secret');
    expect(useAuth().isAuthenticated.value).toBe(true);
    expect(useAuth().participantId.value).toBe('p1');
  });

  it('treats token without exp as expired (fallback decode fails)', async () => {
    const { useAuth } = await import('./useAuth.js');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'not-a-jwt', participantId: 'p1' }),
    } as Response);
    await useAuth().login('admin', 'secret');
    expect(useAuth().isAuthenticated.value).toBe(false);
  });
});
