import type { RoutingConfig } from '@legion/types';
import type { Provider } from './Provider.js';
import type { SystemProviderStore } from './SystemProviderStore.js';

export class ModelRouter {
  constructor(
    private store: SystemProviderStore,
    private systemRouting: RoutingConfig,
    private workspaceRouting: RoutingConfig,
  ) {}

  async resolve(modelId: string): Promise<Provider | null> {
    const workspaceProviders = this.workspaceRouting.models?.[modelId];
    if (workspaceProviders?.length) {
      const provider = await this.resolveFromList(workspaceProviders);
      if (provider) return provider;
    }

    const systemProviders = this.systemRouting.models?.[modelId];
    if (systemProviders?.length) {
      const provider = await this.resolveFromList(systemProviders);
      if (provider) return provider;
    }

    return this.autoResolve(modelId);
  }

  private async resolveFromList(providerNames: string[]): Promise<Provider | null> {
    for (const name of providerNames) {
      try {
        const provider = await this.store.get(name);
        if (provider) return provider;
      } catch {
        // Skip providers that cannot be constructed yet or are misconfigured.
      }
    }
    return null;
  }

  private async autoResolve(modelId: string): Promise<Provider | null> {
    const configs = await this.store.list();
    for (const config of configs) {
      let provider: Provider | null;
      try {
        provider = await this.store.get(config.name);
      } catch {
        continue;
      }
      if (!provider?.listModels) continue;
      try {
        const models = await provider.listModels();
        if (models.some((model) => model.id === modelId)) return provider;
      } catch {
        continue;
      }
    }
    return null;
  }
}
