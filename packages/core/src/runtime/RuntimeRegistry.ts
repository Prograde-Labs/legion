import type { ParticipantType } from '@legion-collective/types';
import { ConflictError, LegionError } from '../errors/LegionError.js';
import type { Runtime, RuntimeFactory } from './Runtime.js';

export class RuntimeRegistry {
  private factories = new Map<ParticipantType, RuntimeFactory>();

  registerFactory(type: ParticipantType, factory: RuntimeFactory): void {
    if (this.factories.has(type)) {
      throw new ConflictError(`Runtime factory already registered for type: ${type}`);
    }
    this.factories.set(type, factory);
  }

  has(type: ParticipantType): boolean {
    return this.factories.has(type);
  }

  build(type: ParticipantType, participantId: string): Runtime {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new LegionError(`No runtime factory for type: ${type}`, 'RUNTIME_FACTORY_MISSING');
    }
    return factory(participantId);
  }
}
