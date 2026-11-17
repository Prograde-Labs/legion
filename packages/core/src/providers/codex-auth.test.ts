import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  extractClaims,
  isRefreshTokenFailure,
  pollDeviceCode,
  refreshTokens,
  requestDeviceCode,
  revokeToken,
} from './codex-auth.js';
import { ProviderError } from '../errors/LegionError.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('codex-auth', () => {
  it('requests a device code and clamps the interval', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        device_auth_id: 'd1',
        user_code: 'MR1V-Q4QIL',
        interval: '2',
        expires_at: '2026-11-17T06:00:00Z',
      }),
    );

    const code = await requestDeviceCode('client-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(JSON.parse(init.body as string)).toEqual({ client_id: 'client-1' });
    expect(code).toMatchObject({
      deviceAuthId: 'd1',
      userCode: 'MR1V-Q4QIL',
      intervalSeconds: 5,
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
    expect(code.expiresAt).toBe(Math.floor(Date.parse('2026-11-17T06:00:00Z') / 1000));
  });

  it('returns null while the device code is pending', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 403 }));
    await expect(pollDeviceCode({ deviceAuthId: 'd1', userCode: 'CODE' })).resolves.toBeNull();
  });

  it('returns the authorization code and verifier on success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ authorization_code: 'ac', code_verifier: 'cv', code_challenge: 'cc' }),
    );
    await expect(pollDeviceCode({ deviceAuthId: 'd1', userCode: 'CODE' })).resolves.toEqual({
      authorizationCode: 'ac',
      codeVerifier: 'cv',
      codeChallenge: 'cc',
    });
  });

  it('sends a JSON refresh grant and returns rotated tokens', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: jwt({ exp: 1790036132 }),
        expires_in: 3600,
      }),
    );

    const tokens = await refreshTokens({ clientId: 'client-1', refreshToken: 'old-refresh' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client-1',
      refresh_token: 'old-refresh',
    });
    expect(tokens.accessToken).toBe('new-access');
    expect(tokens.refreshToken).toBe('new-refresh');
  });

  it('best-effort revokes the refresh token', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await expect(revokeToken({ clientId: 'client-1', token: 'r1' })).resolves.toBe(true);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'r1',
      token_type_hint: 'refresh_token',
      client_id: 'client-1',
    });
  });

  it('extracts account claims from the ID token', () => {
    const idToken = jwt({
      email: 'user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-1',
        chatgpt_plan_type: 'plus',
      },
    });
    expect(extractClaims(idToken)).toEqual({
      accountId: 'acct-1',
      plan: 'plus',
      email: 'user@example.com',
    });
  });

  it('recognizes refresh-token failure messages', () => {
    expect(isRefreshTokenFailure(new ProviderError('invalid_grant'))).toBe(true);
    expect(isRefreshTokenFailure(new ProviderError('network down'))).toBe(false);
  });
});

describe('codex-auth error safety', () => {
  it('does not expose server-supplied credentials in errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'private credential value' }, 400));
    await expect(refreshTokens({ clientId: 'client-1', refreshToken: 'r1' })).rejects.toThrow(
      'Codex token refresh failed: HTTP 400',
    );
  });

  it('retains recognized refresh failure codes without echoing surrounding text', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'invalid_grant private credential value' }, 400),
    );
    await expect(refreshTokens({ clientId: 'client-1', refreshToken: 'r1' })).rejects.toThrow(
      'Codex token refresh failed: invalid_grant',
    );
  });
});
