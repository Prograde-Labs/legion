import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelPricing, PricingSource } from './PricingSource.js';

const MODELS_DEV_URL = 'https://models.dev/api/v1/models.json';
const CACHE_FILENAME = 'models-dev.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  tiers?: Array<{
    tier: { type: 'context'; size: number };
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  }>;
}

interface ModelsDevModel {
  id: string;
  name?: string;
  cost?: ModelsDevCost;
}

interface ModelsDevResponse {
  models?: Record<string, ModelsDevModel>;
}

interface CachedData {
  fetchedAt: number;
  data: ModelsDevResponse;
}

const HARDCODED_FALLBACK: Record<string, ModelPricing> = {
  'gpt-4o': { input: 2.5, output: 10, cache: { read: 1.25, write: 2.5 } },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cache: { read: 0.075, write: 0.15 } },
  'gpt-4-turbo': { input: 10, output: 30, cache: { read: 5, write: 10 } },
  o1: { input: 15, output: 60, cache: { read: 7.5, write: 15 } },
  'o1-mini': { input: 1.1, output: 4.4, cache: { read: 0.55, write: 1.1 } },
  'claude-opus-4-5': { input: 15, output: 75, cache: { read: 1.5, write: 18.75 } },
  'claude-sonnet-4-5': { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  'claude-haiku-4-5': { input: 0.8, output: 4, cache: { read: 0.08, write: 1 } },
  'gemini-2.5-pro': {
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
  },
  'gemini-2.5-flash': { input: 0.075, output: 0.3, cache: { read: 0.01875, write: 0 } },
};

function normalizeModelId(modelId: string): string {
  return modelId.replace(/^(us|eu|global)\./i, '').toLowerCase();
}

function mapCost(cost: ModelsDevCost | undefined): ModelPricing | undefined {
  if (!cost) return undefined;
  const result: ModelPricing = {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cache: {
      read: cost.cache_read ?? 0,
      write: cost.cache_write ?? 0,
    },
  };
  if (cost.tiers) {
    result.tiers = cost.tiers.map((t) => ({
      tier: t.tier,
      input: t.input,
      output: t.output,
      cache: { read: t.cache_read ?? 0, write: t.cache_write ?? 0 },
    }));
  } else if (cost.context_over_200k) {
    result.tiers = [
      {
        tier: { type: 'context', size: 200000 },
        input: cost.context_over_200k.input,
        output: cost.context_over_200k.output,
        cache: {
          read: cost.context_over_200k.cache_read ?? 0,
          write: cost.context_over_200k.cache_write ?? 0,
        },
      },
    ];
  }
  return result;
}

export class ModelsDevPricingSource implements PricingSource {
  private cached: CachedData | null = null;

  constructor(private cacheDir: string) {}

  async resolve(_providerId: string, modelId: string): Promise<ModelPricing | undefined> {
    const normalized = normalizeModelId(modelId);
    const data = await this.getData();
    if (data) {
      const model = data.models?.[normalized] ?? data.models?.[modelId];
      if (model) {
        const pricing = mapCost(model.cost);
        if (pricing) return pricing;
      }
    }
    return HARDCODED_FALLBACK[normalized];
  }

  async refresh(): Promise<void> {
    this.cached = null;
    await this.fetchAndCache();
  }

  private async getData(): Promise<ModelsDevResponse | null> {
    if (this.cached) return this.cached.data;

    const cachePath = join(this.cacheDir, CACHE_FILENAME);
    if (existsSync(cachePath)) {
      try {
        const raw = readFileSync(cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as CachedData;
        if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) {
          this.cached = parsed;
          return parsed.data;
        }
      } catch {
        // Corrupt cache — fall through to refetch.
      }
    }

    return this.fetchAndCache();
  }

  private async fetchAndCache(): Promise<ModelsDevResponse | null> {
    try {
      const res = await fetch(MODELS_DEV_URL);
      if (!res.ok) return null;
      const data = (await res.json()) as ModelsDevResponse;
      this.cached = { fetchedAt: Date.now(), data };
      try {
        mkdirSync(this.cacheDir, { recursive: true });
        writeFileSync(join(this.cacheDir, CACHE_FILENAME), JSON.stringify(this.cached));
      } catch {
        // Cache write failed (permissions, disk full) — non-fatal.
      }
      return data;
    } catch {
      return null;
    }
  }
}
