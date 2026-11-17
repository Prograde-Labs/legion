import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CodexLoginManager } from './CodexLoginManager.js';
import type { CodexAuthStore } from './CodexAuthStore.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

let fetchMock: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;
let store: CodexAuthStore;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  save = vi.fn(async () => undefined);
  store = { save } as unknown as CodexAuthStore;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CodexLoginManager', () => {
  it('starts a device flow and reports the display data', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        device_auth_id: 'd1',
        user_code: 'CODE-1',
        interval: '7',
        expires_at: '2026-11-17T06:00:00Z',
      }),
    );
    const manager = new CodexLoginManager(store);

    const result = await manager.start('Codex', 10);

    expect(result).toMatchObject({
      providerName: 'Codex',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'CODE-1',
      intervalSeconds: 7,
    });
    expect(result.flowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.expiresAt).toBe(new Date('2026-11-17T06:00:00Z').toISOString());
  });

  it('returns pending while the device code is not approved', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ device_auth_id: 'd1', user_code: 'CODE-1', interval: '5' }),
      )
      .mockResolvedValueOnce(new Response('', { status: 403 }));
    const manager = new CodexLoginManager(store);
    const started = await manager.start('Codex', 10);

    await expect(manager.poll(started.flowId)).resolves.toEqual({
      status: 'pending',
      intervalSeconds: 5,
    });
  });

  it('exchanges the code, saves auth, and returns account metadata', async () => {
    const idToken = jwt({
      email: 'user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-1',
        chatgpt_plan_type: 'plus',
      },
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ device_auth_id: 'd1', user_code: 'CODE-1', interval: '5' }),
      )
      .mockResolvedValueOnce(jsonResponse({ authorization_code: 'ac', code_verifier: 'cv' }))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'a', refresh_token: 'r', id_token: idToken }),
      );

    const manager = new CodexLoginManager(store);
    const started = await manager.start('Codex', 42);
    const result = await manager.poll(started.flowId);

    expect(result).toEqual({
      status: 'complete',
      providerName: 'Codex',
      priority: 42,
      account: { email: 'user@example.com', plan: 'plus' },
    });
    expect(save).toHaveBeenCalledWith(
      'Codex',
      expect.objectContaining({ accountId: 'acct-1', accessToken: 'a', refreshToken: 'r' }),
    );
    await expect(manager.poll(started.flowId)).resolves.toEqual({ status: 'expired' });
  });

  it('returns expired for an unknown or elapsed flow', async () => {
    const manager = new CodexLoginManager(store);
    await expect(manager.poll('missing')).resolves.toEqual({ status: 'expired' });

    fetchMock.mockResolvedValue(
      jsonResponse({
        device_auth_id: 'd1',
        user_code: 'CODE-1',
        interval: '5',
        expires_at: '2020-01-01T00:00:00Z',
      }),
    );
    const started = await manager.start('Codex', 10);
    await expect(manager.poll(started.flowId)).resolves.toEqual({ status: 'expired' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid provider names before requesting a device code', async () => {
    const manager = new CodexLoginManager(store);

    await expect(manager.start('../invalid', 10)).rejects.toThrow('Invalid provider name');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
