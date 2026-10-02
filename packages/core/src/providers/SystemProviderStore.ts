import type { ProviderConfig } from '@legion-collective/types';
import { NotImplementedError } from '../errors/LegionError.js';
import type { Storage } from '../storage/Storage.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import type { Provider } from './Provider.js';

export class SystemProviderStore {
  constructor(private storage: Storage) {}

  async get(name: string): Promise<Provider | null> {
    const config = await this.storage.readJson<ProviderConfig>(`providers/${name}.json`);
    if (!config) return null;
    return this.construct(config);
  }

  async list(): Promise<ProviderConfig[]> {
    const keys = await this.storage.list('providers/');
    const configs = await Promise.all(
      keys.map((key) => this.storage.readJson<ProviderConfig>(`providers/${key}`)),
    );
    const valid = configs.filter((config): config is ProviderConfig => config !== null);
    return valid.sort((a, b) => a.priority - b.priority);
  }

  async save(config: ProviderConfig): Promise<void> {
    await this.storage.writeJson(`providers/${config.name}.json`, config);
  }

  async delete(name: string): Promise<void> {
    await this.storage.delete(`providers/${name}.json`);
  }

  private construct(config: ProviderConfig): Provider {
    switch (config.type) {
      case 'openai-compatible':
      case 'anthropic':
        return new OpenAICompatibleProvider(config.baseUrl, config.apiKey);
      case 'copilot':
      case 'codex':
        throw new NotImplementedError(
          `Provider type '${config.type}' is not yet implemented. OAuth support coming soon.`,
        );
    }
  }
}
