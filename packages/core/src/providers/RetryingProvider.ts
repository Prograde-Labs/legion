import timers from 'node:timers/promises';
import type { ProviderRetryConfig } from '@legion-collective/types';
import { ProviderError } from '../errors/LegionError.js';
import type { Provider, ProviderStreamChunk } from './Provider.js';
import { isRetryableProviderFailure } from './provider-retry.js';
import { resolveProviderRetryConfig } from './provider-retry-config.js';

/** Retries a single inference request. Optional provider capabilities remain optional. */
export class RetryingProvider implements Provider {
  readonly listModels?: Provider['listModels'];
  readonly usage?: Provider['usage'];
  readonly pricingSource?: Provider['pricingSource'];

  private readonly policy: Required<ProviderRetryConfig>;

  constructor(
    private readonly provider: Provider,
    policy?: ProviderRetryConfig,
  ) {
    this.policy = resolveProviderRetryConfig(policy);
    this.listModels = provider.listModels?.bind(provider);
    this.usage = provider.usage?.bind(provider);
    this.pricingSource = provider.pricingSource?.bind(provider);
  }

  async *stream(...args: Parameters<Provider['stream']>): AsyncGenerator<ProviderStreamChunk> {
    const signal = args[3]?.signal;
    const { maxRetries, baseDelayMs, maxDelayMs } = this.policy;
    let windowMs = Math.min(baseDelayMs, maxDelayMs);
    for (let retries = 0; ; retries++) {
      signal?.throwIfAborted();
      let emitted = false;
      try {
        for await (const chunk of this.provider.stream(...args)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (
          signal?.aborted ||
          emitted ||
          retries >= maxRetries ||
          !isRetryableProviderFailure(error)
        ) {
          throw error;
        }
        const hint = error instanceof ProviderError ? error.retryAfterMs : undefined;
        const delayMs = Math.min(
          maxDelayMs,
          Math.max(hint ?? 0, Math.floor(Math.random() * windowMs)),
        );
        await timers.setTimeout(delayMs, undefined, { signal });
        windowMs = Math.min(maxDelayMs, windowMs * 2);
      }
    }
  }
}
