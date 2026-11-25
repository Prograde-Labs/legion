import type { ProviderConfig } from '@legion-collective/types';
import { NotImplementedError, ProviderError } from '../errors/LegionError.js';
import type { Storage } from '../storage/Storage.js';
import type { CodexAuthStore } from './CodexAuthStore.js';
import { CodexProvider } from './CodexProvider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { OpenAIResponsesProvider } from './OpenAIResponsesProvider.js';
import type { Provider } from './Provider.js';
import { RetryingProvider } from './RetryingProvider.js';
import { resolveProviderRetryConfig } from './provider-retry-config.js';

/** Provider names become filenames under providers/; reject separators/traversal. */
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertValidProviderName(name: string): void {
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    throw new Error('Invalid provider name');
  }
}

export class SystemProviderStore {
  constructor(
    private storage: Storage,
    private codexAuth?: CodexAuthStore,
  ) {}

  async get(name: string): Promise<Provider | null> {
    assertValidProviderName(name);
    const config = await this.storage.readJson<ProviderConfig>(`providers/${name}.json`);
    if (!config) return null;
    return new RetryingProvider(this.construct(config), config.retry);
  }

  async list(): Promise<ProviderConfig[]> {
    const keys = await this.storage.list('providers/');
    const configs = await Promise.all(
      keys
        .filter((key) => key.endsWith('.json'))
        .map((key) => this.storage.readJson<ProviderConfig>(`providers/${key}`)),
    );
    const valid = configs.filter((config): config is ProviderConfig => config !== null);
    return valid.sort((a, b) => a.priority - b.priority);
  }

  async save(config: ProviderConfig): Promise<ProviderConfig> {
    assertValidProviderName(config.name);
    resolveProviderRetryConfig(config.retry);
    return this.storage.withLock(`providers/${config.name}.json`, async () => {
      const existing = await this.storage.readJson<ProviderConfig>(`providers/${config.name}.json`);
      // Omitted means "leave the operator's policy alone"; {} explicitly resets it.
      const saved: ProviderConfig =
        config.retry === undefined && existing?.retry !== undefined
          ? { ...config, retry: existing.retry }
          : config;
      resolveProviderRetryConfig(saved.retry);
      await this.storage.writeJson(`providers/${config.name}.json`, saved);
      return saved;
    });
  }

  async delete(name: string): Promise<void> {
    assertValidProviderName(name);
    await this.storage.delete(`providers/${name}.json`);
  }

  private construct(config: ProviderConfig): Provider {
    switch (config.type) {
      case 'openai-compatible':
      case 'anthropic':
        return new OpenAICompatibleProvider(config.baseUrl, config.apiKey);
      case 'openai-responses':
        return new OpenAIResponsesProvider(config.baseUrl, config.apiKey);
      case 'codex':
        if (!this.codexAuth) {
          throw new ProviderError('Codex auth store not configured');
        }
        return new CodexProvider(config, this.codexAuth);
      case 'copilot':
        throw new NotImplementedError(
          `Provider type '${config.type}' is not yet implemented. OAuth support coming soon.`,
        );
    }
  }
}
