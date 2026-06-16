import { MemoryStorage } from '@legion/core';
import { describe, expect, it } from 'vitest';
import { createRuntimeTools } from './runtime-tools.js';

function makeDeps() {
  const storage = new MemoryStorage();
  const credStore = { set: async () => {}, list: async () => [] as string[] };
  return { storage, credStore };
}

describe('list_providers', () => {
  it('returns empty array when none configured', async () => {
    const tools = createRuntimeTools(makeDeps());
    const list = tools.find((t) => t.name === 'list_providers')!;
    expect(await list.execute({})).toEqual([]);
  });

  it('returns stored provider configs', async () => {
    const { storage, credStore } = makeDeps();
    await storage.writeJson('providers/openai.json', {
      name: 'openai',
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
    });
    const tools = createRuntimeTools({ storage, credStore });
    const list = tools.find((t) => t.name === 'list_providers')!;
    const result = (await list.execute({})) as { name: string }[];
    expect(result[0]?.name).toBe('openai');
  });
});

describe('configure_provider', () => {
  it('writes provider config to storage', async () => {
    const { storage, credStore } = makeDeps();
    const tools = createRuntimeTools({ storage, credStore });
    const cfg = tools.find((t) => t.name === 'configure_provider')!;
    await cfg.execute({
      name: 'local',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'llama3.2',
    });
    const stored = await storage.readJson<{ name: string }>('providers/local.json');
    expect(stored?.name).toBe('local');
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
    const tools = createRuntimeTools({ storage, credStore });
    const list = tools.find((t) => t.name === 'list_credentials')!;
    const result = (await list.execute({})) as { key: string }[];
    expect(result[0]?.key).toBe('OPENAI_API_KEY');
  });
});
