import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenRouterPricingSource } from './OpenRouterPricingSource.js';

const SAMPLE_OPENROUTER_JSON = {
  data: [
    {
      id: 'openai/gpt-4o',
      pricing: {
        prompt: '0.0000025',
        completion: '0.00001',
        input_cache_read: '0.00000125',
        input_cache_write: '0.0000025',
      },
    },
    {
      id: 'anthropic/claude-sonnet-4-5',
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        input_cache_read: '0.0000003',
        input_cache_write: '0.00000375',
      },
    },
    {
      id: 'z-ai/glm-5.2',
      pricing: {
        prompt: '0.00000056',
        completion: '0.00000176',
        input_cache_read: '0.000000104',
      },
    },
  ],
};

describe('OpenRouterPricingSource', () => {
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

  it('fetches OpenRouter and returns pricing for a known model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_OPENROUTER_JSON),
    });

    const source = new OpenRouterPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'openai/gpt-4o');

    expect(pricing).toEqual({
      input: 0.0000025,
      output: 0.00001,
      cache: { read: 0.00000125, write: 0.0000025 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns pricing for z-ai/glm-5.2 from OpenRouter', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_OPENROUTER_JSON),
    });

    const source = new OpenRouterPricingSource(cacheDir);
    const pricing = await source.resolve('OpenRouter', 'z-ai/glm-5.2');

    expect(pricing).toEqual({
      input: 0.00000056,
      output: 0.00000176,
      cache: { read: 0.000000104, write: 0 },
    });
  });

  it('caches the response to disk and does not refetch within 24h', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_OPENROUTER_JSON),
    });

    const source = new OpenRouterPricingSource(cacheDir);
    await source.resolve('openai', 'openai/gpt-4o');
    await source.resolve('anthropic', 'anthropic/claude-sonnet-4-5');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(existsSync(join(cacheDir, 'openrouter-models.json'))).toBe(true);
  });

  it('reads from cache on second construction without fetching', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_OPENROUTER_JSON),
    });

    const source1 = new OpenRouterPricingSource(cacheDir);
    await source1.resolve('openai', 'openai/gpt-4o');

    const source2 = new OpenRouterPricingSource(cacheDir);
    const pricing = await source2.resolve('openai', 'openai/gpt-4o');

    expect(pricing).toEqual({
      input: 0.0000025,
      output: 0.00001,
      cache: { read: 0.00000125, write: 0.0000025 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refetches when cache is older than 24h', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_OPENROUTER_JSON),
    });

    const source1 = new OpenRouterPricingSource(cacheDir);
    await source1.resolve('openai', 'openai/gpt-4o');

    const cachePath = join(cacheDir, 'openrouter-models.json');
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
    cached.fetchedAt = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(cachePath, JSON.stringify(cached));

    const source2 = new OpenRouterPricingSource(cacheDir);
    await source2.resolve('openai', 'openai/gpt-4o');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for an unknown model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_OPENROUTER_JSON),
    });

    const source = new OpenRouterPricingSource(cacheDir);
    const pricing = await source.resolve('unknown', 'nonexistent-model');

    expect(pricing).toBeUndefined();
  });

  it('strips provider prefixes (us., eu., global.) from model IDs', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_OPENROUTER_JSON),
    });

    const source = new OpenRouterPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'us.openai/gpt-4o');

    expect(pricing?.input).toBe(0.0000025);
  });

  it('matches model IDs case-insensitively', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_OPENROUTER_JSON),
    });

    const source = new OpenRouterPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'OPENAI/GPT-4O');

    expect(pricing?.input).toBe(0.0000025);
  });

  it('falls back to hardcoded pricing when fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const source = new OpenRouterPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toBeDefined();
    expect(pricing?.input).toBeGreaterThan(0);
  });

  it('falls back to hardcoded pricing when fetch returns non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const source = new OpenRouterPricingSource(cacheDir);
    const pricing = await source.resolve('openai', 'gpt-4o');

    expect(pricing).toBeDefined();
  });

  it('treats missing input_cache_write as 0', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE_OPENROUTER_JSON),
    });

    const source = new OpenRouterPricingSource(cacheDir);
    const pricing = await source.resolve('OpenRouter', 'z-ai/glm-5.2');

    expect(pricing?.cache.write).toBe(0);
  });
});
