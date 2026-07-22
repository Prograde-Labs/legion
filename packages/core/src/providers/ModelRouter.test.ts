import type { ProviderConfig, ProviderModel, RoutingConfig } from '@legion/types';
import { describe, expect, it } from 'vitest';
import type { SystemProviderStore } from './SystemProviderStore.js';
import type { Provider } from './Provider.js';
import { ModelRouter } from './ModelRouter.js';

class StubStore {
  constructor(
    private configs: ProviderConfig[],
    private providers: Map<string, Provider | Error>,
  ) {}

  async list(): Promise<ProviderConfig[]> {
    return [...this.configs].sort((a, b) => a.priority - b.priority);
  }

  async get(name: string): Promise<Provider | null> {
    const provider = this.providers.get(name);
    if (provider instanceof Error) throw provider;
    return provider ?? null;
  }
}

function config(name: string, priority = 0): ProviderConfig {
  return { name, type: 'openai-compatible', priority };
}

function provider(models?: ProviderModel[] | Error): Provider {
  return {
    async complete() {
      return { content: null, toolCalls: [], stopReason: 'stop' };
    },
    ...(models !== undefined
      ? {
          async listModels() {
            if (models instanceof Error) throw models;
            return models;
          },
        }
      : {}),
  };
}

function router(
  store: StubStore,
  systemRouting: RoutingConfig = {},
  workspaceRouting: RoutingConfig = {},
): ModelRouter {
  return new ModelRouter(store as unknown as SystemProviderStore, systemRouting, workspaceRouting);
}

describe('ModelRouter', () => {
  it('returns null when no providers exist', async () => {
    const result = await router(new StubStore([], new Map())).resolve('gpt-4o');

    expect(result).toBeNull();
  });

  it('auto-resolves via listModels when provider lists model', async () => {
    const matchingProvider = provider([{ id: 'gpt-4o' }]);
    const result = await router(
      new StubStore([config('openai')], new Map([['openai', matchingProvider]])),
    ).resolve('gpt-4o');

    expect(result).toBe(matchingProvider);
  });

  it('does not auto-resolve providers without listModels', async () => {
    const unlistedProvider = provider();
    const result = await router(
      new StubStore([config('manual')], new Map([['manual', unlistedProvider]])),
    ).resolve('gpt-4o');

    expect(result).toBeNull();
  });

  it('system routing takes priority over auto-resolution', async () => {
    const routedProvider = provider();
    const autoProvider = provider([{ id: 'gpt-4o' }]);
    const result = await router(
      new StubStore(
        [config('auto'), config('routed')],
        new Map([
          ['auto', autoProvider],
          ['routed', routedProvider],
        ]),
      ),
      { models: { 'gpt-4o': ['routed'] } },
    ).resolve('gpt-4o');

    expect(result).toBe(routedProvider);
  });

  it('workspace routing takes priority over system routing', async () => {
    const systemProvider = provider();
    const workspaceProvider = provider();
    const result = await router(
      new StubStore(
        [config('system'), config('workspace')],
        new Map([
          ['system', systemProvider],
          ['workspace', workspaceProvider],
        ]),
      ),
      { models: { 'gpt-4o': ['system'] } },
      { models: { 'gpt-4o': ['workspace'] } },
    ).resolve('gpt-4o');

    expect(result).toBe(workspaceProvider);
  });

  it('falls back to second provider in routing list if first missing', async () => {
    const fallbackProvider = provider();
    const result = await router(
      new StubStore([config('fallback')], new Map([['fallback', fallbackProvider]])),
      { models: { 'gpt-4o': ['missing', 'fallback'] } },
    ).resolve('gpt-4o');

    expect(result).toBe(fallbackProvider);
  });

  it('auto-resolves by priority order when multiple providers list model', async () => {
    const lowPriorityProvider = provider([{ id: 'gpt-4o' }]);
    const highPriorityProvider = provider([{ id: 'gpt-4o' }]);
    const result = await router(
      new StubStore(
        [config('low', 20), config('high', 10)],
        new Map([
          ['low', lowPriorityProvider],
          ['high', highPriorityProvider],
        ]),
      ),
    ).resolve('gpt-4o');

    expect(result).toBe(highPriorityProvider);
  });

  it('explicit routing can reach provider without listModels', async () => {
    const routedProvider = provider();
    const result = await router(
      new StubStore([config('manual')], new Map([['manual', routedProvider]])),
      { models: { 'gpt-4o': ['manual'] } },
    ).resolve('gpt-4o');

    expect(result).toBe(routedProvider);
  });

  it('skips provider if store.get throws during explicit and auto resolution', async () => {
    const explicitFallback = provider();
    const autoFallback = provider([{ id: 'gpt-4o' }]);
    const explicitResult = await router(
      new StubStore(
        [config('broken'), config('explicit-fallback')],
        new Map([
          ['broken', new Error('not implemented')],
          ['explicit-fallback', explicitFallback],
        ]),
      ),
      { models: { 'gpt-4o': ['broken', 'explicit-fallback'] } },
    ).resolve('gpt-4o');
    const autoResult = await router(
      new StubStore(
        [config('broken'), config('auto-fallback')],
        new Map([
          ['broken', new Error('not implemented')],
          ['auto-fallback', autoFallback],
        ]),
      ),
    ).resolve('gpt-4o');

    expect(explicitResult).toBe(explicitFallback);
    expect(autoResult).toBe(autoFallback);
  });

  it('skips provider if listModels throws', async () => {
    const fallbackProvider = provider([{ id: 'gpt-4o' }]);
    const result = await router(
      new StubStore(
        [config('broken'), config('fallback')],
        new Map([
          ['broken', provider(new Error('list failed'))],
          ['fallback', fallbackProvider],
        ]),
      ),
    ).resolve('gpt-4o');

    expect(result).toBe(fallbackProvider);
  });

  it('resolveWithId returns { provider, providerId } via routing', async () => {
    const routedProvider = provider();
    const result = await router(
      new StubStore([config('routed')], new Map([['routed', routedProvider]])),
      { models: { 'gpt-4o': ['routed'] } },
    ).resolveWithId('gpt-4o');

    expect(result).toEqual({ provider: routedProvider, providerId: 'routed' });
  });

  it('resolveWithId returns providerId from auto-resolution', async () => {
    const autoProvider = provider([{ id: 'gpt-4o' }]);
    const result = await router(
      new StubStore([config('auto')], new Map([['auto', autoProvider]])),
    ).resolveWithId('gpt-4o');

    expect(result).toEqual({ provider: autoProvider, providerId: 'auto' });
  });

  it('resolveWithId returns null when no provider matches', async () => {
    const result = await router(new StubStore([], new Map())).resolveWithId('gpt-4o');

    expect(result).toBeNull();
  });

  it('returns metadata for the model from the selected provider', async () => {
    const selectedProvider = provider([{ id: 'model-a', contextWindow: 32000 }]);
    const result = await router(
      new StubStore([config('primary')], new Map([['primary', selectedProvider]])),
      {},
      { models: { 'model-a': ['primary'] } },
    ).getModelMetadata('model-a');

    expect(result).toEqual({ id: 'model-a', contextWindow: 32000 });
  });

  it('returns undefined when selected provider has no matching metadata', async () => {
    const result = await router(
      new StubStore([config('primary')], new Map([['primary', provider([])]])),
      {},
      { models: { missing: ['primary'] } },
    ).getModelMetadata('missing');

    expect(result).toBeUndefined();
  });
});
