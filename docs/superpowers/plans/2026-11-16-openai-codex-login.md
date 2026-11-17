# OpenAI Codex Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `codex` provider that signs in with OpenAI device-code OAuth, streams inference against the Codex backend, records `cost: 0`, and exposes ChatGPT plan usage windows.

**Architecture:** Reuse `OpenAIResponsesProvider` by extracting its request-body, header, URL, and SSE-parser hooks. A new `CodexProvider` subclass adds Codex headers, body sanitization, 401 refresh-retry, model catalog parsing, and usage normalization. A `CodexAuthStore` persists tokens under `providers/.codex-auth/<name>.json`; a `CodexLoginManager` owns in-memory device flows. Five operator tools and two web surfaces expose login, status, logout, and usage.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Node >= 20, Vitest, Vue 3 + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-16-openai-codex-login-design.md`

## Global Constraints

- Worktree: `threads/2026-11-16-openai-codex-login/legion`, branch `feat/openai-codex-login`. `repos/legion` is read-only.
- Node >= 20; pure ESM. Relative imports must use `.js`; type-only imports must use `import type`.
- Prettier: single quotes, semicolons, trailing commas, 100 columns, 2 spaces.
- Codex client ID: `app_EMoamEEZ73f0CkXaXp7hrann` (override `LEGION_CODEX_CLIENT_ID`).
- Inference base: `https://chatgpt.com/backend-api/codex` (override `LEGION_CODEX_BASE_URL`).
- Usage URL: `https://chatgpt.com/backend-api/wham/usage` (override `LEGION_CODEX_USAGE_URL`).
- Verification URL: `https://auth.openai.com/codex/device`.
- Codex headers: `Authorization: Bearer <access>`, `chatgpt-account-id: <account>`, `originator: codex_cli_rs`, `User-Agent: codex_cli_rs/0.0.1`, `OpenAI-Beta: responses=experimental`.
- Credentials: `~/.config/legion/providers/.codex-auth/<name>.json`, file `0600`, directory `0700`, atomic temp+rename.
- Tool names: `openai_login_start`, `openai_login_poll`, `openai_auth_status`, `openai_logout`, `openai_usage`.
- Tokens never appear in `list_providers`, tool results, logs, or the UI.
- Gate order: `npm run format:check` -> `npm run typecheck` -> `npm test`; plus `npm run test --workspace=packages/web` when `packages/web` changes.

---

## Task 1: Shared usage types, `Provider.usage`, and `ProviderError.status`

**Files:**

- Modify: `packages/types/src/usage.ts`
- Modify: `packages/core/src/providers/Provider.ts`
- Modify: `packages/core/src/errors/LegionError.ts`
- Test: `packages/core/src/errors/LegionError.test.ts`

**Interfaces:**

- Produces: `ProviderUsageWindow`, `ProviderUsageSummary` (from `@legion-collective/types`).
- Produces: `Provider.usage?(): Promise<ProviderUsageSummary>`.
- Produces: `new ProviderError(message, status?)`, `ProviderError.status?: number`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/errors/LegionError.test.ts`:

```ts
it('ProviderError carries an optional HTTP status', () => {
  expect(new ProviderError('unauthorized', 401).status).toBe(401);
  expect(new ProviderError('plain').status).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/errors/LegionError.test.ts`
Expected: FAIL — `status` is `undefined` for the first case.

- [ ] **Step 3: Add the shared types**

Append to `packages/types/src/usage.ts`:

```ts
export interface ProviderUsageWindow {
  /** Human label: "5-hour", "Weekly", or an additional-limit name. */
  label: string;
  /** 0-100 as reported by the provider, or null when unknown. */
  usedPercent: number | null;
  /** clamp(100 - usedPercent, 0, 100), or null when unknown. */
  remainingPercent: number | null;
  windowSeconds: number | null;
  /** Unix seconds. */
  resetAt: number | null;
}

export interface ProviderUsageSummary {
  planType?: string;
  windows: ProviderUsageWindow[];
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  /** ISO 8601 timestamp of the fetch. */
  capturedAt: string;
}
```

- [ ] **Step 4: Add `usage?()` to the `Provider` interface**

In `packages/core/src/providers/Provider.ts`, change the type import to include `ProviderUsageSummary`:

```ts
import type {
  JSONSchema,
  ModelConfig,
  ProviderModel,
  ProviderUsageSummary,
} from '@legion-collective/types';
```

Add after `listModels?()`:

```ts
  /** Optional: report the provider account's plan usage windows. */
  usage?(): Promise<ProviderUsageSummary>;
```

- [ ] **Step 5: Add `status` to `ProviderError`**

Replace the class in `packages/core/src/errors/LegionError.ts`:

```ts
export class ProviderError extends LegionError {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message, 'PROVIDER_ERROR');
    this.status = status;
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/errors/LegionError.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/usage.ts packages/core/src/providers/Provider.ts \
  packages/core/src/errors/LegionError.ts packages/core/src/errors/LegionError.test.ts
git commit -m "feat(types): add provider usage summary and ProviderError status"
```

---

## Task 2: Extract reusable hooks from `OpenAIResponsesProvider`

**Files:**

- Modify: `packages/core/src/providers/OpenAIResponsesProvider.ts`
- Test: `packages/core/src/providers/OpenAIResponsesProvider.test.ts`

**Interfaces:**

- Produces (protected, for subclasses): `buildRequestBody(messages, tools, model)`, `requestHeaders()`, `responsesUrl()`, `parseStream(res, options?)`.
- Existing `stream()` behaviour is unchanged.

- [ ] **Step 1: Write the failing test**

Append inside `describe('OpenAIResponsesProvider', ...)` in `packages/core/src/providers/OpenAIResponsesProvider.test.ts`:

```ts
class ExposedResponsesProvider extends OpenAIResponsesProvider {
  async *parse(res: Response, options?: { signal?: AbortSignal }) {
    yield* this.parseStream(res, options);
  }
  headers(): Record<string, string> {
    return this.requestHeaders();
  }
  url(): string {
    return this.responsesUrl();
  }
}

it('exposes parseStream, requestHeaders, and responsesUrl to subclasses', async () => {
  const provider = new ExposedResponsesProvider('https://example.test/v1/', 'sk-key');
  expect(provider.url()).toBe('https://example.test/v1/responses');
  expect(provider.headers()).toMatchObject({ Authorization: 'Bearer sk-key' });

  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of provider.parse(sse(textCompleted('Hi')) as unknown as Response)) {
    chunks.push(chunk);
  }
  expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.delta)).toEqual(['Hi']);
  expect(chunks.at(-1)?.type).toBe('done');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts -t "exposes parseStream"`
Expected: FAIL — `parseStream`/`requestHeaders`/`responsesUrl` do not exist or are private.

- [ ] **Step 3: Refactor `stream()` into hooks**

In `packages/core/src/providers/OpenAIResponsesProvider.ts`, replace the body of `stream()` up to the reader setup with:

```ts
  async *stream(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ProviderStreamChunk> {
    const body = this.buildRequestBody(messages, tools, model);

    const res = await fetch(this.responsesUrl(), {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `OpenAI-compatible API error ${res.status}: ${text.slice(0, 200)}`,
        res.status,
      );
    }

    yield* this.parseStream(res, options);
  }

  protected responsesUrl(): string {
    return `${this.baseUrl}/responses`;
  }

  protected requestHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...authHeaders(this.apiKey),
    };
  }
```

Then move everything from `if (!res.body) { ... }` through the final `yield { type: 'done', ... }` into a new protected method:

```ts
  protected async *parseStream(
    res: Response,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ProviderStreamChunk> {
    if (!res.body) {
      throw new ProviderError('OpenAI-compatible API returned no response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawTerminal = false;
    let stopReason: ProviderStopReason = 'stop';
    let usage = undefined as ReturnType<typeof mapUsage>;
    let completed = false;
    const state: StreamState = {
      reasoningMode: undefined,
      emittedToolCall: false,
      toolKeyToIndex: new Map(),
      nextSyntheticIndex: 0,
    };

    try {
      while (!sawTerminal) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === ':') continue;
          if (!trimmed.startsWith('data:')) continue;

          const raw = trimmed.slice(5).trim();
          if (raw === '[DONE]') continue;

          let event: ResponsesEvent;
          try {
            event = JSON.parse(raw) as ResponsesEvent;
          } catch {
            continue;
          }

          for (const chunk of this.handleEvent(event, state)) {
            if (chunk.type === 'done') {
              sawTerminal = true;
              stopReason = chunk.stopReason;
              if (chunk.usage) usage = chunk.usage;
            } else {
              yield chunk;
            }
          }
          if (sawTerminal) break;
        }
      }
      completed = true;
    } finally {
      if (!completed || options?.signal?.aborted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    if (!sawTerminal) {
      throw new ProviderError('Responses stream ended without a terminal event');
    }

    yield { type: 'done', stopReason, usage, cost: undefined };
  }
```

Change `private buildRequestBody(` to `protected buildRequestBody(`.

- [ ] **Step 4: Run the provider tests**

Run: `npx vitest run packages/core/src/providers/OpenAIResponsesProvider.test.ts`
Expected: PASS — all existing tests plus the new hook test.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/OpenAIResponsesProvider.ts \
  packages/core/src/providers/OpenAIResponsesProvider.test.ts
git commit -m "refactor(providers): expose Responses stream hooks for subclasses"
```

---

## Task 3: Codex OAuth primitives (`codex-auth.ts`)

**Files:**

- Create: `packages/core/src/providers/codex-auth.ts`
- Test: `packages/core/src/providers/codex-auth.test.ts`

**Interfaces:**

- Produces: `getClientId()`, `requestDeviceCode(clientId?)`, `pollDeviceCode({ deviceAuthId, userCode })`, `exchangeAuthorizationCode({ clientId, code, codeVerifier })`, `refreshTokens({ clientId, refreshToken })`, `revokeToken({ clientId, token })`, `tokenExpiry(token?)`, `extractClaims(idToken?)`, `isRefreshTokenFailure(err)`.
- Produces types: `DeviceCode`, `DeviceTokens`, `TokenSet`, `CodexClaims`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/providers/codex-auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/codex-auth.test.ts`
Expected: FAIL — module `./codex-auth.js` not found.

- [ ] **Step 3: Implement `codex-auth.ts`**

Create `packages/core/src/providers/codex-auth.ts`:

```ts
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
  const detail =
    asString(body['detail']) ??
    asString(body['error_description']) ??
    asString(body['error']) ??
    `HTTP ${res.status}`;
  return detail.slice(0, 200);
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/codex-auth.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/codex-auth.ts \
  packages/core/src/providers/codex-auth.test.ts
git commit -m "feat(providers): add Codex device-code OAuth primitives"
```

---

## Task 4: `CodexAuthStore` with atomic 0600 persistence

**Files:**

- Create: `packages/core/src/providers/CodexAuthStore.ts`
- Test: `packages/core/src/providers/CodexAuthStore.test.ts`

**Interfaces:**

- Produces: `CodexAuth` (`clientId`, `issuer`, `accountId?`, `email?`, `plan?`, `idToken?`, `accessToken`, `refreshToken`, `expiresAt`, `savedAt`).
- Produces: `new CodexAuthStore(dir)`, `read(name)`, `save(name, auth)`, `delete(name)`, `ensureFresh(name, force?)`, `buildAuth(tokens, clientId?)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/providers/CodexAuthStore.test.ts`:

```ts
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CodexAuthStore, type CodexAuth } from './CodexAuthStore.js';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/CodexAuthStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `CodexAuthStore.ts`**

Create `packages/core/src/providers/CodexAuthStore.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProviderError } from '../errors/LegionError.js';
import { withKeyedLock } from '../storage/keyed-lock.js';
import {
  extractClaims,
  getClientId,
  isRefreshTokenFailure,
  refreshTokens,
  tokenExpiry,
  type TokenSet,
} from './codex-auth.js';

export interface CodexAuth {
  clientId: string;
  issuer: string;
  accountId?: string;
  email?: string;
  plan?: string;
  idToken?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  savedAt: string;
}

const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const REFRESH_MARGIN_SECONDS = 300;
const ISSUER = 'https://auth.openai.com';

export function buildAuth(tokens: TokenSet, clientId = getClientId()): CodexAuth {
  const claims = extractClaims(tokens.idToken);
  return {
    clientId,
    issuer: ISSUER,
    accountId: claims.accountId,
    email: claims.email,
    plan: claims.plan,
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    savedAt: new Date().toISOString(),
  };
}

export class CodexAuthStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  private path(name: string): string {
    if (!PROVIDER_NAME_PATTERN.test(name)) throw new ProviderError('Invalid provider name');
    return join(this.dir, `${name}.json`);
  }

  async read(name: string): Promise<CodexAuth | null> {
    try {
      return JSON.parse(await readFile(this.path(name), 'utf8')) as CodexAuth;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof SyntaxError) {
        throw new ProviderError(`Codex auth file for '${name}' is corrupt; sign in again`);
      }
      throw err;
    }
  }

  async save(name: string, auth: CodexAuth): Promise<void> {
    const target = this.path(name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, target);
    await chmod(target, 0o600).catch(() => undefined);
  }

  async delete(name: string): Promise<void> {
    await rm(this.path(name), { force: true });
  }

  async ensureFresh(name: string, force = false): Promise<CodexAuth> {
    return withKeyedLock(this.locks, this.path(name), async () => {
      const current = await this.read(name);
      if (!current) throw new ProviderError('Not signed in to ChatGPT');

      const now = Math.floor(Date.now() / 1000);
      if (!force && current.expiresAt - now >= REFRESH_MARGIN_SECONDS) return current;

      try {
        const tokens = await refreshTokens({
          clientId: current.clientId,
          refreshToken: current.refreshToken,
        });
        const claims = extractClaims(tokens.idToken ?? current.idToken);
        const next: CodexAuth = {
          ...current,
          idToken: tokens.idToken ?? current.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokenExpiry(tokens.accessToken) ?? tokens.expiresAt,
          accountId: claims.accountId ?? current.accountId,
          email: claims.email ?? current.email,
          plan: claims.plan ?? current.plan,
          savedAt: new Date().toISOString(),
        };
        await this.save(name, next);
        return next;
      } catch (err) {
        if (isRefreshTokenFailure(err)) {
          await this.delete(name).catch(() => undefined);
          throw new ProviderError('ChatGPT session expired; sign in again', 401);
        }
        throw err;
      }
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/CodexAuthStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/CodexAuthStore.ts \
  packages/core/src/providers/CodexAuthStore.test.ts
git commit -m "feat(providers): persist Codex credentials with 0600 atomic writes"
```

---

## Task 5: `CodexProvider` and usage normalization

**Files:**

- Create: `packages/core/src/providers/codex-usage.ts`
- Create: `packages/core/src/providers/CodexProvider.ts`
- Test: `packages/core/src/providers/codex-usage.test.ts`
- Test: `packages/core/src/providers/CodexProvider.test.ts`

**Interfaces:**

- Produces: `normalizeCodexUsage(raw): ProviderUsageSummary`.
- Produces: `new CodexProvider(config, authStore)`; overrides `stream`, `listModels`, `usage`.
- Consumes: `CodexAuthStore.ensureFresh`, `OpenAIResponsesProvider.buildRequestBody`/`parseStream`/`responsesUrl`.

- [ ] **Step 1: Write the failing usage-normalization tests**

Create `packages/core/src/providers/codex-usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeCodexUsage } from './codex-usage.js';

describe('normalizeCodexUsage', () => {
  it('maps primary and secondary windows with labels and remaining percentages', () => {
    const summary = normalizeCodexUsage({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: 12, reset_at: 1790036132 },
        secondary_window: { limit_window_seconds: 604800, used_percent: 40, reset_at: 1790640932 },
      },
      credits: { has_credits: true, unlimited: false, balance: '4.50' },
    });

    expect(summary.planType).toBe('plus');
    expect(summary.windows).toEqual([
      {
        label: '5-hour',
        usedPercent: 12,
        remainingPercent: 88,
        windowSeconds: 18000,
        resetAt: 1790036132,
      },
      {
        label: 'Weekly',
        usedPercent: 40,
        remainingPercent: 60,
        windowSeconds: 604800,
        resetAt: 1790640932,
      },
    ]);
    expect(summary.credits).toEqual({ hasCredits: true, unlimited: false, balance: '4.50' });
  });

  it('labels additional rate limits and clamps percentages', () => {
    const summary = normalizeCodexUsage({
      additional_rate_limits: [
        {
          limit_name: 'GPT-5 Codex',
          rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 120 } },
        },
      ],
    });

    expect(summary.windows).toEqual([
      {
        label: 'GPT-5 Codex 5-hour',
        usedPercent: 120,
        remainingPercent: 0,
        windowSeconds: 18000,
        resetAt: null,
      },
    ]);
  });

  it('returns empty windows for an unrecognized body', () => {
    expect(normalizeCodexUsage({}).windows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/src/providers/codex-usage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `codex-usage.ts`**

Create `packages/core/src/providers/codex-usage.ts`:

```ts
import type { ProviderUsageSummary, ProviderUsageWindow } from '@legion-collective/types';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function windowLabel(seconds: number): string {
  if (seconds === 18_000) return '5-hour';
  if (seconds === 604_800) return 'Weekly';
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}-hour`;
  return `${Math.round(seconds / 86_400)}-day`;
}

function mapWindow(
  raw: unknown,
  fallbackLabel: string,
  prefix?: string,
): ProviderUsageWindow | null {
  const window = asRecord(raw);
  if (Object.keys(window).length === 0) return null;

  const windowSeconds = asNumber(window['limit_window_seconds']);
  const used = asNumber(window['used_percent']);
  const resetAt = asNumber(window['reset_at']);

  const label =
    windowSeconds === null
      ? fallbackLabel
      : prefix
        ? `${prefix} ${windowLabel(windowSeconds)}`
        : windowLabel(windowSeconds);

  return {
    label,
    usedPercent: used,
    remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
    windowSeconds,
    resetAt,
  };
}

export function normalizeCodexUsage(raw: unknown): ProviderUsageSummary {
  const body = asRecord(raw);
  const windows: ProviderUsageWindow[] = [];

  const rateLimit = asRecord(body['rate_limit']);
  const primary = mapWindow(rateLimit['primary_window'], 'Primary');
  if (primary) windows.push(primary);
  const secondary = mapWindow(rateLimit['secondary_window'], 'Secondary');
  if (secondary) windows.push(secondary);

  const additional = body['additional_rate_limits'];
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const item = asRecord(entry);
      const prefix =
        asString(item['limit_name']) ?? asString(item['metered_feature']) ?? 'Additional';
      const nested = asRecord(item['rate_limit']);
      const p = mapWindow(nested['primary_window'], 'Primary', prefix);
      if (p) windows.push(p);
      const s = mapWindow(nested['secondary_window'], 'Secondary', prefix);
      if (s) windows.push(s);
    }
  }

  const creditsRaw = asRecord(body['credits']);
  const credits =
    Object.keys(creditsRaw).length > 0
      ? {
          hasCredits: creditsRaw['has_credits'] === true,
          unlimited: creditsRaw['unlimited'] === true,
          balance: asString(creditsRaw['balance']),
        }
      : null;

  return {
    planType: asString(body['plan_type']) ?? undefined,
    windows,
    credits,
    capturedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/core/src/providers/codex-usage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing provider tests**

Create `packages/core/src/providers/CodexProvider.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CodexProvider } from './CodexProvider.js';
import type { CodexAuthStore } from './CodexAuthStore.js';
import { ProviderError } from '../errors/LegionError.js';
import type { ProviderStreamChunk } from './Provider.js';

const AUTH = {
  clientId: 'client-1',
  issuer: 'https://auth.openai.com',
  accountId: 'acct-1',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  savedAt: '2026-11-17T05:00:00.000Z',
};

function makeStore(ensureFresh = vi.fn(async () => AUTH)): CodexAuthStore {
  return { ensureFresh } as unknown as CodexAuthStore;
}

function makeSse(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
}

function sse(events: Record<string, unknown>[]): Response {
  return new Response(makeSse(events.map((e) => `data: ${JSON.stringify(e)}`)), { status: 200 });
}

function textEvents(text: string): Record<string, unknown>[] {
  return [
    { type: 'response.created', response: { id: 'r1' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: { id: 'r1', usage: { input_tokens: 4, output_tokens: 2 } },
    },
  ];
}

async function drain(
  provider: CodexProvider,
  messages: Parameters<CodexProvider['stream']>[0],
  tools: Parameters<CodexProvider['stream']>[1] = [],
  model: Parameters<CodexProvider['stream']>[2] = { model: 'gpt-5.5' },
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream(messages, tools, model)) chunks.push(chunk);
  return chunks;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CodexProvider', () => {
  it('posts sanitized body and Codex headers, and records cost 0', async () => {
    fetchMock.mockResolvedValue(sse(textEvents('Hello')));

    const provider = new CodexProvider({ name: 'Codex', type: 'codex', priority: 10 }, makeStore());
    const chunks = await drain(
      provider,
      [
        { role: 'system', content: 'Be terse.' },
        { role: 'system', content: 'No filler.' },
        { role: 'user', content: 'hi' },
      ],
      [],
      { model: 'gpt-5.5', temperature: 0.2, maxTokens: 100 },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'chatgpt-account-id': 'acct-1',
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/0.0.1',
      'OpenAI-Beta': 'responses=experimental',
    });

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['temperature']).toBeUndefined();
    expect(body['max_output_tokens']).toBeUndefined();
    expect(body['instructions']).toBe('Be terse.\n\nNo filler.');
    expect(body['input']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body['parallel_tool_calls']).toBe(false);
    expect(body['include']).toEqual(['reasoning.encrypted_content']);

    expect(chunks.filter((c) => c.type === 'text_delta')).toEqual([
      { type: 'text_delta', delta: 'Hello' },
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop', cost: 0 });
  });

  it('defaults empty instructions and retries once on 401 with a forced refresh', async () => {
    const ensureFresh = vi
      .fn()
      .mockResolvedValueOnce(AUTH)
      .mockResolvedValueOnce({ ...AUTH, accessToken: 'new-token' });
    fetchMock
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(sse(textEvents('ok')));

    const provider = new CodexProvider(
      { name: 'Codex', type: 'codex', priority: 10 },
      makeStore(ensureFresh),
    );
    await drain(provider, [{ role: 'user', content: 'hi' }]);

    expect(ensureFresh).toHaveBeenNthCalledWith(1, 'Codex');
    expect(ensureFresh).toHaveBeenNthCalledWith(2, 'Codex', true);
    const second = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(second[1].headers).toMatchObject({ Authorization: 'Bearer new-token' });
    const body = JSON.parse(second[1].body as string) as Record<string, unknown>;
    expect(body['instructions']).toBe('Follow the user request.');
  });

  it('propagates HTTP status on non-OK responses', async () => {
    fetchMock.mockResolvedValue(new Response('slow down', { status: 429 }));
    const provider = new CodexProvider({ name: 'Codex', type: 'codex', priority: 10 }, makeStore());

    await expect(drain(provider, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      status: 429,
    });
  });

  it('parses the Codex model catalog', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-5.5',
              display_name: 'GPT-5.5',
              context_window: 200000,
              input_modalities: ['text', 'image'],
            },
            { slug: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex' },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = new CodexProvider({ name: 'Codex', type: 'codex', priority: 10 }, makeStore());

    await expect(provider.listModels()).resolves.toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 200000, capabilities: ['vision'] },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    ]);
  });

  it('fetches and normalizes usage', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 10 } },
        }),
        { status: 200 },
      ),
    );
    const provider = new CodexProvider({ name: 'Codex', type: 'codex', priority: 10 }, makeStore());

    const usage = await provider.usage();
    expect(usage.planType).toBe('plus');
    expect(usage.windows[0]).toMatchObject({ label: '5-hour', remainingPercent: 90 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'chatgpt-account-id': 'acct-1',
    });
  });

  it('fails usage with a clear error when the account id is missing', async () => {
    const provider = new CodexProvider(
      { name: 'Codex', type: 'codex', priority: 10 },
      makeStore(vi.fn(async () => ({ ...AUTH, accountId: undefined }))),
    );

    await expect(provider.usage()).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.usage()).rejects.toThrow('sign in again');
  });
});
```

- [ ] **Step 6: Run the provider tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/CodexProvider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `CodexProvider.ts`**

Create `packages/core/src/providers/CodexProvider.ts`:

```ts
import type {
  ModelConfig,
  ProviderConfig,
  ProviderModel,
  ProviderUsageSummary,
} from '@legion-collective/types';
import { ProviderError } from '../errors/LegionError.js';
import type { CodexAuth, CodexAuthStore } from './CodexAuthStore.js';
import { normalizeCodexUsage } from './codex-usage.js';
import { OpenAIResponsesProvider } from './OpenAIResponsesProvider.js';
import type { ProviderMessage, ProviderStreamChunk, ProviderTool } from './Provider.js';

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USER_AGENT = 'codex_cli_rs/0.0.1';

export class CodexProvider extends OpenAIResponsesProvider {
  private readonly providerName: string;
  private readonly authStore: CodexAuthStore;
  private readonly usageUrl: string;

  constructor(config: ProviderConfig, authStore: CodexAuthStore) {
    super(config.baseUrl ?? process.env['LEGION_CODEX_BASE_URL'] ?? DEFAULT_BASE_URL, undefined);
    this.providerName = config.name;
    this.authStore = authStore;
    this.usageUrl = process.env['LEGION_CODEX_USAGE_URL'] ?? DEFAULT_USAGE_URL;
  }

  private headers(auth: CodexAuth, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      originator: 'codex_cli_rs',
      'User-Agent': USER_AGENT,
      'OpenAI-Beta': 'responses=experimental',
      Accept: accept,
    };
    if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;
    return headers;
  }

  private sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
    const out = { ...body };
    delete out['temperature'];
    delete out['max_output_tokens'];

    const input = Array.isArray(out['input']) ? (out['input'] as Record<string, unknown>[]) : [];
    const systemTexts = input
      .filter((item) => item['role'] === 'system')
      .map((item) => (typeof item['content'] === 'string' ? item['content'] : ''))
      .filter((text) => text.length > 0);

    const instructions = [out['instructions'], ...systemTexts]
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .join('\n\n');

    out['input'] = input.filter((item) => item['role'] !== 'system');
    out['instructions'] = instructions || 'Follow the user request.';
    out['parallel_tool_calls'] = false;
    out['include'] = ['reasoning.encrypted_content'];
    return out;
  }

  private async post(
    body: Record<string, unknown>,
    auth: CodexAuth,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(this.responsesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers(auth, 'text/event-stream') },
      body: JSON.stringify(body),
      signal,
    });
  }

  override async *stream(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ProviderStreamChunk> {
    let auth = await this.authStore.ensureFresh(this.providerName);
    const body = this.sanitizeBody(this.buildRequestBody(messages, tools, model));

    let res = await this.post(body, auth, options?.signal);
    if (res.status === 401) {
      auth = await this.authStore.ensureFresh(this.providerName, true);
      res = await this.post(body, auth, options?.signal);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`Codex API error ${res.status}: ${text.slice(0, 200)}`, res.status);
    }

    for await (const chunk of this.parseStream(res, options)) {
      if (chunk.type === 'done') yield { ...chunk, cost: 0 };
      else yield chunk;
    }
  }

  override async listModels(): Promise<ProviderModel[]> {
    try {
      const auth = await this.authStore.ensureFresh(this.providerName);
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(auth, 'application/json'),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as Record<string, unknown>;
      const raw = Array.isArray(data['models'])
        ? data['models']
        : Array.isArray(data['data'])
          ? data['data']
          : [];

      return raw.flatMap((entry): ProviderModel[] => {
        const item = entry as Record<string, unknown>;
        const id =
          typeof item['slug'] === 'string'
            ? item['slug']
            : typeof item['id'] === 'string'
              ? item['id']
              : undefined;
        if (!id) return [];

        const name =
          typeof item['display_name'] === 'string'
            ? item['display_name']
            : typeof item['name'] === 'string'
              ? item['name']
              : id;
        const contextWindow =
          typeof item['context_window'] === 'number' ? item['context_window'] : undefined;
        const modalities = Array.isArray(item['input_modalities']) ? item['input_modalities'] : [];
        const capabilities: ProviderModel['capabilities'] = modalities.includes('image')
          ? ['vision']
          : undefined;

        return [{ id, name, contextWindow, capabilities }];
      });
    } catch {
      return [];
    }
  }

  async usage(): Promise<ProviderUsageSummary> {
    const auth = await this.authStore.ensureFresh(this.providerName);
    if (!auth.accountId) throw new ProviderError('Codex account id missing; sign in again');

    const res = await fetch(this.usageUrl, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'chatgpt-account-id': auth.accountId,
        originator: 'codex_cli_rs',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`Codex usage error ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    return normalizeCodexUsage(await res.json());
  }
}
```

- [ ] **Step 8: Run both test files**

Run: `npx vitest run packages/core/src/providers/codex-usage.test.ts packages/core/src/providers/CodexProvider.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/providers/codex-usage.ts \
  packages/core/src/providers/CodexProvider.ts \
  packages/core/src/providers/codex-usage.test.ts \
  packages/core/src/providers/CodexProvider.test.ts
git commit -m "feat(providers): add Codex backend provider and usage normalization"
```

---

## Task 6: Construct `codex` in `SystemProviderStore`

**Files:**

- Modify: `packages/core/src/providers/SystemProviderStore.ts`
- Test: `packages/core/src/providers/SystemProviderStore.test.ts`

**Interfaces:**

- Produces: `new SystemProviderStore(storage, codexAuth?)`; `list()` returns only `*.json`; `get()` constructs `CodexProvider` when a store is present.

- [ ] **Step 1: Update the failing tests**

In `packages/core/src/providers/SystemProviderStore.test.ts`:

Replace the `get() throws NotImplementedError for codex` test with:

```ts
it('get() throws ProviderError for codex when no auth store is configured', async () => {
  const storage = new MemoryStorage();
  await storage.writeJson('providers/codex.json', providerConfig({ name: 'codex', type: 'codex' }));
  const store = new SystemProviderStore(storage);

  await expect(store.get('codex')).rejects.toMatchObject({ name: 'ProviderError' });
});

it('get() constructs a CodexProvider when an auth store is configured', async () => {
  const storage = new MemoryStorage();
  await storage.writeJson('providers/codex.json', providerConfig({ name: 'codex', type: 'codex' }));
  const store = new SystemProviderStore(storage, new CodexAuthStore('/tmp/codex-auth-test'));

  const provider = await store.get('codex');

  expect(provider).not.toBeNull();
  expect(typeof provider!.stream).toBe('function');
  expect(typeof provider!.usage).toBe('function');
});

it('list() ignores the .codex-auth credential directory', async () => {
  const storage = new MemoryStorage();
  await storage.writeJson('providers/local.json', providerConfig());
  await storage.writeJson('providers/.codex-auth/Codex.json', {
    accessToken: 'a',
    refreshToken: 'r',
  });
  const store = new SystemProviderStore(storage);

  const configs = await store.list();

  expect(configs.map((c) => c.name)).toEqual(['test-provider']);
});
```

Add imports at the top:

```ts
import { CodexAuthStore } from './CodexAuthStore.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/SystemProviderStore.test.ts`
Expected: FAIL — codex still throws `NotImplementedError`; `.codex-auth` is read as a config.

- [ ] **Step 3: Implement the store changes**

In `packages/core/src/providers/SystemProviderStore.ts`:

Add imports:

```ts
import { ProviderError } from '../errors/LegionError.js';
import { CodexAuthStore } from './CodexAuthStore.js';
import { CodexProvider } from './CodexProvider.js';
```

Change the constructor:

```ts
  constructor(
    private storage: Storage,
    private codexAuth?: CodexAuthStore,
  ) {}
```

Filter `list()`:

```ts
  async list(): Promise<ProviderConfig[]> {
    const keys = await this.storage.list('providers/');
    const configs = await Promise.all(
      keys
        .filter((key) => key.endsWith('.json'))
        .map((key) => this.storage.readJson<ProviderConfig>(`providers/${key}`)),
    );
    const valid = configs.filter((config): config is ProviderConfig => config !== null);
    return valid.sort((a, b) => a.priority - b.priority);
  }
```

Replace the `construct` switch:

```ts
  private construct(config: ProviderConfig): Provider {
    switch (config.type) {
      case 'openai-compatible':
      case 'anthropic':
        return new OpenAICompatibleProvider(config.baseUrl, config.apiKey);
      case 'openai-responses':
        return new OpenAIResponsesProvider(config.baseUrl, config.apiKey);
      case 'codex':
        if (!this.codexAuth) {
          throw new ProviderError('Codex auth store not configured');
        }
        return new CodexProvider(config, this.codexAuth);
      case 'copilot':
        throw new NotImplementedError(
          `Provider type '${config.type}' is not yet implemented. OAuth support coming soon.`,
        );
    }
  }
```

Remove `codex` from the `NotImplementedError` case.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/SystemProviderStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/SystemProviderStore.ts \
  packages/core/src/providers/SystemProviderStore.test.ts
git commit -m "feat(providers): construct codex providers and skip auth directory"
```

---

## Task 7: `CodexLoginManager` for device-flow orchestration

**Files:**

- Create: `packages/core/src/providers/CodexLoginManager.ts`
- Test: `packages/core/src/providers/CodexLoginManager.test.ts`

**Interfaces:**

- Produces: `new CodexLoginManager(authStore)`, `start(providerName, priority)`, `poll(flowId)`.
- `start` returns `{ flowId, providerName, verificationUrl, userCode, intervalSeconds, expiresAt }` (`expiresAt` ISO).
- `poll` returns `{ status: 'pending', intervalSeconds }` | `{ status: 'expired' }` | `{ status: 'complete', providerName, priority, account }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/providers/CodexLoginManager.test.ts`:

```ts
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
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/providers/CodexLoginManager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `CodexLoginManager.ts`**

Create `packages/core/src/providers/CodexLoginManager.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { ProviderError } from '../errors/LegionError.js';
import { buildAuth, type CodexAuthStore } from './CodexAuthStore.js';
import {
  exchangeAuthorizationCode,
  getClientId,
  pollDeviceCode,
  requestDeviceCode,
} from './codex-auth.js';

const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface LoginStartResult {
  flowId: string;
  providerName: string;
  verificationUrl: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
}

export type LoginPollResult =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'expired' }
  | {
      status: 'complete';
      providerName: string;
      priority: number;
      account: { email?: string; plan?: string };
    };

interface PendingLogin {
  flowId: string;
  providerName: string;
  priority: number;
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
  verificationUrl: string;
}

export class CodexLoginManager {
  private readonly flows = new Map<string, PendingLogin>();

  constructor(private readonly authStore: CodexAuthStore) {}

  async start(providerName: string, priority: number): Promise<LoginStartResult> {
    if (!PROVIDER_NAME_PATTERN.test(providerName)) {
      throw new ProviderError('Invalid provider name');
    }

    const code = await requestDeviceCode(getClientId());
    const flow: PendingLogin = {
      flowId: randomUUID(),
      providerName,
      priority,
      deviceAuthId: code.deviceAuthId,
      userCode: code.userCode,
      intervalSeconds: code.intervalSeconds,
      expiresAt: code.expiresAt,
      verificationUrl: code.verificationUrl,
    };
    this.flows.set(flow.flowId, flow);

    return {
      flowId: flow.flowId,
      providerName,
      verificationUrl: flow.verificationUrl,
      userCode: flow.userCode,
      intervalSeconds: flow.intervalSeconds,
      expiresAt: new Date(flow.expiresAt * 1000).toISOString(),
    };
  }

  async poll(flowId: string): Promise<LoginPollResult> {
    const flow = this.flows.get(flowId);
    if (!flow) return { status: 'expired' };

    if (Math.floor(Date.now() / 1000) >= flow.expiresAt) {
      this.flows.delete(flowId);
      return { status: 'expired' };
    }

    const tokens = await pollDeviceCode({
      deviceAuthId: flow.deviceAuthId,
      userCode: flow.userCode,
    });
    if (!tokens) return { status: 'pending', intervalSeconds: flow.intervalSeconds };

    const clientId = getClientId();
    const exchanged = await exchangeAuthorizationCode({
      clientId,
      code: tokens.authorizationCode,
      codeVerifier: tokens.codeVerifier,
    });
    const auth = buildAuth(exchanged, clientId);
    await this.authStore.save(flow.providerName, auth);
    this.flows.delete(flowId);

    return {
      status: 'complete',
      providerName: flow.providerName,
      priority: flow.priority,
      account: { email: auth.email, plan: auth.plan },
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/providers/CodexLoginManager.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/CodexLoginManager.ts \
  packages/core/src/providers/CodexLoginManager.test.ts
git commit -m "feat(providers): orchestrate Codex device-code login flows"
```

---

## Task 8: Runtime operator tools for login, status, logout, and usage

**Files:**

- Modify: `packages/core/src/index.ts`
- Modify: `packages/runtime/src/server/runtime-tools.ts`
- Test: `packages/runtime/src/server/runtime-tools.test.ts`

**Interfaces:**

- Consumes: `CodexAuthStore`, `CodexLoginManager`, `revokeToken`.
- Produces: five tools in `createRuntimeTools`; `codexAuth?: CodexAuthStore` dependency.
- `save_provider` accepts `codex`; `SUPPORTED_PROVIDER_TYPES` includes it.

- [ ] **Step 1: Export the new core modules**

In `packages/core/src/index.ts`, add after the existing provider exports:

```ts
export * from './providers/codex-auth.js';
export * from './providers/CodexAuthStore.js';
export * from './providers/CodexLoginManager.js';
export * from './providers/CodexProvider.js';
export * from './providers/codex-usage.js';
```

- [ ] **Step 2: Update the failing runtime-tool tests**

In `packages/runtime/src/server/runtime-tools.test.ts`:

Add imports:

```ts
import type { CodexAuthStore } from '@legion-collective/core';
import type { ProviderUsageSummary } from '@legion-collective/types';
```

Extend the existing `ProviderStub` type:

```ts
type ProviderStub = {
  listModels?: () => Promise<ProviderModel[]>;
  usage?: () => Promise<ProviderUsageSummary>;
};
```

Add a helper after `makeSystemStore`:

```ts
function makeCodexAuth(
  overrides: Partial<Record<'read' | 'save' | 'delete' | 'ensureFresh', unknown>> = {},
): CodexAuthStore {
  return {
    read: async () => null,
    save: async () => undefined,
    delete: async () => undefined,
    ensureFresh: async () => {
      throw new Error('not signed in');
    },
    ...overrides,
  } as unknown as CodexAuthStore;
}
```

Update `makeDeps` to include `codexAuth: undefined` in the returned object:

```ts
    codexAuth: undefined,
```

Update the tool-list assertion in `exposes only provider and routing tools`:

```ts
expect(tools.map((t) => t.name)).toEqual([
  'list_providers',
  'save_provider',
  'delete_provider',
  'list_models',
  'get_routing',
  'save_routing',
  'list_pending_approvals',
  'list_mcp_sources',
  'save_mcp_sources',
  'openai_login_start',
  'openai_login_poll',
  'openai_auth_status',
  'openai_logout',
  'openai_usage',
]);
```

Update `save_provider advertises only the constructible provider types`:

```ts
expect(schema.properties?.type?.enum).toEqual(['openai-compatible', 'openai-responses', 'codex']);
```

In `save_provider rejects unsupported provider types`, change the first payload's type from `'codex'` to `'copilot'` and update the assertion:

```ts
await expect(
  tool(tools, 'save_provider').execute({ name: 'unsupported', type: 'copilot', priority: 1 }),
).resolves.toEqual({ status: 'error', error: expect.stringContaining('copilot') });
```

Add tests inside `describe('runtime tools', ...)`:

```ts
it('save_provider accepts codex without a base URL or API key', async () => {
  const systemStore = makeSystemStore();
  const tools = createRuntimeTools(makeDeps({ systemStore }));

  await expect(
    tool(tools, 'save_provider').execute({ name: 'Codex', type: 'codex', priority: 5 }),
  ).resolves.toEqual({
    status: 'success',
    data: { name: 'Codex', type: 'codex', priority: 5 },
  });
  expect(systemStore._store.get('Codex')).toEqual({
    name: 'Codex',
    type: 'codex',
    priority: 5,
  });
});

it('openai_login_start returns device-code display data', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        device_auth_id: 'd1',
        user_code: 'CODE-1',
        interval: '5',
        expires_at: '2026-11-17T06:00:00Z',
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const tools = createRuntimeTools(makeDeps({ codexAuth: makeCodexAuth() }));

  try {
    const result = await tool(tools, 'openai_login_start').execute({ providerName: 'Codex' });
    expect(result.status).toBe('success');
    expect(result.data).toMatchObject({
      providerName: 'Codex',
      userCode: 'CODE-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('openai_login_poll creates the provider config on completion', async () => {
  const idToken = `x.${Buffer.from(
    JSON.stringify({
      email: 'user@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct', chatgpt_plan_type: 'plus' },
    }),
  ).toString('base64url')}.y`;
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ device_auth_id: 'd1', user_code: 'CODE-1', interval: '5' }), {
        status: 200,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ authorization_code: 'ac', code_verifier: 'cv' }), {
        status: 200,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', id_token: idToken }), {
        status: 200,
      }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const systemStore = makeSystemStore();
  const tools = createRuntimeTools(makeDeps({ systemStore, codexAuth: makeCodexAuth() }));

  try {
    const started = await tool(tools, 'openai_login_start').execute({ providerName: 'Codex' });
    const flowId = (started.data as { flowId: string }).flowId;
    const result = await tool(tools, 'openai_login_poll').execute({ flowId });

    expect(result).toMatchObject({
      status: 'success',
      data: { status: 'complete', providerName: 'Codex', priority: 10 },
    });
    expect(systemStore._store.get('Codex')).toEqual({
      name: 'Codex',
      type: 'codex',
      priority: 10,
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('openai_auth_status reports account metadata without tokens', async () => {
  const codexAuth = makeCodexAuth({
    read: async () => ({
      clientId: 'c',
      issuer: 'https://auth.openai.com',
      accountId: 'acct',
      email: 'user@example.com',
      plan: 'plus',
      accessToken: 'secret',
      refreshToken: 'secret',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      savedAt: '2026-11-17T05:00:00.000Z',
    }),
  });
  const tools = createRuntimeTools(makeDeps({ codexAuth }));

  const result = await tool(tools, 'openai_auth_status').execute({ providerName: 'Codex' });
  expect(result).toEqual({
    status: 'success',
    data: {
      signedIn: true,
      email: 'user@example.com',
      plan: 'plus',
      accountId: 'acct',
      expiresAt: expect.any(Number),
      expired: false,
    },
  });
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('openai_auth_status reports signed out when no auth file exists', async () => {
  const tools = createRuntimeTools(makeDeps({ codexAuth: makeCodexAuth() }));
  await expect(
    tool(tools, 'openai_auth_status').execute({ providerName: 'Codex' }),
  ).resolves.toEqual({ status: 'success', data: { signedIn: false } });
});

it('openai_logout revokes and deletes the auth file', async () => {
  const deleted: string[] = [];
  const codexAuth = makeCodexAuth({
    read: async () => ({
      clientId: 'c',
      issuer: 'https://auth.openai.com',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      savedAt: '2026-11-17T05:00:00.000Z',
    }),
    delete: async (name: string) => void deleted.push(name),
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
  const tools = createRuntimeTools(makeDeps({ codexAuth }));

  try {
    await expect(tool(tools, 'openai_logout').execute({ providerName: 'Codex' })).resolves.toEqual({
      status: 'success',
      data: { signedOut: true, revoked: true },
    });
    expect(deleted).toEqual(['Codex']);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('openai_logout succeeds when there is nothing to revoke', async () => {
  const tools = createRuntimeTools(makeDeps({ codexAuth: makeCodexAuth() }));
  await expect(tool(tools, 'openai_logout').execute({ providerName: 'Codex' })).resolves.toEqual({
    status: 'success',
    data: { signedOut: true, revoked: false },
  });
});

it('openai_usage delegates to the provider usage method', async () => {
  const summary = {
    planType: 'plus',
    windows: [
      {
        label: '5-hour',
        usedPercent: 12,
        remainingPercent: 88,
        windowSeconds: 18000,
        resetAt: 1790036132,
      },
    ],
    capturedAt: '2026-11-17T05:00:00.000Z',
  };
  const systemStore = makeSystemStore([{ name: 'Codex', type: 'codex', priority: 10 }], {
    Codex: { usage: async () => summary },
  });
  const tools = createRuntimeTools(makeDeps({ systemStore }));

  await expect(tool(tools, 'openai_usage').execute({ providerName: 'Codex' })).resolves.toEqual({
    status: 'success',
    data: summary,
  });
});

it('openai_usage errors for a provider without usage support', async () => {
  const systemStore = makeSystemStore([{ name: 'local', type: 'openai-compatible', priority: 1 }], {
    local: {},
  });
  const tools = createRuntimeTools(makeDeps({ systemStore }));

  await expect(tool(tools, 'openai_usage').execute({ providerName: 'local' })).resolves.toEqual({
    status: 'error',
    error: expect.stringContaining('does not expose usage'),
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/runtime/src/server/runtime-tools.test.ts`
Expected: FAIL — the five tools are missing and `codex` is rejected.

- [ ] **Step 4: Implement the runtime tool changes**

In `packages/runtime/src/server/runtime-tools.ts`:

Update imports:

```ts
import type { Tool, SystemProviderStore } from '@legion-collective/core';
import type { AuthEngine, PendingApprovalRegistry } from '@legion-collective/core';
import type { CodexAuthStore } from '@legion-collective/core';
import { CodexLoginManager, revokeToken } from '@legion-collective/core';
```

Add `codex` to `SUPPORTED_PROVIDER_TYPES`:

```ts
const SUPPORTED_PROVIDER_TYPES = new Set<ProviderConfig['type']>([
  'openai-compatible',
  'openai-responses',
  'codex',
]);
```

Add to `RuntimeToolDeps`:

```ts
  codexAuth?: CodexAuthStore;
```

Destructure it:

```ts
    saveMCPServers,
    codexAuth,
  } = deps;
```

After the destructuring, add:

```ts
const codexLogin = codexAuth ? new CodexLoginManager(codexAuth) : null;
```

Add `codex` to the `save_provider` enum:

```ts
            enum: ['openai-compatible', 'openai-responses', 'codex'],
```

Append the five tools to the returned array, after `save_mcp_sources`:

```ts
    {
      name: 'openai_login_start',
      description: 'Start an OpenAI Codex device-code login for a provider.',
      parameters: {
        type: 'object',
        properties: {
          providerName: { type: 'string' },
          priority: { type: 'number' },
        },
        required: ['providerName'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          if (!codexLogin) throw new Error('Codex auth store not configured');
          const { providerName, priority } = rawArgs as {
            providerName: string;
            priority?: number;
          };
          return {
            status: 'success',
            data: await codexLogin.start(providerName, priority ?? 10),
          };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'openai_login_poll',
      description: 'Poll an in-progress OpenAI Codex device-code login.',
      parameters: {
        type: 'object',
        properties: { flowId: { type: 'string' } },
        required: ['flowId'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          if (!codexLogin) throw new Error('Codex auth store not configured');
          const { flowId } = rawArgs as { flowId: string };
          const result = await codexLogin.poll(flowId);

          if (result.status === 'complete') {
            const existing = (await systemStore.list()).find(
              (config) => config.name === result.providerName,
            );
            if (!existing) {
              await systemStore.save({
                name: result.providerName,
                type: 'codex',
                priority: result.priority,
              });
            }
          }

          return { status: 'success', data: result };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'openai_auth_status',
      description: 'Report whether a Codex provider is signed in, without exposing tokens.',
      parameters: {
        type: 'object',
        properties: { providerName: { type: 'string' } },
        required: ['providerName'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          if (!codexAuth) throw new Error('Codex auth store not configured');
          const { providerName } = rawArgs as { providerName: string };
          const auth = await codexAuth.read(providerName);
          if (!auth) return { status: 'success', data: { signedIn: false } };

          return {
            status: 'success',
            data: {
              signedIn: true,
              email: auth.email,
              plan: auth.plan,
              accountId: auth.accountId,
              expiresAt: auth.expiresAt,
              expired: auth.expiresAt <= Math.floor(Date.now() / 1000),
            },
          };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'openai_logout',
      description: 'Revoke and delete stored OpenAI Codex credentials for a provider.',
      parameters: {
        type: 'object',
        properties: { providerName: { type: 'string' } },
        required: ['providerName'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          if (!codexAuth) throw new Error('Codex auth store not configured');
          const { providerName } = rawArgs as { providerName: string };
          const auth = await codexAuth.read(providerName);
          if (!auth) return { status: 'success', data: { signedOut: true, revoked: false } };

          const revoked = await revokeToken({
            clientId: auth.clientId,
            token: auth.refreshToken,
          });
          await codexAuth.delete(providerName);
          return { status: 'success', data: { signedOut: true, revoked } };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },

    {
      name: 'openai_usage',
      description: 'Return the ChatGPT plan usage windows for a Codex provider.',
      parameters: {
        type: 'object',
        properties: { providerName: { type: 'string' } },
        required: ['providerName'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const { providerName } = rawArgs as { providerName: string };
          const provider = await systemStore.get(providerName);
          if (!provider) throw new Error(`Provider '${providerName}' not found`);
          if (!provider.usage) {
            throw new Error(`Provider '${providerName}' does not expose usage`);
          }
          return { status: 'success', data: await provider.usage() };
        } catch (err) {
          return toErrorResult(err);
        }
      },
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/runtime/src/server/runtime-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/runtime/src/server/runtime-tools.ts \
  packages/runtime/src/server/runtime-tools.test.ts
git commit -m "feat(runtime): add OpenAI Codex login and usage tools"
```

---

## Task 9: Wire `CodexAuthStore` into `LegionProcess`

**Files:**

- Modify: `packages/runtime/src/LegionProcess.ts`

**Interfaces:**

- Consumes: `CodexAuthStore`.
- Produces: `SystemProviderStore` constructed with the auth store; `createRuntimeTools` receives `codexAuth`.

- [ ] **Step 1: Add the import**

In the core import block of `packages/runtime/src/LegionProcess.ts`, add:

```ts
  CodexAuthStore,
```

- [ ] **Step 2: Construct the auth store and pass it to the provider store**

Replace:

```ts
const systemStorage = new FileStorage(systemConfigDir);
const systemStore = new SystemProviderStore(systemStorage);
```

with:

```ts
const systemStorage = new FileStorage(systemConfigDir);
const codexAuth = new CodexAuthStore(join(systemConfigDir, 'providers', '.codex-auth'));
const systemStore = new SystemProviderStore(systemStorage, codexAuth);
```

- [ ] **Step 3: Pass it to the runtime tools**

In the `createRuntimeTools({ ... })` call, add after `authEngine,`:

```ts
      codexAuth,
```

- [ ] **Step 4: Verify compilation and tests**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS (all unit tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts
git commit -m "feat(runtime): wire Codex auth store into the process"
```

---

## Task 10: Grant the operator the new tools

**Files:**

- Modify: `packages/core/src/collective/default-participants.ts`
- Test: `packages/core/src/collective/default-participants.test.ts`

**Interfaces:**

- Produces: the five Codex tools are in `MANAGEMENT_TOOLS` and therefore `auto` for the bootstrap operator.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/collective/default-participants.test.ts`, add after the existing `save_routing` assertion:

```ts
for (const toolName of [
  'openai_login_start',
  'openai_login_poll',
  'openai_auth_status',
  'openai_logout',
  'openai_usage',
]) {
  expect(operator.tools[toolName]).toBe('auto');
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/collective/default-participants.test.ts`
Expected: FAIL — the tools are `undefined`.

- [ ] **Step 3: Add the tools to `MANAGEMENT_TOOLS`**

In `packages/core/src/collective/default-participants.ts`, after `'save_routing',` add:

```ts
  'openai_login_start',
  'openai_login_poll',
  'openai_auth_status',
  'openai_logout',
  'openai_usage',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/collective/default-participants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/collective/default-participants.ts \
  packages/core/src/collective/default-participants.test.ts
git commit -m "feat(core): grant the operator Codex login and usage tools"
```

---

## Task 11: Codex sign-in and usage UI in `ProviderSlideOver.vue`

**Files:**

- Modify: `packages/web/src/components/config/ProviderSlideOver.vue`
- Test: `packages/web/src/components/config/ProviderSlideOver.test.ts`

**Interfaces:**

- Consumes: `openai_auth_status`, `openai_usage`, `openai_login_start`, `openai_login_poll`, `openai_logout`.
- Produces: a `codex` type option; hidden base URL/API key; a ChatGPT plan panel with sign-in, code display, polling, account, usage, refresh, and sign-out.

- [ ] **Step 1: Update the failing tests**

In `packages/web/src/components/config/ProviderSlideOver.test.ts`:

Update the `offers only the provider types the store can construct` test:

```ts
it('offers the constructible provider types including codex', async () => {
  const wrapper = await openForm();
  const values = wrapper
    .findAll('select option')
    .map((o) => (o.element as HTMLOptionElement).value);
  expect(values).toEqual(['openai-compatible', 'openai-responses', 'codex']);
});
```

Add a helper and tests:

```ts
async function openCodexForm() {
  const wrapper = mount(ProviderSlideOver, {
    global: { stubs: { teleport: true } },
    props: {
      open: false,
      provider: { name: 'Codex', type: 'codex', priority: 10 },
    },
  });
  await wrapper.setProps({ open: true });
  return wrapper;
}

describe('ProviderSlideOver codex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides base URL and API key for codex', async () => {
    const wrapper = await openForm();
    await wrapper.find('[data-test="provider-name"]').setValue('Codex');
    await wrapper.get('select').setValue('codex');

    expect(wrapper.find('[data-test="provider-base-url"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="provider-api-key"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="codex-panel"]').exists()).toBe(true);
  });

  it('shows the verification URL and code after starting a login', async () => {
    execute.mockImplementation(async (tool: string) => {
      if (tool === 'openai_auth_status') return { signedIn: false };
      if (tool === 'openai_login_start') {
        return {
          flowId: 'flow-1',
          providerName: 'Codex',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'CODE-1',
          intervalSeconds: 5,
          expiresAt: '2026-11-17T06:00:00.000Z',
        };
      }
      throw new Error(`unexpected tool ${tool}`);
    });

    const wrapper = await openCodexForm();
    await vi.waitFor(() => expect(wrapper.find('[data-test="codex-sign-in"]').exists()).toBe(true));
    await wrapper.find('[data-test="codex-sign-in"]').trigger('click');

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="codex-user-code"]').text()).toContain('CODE-1'),
    );
    expect(wrapper.find('[data-test="codex-verification-url"]').text()).toContain(
      'https://auth.openai.com/codex/device',
    );
    expect(wrapper.text()).toContain('Waiting for approval');
  });

  it('polls to completion and emits saved', async () => {
    vi.useFakeTimers();
    try {
      execute.mockImplementation(async (tool: string) => {
        if (tool === 'openai_auth_status') return { signedIn: false };
        if (tool === 'openai_login_start') {
          return {
            flowId: 'flow-1',
            providerName: 'Codex',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'CODE-1',
            intervalSeconds: 5,
            expiresAt: '2026-11-17T06:00:00.000Z',
          };
        }
        if (tool === 'openai_login_poll') {
          return {
            status: 'complete',
            providerName: 'Codex',
            priority: 10,
            account: { email: 'user@example.com', plan: 'plus' },
          };
        }
        if (tool === 'openai_usage') {
          return { planType: 'plus', windows: [], capturedAt: '2026-11-17T05:00:00.000Z' };
        }
        throw new Error(`unexpected tool ${tool}`);
      });

      const wrapper = await openCodexForm();
      await flushPromises();
      await wrapper.find('[data-test="codex-sign-in"]').trigger('click');
      await flushPromises();
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();

      expect(wrapper.emitted('saved')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the signed-in account and usage windows', async () => {
    execute.mockImplementation(async (tool: string) => {
      if (tool === 'openai_auth_status') {
        return { signedIn: true, email: 'user@example.com', plan: 'plus' };
      }
      if (tool === 'openai_usage') {
        return {
          planType: 'plus',
          windows: [
            {
              label: '5-hour',
              usedPercent: 12,
              remainingPercent: 88,
              windowSeconds: 18000,
              resetAt: null,
            },
          ],
          capturedAt: '2026-11-17T05:00:00.000Z',
        };
      }
      throw new Error(`unexpected tool ${tool}`);
    });

    const wrapper = await openCodexForm();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="codex-account"]').text()).toContain('user@example.com'),
    );
    expect(wrapper.find('[data-test="codex-account"]').text()).toContain('plus');
    expect(wrapper.find('[data-test="codex-usage-window"]').text()).toContain('88% remaining');
  });

  it('signs out and emits saved', async () => {
    execute.mockImplementation(async (tool: string) => {
      if (tool === 'openai_auth_status') {
        return { signedIn: true, email: 'user@example.com', plan: 'plus' };
      }
      if (tool === 'openai_usage') {
        return { planType: 'plus', windows: [], capturedAt: '2026-11-17T05:00:00.000Z' };
      }
      if (tool === 'openai_logout') return { signedOut: true, revoked: true };
      throw new Error(`unexpected tool ${tool}`);
    });

    const wrapper = await openCodexForm();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="codex-sign-out"]').exists()).toBe(true),
    );
    await wrapper.find('[data-test="codex-sign-out"]').trigger('click');

    await vi.waitFor(() => expect(wrapper.find('[data-test="codex-sign-in"]').exists()).toBe(true));
    expect(wrapper.emitted('saved')).toBeTruthy();
  });
});
```

Change the existing Vue Test Utils import at the top to include `flushPromises`:

```ts
import { flushPromises, mount } from '@vue/test-utils';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace=packages/web -- ProviderSlideOver`
Expected: FAIL — no `codex` option and no panel.

- [ ] **Step 3: Replace the component**

Replace `packages/web/src/components/config/ProviderSlideOver.vue` with:

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ProviderConfig, ProviderUsageSummary } from '@legion-collective/types';
import SlideOver from '../common/SlideOver.vue';
import { useLegionApi } from '../../composables/useLegionApi.js';
import { friendlyToolError } from '../../composables/friendlyToolError.js';

interface AuthStatus {
  signedIn: boolean;
  email?: string;
  plan?: string;
  accountId?: string;
  expiresAt?: number;
  expired?: boolean;
}

interface LoginStart {
  flowId: string;
  providerName: string;
  verificationUrl: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
}

type LoginPollResult =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'expired' }
  | {
      status: 'complete';
      providerName: string;
      priority: number;
      account: { email?: string; plan?: string };
    };

const props = defineProps<{
  open: boolean;
  provider: ProviderConfig | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useLegionApi();

const name = ref('');
const type = ref<ProviderConfig['type']>('openai-compatible');
const baseUrl = ref('');
const apiKey = ref('');
const priority = ref(10);
const saving = ref(false);
const error = ref<string | null>(null);
const apiKeyPlaceholder = ref('');

const auth = ref<AuthStatus | null>(null);
const usage = ref<ProviderUsageSummary | null>(null);
const usageError = ref<string | null>(null);
const login = ref<LoginStart | null>(null);
const loginStatus = ref<'idle' | 'starting' | 'waiting' | 'complete'>('idle');
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const isCodex = computed(() => type.value === 'codex');

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function refreshUsage() {
  usageError.value = null;
  try {
    usage.value = await execute<ProviderUsageSummary>('openai_usage', {
      providerName: name.value,
    });
  } catch (err) {
    usage.value = null;
    usageError.value = friendlyToolError(err);
  }
}

async function refreshAuth() {
  if (!name.value) {
    auth.value = null;
    usage.value = null;
    return;
  }
  try {
    auth.value = await execute<AuthStatus>('openai_auth_status', { providerName: name.value });
  } catch {
    auth.value = { signedIn: false };
  }
  if (auth.value?.signedIn) await refreshUsage();
  else usage.value = null;
}

function schedulePoll() {
  stopPolling();
  const seconds = Math.max(5, login.value?.intervalSeconds ?? 5);
  pollTimer = setTimeout(() => void pollLogin(), seconds * 1000);
}

async function pollLogin() {
  if (!login.value) return;
  try {
    const result = await execute<LoginPollResult>('openai_login_poll', {
      flowId: login.value.flowId,
    });
    if (result.status === 'pending') {
      schedulePoll();
      return;
    }
    if (result.status === 'complete') {
      loginStatus.value = 'complete';
      login.value = null;
      await refreshAuth();
      emit('saved');
      return;
    }
    loginStatus.value = 'idle';
    login.value = null;
    error.value = 'The sign-in code expired. Start again.';
  } catch (err) {
    loginStatus.value = 'idle';
    login.value = null;
    error.value = friendlyToolError(err);
  }
}

async function startLogin() {
  error.value = null;
  loginStatus.value = 'starting';
  try {
    login.value = await execute<LoginStart>('openai_login_start', {
      providerName: name.value,
      priority: priority.value,
    });
    loginStatus.value = 'waiting';
    schedulePoll();
  } catch (err) {
    loginStatus.value = 'idle';
    error.value = friendlyToolError(err);
  }
}

async function logout() {
  error.value = null;
  try {
    await execute('openai_logout', { providerName: name.value });
    auth.value = { signedIn: false };
    usage.value = null;
    loginStatus.value = 'idle';
    emit('saved');
  } catch (err) {
    error.value = friendlyToolError(err);
  }
}

function copyCode() {
  if (!login.value) return;
  void navigator.clipboard?.writeText(login.value.userCode).catch(() => undefined);
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      stopPolling();
      return;
    }
    error.value = null;
    usageError.value = null;
    auth.value = null;
    usage.value = null;
    login.value = null;
    loginStatus.value = 'idle';
    name.value = props.provider?.name ?? '';
    type.value = props.provider?.type ?? 'openai-compatible';
    baseUrl.value = props.provider?.baseUrl ?? '';
    priority.value = props.provider?.priority ?? 10;
    apiKey.value = '';
    apiKeyPlaceholder.value = props.provider?.apiKey ? '••••••••' : '';
    if (type.value === 'codex') void refreshAuth();
  },
);

watch(type, (next) => {
  if (next === 'codex' && props.open) void refreshAuth();
});

onBeforeUnmount(stopPolling);

async function save() {
  saving.value = true;
  error.value = null;
  try {
    const payload: ProviderConfig = {
      name: name.value,
      type: type.value,
      priority: priority.value,
    };
    if (type.value !== 'codex') {
      if (baseUrl.value) payload.baseUrl = baseUrl.value;
      if (apiKey.value) {
        payload.apiKey = apiKey.value;
      } else if (props.provider?.apiKey) {
        payload.apiKey = props.provider.apiKey;
      }
    }
    await execute('save_provider', payload);
    emit('saved');
    emit('close');
  } catch (err) {
    error.value = friendlyToolError(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <SlideOver
    :open="open"
    :title="provider ? 'Edit provider' : 'Add provider'"
    @close="emit('close')"
  >
    <div class="p-5 space-y-4">
      <p v-if="error" data-test="provider-error" role="alert" class="text-xs text-danger">
        {{ error }}
      </p>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >Name</label
        >
        <input
          v-model="name"
          data-test="provider-name"
          :readonly="!!provider"
          class="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink font-mono outline-none"
        />
        <p class="text-[10px] text-faint mt-1">Cannot change after creation.</p>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >Type</label
        >
        <select
          v-model="type"
          class="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink"
        >
          <option value="openai-compatible">openai-compatible</option>
          <option value="openai-responses">openai-responses</option>
          <option value="codex">codex</option>
        </select>
      </div>
      <div v-if="type !== 'codex'">
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >Base URL</label
        >
        <input
          v-model="baseUrl"
          data-test="provider-base-url"
          placeholder="https://api.openai.com/v1"
          class="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink font-mono outline-none"
        />
      </div>
      <div v-if="type !== 'codex'">
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >API Key</label
        >
        <input
          v-model="apiKey"
          data-test="provider-api-key"
          type="password"
          :placeholder="apiKeyPlaceholder || 'sk-...'"
          class="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink font-mono outline-none"
        />
        <p v-if="provider?.apiKey" class="text-[10px] text-faint mt-1">
          Leave blank to keep existing key.
        </p>
      </div>

      <div v-if="isCodex" data-test="codex-panel" class="border border-line rounded p-3 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-[10px] uppercase tracking-widest text-muted font-semibold"
            >ChatGPT plan</span
          >
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noreferrer"
            class="text-[10px] text-accent"
            >Manage usage</a
          >
        </div>

        <template v-if="auth?.signedIn">
          <div data-test="codex-account" class="text-xs text-ink">
            Signed in as {{ auth.email ?? 'ChatGPT account' }}
            <span v-if="auth.plan" class="text-muted"> · {{ auth.plan }}</span>
          </div>
          <div v-if="usageError" data-test="codex-usage-error" class="text-[10px] text-warning">
            Usage unavailable — {{ usageError }}
          </div>
          <div v-else-if="usage" class="space-y-1">
            <div
              v-for="w in usage.windows"
              :key="w.label"
              data-test="codex-usage-window"
              class="flex justify-between text-[10px] text-muted"
            >
              <span>{{ w.label }}</span>
              <span>
                {{ w.remainingPercent === null ? '—' : `${w.remainingPercent}% remaining` }}
              </span>
            </div>
            <p v-if="usage.windows.length === 0" class="text-[10px] text-faint">
              No usage windows reported.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              data-test="codex-refresh-usage"
              @click="refreshUsage"
              class="text-[10px] px-2 py-1 border border-line rounded text-muted"
            >
              Refresh usage
            </button>
            <button
              data-test="codex-sign-out"
              @click="logout"
              class="text-[10px] px-2 py-1 border border-line rounded text-danger"
            >
              Sign out
            </button>
            <button
              data-test="codex-re-sign-in"
              @click="startLogin"
              :disabled="!name"
              class="text-[10px] px-2 py-1 border border-line rounded text-accent"
            >
              Re-sign in
            </button>
          </div>
        </template>

        <template v-else-if="loginStatus === 'waiting' && login">
          <p class="text-xs text-ink">
            Open
            <a
              :href="login.verificationUrl"
              target="_blank"
              rel="noreferrer"
              data-test="codex-verification-url"
              class="text-accent"
              >{{ login.verificationUrl }}</a
            >
            and enter this code:
          </p>
          <div class="flex items-center gap-2">
            <code data-test="codex-user-code" class="text-sm font-mono text-ink">{{
              login.userCode
            }}</code>
            <button
              data-test="codex-copy-code"
              @click="copyCode"
              class="text-[10px] px-2 py-1 border border-line rounded text-muted"
            >
              Copy
            </button>
          </div>
          <p class="text-[10px] text-faint">Waiting for approval…</p>
        </template>

        <template v-else>
          <p class="text-[10px] text-muted">
            Sign in to draw inference from your ChatGPT plan instead of API billing.
          </p>
          <button
            data-test="codex-sign-in"
            @click="startLogin"
            :disabled="!name || loginStatus === 'starting'"
            class="text-xs px-3 py-1.5 bg-accent text-on-accent font-bold rounded disabled:opacity-50"
          >
            {{ loginStatus === 'starting' ? 'Starting…' : 'Sign in with OpenAI' }}
          </button>
          <p v-if="!name" class="text-[10px] text-faint">Enter a provider name first.</p>
        </template>
      </div>

      <div>
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >Priority</label
        >
        <input
          v-model.number="priority"
          type="number"
          min="1"
          class="w-20 bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink outline-none"
        />
        <p class="text-[10px] text-faint mt-1">
          Lower number = higher priority (used for auto-routing).
        </p>
      </div>
    </div>
    <template #footer>
      <div class="flex justify-end gap-2 px-5 py-3">
        <button
          @click="emit('close')"
          class="text-xs px-3 py-1.5 border border-line text-muted rounded"
        >
          Cancel
        </button>
        <button
          data-test="provider-save"
          @click="save"
          :disabled="saving"
          class="text-xs px-3 py-1.5 bg-accent text-on-accent font-bold rounded disabled:opacity-50"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </template>
  </SlideOver>
</template>
```

- [ ] **Step 4: Run the web tests**

Run: `npm run test --workspace=packages/web -- ProviderSlideOver`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/config/ProviderSlideOver.vue \
  packages/web/src/components/config/ProviderSlideOver.test.ts
git commit -m "feat(web): add Codex sign-in and usage panel"
```

---

## Task 12: Codex account and usage column in `ConfigView.vue`

**Files:**

- Modify: `packages/web/src/views/ConfigView.vue`
- Test: `packages/web/src/views/ConfigView.test.ts`

**Interfaces:**

- Consumes: `openai_auth_status`, `openai_usage` (best-effort after `list_providers`).
- Produces: a `Usage` column (`5h 88% · 7d 60%`), account/plan under the provider name, and a `Manage usage` link.

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/src/views/ConfigView.test.ts`:

```ts
const CODEX_PROVIDER = {
  name: 'Codex',
  type: 'codex' as const,
  priority: 5,
};

function stubCodexFetch(
  status: Record<string, unknown>,
  usage: Record<string, unknown>,
): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      tool: string;
      args: { providerName?: string };
    };
    if (body.tool === 'list_providers') return toolResponse('list_providers', [CODEX_PROVIDER]);
    if (body.tool === 'get_routing') {
      return toolResponse('get_routing', { system: {}, workspace: {} });
    }
    if (body.tool === 'openai_auth_status') {
      return toolResponse('openai_auth_status', status[body.args.providerName ?? '']);
    }
    if (body.tool === 'openai_usage') {
      return toolResponse('openai_usage', usage[body.args.providerName ?? '']);
    }
    return toolResponse(body.tool, {});
  });
}

describe('ConfigView codex usage', () => {
  it('renders the account and remaining usage for codex providers', async () => {
    vi.stubGlobal(
      'fetch',
      stubCodexFetch(
        { Codex: { signedIn: true, email: 'user@example.com', plan: 'plus' } },
        {
          Codex: {
            planType: 'plus',
            windows: [
              {
                label: '5-hour',
                usedPercent: 12,
                remainingPercent: 88,
                windowSeconds: 18000,
                resetAt: null,
              },
              {
                label: 'Weekly',
                usedPercent: 40,
                remainingPercent: 60,
                windowSeconds: 604800,
                resetAt: null,
              },
            ],
            capturedAt: '2026-11-17T05:00:00.000Z',
          },
        },
      ),
    );
    await router.push('/config');
    await router.isReady();
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });

    await vi.waitFor(() => expect(wrapper.text()).toContain('user@example.com'));
    expect(wrapper.text()).toContain('plus');
    expect(wrapper.find('[data-test="provider-usage"]').text()).toContain('5h 88%');
    expect(wrapper.find('[data-test="provider-usage"]').text()).toContain('7d 60%');
    expect(wrapper.text()).toContain('Manage usage');
    wrapper.unmount();
  });

  it('shows sign-in and an em dash for unsigned codex providers', async () => {
    vi.stubGlobal('fetch', stubCodexFetch({ Codex: { signedIn: false } }, {}));
    await router.push('/config');
    await router.isReady();
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="provider-usage"]').text()).toContain('Sign in'),
    );
    wrapper.unmount();
  });

  it('shows an em dash for non-codex providers', async () => {
    vi.stubGlobal('fetch', stubProviderFetch());
    await router.push('/config');
    await router.isReady();
    const wrapper = mount(ConfigView, { global: { plugins: [router] } });

    await vi.waitFor(() => expect(wrapper.find('[data-test="provider-usage"]').text()).toBe('—'));
    wrapper.unmount();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace=packages/web -- ConfigView`
Expected: FAIL — no usage column or account line.

- [ ] **Step 3: Add the codex state and loader**

In `packages/web/src/views/ConfigView.vue`:

Update the type import:

```ts
import type { ProviderConfig, ProviderUsageSummary, RoutingConfig } from '@legion-collective/types';
```

Add after the existing refs:

```ts
interface CodexStatus {
  signedIn: boolean;
  email?: string;
  plan?: string;
}

const codexStatus = ref<Record<string, CodexStatus>>({});
const codexUsage = ref<Record<string, ProviderUsageSummary | null>>({});
const hasCodex = computed(() => providers.value.some((p) => p.type === 'codex'));
```

Add the loader:

```ts
async function loadCodexInfo(list: ProviderConfig[]) {
  const status: Record<string, CodexStatus> = {};
  const usage: Record<string, ProviderUsageSummary | null> = {};

  await Promise.all(
    list
      .filter((p) => p.type === 'codex')
      .map(async (p) => {
        try {
          status[p.name] = await execute<CodexStatus>('openai_auth_status', {
            providerName: p.name,
          });
        } catch {
          status[p.name] = { signedIn: false };
        }
        if (status[p.name]?.signedIn) {
          try {
            usage[p.name] = await execute<ProviderUsageSummary>('openai_usage', {
              providerName: p.name,
            });
          } catch {
            usage[p.name] = null;
          }
        }
      }),
  );

  codexStatus.value = status;
  codexUsage.value = usage;
}
```

Call it at the end of `load()` after `loadError.value = null;`:

```ts
await loadCodexInfo(providers.value);
```

Add the summary helpers:

```ts
function shortLabel(label: string): string {
  if (label === '5-hour') return '5h';
  if (label === 'Weekly') return '7d';
  return label;
}

function usageSummary(name: string): string {
  if (!codexStatus.value[name]?.signedIn) return 'Sign in';
  const usage = codexUsage.value[name];
  if (!usage) return 'Unavailable';
  const parts = usage.windows.map(
    (w) => `${shortLabel(w.label)} ${w.remainingPercent === null ? '—' : `${w.remainingPercent}%`}`,
  );
  return parts.length > 0 ? parts.join(' · ') : '—';
}
```

- [ ] **Step 4: Add the column and account display**

In the template, change the header array to:

```ts
              v-for="h in ['Priority', 'Name', 'Type', 'Base URL', 'API Key', 'Usage', '']"
```

Change the empty-state `colspan` from `6` to `7`.

Replace the Name cell:

```html
<td class="px-3 py-2.5 font-mono text-ink font-medium">
  {{ p.name }}
  <div
    v-if="p.type === 'codex' && codexStatus[p.name]?.email"
    class="font-sans text-[10px] text-faint"
  >
    {{ codexStatus[p.name]?.email }} · {{ codexStatus[p.name]?.plan ?? 'ChatGPT' }}
  </div>
</td>
```

Insert the Usage cell after the API Key cell:

```html
<td class="px-3 py-2.5 text-muted text-[10px]" data-test="provider-usage">
  <template v-if="p.type === 'codex'">{{ usageSummary(p.name) }}</template>
  <template v-else>—</template>
</td>
```

Add the `Manage usage` link next to the `+ Add provider` button:

```html
<div class="flex items-center gap-4 shrink-0 ml-4">
  <a
    v-if="hasCodex"
    href="https://chatgpt.com/settings/usage"
    target="_blank"
    rel="noreferrer"
    class="text-[10px] text-accent"
    >Manage usage</a
  >
  <button
    v-if="canSaveProvider"
    data-test="add-provider"
    @click="openProvider(null)"
    class="text-xs px-3 py-1.5 border border-line text-accent rounded"
  >
    + Add provider
  </button>
</div>
```

Remove the old standalone `+ Add provider` button and its `shrink-0 ml-4` classes (they are now inside the wrapper above).

- [ ] **Step 5: Run the web tests**

Run: `npm run test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/views/ConfigView.vue packages/web/src/views/ConfigView.test.ts
git commit -m "feat(web): show Codex account and plan usage in the provider table"
```

---

## Task 13: Integration test and docs

**Files:**

- Create: `packages/core/src/providers/CodexProvider.integration.test.ts`
- Modify: `docs/testing.md`

**Interfaces:**

- Gated by `LEGION_OPENAI_CODEX_INTEGRATION=1`; reads a credential file from `LEGION_CODEX_AUTH_FILE`.

- [ ] **Step 1: Create the opt-in integration test**

Create `packages/core/src/providers/CodexProvider.integration.test.ts`:

```ts
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAuthStore } from './CodexAuthStore.js';
import { CodexProvider } from './CodexProvider.js';

const LIVE = !!process.env['LEGION_OPENAI_CODEX_INTEGRATION'];
const AUTH_FILE = process.env['LEGION_CODEX_AUTH_FILE'];
const MODEL_ID = process.env['LEGION_CODEX_MODEL'] ?? 'gpt-5.5';

function makeProvider(): CodexProvider {
  if (!AUTH_FILE) throw new Error('LEGION_CODEX_AUTH_FILE is required');
  const providerName = basename(AUTH_FILE, '.json');
  return new CodexProvider(
    { name: providerName, type: 'codex', priority: 10 },
    new CodexAuthStore(dirname(AUTH_FILE)),
  );
}

describe.skipIf(!LIVE)('CodexProvider: live backend', () => {
  it('streams one text turn end-to-end', async () => {
    const provider = makeProvider();
    const chunks = [];
    for await (const chunk of provider.stream(
      [
        { role: 'system', content: 'Always respond in exactly one short sentence.' },
        { role: 'user', content: 'Say hello.' },
      ],
      [],
      { model: MODEL_ID },
    )) {
      chunks.push(chunk);
    }

    const done = chunks.at(-1);
    expect(done?.type).toBe('done');
    const text = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => c.delta)
      .join('');
    expect(text.length).toBeGreaterThan(0);
    if (done?.type === 'done') {
      expect(done.cost).toBe(0);
    }
  });

  it('calls a function tool', async () => {
    const provider = makeProvider();
    const chunks = [];
    for await (const chunk of provider.stream(
      [{ role: 'user', content: 'Call the echo tool with the message hi.' }],
      [
        {
          name: 'echo',
          description: 'Echo a message back.',
          parameters: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
      ],
      { model: MODEL_ID },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.type === 'tool_call_start')).toBe(true);
  });

  it('fetches plan usage', async () => {
    const provider = makeProvider();
    const usage = await provider.usage();
    expect(Array.isArray(usage.windows)).toBe(true);
    expect(usage.capturedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Document the gate**

In `docs/testing.md`, add a row after the `LEGION_OPENAI_RESPONSES_INTEGRATION=1` row:

```md
| `LEGION_OPENAI_CODEX_INTEGRATION=1` | `CodexProvider.integration.test.ts` | Requires a Codex auth file; set `LEGION_CODEX_AUTH_FILE` to its path; model `gpt-5.5` by default (override with `LEGION_CODEX_MODEL`) |
```

Add a run example after the existing examples:

```sh
# Codex login integration (requires a completed device login)
LEGION_OPENAI_CODEX_INTEGRATION=1 LEGION_CODEX_AUTH_FILE=~/.config/legion/providers/.codex-auth/Codex.json npm run test:coverage
```

- [ ] **Step 3: Run formatting and the full gate**

Run: `npm run format`
Run: `npm run format:check`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS.

Run: `npm run test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/providers/CodexProvider.integration.test.ts docs/testing.md
git commit -m "test(codex): add opt-in Codex login integration coverage"
```

---

## Self-review

**Spec coverage**

- Q1 provider type/config: Task 6 (construct, `.json` filter), Task 8 (`SUPPORTED_PROVIDER_TYPES`, enum), Task 11 (dropdown, hidden fields).
- Q2 credential storage: Task 4 (0600, 0700, atomic, keyed lock, refresh failure clears).
- Q3 login flow and five tools: Task 7 (manager), Task 8 (tools), Task 10 (operator grants), Task 11 (UI polling).
- Q4 inference: Task 2 (hooks), Task 5 (Codex provider, headers, sanitization, 401 retry, `cost: 0`, models).
- Q5 usage windows: Task 1 (types), Task 5 (`normalizeCodexUsage`), Task 8 (`openai_usage`), Task 12 (table).
- Q6 web UI: Task 11 (slide-over), Task 12 (config table).
- Q7 errors/security: Task 4 (refresh failures, modes), Task 5 (status propagation, account-id check), Task 8 (no tokens in results).
- Q8 testing: unit tests in Tasks 2-8, runtime tests in Task 8, web tests in Tasks 11-12, integration in Task 13.
- Q9 test seams/routing: Task 3 (`LEGION_CODEX_CLIENT_ID`), Task 5 (`LEGION_CODEX_BASE_URL`, `LEGION_CODEX_USAGE_URL`), Task 13 (`LEGION_CODEX_AUTH_FILE`); routing is operator-configured, no code change.

**Placeholder scan:** no TBD/TODO; every step names exact files, code, and commands.

**Type consistency:** `CodexAuth` fields, `CodexLoginManager` result shapes, and `ProviderUsageSummary` match across Tasks 1, 4, 5, 7, and 8. Tool names are identical in Tasks 8, 10, 11, and 12.

**Known manual follow-up:** after the first real login, run one text turn, one tool call, one multi-turn recall, and one usage fetch against the live backend. If the Codex backend rejects the body, adjust only `CodexProvider.sanitizeBody` (add `reasoning`, `text`, `client_metadata`, or `prompt_cache_key` there).
