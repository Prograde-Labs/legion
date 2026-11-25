import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@legion-collective/types';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { CodexAuthStore } from './CodexAuthStore.js';
import { SystemProviderStore } from './SystemProviderStore.js';

function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'test-provider',
    type: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'test-key',
    priority: 10,
    ...overrides,
  };
}

describe('SystemProviderStore', () => {
  it('get() returns null when no provider file exists', async () => {
    const store = new SystemProviderStore(new MemoryStorage());

    const result = await store.get('missing');

    expect(result).toBeNull();
  });

  it('get() returns Provider with stream function for openai-compatible', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('providers/openai.json', providerConfig({ name: 'openai' }));
    const store = new SystemProviderStore(storage);

    const provider = await store.get('openai');

    expect(provider).not.toBeNull();
    expect(typeof provider!.stream).toBe('function');
  });

  it('get() returns Provider with listModels for openai-compatible', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('providers/openai.json', providerConfig({ name: 'openai' }));
    const store = new SystemProviderStore(storage);

    const provider = await store.get('openai');

    expect(provider).not.toBeNull();
    expect(typeof provider!.listModels).toBe('function');
  });

  it('get() throws NotImplementedError for copilot', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson(
      'providers/copilot.json',
      providerConfig({ name: 'copilot', type: 'copilot' }),
    );
    const store = new SystemProviderStore(storage);

    await expect(store.get('copilot')).rejects.toMatchObject({ name: 'NotImplementedError' });
  });

  it('get() throws ProviderError for codex when no auth store is configured', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson(
      'providers/codex.json',
      providerConfig({ name: 'codex', type: 'codex' }),
    );
    const store = new SystemProviderStore(storage);

    await expect(store.get('codex')).rejects.toMatchObject({ name: 'ProviderError' });
  });

  it('get() constructs a CodexProvider when an auth store is configured', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson(
      'providers/codex.json',
      providerConfig({ name: 'codex', type: 'codex' }),
    );
    const store = new SystemProviderStore(storage, new CodexAuthStore('/tmp/codex-auth-test'));

    const provider = await store.get('codex');

    expect(provider).not.toBeNull();
    expect(typeof provider!.stream).toBe('function');
    expect(typeof provider!.usage).toBe('function');
  });

  it('get() returns Provider with stream for openai-responses', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson(
      'providers/responses.json',
      providerConfig({ name: 'responses', type: 'openai-responses' }),
    );
    const store = new SystemProviderStore(storage);

    const provider = await store.get('responses');

    expect(provider).not.toBeNull();
    expect(typeof provider!.stream).toBe('function');
    expect(typeof provider!.listModels).toBe('function');
  });

  it('list() returns [] when no providers exist', async () => {
    const store = new SystemProviderStore(new MemoryStorage());

    const result = await store.list();

    expect(result).toEqual([]);
  });

  it('list() ignores the .codex-auth credential directory', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('providers/local.json', providerConfig());
    await storage.writeJson('providers/.codex-auth/Codex.json', {
      accessToken: 'a',
      refreshToken: 'r',
    });
    const store = new SystemProviderStore(storage);

    const configs = await store.list();

    expect(configs.map((c) => c.name)).toEqual(['test-provider']);
  });

  it('list() ignores non-JSON entries', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('providers/local.json', providerConfig());
    await storage.writeJson('providers/credentials', { accessToken: 'a' });
    const store = new SystemProviderStore(storage);

    expect((await store.list()).map((config) => config.name)).toEqual(['test-provider']);
  });

  it('list() returns all saved configs sorted by priority ascending', async () => {
    const storage = new MemoryStorage();
    const lowPriority = providerConfig({ name: 'low-priority', priority: 20 });
    const highPriority = providerConfig({ name: 'high-priority', priority: 5 });
    await storage.writeJson('providers/low-priority.json', lowPriority);
    await storage.writeJson('providers/high-priority.json', highPriority);
    const store = new SystemProviderStore(storage);

    const result = await store.list();

    expect(result).toEqual([highPriority, lowPriority]);
  });

  it('save() writes provider config so get() can find it', async () => {
    const store = new SystemProviderStore(new MemoryStorage());

    await store.save(providerConfig({ name: 'saved' }));

    const provider = await store.get('saved');
    expect(provider).not.toBeNull();
  });

  it('save() writes provider config so list() can find it', async () => {
    const store = new SystemProviderStore(new MemoryStorage());
    const config = providerConfig({ name: 'listed' });

    await store.save(config);

    expect(await store.list()).toEqual([config]);
  });

  it('save() preserves an existing retry policy when the field is omitted', async () => {
    const store = new SystemProviderStore(new MemoryStorage());
    const retry = { maxRetries: 1, baseDelayMs: 25, maxDelayMs: 400 };
    await store.save(providerConfig({ name: 'kept', retry }));

    const saved = await store.save(providerConfig({ name: 'kept', priority: 3 }));

    expect(saved).toEqual(providerConfig({ name: 'kept', priority: 3, retry }));
    expect((await store.list())[0]).toEqual(saved);
  });

  it('save() replaces or resets a retry policy when supplied', async () => {
    const store = new SystemProviderStore(new MemoryStorage());
    await store.save(providerConfig({ name: 'replaced', retry: { maxRetries: 2 } }));

    await store.save(providerConfig({ name: 'replaced', retry: { maxRetries: 0 } }));
    expect((await store.list())[0]?.retry).toEqual({ maxRetries: 0 });

    await store.save(providerConfig({ name: 'replaced', retry: {} }));
    expect((await store.list())[0]?.retry).toEqual({});
  });

  it('rejects provider names that escape the provider directory', async () => {
    const store = new SystemProviderStore(new MemoryStorage());

    await expect(store.save(providerConfig({ name: '../evil' }))).rejects.toThrow(
      'Invalid provider name',
    );
    await expect(store.save(providerConfig({ name: 'a/b' }))).rejects.toThrow(
      'Invalid provider name',
    );
  });

  it('rejects traversal names on get and delete without touching storage', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('config.json', { secret: true });
    const store = new SystemProviderStore(storage);

    await expect(store.get('../config')).rejects.toThrow('Invalid provider name');
    await expect(store.delete('../config')).rejects.toThrow('Invalid provider name');
    expect(await storage.readJson('config.json')).toEqual({ secret: true });
  });

  it('delete() removes provider so get() returns null', async () => {
    const store = new SystemProviderStore(new MemoryStorage());
    await store.save(providerConfig({ name: 'deleted' }));

    await store.delete('deleted');

    expect(await store.get('deleted')).toBeNull();
  });

  it('delete() removes provider so list() does not include it', async () => {
    const store = new SystemProviderStore(new MemoryStorage());
    const kept = providerConfig({ name: 'kept', priority: 1 });
    await store.save(kept);
    await store.save(providerConfig({ name: 'deleted', priority: 2 }));

    await store.delete('deleted');

    expect(await store.list()).toEqual([kept]);
  });
});
