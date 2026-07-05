import { Decimal } from 'decimal.js';
import type { MessageUsage } from '@legion/types';
import type { ProviderUsage } from './Provider.js';
import type { Provider } from './Provider.js';
import type { ModelPricing, PricingSource } from './PricingSource.js';

export type ProviderLookup = (providerId: string) => Provider | undefined;

export class UsageCalculator {
  constructor(
    private defaultPricingSource: PricingSource,
    private providers: ProviderLookup | Map<string, Provider>,
  ) {}

  async compute(
    providerId: string,
    modelId: string,
    raw: ProviderUsage,
    providerCostOverride?: number,
  ): Promise<MessageUsage> {
    const cacheRead = raw.cacheReadInputTokens ?? 0;
    const cacheWrite = raw.cacheWriteInputTokens ?? 0;
    const input = Math.max(0, raw.inputTokens - cacheRead - cacheWrite);
    const reasoning = raw.reasoningTokens ?? 0;
    const output = Math.max(0, raw.outputTokens - reasoning);

    const cost =
      providerCostOverride !== undefined
        ? providerCostOverride
        : await this.computeCost(providerId, modelId, raw.inputTokens, {
            input,
            output,
            reasoning,
            cacheRead,
            cacheWrite,
          });

    return {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
      cost,
      modelId,
      providerId,
    };
  }

  private async computeCost(
    providerId: string,
    modelId: string,
    contextTokens: number,
    buckets: {
      input: number;
      output: number;
      reasoning: number;
      cacheRead: number;
      cacheWrite: number;
    },
  ): Promise<number> {
    const pricing = await this.resolvePricing(providerId, modelId);
    if (!pricing) return 0;

    const tieredPricing =
      pricing.tiers
        ?.filter((t) => t.tier.type === 'context' && contextTokens > t.tier.size)
        .sort((a, b) => b.tier.size - a.tier.size)[0] ?? pricing;

    const cost = new Decimal(0)
      .add(new Decimal(buckets.input).mul(tieredPricing.input).div(1_000_000))
      .add(new Decimal(buckets.output).mul(tieredPricing.output).div(1_000_000))
      .add(new Decimal(buckets.cacheRead).mul(tieredPricing.cache.read).div(1_000_000))
      .add(new Decimal(buckets.cacheWrite).mul(tieredPricing.cache.write).div(1_000_000))
      .add(new Decimal(buckets.reasoning).mul(tieredPricing.output).div(1_000_000))
      .toNumber();

    return cost;
  }

  private async resolvePricing(
    providerId: string,
    modelId: string,
  ): Promise<ModelPricing | undefined> {
    const provider = this.lookupProvider(providerId);
    if (provider?.pricingSource) {
      const pricing = await provider.pricingSource().resolve(providerId, modelId);
      if (pricing) return pricing;
    }
    return this.defaultPricingSource.resolve(providerId, modelId);
  }

  private lookupProvider(providerId: string): Provider | undefined {
    if (this.providers instanceof Map) {
      return this.providers.get(providerId);
    }
    return this.providers(providerId);
  }
}
