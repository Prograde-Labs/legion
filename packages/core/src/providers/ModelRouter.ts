import type { ProviderModel, RoutingConfig } from '@legion/types';
import type { Provider } from './Provider.js';
import type { SystemProviderStore } from './SystemProviderStore.js';

export class ModelRouter {
  constructor(
    private store: SystemProviderStore,
    private systemRouting: RoutingConfig,
    private workspaceRouting: RoutingConfig,
  ) {}

  async resolve(modelId: string): Promise<Provider | null> {
    const resolved = await this.resolveWithId(modelId);
    return resolved?.provider ?? null;
  }

  async resolveWithId(modelId: string): Promise<{ provider: Provider; providerId: string } | null> {
    const workspaceProviders = this.workspaceRouting.models?.[modelId];
    if (workspaceProviders?.length) {
      const resolved = await this.resolveFromList(workspaceProviders);
      if (resolved) return resolved;
    }

    const systemProviders = this.systemRouting.models?.[modelId];
    if (systemProviders?.length) {
      const resolved = await this.resolveFromList(systemProviders);
      if (resolved) return resolved;
    }

    return this.autoResolve(modelId);
  }

  async getModelMetadata(modelId: string): Promise<ProviderModel | undefined> {
    const resolved = await this.resolveWithId(modelId);
    if (!resolved?.provider.listModels) return undefined;
    try {
      return (await resolved.provider.listModels()).find((model) => model.id === modelId);
    } catch {
      return undefined;
    }
  }

  private async resolveFromList(
    providerNames: string[],
  ): Promise<{ provider: Provider; providerId: string } | null> {
    for (const name of providerNames) {
      try {
        const provider = await this.store.get(name);
        if (provider) return { provider, providerId: name };
      } catch {
        // Skip providers that cannot be constructed yet or are misconfigured.
      }
    }
    return null;
  }

  private async autoResolve(
    modelId: string,
  ): Promise<{ provider: Provider; providerId: string } | null> {
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
        if (models.some((model) => model.id === modelId)) {
          return { provider, providerId: config.name };
        }
      } catch {
        continue;
      }
    }
    return null;
  }
}
