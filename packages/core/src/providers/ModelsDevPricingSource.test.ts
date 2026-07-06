import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelsDevPricingSource } from './ModelsDevPricingSource.js';

const SAMPLE_API_JSON = {
  openrouter: {
    id: 'openrouter',
    models: {
      'z-ai/glm-5.2': {
        id: 'z-ai/glm-5.2',
        cost: { input: 0.56, output: 1.76, cache_read: 0.104 },
      },
      'qwen/qwen3.6-35b-a3b': {
        id: 'qwen/qwen3.6-35b-a3b',
        cost: { input: 0.14, output: 1 },
      },
    },
  },
  zai: {
    id: 'zai',
    models: {
      'glm-5.2': {
        id: 'glm-5.2',
        cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
      },
    },
  },
  lmstudio: {
    id: 'lmstudio',
    models: {},
  },
  openai: {
    id: 'openai',
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 },
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

  it('returns provider-specific pricing when provider matches', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const openrouterPricing = await source.resolve('OpenRouter', 'z-ai/glm-5.2');
    expect(openrouterPricing).toEqual({
      input: 0.56,
      output: 1.76,
      cache: { read: 0.104, write: 0 },
    });

    const zaiPricing = await source.resolve('Z.AI', 'glm-5.2');
    expect(zaiPricing).toEqual({
      input: 1.4,
      output: 4.4,
      cache: { read: 0.26, write: 0 },
    });
  });

  it('normalizes provider IDs (case, spaces, dashes)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('LM Studio', 'z-ai/glm-5.2');

    expect(pricing).toEqual({
      input: 0.56,
      output: 1.76,
      cache: { read: 0.104, write: 0 },
    });
  });

  it('falls back to any provider with matching model ID', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('UnknownProvider', 'gpt-4o');

    expect(pricing?.input).toBe(2.5);
  });

  it('caches the response to disk and does not refetch within 24h', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    await source.resolve('OpenRouter', 'z-ai/glm-5.2');
    await source.resolve('Z.AI', 'glm-5.2');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(existsSync(join(cacheDir, 'models-dev.json'))).toBe(true);
  });

  it('reads from cache on second construction without fetching', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source1 = new ModelsDevPricingSource(cacheDir);
    await source1.resolve('OpenRouter', 'z-ai/glm-5.2');

    const source2 = new ModelsDevPricingSource(cacheDir);
    const pricing = await source2.resolve('OpenRouter', 'z-ai/glm-5.2');

    expect(pricing?.input).toBe(0.56);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refetches when cache is older than 24h', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source1 = new ModelsDevPricingSource(cacheDir);
    await source1.resolve('OpenRouter', 'z-ai/glm-5.2');

    const cachePath = join(cacheDir, 'models-dev.json');
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
    cached.fetchedAt = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(cachePath, JSON.stringify(cached));

    const source2 = new ModelsDevPricingSource(cacheDir);
    await source2.resolve('OpenRouter', 'z-ai/glm-5.2');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for an unknown model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'nonexistent-model');

    expect(pricing).toBeUndefined();
  });

  it('strips provider prefixes (us., eu., global.) from model IDs', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openrouter', 'us.z-ai/glm-5.2');

    expect(pricing?.input).toBe(0.56);
  });

  it('matches model IDs case-insensitively', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openrouter', 'Z-AI/GLM-5.2');

    expect(pricing?.input).toBe(0.56);
  });

  it('falls back to hardcoded pricing when fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toBeDefined();
    expect(pricing?.input).toBe(2.5);
  });

  it('falls back to hardcoded pricing when fetch returns non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toBeDefined();
  });

  it('treats missing cache_write as 0', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_JSON),
    });

    const source = new ModelsDevPricingSource(cacheDir);
    const pricing = await source.resolve('OpenRouter', 'z-ai/glm-5.2');

    expect(pricing?.cache.write).toBe(0);
  });
});
