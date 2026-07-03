import { MemoryStorage } from '@legion/core';
import type { ProviderConfig } from '@legion/types';
import { describe, expect, it } from 'vitest';
import { createRuntimeTools } from './runtime-tools.js';

function makeProviderStore(initial: ProviderConfig[] = []) {
  const store = new Map<string, ProviderConfig>(initial.map((c) => [c.name, c]));
  return {
    list: async () => Array.from(store.values()),
    save: async (config: ProviderConfig) => { store.set(config.name, config); },
    get: async (name: string) => store.get(name) ?? null,
    _store: store,
  };
}

function makeDeps() {
  const storage = new MemoryStorage();
  const providerStore = makeProviderStore();
  const credStore = { set: async () => {}, list: async () => [] as string[] };
  return { storage, providerStore, credStore };
}

describe('list_providers', () => {
  it('returns empty array when none configured', async () => {
    const tools = createRuntimeTools(makeDeps());
    const list = tools.find((t) => t.name === 'list_providers')!;
    expect(await list.execute({})).toEqual({ status: 'success', data: [] });
  });

  it('returns stored provider configs', async () => {
    const { storage, credStore } = makeDeps();
    const providerStore = makeProviderStore([{
      name: 'openai',
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
    }]);
    const tools = createRuntimeTools({ storage, providerStore, credStore });
    const list = tools.find((t) => t.name === 'list_providers')!;
    const result = (await list.execute({})) as { status: string; data: { name: string }[] };
    expect(result.data[0]?.name).toBe('openai');
  });
});

describe('configure_provider', () => {
  it('saves provider config via providerStore', async () => {
    const { storage, credStore } = makeDeps();
    const providerStore = makeProviderStore();
    const tools = createRuntimeTools({ storage, providerStore, credStore });
    const cfg = tools.find((t) => t.name === 'configure_provider')!;
    await cfg.execute({
      name: 'local',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'llama3.2',
    });
    expect(providerStore._store.get('local')?.name).toBe('local');
  });
});

describe('list_credentials', () => {
  it('returns masked credential info', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('credential-meta/OPENAI_API_KEY.json', {
      key: 'OPENAI_API_KEY',
      maskedValue: 'sk-••••3f2a',
      usedBy: ['openai'],
      updatedAt: 1000,
    });
    const credStore = { set: async () => {}, list: async () => ['OPENAI_API_KEY'] };
    const providerStore = makeProviderStore();
    const tools = createRuntimeTools({ storage, providerStore, credStore });
    const list = tools.find((t) => t.name === 'list_credentials')!;
    const result = (await list.execute({})) as { status: string; data: { key: string }[] };
    expect(result.data[0]?.key).toBe('OPENAI_API_KEY');
  });
});

describe('set_credential_with_meta', () => {
  it('sets credential and writes metadata', async () => {
    const storage = new MemoryStorage();
    let storedValue = '';
    const credStore = {
      set: async (key: string, value: string) => { storedValue = value; },
      list: async () => [] as string[],
    };
    const providerStore = makeProviderStore();
    const tools = createRuntimeTools({ storage, providerStore, credStore });
    const tool = tools.find((t) => t.name === 'set_credential_with_meta')!;
    const result = await tool.execute({ key: 'TEST_KEY', value: 'secret1234', usedBy: ['openai'] });
    expect(result).toEqual({ status: 'success', data: { key: 'TEST_KEY' } });
    expect(storedValue).toBe('secret1234');
    const meta = await storage.readJson<{ maskedValue: string; usedBy: string[] }>('credential-meta/TEST_KEY.json');
    expect(meta?.maskedValue).toBe('••••1234');
    expect(meta?.usedBy).toEqual(['openai']);
  });
});
