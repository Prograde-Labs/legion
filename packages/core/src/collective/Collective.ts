import type { Storage } from '../storage/Storage.js';
import type { ParticipantConfig } from '@legion/types';
import { ConflictError, InvariantError, ParticipantNotFoundError } from '../errors/LegionError.js';
import { createDefaultParticipants } from './default-participants.js';
import { EventBus } from '../events/EventBus.js';

const PARTICIPANTS_PREFIX = 'collective/participants';

export class Collective {
  private participants = new Map<string, ParticipantConfig>();

  constructor(eventBus: EventBus);
  constructor(storage: Storage, participants: ParticipantConfig[]);
  constructor(
    storageOrEventBus: Storage | EventBus,
    participants?: ParticipantConfig[],
  ) {
    if (storageOrEventBus instanceof EventBus) {
      this.eventBus = storageOrEventBus;
    } else {
      this.storage = storageOrEventBus;
      for (const p of participants!) this.participants.set(p.id, p);
    }
  }

  private eventBus?: EventBus;
  private storage?: Storage;

  get storageForWriting(): Storage | undefined {
    return this.storage;
  }

  static async load(storage: Storage): Promise<Collective> {
    const files = await storage.list(PARTICIPANTS_PREFIX);
    const participants: ParticipantConfig[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      const config = await storage.readJson<ParticipantConfig>(`${PARTICIPANTS_PREFIX}/${id}.json`);
      if (config) participants.push(config);
    }
    return new Collective(storage, participants);
  }

  get(id: string): ParticipantConfig | undefined {
    return this.participants.get(id);
  }

  getOrThrow(id: string): ParticipantConfig {
    const p = this.participants.get(id);
    if (!p) throw new ParticipantNotFoundError(id);
    return p;
  }

  list(): ParticipantConfig[] {
    return [...this.participants.values()];
  }

  listActive(): ParticipantConfig[] {
    return this.list().filter((p) => (p.status ?? 'active') === 'active');
  }

  findByIdentity(connector: string, externalId: string): ParticipantConfig | undefined {
    return this.list().find((p) =>
      p.identities?.some((i) => i.connector === connector && i.externalId === externalId),
    );
  }

  operators(): ParticipantConfig[] {
    return this.listActive().filter((p) => p.operator === true);
  }

  private async persist(config: ParticipantConfig): Promise<void> {
    if (!this.storage) return;
    await this.storage.writeJson(`${PARTICIPANTS_PREFIX}/${config.id}.json`, config);
  }

  async add(config: ParticipantConfig): Promise<void> {
    if (this.participants.has(config.id)) {
      throw new ConflictError(`Participant already exists: ${config.id}`);
    }
    const withStatus: ParticipantConfig = { status: 'active', ...config };
    this.participants.set(withStatus.id, withStatus);
    await this.persist(withStatus);
  }

  async update(id: string, patch: Partial<ParticipantConfig>): Promise<void> {
    const existing = this.getOrThrow(id);
    const updated = { ...existing, ...patch } as ParticipantConfig;
    if (existing.operator === true && updated.operator === false) {
      const otherOperators = this.operators().filter((p) => p.id !== id);
      if (otherOperators.length === 0) {
        throw new InvariantError('Cannot strip operator authority from the last operator');
      }
    }
    this.participants.set(id, updated);
    await this.persist(updated);
  }

  async retire(id: string): Promise<void> {
    const existing = this.getOrThrow(id);
    if (existing.protected) {
      throw new InvariantError(`Cannot retire protected participant: ${id}`);
    }
    if (existing.operator === true) {
      const otherActiveOperators = this.operators().filter((p) => p.id !== id);
      if (otherActiveOperators.length === 0) {
        throw new InvariantError('Cannot retire the last active operator');
      }
    }
    const updated = { ...existing, status: 'retired' as const };
    this.participants.set(id, updated);
    await this.persist(updated);
    this.eventBus?.emit('participant:retired', { participantId: id });
  }

  async seed(participants: ParticipantConfig[]): Promise<void> {
    for (const p of participants) {
      const withStatus: ParticipantConfig = { status: 'active', ...p };
      this.participants.set(withStatus.id, withStatus);
      await this.persist(withStatus);
      this.eventBus?.emit('participant:active', { participantId: withStatus.id });
    }
  }

  modify(id: string, updates: { name?: string }): ParticipantConfig {
    const p = this.getOrThrow(id);
    if (updates.name !== undefined) p.name = updates.name;
    return p;
  }

  async seedDefaultsIfEmpty(): Promise<string[]> {
    if (this.participants.size > 0) return [];
    const defaults = createDefaultParticipants();
    for (const config of defaults) {
      this.participants.set(config.id, config);
      await this.persist(config);
    }
    return defaults.map((p) => p.id);
  }
}
