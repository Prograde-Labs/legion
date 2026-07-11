import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@legion/types';
import { MemoryStorage } from '../storage/MemoryStorage.js';
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

  it('get() throws NotImplementedError for codex', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson(
      'providers/codex.json',
      providerConfig({ name: 'codex', type: 'codex' }),
    );
    const store = new SystemProviderStore(storage);

    await expect(store.get('codex')).rejects.toMatchObject({ name: 'NotImplementedError' });
  });

  it('list() returns [] when no providers exist', async () => {
    const store = new SystemProviderStore(new MemoryStorage());

    const result = await store.list();

    expect(result).toEqual([]);
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
