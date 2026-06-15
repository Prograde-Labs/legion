import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from './Collective.js';
import type { AgentConfig, UserConfig } from '@legion/types';

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
    model: { provider: 'openai-compatible', model: 'gpt-4o-mini' },
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
