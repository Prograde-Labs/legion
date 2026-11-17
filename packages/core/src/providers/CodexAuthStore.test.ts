import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CodexAuthStore } from './CodexAuthStore.js';
import type { CodexAuth } from './CodexAuthStore.js';

function auth(overrides: Partial<CodexAuth> = {}): CodexAuth {
  return {
    clientId: 'client-1',
    issuer: 'https://auth.openai.com',
    accountId: 'acct-1',
    email: 'user@example.com',
    plan: 'plus',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    savedAt: '2026-11-17T05:00:00.000Z',
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CodexAuthStore', () => {
  it('deletes stray temporary credentials for only the named provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    const store = new CodexAuthStore(dir);
    await writeFile(join(dir, 'Codex.json.stray.tmp'), 'secret');
    await writeFile(join(dir, 'Codex2.json.stray.tmp'), 'other');
    await store.delete('Codex');
    expect(await readdir(dir)).toEqual(['Codex2.json.stray.tmp']);
  });

  it('cleans temporary credentials when rename fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    await mkdir(join(dir, 'Codex.json'));
    await expect(new CodexAuthStore(dir).save('Codex', auth())).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['Codex.json']);
  });

  it('waits for an in-flight refresh before revoking and deleting credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    const store = new CodexAuthStore(dir);
    await store.save('Codex', auth({ expiresAt: 0 }));
    let resolveRefresh!: (response: Response) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    fetchMock
      .mockImplementationOnce(() => {
        refreshStarted();
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      })
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const refresh = store.ensureFresh('Codex');
    await started;
    const logout = store.logout('Codex');
    resolveRefresh(
      new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' })),
    );
    await refresh;
    await expect(logout).resolves.toEqual({ signedOut: true, revoked: true });
    expect(await store.read('Codex')).toBeNull();
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain('new-refresh');
  });

  it('deletes credentials and stray temporary files even when revocation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    const store = new CodexAuthStore(dir);
    await store.save('Codex', auth());
    await writeFile(join(dir, 'Codex.json.leftover.tmp'), 'secret');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(store.logout('Codex')).resolves.toEqual({ signedOut: true, revoked: false });
    expect(await readdir(dir)).toEqual([]);
    await expect(store.logout('Codex')).resolves.toEqual({ signedOut: true, revoked: false });
  });
  it('restricts permissions on an existing credential directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    const dir = join(parent, 'credentials');
    try {
      await mkdir(dir, { mode: 0o755 });
      await chmod(dir, 0o755);
      await new CodexAuthStore(dir).save('Codex', auth());
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('saves with mode 0600, reads, and deletes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    const store = new CodexAuthStore(dir);

    await store.save('Codex', auth());

    expect((await store.read('Codex'))?.accessToken).toBe('access');
    expect((await stat(join(dir, 'Codex.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, 'Codex.json'), 'utf8'))).toMatchObject({
      accountId: 'acct-1',
    });

    await store.delete('Codex');
    expect(await store.read('Codex')).toBeNull();
  });

  it('returns null for a missing file and rejects a corrupt one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    const store = new CodexAuthStore(dir);

    expect(await store.read('Missing')).toBeNull();

    await store.save('Broken', auth());
    await (await import('node:fs/promises')).writeFile(join(dir, 'Broken.json'), '{not json');
    await expect(store.read('Broken')).rejects.toThrow('corrupt');
  });

  it('returns the current auth without refreshing when it is still fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    const store = new CodexAuthStore(dir);
    await store.save('Codex', auth());

    await expect(store.ensureFresh('Codex')).resolves.toMatchObject({ accessToken: 'access' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes when the access token is near expiry and keeps the old id token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    const store = new CodexAuthStore(dir);
    await store.save(
      'Codex',
      auth({ expiresAt: Math.floor(Date.now() / 1000) + 60, idToken: 'old-id' }),
    );

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }), {
        status: 200,
      }),
    );

    const fresh = await store.ensureFresh('Codex');

    expect(fresh.accessToken).toBe('new-access');
    expect(fresh.refreshToken).toBe('new-refresh');
    expect(fresh.idToken).toBe('old-id');
    expect((await store.read('Codex'))?.accessToken).toBe('new-access');
  });

  it('clears tokens and surfaces sign-in again on refresh-token failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
    const store = new CodexAuthStore(dir);
    await store.save('Codex', auth({ expiresAt: Math.floor(Date.now() / 1000) + 60 }));

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );

    await expect(store.ensureFresh('Codex')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('sign in again'),
    });
    expect(await store.read('Codex')).toBeNull();
  });

  it('rejects an invalid provider name', async () => {
    const store = new CodexAuthStore('/tmp/codex-auth');
    await expect(store.save('../escape', auth())).rejects.toThrow('Invalid provider name');
  });
});
