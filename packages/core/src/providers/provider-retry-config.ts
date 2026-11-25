import type { ProviderRetryConfig } from '@legion-collective/types';

// Node clamps setTimeout delays larger than this to 1 ms.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export const providerRetrySchema = {
  type: 'object',
  description: 'Retry policy for transient failures before content. Use maxRetries: 0 to disable.',
  additionalProperties: false,
  properties: {
    maxRetries: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 3 },
    baseDelayMs: { type: 'integer', minimum: 0, maximum: MAX_TIMEOUT_MS, default: 500 },
    maxDelayMs: { type: 'integer', minimum: 0, maximum: MAX_TIMEOUT_MS, default: 30000 },
  },
} as const;

/** Validate a policy from the management API or a provider file, applying defaults at use time. */
export function resolveProviderRetryConfig(value?: unknown): Required<ProviderRetryConfig> {
  const fields = providerRetrySchema.properties;
  const policy: Required<ProviderRetryConfig> = {
    maxRetries: fields.maxRetries.default,
    baseDelayMs: fields.baseDelayMs.default,
    maxDelayMs: fields.maxDelayMs.default,
  };
  if (value === undefined) return policy;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('retry must be an object');
  }
  for (const [field, amount] of Object.entries(value)) {
    if (!Object.hasOwn(fields, field)) throw new Error(`Unknown retry field: ${field}`);
    const key = field as keyof ProviderRetryConfig;
    const { maximum } = fields[key];
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > maximum) {
      throw new Error(`retry.${field} must be an integer between 0 and ${maximum}`);
    }
    policy[key] = amount;
  }
  return policy;
}
