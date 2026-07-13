import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from './Collective.js';
import type { AgentConfig, UserConfig } from '@legion/types';
import { ConflictError, InvariantError } from '../errors/LegionError.js';
import { EventBus } from '../events/EventBus.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledStorage extends MemoryStorage {
  private blockedWrite?: {
    started: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  };
  failNextWrite = false;

  blockNextWrite() {
    const blockedWrite = { started: deferred(), release: deferred() };
    this.blockedWrite = blockedWrite;
    return blockedWrite;
  }

  override async writeJson(key: string, value: unknown): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated persistence failure');
    }
    const blockedWrite = this.blockedWrite;
    if (blockedWrite) {
      this.blockedWrite = undefined;
      blockedWrite.started.resolve();
      await blockedWrite.release.promise;
    }
    await super.writeJson(key, value);
  }
}

function seedStorage() {
  const storage = new MemoryStorage();
  const operator: UserConfig = {
    id: 'op-1',
    name: 'Operator',
    type: 'user',
    tools: {},
    operator: true,
    protected: true,
    status: 'active',
  };
  const agent: AgentConfig = {
    id: 'agent-1',
    name: 'Researcher',
    type: 'agent',
    tools: { communicate: 'auto' },
    systemPrompt: 'You help.',
    model: { model: 'gpt-4o-mini' },
    status: 'active',
  };
  return { storage, operator, agent };
}

describe('Collective: load and query', () => {
  it('loads participants from storage', async () => {
    const { storage, operator, agent } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    await storage.writeJson('collective/participants/agent-1.json', agent);

    const collective = await Collective.load(storage);
    expect(collective.get('agent-1')?.name).toBe('Researcher');
    expect(collective.list().length).toBe(2);
  });

  it('getOrThrow raises ParticipantNotFoundError for unknown ids', async () => {
    const { storage } = seedStorage();
    const collective = await Collective.load(storage);
    expect(() => collective.getOrThrow('ghost')).toThrow(/ghost/);
  });

  it('lists only active participants via listActive', async () => {
    const { storage, operator, agent } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    await storage.writeJson('collective/participants/agent-1.json', {
      ...agent,
      status: 'retired',
    });
    const collective = await Collective.load(storage);
    expect(collective.listActive().map((p) => p.id)).toEqual(['op-1']);
  });

  it('finds a participant by connector identity', async () => {
    const { storage, operator } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', {
      ...operator,
      identities: [{ connector: 'web', externalId: 'op-1' }],
    });
    const collective = await Collective.load(storage);
    expect(collective.findByIdentity('web', 'op-1')?.id).toBe('op-1');
    expect(collective.findByIdentity('web', 'nobody')).toBeUndefined();
  });
});

describe('Collective: mutation and invariants', () => {
  async function withOperatorAndAgent() {
    const { storage, operator, agent } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    await storage.writeJson('collective/participants/agent-1.json', agent);
    return Collective.load(storage);
  }

  it('adds a participant and persists it', async () => {
    const collective = await withOperatorAndAgent();
    await collective.add({
      id: 'mock-1',
      name: 'Mock',
      type: 'mock',
      tools: {},
      responses: ['ok'],
      status: 'active',
    });
    expect(collective.get('mock-1')?.name).toBe('Mock');
    const reloaded = await Collective.load(
      (collective as unknown as { storage: MemoryStorage }).storage,
    );
    expect(reloaded.get('mock-1')).toBeDefined();
  });

  it('rejects adding a duplicate id', async () => {
    const collective = await withOperatorAndAgent();
    await expect(
      collective.add({ id: 'agent-1', name: 'Dup', type: 'mock', tools: {}, responses: [] }),
    ).rejects.toThrow(ConflictError);
  });

  it('retires a non-protected participant', async () => {
    const collective = await withOperatorAndAgent();
    await collective.retire('agent-1');
    expect(collective.get('agent-1')?.status).toBe('retired');
  });

  it('refuses to retire a protected participant', async () => {
    const collective = await withOperatorAndAgent();
    await expect(collective.retire('op-1')).rejects.toThrow(InvariantError);
  });

  it('refuses to retire the last active operator', async () => {
    const { storage } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', {
      id: 'op-1',
      name: 'Op',
      type: 'user',
      tools: {},
      operator: true,
      status: 'active',
    });
    const collective = await Collective.load(storage);
    await expect(collective.retire('op-1')).rejects.toThrow(InvariantError);
  });

  it('updates a participant via patch', async () => {
    const collective = await withOperatorAndAgent();
    await collective.update('agent-1', { name: 'Renamed' });
    expect(collective.get('agent-1')?.name).toBe('Renamed');
  });

  it('refuses to strip operator authority from the last operator', async () => {
    const { storage } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', {
      id: 'op-1',
      name: 'Op',
      type: 'user',
      tools: {},
      operator: true,
      status: 'active',
    });
    const collective = await Collective.load(storage);
    await expect(collective.update('op-1', { operator: false })).rejects.toThrow(InvariantError);
  });

  it('serializes retire and middleware replacement using freshest participant state', async () => {
    const storage = new ControlledStorage();
    const { operator, agent } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    await storage.writeJson('collective/participants/agent-1.json', agent);
    const collective = await Collective.load(storage);
    const blocked = storage.blockNextWrite();

    const retiring = collective.retire('agent-1');
    await blocked.started.promise;
    let replacementSettled = false;
    const replacing = collective
      .replaceMiddleware('agent-1', [{ id: 'audit', type: 'audit', enabled: false, config: {} }])
      .finally(() => {
        replacementSettled = true;
      });
    await Promise.resolve();

    expect(replacementSettled).toBe(false);
    blocked.release.resolve();
    await Promise.all([retiring, replacing]);

    expect(collective.get('agent-1')).toEqual(
      expect.objectContaining({ status: 'retired', middlewareRevision: 1 }),
    );
    expect(await storage.readJson('collective/participants/agent-1.json')).toEqual(
      expect.objectContaining({ status: 'retired', middlewareRevision: 1 }),
    );
  });

  it('keeps memory unchanged after persistence failure and releases mutation lock', async () => {
    const storage = new ControlledStorage();
    const { operator, agent } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    await storage.writeJson('collective/participants/agent-1.json', agent);
    const collective = await Collective.load(storage);
    const bus = new EventBus();
    collective.eventBus = bus;
    const retired = vi.fn();
    bus.on('participant:retired', retired);
    storage.failNextWrite = true;

    await expect(collective.retire('agent-1')).rejects.toThrow('simulated persistence failure');
    expect(collective.get('agent-1')?.status).toBe('active');
    expect(retired).not.toHaveBeenCalled();

    await collective.update('agent-1', { name: 'Recovered' });
    expect(collective.get('agent-1')?.name).toBe('Recovered');
  });

  it('serializes add and update for the same participant', async () => {
    const storage = new ControlledStorage();
    const collective = await Collective.load(storage);
    const blocked = storage.blockNextWrite();
    const adding = collective.add({
      id: 'new-agent',
      name: 'Initial',
      type: 'agent',
      tools: {},
      systemPrompt: 'test',
      model: { model: 'test' },
      maxIterations: 20,
    });
    await blocked.started.promise;
    let updateSettled = false;
    const updating = collective.update('new-agent', { name: 'Updated' }).finally(() => {
      updateSettled = true;
    });
    await Promise.resolve();

    expect(updateSettled).toBe(false);
    blocked.release.resolve();
    await Promise.all([adding, updating]);

    expect(collective.get('new-agent')?.name).toBe('Updated');
    expect(await storage.readJson('collective/participants/new-agent.json')).toEqual(
      expect.objectContaining({ name: 'Updated' }),
    );
  });

  it('clones middleware when adding and replacing participants', async () => {
    const collective = await Collective.load(new MemoryStorage());
    const createdMiddleware = [
      { id: 'created', type: 'audit', enabled: false, config: { nested: { value: 1 } } },
    ];
    await collective.add({
      id: 'clone-agent',
      name: 'Clone Agent',
      type: 'agent',
      tools: {},
      systemPrompt: 'test',
      model: { model: 'test' },
      maxIterations: 20,
      middleware: createdMiddleware,
    });
    createdMiddleware[0].config.nested.value = 2;

    const replacement = [
      { id: 'replacement', type: 'audit', enabled: false, config: { nested: { value: 3 } } },
    ];
    const result = await collective.replaceMiddleware('clone-agent', replacement);
    replacement[0].config.nested.value = 4;
    result.middleware![0].config.nested = { value: 5 };

    expect(collective.get('clone-agent')?.middleware).toEqual([
      { id: 'replacement', type: 'audit', enabled: false, config: { nested: { value: 3 } } },
    ]);
  });
});

describe('Collective: seedDefaultsIfEmpty', () => {
  it('seeds the bootstrap operator into an empty collective', async () => {
    const storage = new MemoryStorage();
    const collective = await Collective.load(storage);
    const seeded = await collective.seedDefaultsIfEmpty();
    expect(seeded).toContain('operator');
    expect(collective.operators().length).toBe(1);
  });

  it('does nothing when participants already exist', async () => {
    const { storage, operator } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    const collective = await Collective.load(storage);
    expect(await collective.seedDefaultsIfEmpty()).toEqual([]);
  });
});

describe('Collective: participant events', () => {
  it('emits participant:active when seed() registers a participant', async () => {
    const bus = new EventBus();
    const collective = new Collective(bus);
    const seen: string[] = [];
    bus.on('participant:active', (p) => seen.push(p.participantId));
    await collective.seed([{ id: 'p1', name: 'alpha', type: 'agent', status: 'active' }]);
    expect(seen).toEqual(['p1']);
  });

  it('emits participant:retired when retire() is called', async () => {
    const bus = new EventBus();
    const collective = new Collective(bus);
    await collective.seed([{ id: 'p1', name: 'alpha', type: 'agent', status: 'active' }]);
    const seen: string[] = [];
    bus.on('participant:retired', (p) => seen.push(p.participantId));
    await collective.retire('p1');
    expect(seen).toEqual(['p1']);
  });
});
