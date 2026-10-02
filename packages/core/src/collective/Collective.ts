import type { Storage } from '../storage/Storage.js';
import type { MiddlewareInstanceConfig, ParticipantConfig } from '@legion-collective/types';
import { ConflictError, InvariantError, ParticipantNotFoundError } from '../errors/LegionError.js';
import { createDefaultParticipants } from './default-participants.js';
import { EventBus } from '../events/EventBus.js';

const PARTICIPANTS_PREFIX = 'collective/participants';

export class Collective {
  private participants = new Map<string, ParticipantConfig>();
  private participantMutationTails = new Map<string, Promise<void>>();
  private participantCreationTail = Promise.resolve();

  constructor(eventBus: EventBus);
  constructor(storage: Storage, participants: ParticipantConfig[]);
  constructor(storageOrEventBus: Storage | EventBus, participants?: ParticipantConfig[]) {
    if (storageOrEventBus instanceof EventBus) {
      this._eventBus = storageOrEventBus;
    } else {
      this.storage = storageOrEventBus;
      for (const p of participants!) this.participants.set(p.id, p);
    }
  }

  private _eventBus?: EventBus;
  get eventBus(): EventBus | undefined {
    return this._eventBus;
  }
  set eventBus(v: EventBus | undefined) {
    this._eventBus = v;
  }
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
    const participant = this.getStored(id);
    return participant ? structuredClone(participant) : undefined;
  }

  getOrThrow(id: string): ParticipantConfig {
    return structuredClone(this.getStoredOrThrow(id));
  }

  list(): ParticipantConfig[] {
    return this.listStored().map((participant) => structuredClone(participant));
  }

  listActive(): ParticipantConfig[] {
    return this.listStored()
      .filter((participant) => (participant.status ?? 'active') === 'active')
      .map((participant) => structuredClone(participant));
  }

  findByIdentity(connector: string, externalId: string): ParticipantConfig | undefined {
    const participant = this.listStored().find((candidate) =>
      candidate.identities?.some(
        (identity) => identity.connector === connector && identity.externalId === externalId,
      ),
    );
    return participant ? structuredClone(participant) : undefined;
  }

  operators(): ParticipantConfig[] {
    return this.operatorsStored().map((participant) => structuredClone(participant));
  }

  private getStored(id: string): ParticipantConfig | undefined {
    return this.participants.get(id);
  }

  private getStoredOrThrow(id: string): ParticipantConfig {
    const participant = this.getStored(id);
    if (!participant) throw new ParticipantNotFoundError(id);
    return participant;
  }

  private listStored(): ParticipantConfig[] {
    return [...this.participants.values()];
  }

  private operatorsStored(): ParticipantConfig[] {
    return this.listStored().filter(
      (participant) =>
        (participant.status ?? 'active') === 'active' && participant.operator === true,
    );
  }

  private async persist(config: ParticipantConfig): Promise<void> {
    if (!this.storage) return;
    await this.storage.writeJson(`${PARTICIPANTS_PREFIX}/${config.id}.json`, config);
  }

  private async persistAndPublish(config: ParticipantConfig): Promise<void> {
    await this.persist(config);
    this.participants.set(config.id, config);
  }

  private async withParticipantMutation<T>(id: string, mutate: () => Promise<T>): Promise<T> {
    const previous = this.participantMutationTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.participantMutationTails.set(id, current);
    await previous;
    try {
      return await mutate();
    } finally {
      release();
      if (this.participantMutationTails.get(id) === current) {
        this.participantMutationTails.delete(id);
      }
    }
  }

  private async withParticipantCreation<T>(create: () => Promise<T>): Promise<T> {
    const previous = this.participantCreationTail;
    let release!: () => void;
    this.participantCreationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await create();
    } finally {
      release();
    }
  }

  private async addWithoutCreationLock(config: ParticipantConfig): Promise<void> {
    await this.withParticipantMutation(config.id, async () => {
      if (this.participants.has(config.id)) {
        throw new ConflictError(`Participant already exists: ${config.id}`);
      }
      const withStatus: ParticipantConfig = { status: 'active', ...config };
      await this.persistAndPublish(withStatus);
    });
  }

  private async seedWithoutCreationLock(participants: ParticipantConfig[]): Promise<void> {
    for (const participant of participants) {
      await this.withParticipantMutation(participant.id, async () => {
        const withStatus: ParticipantConfig = { status: 'active', ...participant };
        await this.persistAndPublish(withStatus);
        this.eventBus?.emit('participant:active', { participantId: withStatus.id });
      });
    }
  }

  async add(config: ParticipantConfig): Promise<void> {
    const detached = structuredClone(config);
    await this.withParticipantCreation(() => this.addWithoutCreationLock(detached));
  }

  async update(id: string, patch: Partial<ParticipantConfig>): Promise<void> {
    await this.withParticipantMutation(id, async () => {
      const existing = this.getStoredOrThrow(id);
      const updated = { ...existing, ...patch } as ParticipantConfig;
      if (Object.hasOwn(patch, 'middleware')) {
        updated.middleware =
          patch.middleware === undefined ? undefined : structuredClone(patch.middleware);
        updated.middlewareRevision = (existing.middlewareRevision ?? 0) + 1;
      } else if (patch.middlewareRevision !== undefined) {
        updated.middlewareRevision = Math.max(
          existing.middlewareRevision ?? 0,
          patch.middlewareRevision,
        );
      }
      if (existing.operator === true && updated.operator === false) {
        const otherOperators = this.operatorsStored().filter(
          (participant) => participant.id !== id,
        );
        if (otherOperators.length === 0) {
          throw new InvariantError('Cannot strip operator authority from the last operator');
        }
      }
      await this.persistAndPublish(updated);
    });
  }

  async replaceMiddleware(
    participantId: string,
    middleware: MiddlewareInstanceConfig[],
  ): Promise<ParticipantConfig> {
    const detachedMiddleware = structuredClone(middleware);
    return this.withParticipantMutation(participantId, async () => {
      const existing = this.getStoredOrThrow(participantId);
      const updated = {
        ...existing,
        middleware: detachedMiddleware,
        middlewareRevision: (existing.middlewareRevision ?? 0) + 1,
      } as ParticipantConfig;
      await this.persistAndPublish(updated);
      return structuredClone(updated);
    });
  }

  async retire(id: string): Promise<void> {
    await this.withParticipantMutation(id, async () => {
      const existing = this.getStoredOrThrow(id);
      if (existing.protected) {
        throw new InvariantError(`Cannot retire protected participant: ${id}`);
      }
      if (existing.operator === true) {
        const otherActiveOperators = this.operatorsStored().filter(
          (participant) => participant.id !== id,
        );
        if (otherActiveOperators.length === 0) {
          throw new InvariantError('Cannot retire the last active operator');
        }
      }
      const updated = { ...existing, status: 'retired' as const };
      await this.persistAndPublish(updated);
      this.eventBus?.emit('participant:retired', { participantId: id });
    });
  }

  async seed(participants: ParticipantConfig[]): Promise<void> {
    const detachedParticipants = structuredClone(participants);
    await this.withParticipantCreation(() => this.seedWithoutCreationLock(detachedParticipants));
  }

  async seedDefaultsIfEmpty(): Promise<string[]> {
    return this.withParticipantCreation(async () => {
      if (this.participants.size > 0) return [];
      const defaults = createDefaultParticipants();
      for (const config of defaults) await this.addWithoutCreationLock(config);
      return defaults.map((participant) => participant.id);
    });
  }
}
