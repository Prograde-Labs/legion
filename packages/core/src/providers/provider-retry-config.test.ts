import { expect, it } from 'vitest';
import { resolveProviderRetryConfig } from '../index.js';

it('applies the provider defaults only to omitted retry fields', () => {
  expect(resolveProviderRetryConfig()).toEqual({
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 30000,
  });
  expect(resolveProviderRetryConfig({ maxRetries: 0, maxDelayMs: 0 })).toEqual({
    maxRetries: 0,
    baseDelayMs: 500,
    maxDelayMs: 0,
  });
});

it('rejects an unbounded retry budget', () => {
  expect(() => resolveProviderRetryConfig({ maxRetries: 11 })).toThrow(/maxRetries/);
});
