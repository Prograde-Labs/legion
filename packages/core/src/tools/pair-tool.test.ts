import { describe, expect, it } from 'vitest';
import { pairTool } from './pair-tool.js';
import type { ToolContext } from './Tool.js';
import type { ParticipantConfig } from '@legion-collective/types';

function makeContext(participants: Record<string, ParticipantConfig>) {
  const updates: Array<{ id: string; patch: Partial<ParticipantConfig> }> = [];
  const collective = {
    get: (id: string) => participants[id],
    findByIdentity: (connector: string, externalId: string) =>
      Object.values(participants).find((p) =>
        p.identities?.some((i) => i.connector === connector && i.externalId === externalId),
      ),
    update: async (id: string, patch: Partial<ParticipantConfig>) => {
      updates.push({ id, patch });
      participants[id] = { ...participants[id], ...patch } as ParticipantConfig;
    },
  };
  return { context: { collective } as unknown as ToolContext, updates, participants };
}

const user = (id: string, identities: ParticipantConfig['identities'] = []): ParticipantConfig => ({
  id,
  name: id,
  type: 'user',
  tools: {},
  identities,
});

describe('pair tool', () => {
  it('merges an identity into a participant', async () => {
    const { context, participants } = makeContext({ alice: user('alice') });
    const result = await pairTool.execute(
      { participantId: 'alice', connector: 'teams', externalId: 'aad-1' },
      context,
    );
    expect(result).toMatchObject({ status: 'success' });
    expect(participants.alice.identities).toEqual([{ connector: 'teams', externalId: 'aad-1' }]);
  });

  it('dedupes an existing identity', async () => {
    const { context } = makeContext({
      alice: user('alice', [{ connector: 'teams', externalId: 'aad-1' }]),
    });
    const result = await pairTool.execute(
      { participantId: 'alice', connector: 'teams', externalId: 'aad-1' },
      context,
    );
    expect(result).toMatchObject({ status: 'success', data: { alreadyPaired: true } });
  });

  it('preserves unrelated identities', async () => {
    const { context, participants } = makeContext({
      alice: user('alice', [{ connector: 'web', externalId: 'alice' }]),
    });
    await pairTool.execute(
      { participantId: 'alice', connector: 'teams', externalId: 'aad-1' },
      context,
    );
    expect(participants.alice.identities).toEqual([
      { connector: 'web', externalId: 'alice' },
      { connector: 'teams', externalId: 'aad-1' },
    ]);
  });

  it('rejects a missing participant', async () => {
    const { context } = makeContext({});
    const result = await pairTool.execute(
      { participantId: 'ghost', connector: 'teams', externalId: 'aad-1' },
      context,
    );
    expect(result).toMatchObject({ status: 'error' });
  });

  it('rejects empty fields', async () => {
    const { context } = makeContext({ alice: user('alice') });
    const result = await pairTool.execute(
      { participantId: 'alice', connector: '', externalId: 'aad-1' },
      context,
    );
    expect(result).toMatchObject({ status: 'error' });
  });

  it('rejects an identity owned by another participant', async () => {
    const { context } = makeContext({
      alice: user('alice'),
      bob: user('bob', [{ connector: 'teams', externalId: 'aad-1' }]),
    });
    const result = await pairTool.execute(
      { participantId: 'alice', connector: 'teams', externalId: 'aad-1' },
      context,
    );
    expect(result).toMatchObject({ status: 'error' });
    expect((result as { error: string }).error).toMatch(/already paired to bob/);
  });
});
