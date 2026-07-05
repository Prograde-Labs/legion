import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelPricing, PricingSource } from './PricingSource.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_FILENAME = 'openrouter-models.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

interface OpenRouterModel {
  id: string;
  pricing?: OpenRouterPricing;
}

interface OpenRouterResponse {
  data?: OpenRouterModel[];
}

interface CachedData {
  fetchedAt: number;
  data: OpenRouterResponse;
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
  'gemini-2.5-pro': { input: 1.25, output: 10, cache: { read: 0.3125, write: 0 } },
  'gemini-2.5-flash': { input: 0.075, output: 0.3, cache: { read: 0.01875, write: 0 } },
};

function normalizeModelId(modelId: string): string {
  return modelId.replace(/^(us|eu|global)\./i, '').toLowerCase();
}

function toNum(s: string | undefined): number {
  if (s === undefined) return 0;
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

function mapPricing(p: OpenRouterPricing | undefined): ModelPricing | undefined {
  if (!p || (p.prompt === undefined && p.completion === undefined)) return undefined;
  return {
    input: toNum(p.prompt),
    output: toNum(p.completion),
    cache: {
      read: toNum(p.input_cache_read),
      write: toNum(p.input_cache_write),
    },
  };
}

export class ModelsDevPricingSource implements PricingSource {
  private cached: CachedData | null = null;

  constructor(private cacheDir: string) {}

  async resolve(_providerId: string, modelId: string): Promise<ModelPricing | undefined> {
    const normalized = normalizeModelId(modelId);
    const data = await this.getData();
    if (data?.data) {
      const model = data.data.find((m) => m.id.toLowerCase() === normalized);
      if (model) {
        const pricing = mapPricing(model.pricing);
        if (pricing) return pricing;
      }
    }
    return HARDCODED_FALLBACK[normalized];
  }

  async refresh(): Promise<void> {
    this.cached = null;
    await this.fetchAndCache();
  }

  private async getData(): Promise<OpenRouterResponse | null> {
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

  private async fetchAndCache(): Promise<OpenRouterResponse | null> {
    try {
      const res = await fetch(OPENROUTER_MODELS_URL);
      if (!res.ok) return null;
      const data = (await res.json()) as OpenRouterResponse;
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
