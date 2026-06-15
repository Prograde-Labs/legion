import { ConflictError } from '../errors/LegionError.js';
import type { Provider } from './Provider.js';

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  register(name: string, provider: Provider): void {
    if (this.providers.has(name)) {
      throw new ConflictError(`Provider already registered: ${name}`);
    }
    this.providers.set(name, provider);
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}
