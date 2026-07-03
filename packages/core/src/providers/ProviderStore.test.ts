import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { ProviderStore } from './ProviderStore.js';
import type { ProviderConfig } from '@legion/types';

describe('ProviderStore', () => {
  it('get() returns null when no provider file exists', async () => {
    const storage = new MemoryStorage();
    const store = new ProviderStore(storage);
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('get() returns an OpenAICompatibleProvider when the file exists', async () => {
    const storage = new MemoryStorage();
    const config: ProviderConfig = {
      name: 'my-provider',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      defaultModel: 'llama',
    };
    await storage.writeJson('providers/my-provider.json', config);
    const store = new ProviderStore(storage);
    const provider = await store.get('my-provider');
    expect(provider).not.toBeNull();
    expect(typeof provider!.complete).toBe('function');
  });

  it('list() returns empty array when no providers exist', async () => {
    const storage = new MemoryStorage();
    const store = new ProviderStore(storage);
    const result = await store.list();
    expect(result).toEqual([]);
  });

  it('list() returns all saved provider configs', async () => {
    const storage = new MemoryStorage();
    const configA: ProviderConfig = {
      name: 'provider-a',
      type: 'openai-compatible',
      baseUrl: 'http://a.example/v1',
      defaultModel: 'model-a',
    };
    const configB: ProviderConfig = {
      name: 'provider-b',
      type: 'openai-compatible',
      baseUrl: 'http://b.example/v1',
      defaultModel: 'model-b',
    };
    await storage.writeJson('providers/provider-a.json', configA);
    await storage.writeJson('providers/provider-b.json', configB);
    const store = new ProviderStore(storage);
    const result = await store.list();
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name).sort()).toEqual(['provider-a', 'provider-b']);
  });

  it('save() writes provider config so get() can find it', async () => {
    const storage = new MemoryStorage();
    const store = new ProviderStore(storage);
    const config: ProviderConfig = {
      name: 'saved-provider',
      type: 'openai-compatible',
      baseUrl: 'http://saved.example/v1',
      defaultModel: 'saved-model',
    };
    await store.save(config);
    const provider = await store.get('saved-provider');
    expect(provider).not.toBeNull();
  });

  it('save() writes provider config so list() can find it', async () => {
    const storage = new MemoryStorage();
    const store = new ProviderStore(storage);
    const config: ProviderConfig = {
      name: 'listed-provider',
      type: 'openai-compatible',
      baseUrl: 'http://listed.example/v1',
      defaultModel: 'listed-model',
    };
    await store.save(config);
    const result = await store.list();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('listed-provider');
  });
});
