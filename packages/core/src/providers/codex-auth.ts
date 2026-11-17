import { ProviderError } from '../errors/LegionError.js';

const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE = 'https://auth.openai.com';
export const CODEX_VERIFICATION_URL = 'https://auth.openai.com/codex/device';

export function getClientId(): string {
  return process.env['LEGION_CODEX_CLIENT_ID'] || DEFAULT_CLIENT_ID;
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
  verificationUrl: string;
}

export interface DeviceTokens {
  authorizationCode: string;
  codeChallenge?: string;
  codeVerifier: string;
}

export interface TokenSet {
  idToken?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface CodexClaims {
  accountId?: string;
  email?: string;
  plan?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '');
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

function errorSnippet(res: Response, body: Record<string, unknown>): string {
  const details = [body['detail'], body['error_description'], body['error']];
  return (
    REFRESH_FAILURE_CODES.find((code) =>
      details.some((detail) => typeof detail === 'string' && detail.toLowerCase().includes(code)),
    ) ?? `HTTP ${res.status}`
  );
}

export async function requestDeviceCode(clientId = getClientId()): Promise<DeviceCode> {
  const res = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  const body = await readJson(res);
  if (!res.ok) {
    throw new ProviderError(
      `Codex device-code request failed: ${errorSnippet(res, body)}`,
      res.status,
    );
  }

  const deviceAuthId = asString(body['device_auth_id']);
  const userCode = asString(body['user_code']);
  if (!deviceAuthId || !userCode) {
    throw new ProviderError('Codex device-code response missing device_auth_id/user_code');
  }

  const parsedInterval = Number.parseInt(String(body['interval'] ?? '5'), 10);
  const intervalSeconds = Number.isFinite(parsedInterval) ? Math.max(5, parsedInterval) : 5;

  const rawExpiry = body['expires_at'];
  const expiresAt =
    typeof rawExpiry === 'number'
      ? rawExpiry
      : typeof rawExpiry === 'string' && !Number.isNaN(Date.parse(rawExpiry))
        ? Math.floor(Date.parse(rawExpiry) / 1000)
        : Math.floor(Date.now() / 1000) + 900;

  return {
    deviceAuthId,
    userCode,
    intervalSeconds,
    expiresAt,
    verificationUrl: CODEX_VERIFICATION_URL,
  };
}

export async function pollDeviceCode(input: {
  deviceAuthId: string;
  userCode: string;
}): Promise<DeviceTokens | null> {
  const res = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: input.deviceAuthId, user_code: input.userCode }),
  });
  if (res.status === 403 || res.status === 404) return null;

  const body = await readJson(res);
  if (!res.ok) {
    throw new ProviderError(
      `Codex device-code poll failed: ${errorSnippet(res, body)}`,
      res.status,
    );
  }

  const authorizationCode = asString(body['authorization_code']);
  const codeVerifier = asString(body['code_verifier']);
  if (!authorizationCode || !codeVerifier) {
    throw new ProviderError('Codex device-code response missing authorization_code/code_verifier');
  }

  return {
    authorizationCode,
    codeVerifier,
    codeChallenge: asString(body['code_challenge']),
  };
}

function tokenSetFrom(body: Record<string, unknown>, context: string): TokenSet {
  const accessToken = asString(body['access_token']);
  const refreshToken = asString(body['refresh_token']);
  if (!accessToken || !refreshToken) {
    throw new ProviderError(`${context} response missing access_token/refresh_token`);
  }

  const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : undefined;
  const expiresAt =
    tokenExpiry(accessToken) ??
    (expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : Math.floor(Date.now() / 1000) + 3600);

  return {
    accessToken,
    refreshToken,
    idToken: asString(body['id_token']),
    expiresAt,
  };
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  code: string;
  codeVerifier: string;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: `${AUTH_BASE}/deviceauth/callback`,
  });
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await readJson(res);
  if (!res.ok) {
    throw new ProviderError(`Codex token exchange failed: ${errorSnippet(res, json)}`, res.status);
  }
  return tokenSetFrom(json, 'Codex token exchange');
}

export async function refreshTokens(input: {
  clientId: string;
  refreshToken: string;
}): Promise<TokenSet> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      refresh_token: input.refreshToken,
    }),
  });
  const json = await readJson(res);
  if (!res.ok) {
    throw new ProviderError(`Codex token refresh failed: ${errorSnippet(res, json)}`, res.status);
  }
  return tokenSetFrom(json, 'Codex token refresh');
}

export async function revokeToken(input: { clientId: string; token: string }): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH_BASE}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: input.token,
        token_type_hint: 'refresh_token',
        client_id: input.clientId,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return asRecord(JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')));
  } catch {
    return {};
  }
}

export function tokenExpiry(token: string | undefined): number | null {
  const exp = decodeJwtPayload(token)['exp'];
  return typeof exp === 'number' ? exp : null;
}

export function extractClaims(idToken: string | undefined): CodexClaims {
  const payload = decodeJwtPayload(idToken);
  const auth = asRecord(payload['https://api.openai.com/auth']);
  const profile = asRecord(payload['https://api.openai.com/profile']);
  return {
    accountId: asString(auth['chatgpt_account_id']),
    plan: asString(auth['chatgpt_plan_type']),
    email: asString(payload['email']) ?? asString(profile['email']),
  };
}

const REFRESH_FAILURE_CODES = [
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
];

export function isRefreshTokenFailure(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  const message = err.message.toLowerCase();
  return REFRESH_FAILURE_CODES.some((code) => message.includes(code));
}
