import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../errors/LegionError.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { OpenAIResponsesProvider } from './OpenAIResponsesProvider.js';
import { isRetryableProviderFailure } from './provider-retry.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([OpenAICompatibleProvider, OpenAIResponsesProvider])(
  '%s HTTP failures',
  (Provider) => {
    it.each([
      [408, undefined, true],
      [429, 'rate_limit_exceeded', true],
      [502, undefined, true],
      [503, 'upstream_unknown', true],
      [400, 'invalid_request_error', false],
      [401, undefined, false],
      [429, 'insufficient_quota', false],
      [503, 'model_not_found', false],
      [500, 'context_length_exceeded', false],
    ] as const)(
      'classifies status %i and code %s as retryable=%s',
      async (status, code, retryable) => {
        const body = code ? JSON.stringify({ error: { code } }) : 'proxy response';
        vi.stubGlobal('fetch', async () => new Response(body, { status }));
        const attempt = new Provider().stream([], [], { model: 'test' }).next();
        await expect(attempt).rejects.toMatchObject({ status, providerCode: code, retryable });
      },
    );
  },
);

describe('provider retry hints', () => {
  it.each([400, 401, 403, 404, 409, 422])(
    'does not retry HTTP %i even for server_error',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        async () => new Response('{"error":{"code":"server_error"}}', { status }),
      );
      const attempt = new OpenAIResponsesProvider().stream([], [], { model: 'test' }).next();
      await expect(attempt).rejects.toMatchObject({
        status,
        providerCode: 'server_error',
        retryable: false,
      });
    },
  );

  it('honors Retry-After from a successful HTTP response carrying an SSE failure', async () => {
    const body =
      'data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\n\n';
    vi.stubGlobal('fetch', async () => new Response(body, { headers: { 'Retry-After': '4' } }));
    const attempt = new OpenAIResponsesProvider().stream([], [], { model: 'test' }).next();
    await expect(attempt).rejects.toMatchObject({
      providerCode: 'server_error',
      retryable: true,
      retryAfterMs: 4000,
    });
  });

  it.each([
    [{ 'Retry-After': '1.5' }, 1500],
    [{ 'Retry-After': 'Wed, 25 Nov 2026 10:00:03 GMT' }, 3000],
    [{ 'retry-after-ms': '250', 'Retry-After': '4' }, 250],
    [{ 'x-ms-retry-after-ms': '300' }, 300],
    [{ 'Retry-After': '-2' }, undefined],
    [{ 'Retry-After': 'invalid' }, undefined],
  ] as const)('reads %j', async (headers, retryAfterMs) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-25T10:00:00Z'));
    vi.stubGlobal(
      'fetch',
      async () => new Response(null, { status: 429, headers: { ...headers } }),
    );
    const attempt = new OpenAICompatibleProvider().stream([], [], { model: 'test' }).next();
    await expect(attempt).rejects.toMatchObject({ retryAfterMs });
  });
});

it('defaults unclassified ProviderErrors to non-retryable', () => {
  expect(new ProviderError('unknown')).toMatchObject({ retryable: false });
});

describe('isRetryableProviderFailure', () => {
  it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])(
    'recognizes a nested %s transport cause',
    (code) => {
      const fetchError = new TypeError('fetch failed', {
        cause: new Error('socket', { cause: { code } }),
      });
      expect(isRetryableProviderFailure(fetchError)).toBe(true);
    },
  );

  it('recognizes a Node aggregate connection failure', () => {
    const cause = new AggregateError([{ code: 'ECONNREFUSED' }], 'connect');
    expect(isRetryableProviderFailure(new TypeError('fetch failed', { cause }))).toBe(true);
  });

  it.each([
    new TypeError('fetch failed', { cause: { code: 'ERR_INVALID_URL' } }),
    new Error('ECONNRESET'),
    new DOMException('canceled', 'AbortError'),
    new ProviderError('not classified', 503),
    null,
  ])('ignores unclassified, permanent, and canceled errors: %s', (err) => {
    expect(isRetryableProviderFailure(err)).toBe(false);
  });

  it('terminates on a cyclic cause', () => {
    const err = new Error('cycle');
    err.cause = err;
    expect(isRetryableProviderFailure(err)).toBe(false);
  });

  it('uses the classifier decision on ProviderError', () => {
    const err = new ProviderError('rate limited', undefined, { retryable: true });
    expect(isRetryableProviderFailure(err)).toBe(true);
  });
});
