import { describe, it, expect } from 'vitest';
import { UsageCalculator } from './UsageCalculator.js';
import type { PricingSource, ModelPricing } from './PricingSource.js';
import type { Provider } from './Provider.js';
import type { ProviderUsage } from './Provider.js';

class MockPricingSource implements PricingSource {
  constructor(private pricing: Record<string, ModelPricing>) {}
  async resolve(_providerId: string, modelId: string): Promise<ModelPricing | undefined> {
    return this.pricing[modelId];
  }
}

const GPT_4O_PRICING: ModelPricing = {
  input: 2.5,
  output: 10,
  cache: { read: 1.25, write: 2.5 },
};

const TIERED_PRICING: ModelPricing = {
  input: 1.25,
  output: 10,
  cache: { read: 0.3125, write: 0 },
  tiers: [
    {
      tier: { type: 'context', size: 200000 },
      input: 2.5,
      output: 15,
      cache: { read: 0.625, write: 0 },
    },
  ],
};

describe('UsageCalculator', () => {
  it('subtracts cache read and cache write from input tokens', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 2006,
      outputTokens: 300,
      cacheReadInputTokens: 1920,
      cacheWriteInputTokens: 50,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    expect(usage.input).toBe(36); // 2006 - 1920 - 50
    expect(usage.cache.read).toBe(1920);
    expect(usage.cache.write).toBe(50);
  });

  it('subtracts reasoning tokens from output tokens', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 300,
      reasoningTokens: 50,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    expect(usage.output).toBe(250); // 300 - 50
    expect(usage.reasoning).toBe(50);
  });

  it('computes cost as sum of (tokens * rate / 1M) for each bucket', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 2006,
      outputTokens: 300,
      cacheReadInputTokens: 1920,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    // input: 86 tokens (2006 - 1920) * 2.5 / 1e6 = 0.000215
    // output: 300 * 10 / 1e6 = 0.003
    // cache.read: 1920 * 1.25 / 1e6 = 0.0024
    // total = 0.005615
    expect(usage.cost).toBeCloseTo(0.005615, 6);
  });

  it('charges reasoning tokens at output rate', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 300,
      reasoningTokens: 100,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    // input: 100 * 2.5 / 1e6 = 0.00025
    // output: 200 * 10 / 1e6 = 0.002
    // reasoning: 100 * 10 / 1e6 = 0.001
    // total = 0.00325
    expect(usage.cost).toBeCloseTo(0.00325, 6);
  });

  it('selects tiered pricing when context exceeds tier size', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gemini-2.5-pro': TIERED_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 250000,
      outputTokens: 1000,
    };
    const usage = await calc.compute('google', 'gemini-2.5-pro', raw);

    // Uses tier (>200K): input 2.5, output 15
    // input: 250000 * 2.5 / 1e6 = 0.625
    // output: 1000 * 15 / 1e6 = 0.015
    // total = 0.64
    expect(usage.cost).toBeCloseTo(0.64, 6);
  });

  it('uses base pricing when context is below tier size', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gemini-2.5-pro': TIERED_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100000,
      outputTokens: 1000,
    };
    const usage = await calc.compute('google', 'gemini-2.5-pro', raw);

    // Base: input 1.25, output 10
    // input: 100000 * 1.25 / 1e6 = 0.125
    // output: 1000 * 10 / 1e6 = 0.01
    // total = 0.135
    expect(usage.cost).toBeCloseTo(0.135, 6);
  });

  it('uses provider cost override when provided', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 100,
    };
    const usage = await calc.compute('copilot', 'gpt-4o', raw, 0.42);

    expect(usage.cost).toBe(0.42);
  });

  it('treats undefined optional fields as 0', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 50,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
    expect(usage.reasoning).toBe(0);
    expect(usage.cache.read).toBe(0);
    expect(usage.cache.write).toBe(0);
  });

  it('returns cost 0 when pricing is unknown', async () => {
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const raw: ProviderUsage = {
      inputTokens: 100,
      outputTokens: 50,
    };
    const usage = await calc.compute('unknown', 'nonexistent', raw);

    expect(usage.cost).toBe(0);
  });

  it('clamps input to non-negative when cache exceeds input', async () => {
    const calc = new UsageCalculator(
      new MockPricingSource({ 'gpt-4o': GPT_4O_PRICING }),
      new Map(),
    );
    const raw: ProviderUsage = {
      inputTokens: 50,
      outputTokens: 10,
      cacheReadInputTokens: 100,
    };
    const usage = await calc.compute('openai', 'gpt-4o', raw);

    expect(usage.input).toBe(0); // Math.max(0, 50 - 100)
  });

  it('uses provider.pricingSource() override when provider is registered', async () => {
    const customPricing: ModelPricing = { input: 0, output: 0, cache: { read: 0, write: 0 } };
    const customSource = new MockPricingSource({ 'custom-model': customPricing });
    const provider: Provider = {
      async complete() {
        return { content: '', toolCalls: [], stopReason: 'stop' };
      },
      pricingSource() {
        return customSource;
      },
    };
    const calc = new UsageCalculator(new MockPricingSource({}), new Map([['custom', provider]]));
    const raw: ProviderUsage = { inputTokens: 100, outputTokens: 50 };
    const usage = await calc.compute('custom', 'custom-model', raw);

    expect(usage.cost).toBe(0); // Custom pricing has all-zero rates
  });
});
