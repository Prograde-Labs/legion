import { ProviderError, type ProviderErrorMetadata } from '../errors/LegionError.js';

const permanentCodes = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'billing_not_active',
  'usage_limit_reached',
  'invalid_api_key',
  'authentication_error',
  'permission_denied',
  'permission_error',
  'invalid_request_error',
  'invalid_request',
  'invalid_value',
  'model_not_found',
  'context_length_exceeded',
  'content_policy_violation',
  'content_filter',
]);
const transientCodes = new Set([
  'rate_limit_exceeded',
  'rate_limit_error',
  'rate_limited',
  'too_many_requests',
  'server_error',
  'internal_server_error',
  'service_unavailable',
  'overloaded_error',
  'engine_overloaded',
  'model_overloaded',
  'timeout',
  'request_timeout',
]);

const transportCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Node fetch wraps socket errors in a TypeError, sometimes via an AggregateError. */
export function isRetryableProviderFailure(err: unknown): boolean {
  const pending = [err];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof ProviderError) return value.retryable;
    if ('name' in value && value.name === 'AbortError') return false;
    if ('code' in value && typeof value.code === 'string' && transportCodes.has(value.code))
      return true;
    if ('cause' in value) pending.push(value.cause);
    if (value instanceof AggregateError) {
      for (const error of value.errors) pending.push(error);
    }
  }
  return false;
}

export function classifyProviderError(
  error: unknown,
  status?: number,
  headers?: Headers,
): ProviderErrorMetadata {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const type = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
  const codes = [code, type].filter((v): v is string => typeof v === 'string' && v.length > 0);
  const retryableStatus =
    status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600);
  return {
    providerCode: codes[0],
    retryable:
      !codes.some((c) => permanentCodes.has(c)) &&
      (status === undefined ? codes.some((c) => transientCodes.has(c)) : retryableStatus),
    retryAfterMs: retryAfterMs(headers),
  };
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  for (const [key, scale] of [
    ['retry-after-ms', 1],
    ['x-ms-retry-after-ms', 1],
    ['x-retry-after-ms', 1],
    ['retry-after', 1000],
  ] as const) {
    const raw = headers.get(key)?.trim();
    if (!raw) continue;
    if (/^\d+(\.\d+)?$/.test(raw)) {
      const value = Number(raw) * scale;
      if (Number.isFinite(value)) return Math.ceil(value);
    } else if (key === 'retry-after' && /^[A-Za-z]{3}/.test(raw)) {
      const time = Date.parse(raw);
      if (Number.isFinite(time)) return Math.max(0, time - Date.now());
    }
  }
  return undefined;
}

export async function httpProviderError(
  res: Response,
  context: string,
  redact = (text: string) => text,
): Promise<ProviderError> {
  const text = await res.text().catch(() => '');
  let error: unknown;
  try {
    const body: unknown = JSON.parse(text);
    error = body && typeof body === 'object' && 'error' in body ? body.error : body;
  } catch {
    // Proxies commonly return plain text or HTML instead of a provider error envelope.
  }
  const metadata = classifyProviderError(error, res.status, res.headers);
  return new ProviderError(`${context} ${res.status}: ${redact(text).slice(0, 200)}`, res.status, {
    ...metadata,
    providerCode: metadata.providerCode && redact(metadata.providerCode),
  });
}
