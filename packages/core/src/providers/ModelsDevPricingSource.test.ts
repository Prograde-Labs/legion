import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelsDevPricingSource } from './ModelsDevPricingSource.js';

const SAMPLE_MODELS_JSON = {
  models: {
    'gpt-4o': {
      id: 'gpt-4o',
      name: 'GPT-4o',
      cost: {
        input: 2.5,
        output: 10,
        cache_read: 1.25,
        cache_write: 2.5,
      },
    },
    'claude-sonnet-4-5': {
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      cost: {
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_write: 3.75,
      },
    },
    'gemini-2.5-pro': {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      cost: {
        input: 1.25,
        output: 10,
        cache_read: 0.3125,
        cache_write: 0,
        tiers: [
          {
            tier: { type: 'context', size: 200000 },
            input: 2.5,
            output: 15,
            cache_read: 0.625,
            cache_write: 0,
          },
        ],
      },
    },
  },
};

describe('ModelsDevPricingSource', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let cacheDir: string;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    cacheDir = mkdtempSync(join(tmpdir(), 'legion-pricing-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('fetches models.dev and returns pricing for a known model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toEqual({
      input: 2.5,
      output: 10,
      cache: { read: 1.25, write: 2.5 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('caches the response to disk and does not refetch within 24h', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    await source.resolve('openai', 'gpt-4o');
    await source.resolve('anthropic', 'claude-sonnet-4-5');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(existsSync(join(cacheDir, 'models-dev.json'))).toBe(true);
  });

  it('reads from cache on second construction without fetching', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source1 = new ModelsDevPricingSource(cacheDir);
    await source1.resolve('openai', 'gpt-4o');

    const source2 = new ModelsDevPricingSource(cacheDir);
    const pricing = await source2.resolve('openai', 'gpt-4o');

    expect(pricing).toEqual({
      input: 2.5,
      output: 10,
      cache: { read: 1.25, write: 2.5 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refetches when cache is older than 24h', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source1 = new ModelsDevPricingSource(cacheDir);
    await source1.resolve('openai', 'gpt-4o');

    // Backdate the cache file by 25 hours
    const cachePath = join(cacheDir, 'models-dev.json');
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
    cached.fetchedAt = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(cachePath, JSON.stringify(cached));

    const source2 = new ModelsDevPricingSource(cacheDir);
    await source2.resolve('openai', 'gpt-4o');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for an unknown model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('unknown', 'nonexistent-model');

    expect(pricing).toBeUndefined();
  });

  it('strips provider prefixes (us., eu., global.) from model IDs', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'us.gpt-4o');

    expect(pricing).toEqual({
      input: 2.5,
      output: 10,
      cache: { read: 1.25, write: 2.5 },
    });
  });

  it('matches model IDs case-insensitively', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'GPT-4O');

    expect(pricing?.input).toBe(2.5);
  });

  it('parses tiered pricing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MODELS_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('google', 'gemini-2.5-pro');

    expect(pricing?.tiers).toEqual([
      {
        tier: { type: 'context', size: 200000 },
        input: 2.5,
        output: 15,
        cache: { read: 0.625, write: 0 },
      },
    ]);
  });

  it('falls back to hardcoded pricing when fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toBeDefined();
    expect(pricing?.input).toBeGreaterThan(0);
  });

  it('falls back to hardcoded pricing when fetch returns non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toBeDefined();
  });

  it('prefers tiers over legacy context_over_200k (no duplicate tiers)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          models: {
            'mixed-model': {
              id: 'mixed-model',
              cost: {
                input: 1,
                output: 2,
                cache_read: 0.5,
                cache_write: 1,
                tiers: [
                  {
                    tier: { type: 'context', size: 200000 },
                    input: 2,
                    output: 4,
                    cache_read: 1,
                    cache_write: 2,
                  },
                ],
                context_over_200k: {
                  input: 999,
                  output: 999,
                  cache_read: 999,
                  cache_write: 999,
                },
              },
            },
          },
        }),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('test', 'mixed-model');

    expect(pricing?.tiers).toEqual([
      {
        tier: { type: 'context', size: 200000 },
        input: 2,
        output: 4,
        cache: { read: 1, write: 2 },
      },
    ]);
    // Legacy field ignored — no duplicate, no 999 values
    expect(pricing?.tiers).toHaveLength(1);
    expect(pricing?.tiers?.[0].input).not.toBe(999);
  });
});
