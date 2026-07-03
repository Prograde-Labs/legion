import type { Storage } from '../storage/Storage.js';
import type { ProviderConfig } from '@legion/types';
import type { Provider } from './Provider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';

export class ProviderStore {
  constructor(private storage: Storage) {}

  /**
   * Read provider config for `name` from storage and construct an
   * OpenAICompatibleProvider. Returns null if no config file exists.
   */
  async get(name: string): Promise<Provider | null> {
    const config = await this.storage.readJson<ProviderConfig>(`providers/${name}.json`);
    if (!config) return null;
    return new OpenAICompatibleProvider(config.baseUrl, config.apiKeyEnv ?? config.credentialKey);
  }

  /** List all saved provider configs. */
  async list(): Promise<ProviderConfig[]> {
    const keys = await this.storage.list('providers/');
    const configs = await Promise.all(
      keys.map((k) => this.storage.readJson<ProviderConfig>(`providers/${k}`)),
    );
    return configs.filter((c): c is ProviderConfig => c !== null);
  }

  /** Persist a provider config so it can be resolved by `get()` and `list()`. */
  async save(config: ProviderConfig): Promise<void> {
    await this.storage.writeJson(`providers/${config.name}.json`, config);
  }
}
