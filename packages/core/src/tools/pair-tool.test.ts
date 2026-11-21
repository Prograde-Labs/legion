import { describe, expect, it } from 'vitest';
import { pairTool } from './pair-tool.js';
import type { ToolContext } from './Tool.js';
import type { ParticipantConfig } from '@legion-collective/types';

function makeContext(
  participants: Record<string, ParticipantConfig>,
  options: { deferUpdate?: boolean } = {},
) {
  const updates: Array<{ id: string; patch: Partial<ParticipantConfig> }> = [];
  const collective = {
    get: (id: string) => participants[id],
    findByIdentity: (connector: string, externalId: string) =>
      Object.values(participants).find((p) =>
        p.identities?.some((i) => i.connector === connector && i.externalId === externalId),
      ),
    update: async (id: string, patch: Partial<ParticipantConfig>) => {
      updates.push({ id, patch });
      // Simulate asynchronous persistence so concurrent callers can interleave
      // between the read and the write unless the tool serializes them.
      if (options.deferUpdate) await new Promise((resolve) => setTimeout(resolve, 0));
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

  it('allows only one concurrent pairing of the same identity', async () => {
    const { context, participants } = makeContext(
      { alice: user('alice'), bob: user('bob') },
      { deferUpdate: true },
    );
    const results = (await Promise.all([
      pairTool.execute(
        { participantId: 'alice', connector: 'teams', externalId: 'aad-1' },
        context,
      ),
      pairTool.execute({ participantId: 'bob', connector: 'teams', externalId: 'aad-1' }, context),
    ])) as Array<{ status: string; error?: string; data?: { participantId?: string } }>;

    expect(results.filter((r) => r.status === 'success')).toHaveLength(1);
    const errors = results.filter((r) => r.status === 'error');
    expect(errors).toHaveLength(1);
    const winner = results.find((r) => r.status === 'success');
    const winnerId = winner?.data?.participantId as string;
    expect(errors[0].error).toMatch(new RegExp(`already paired to ${winnerId}`));
    expect(participants[winnerId].identities).toEqual([
      { connector: 'teams', externalId: 'aad-1' },
    ]);
    const loserId = winnerId === 'alice' ? 'bob' : 'alice';
    expect(participants[loserId].identities ?? []).toEqual([]);
  });

  it('merges concurrent pairings of different identities into the same participant', async () => {
    const { context, participants } = makeContext({ alice: user('alice') }, { deferUpdate: true });
    const results = await Promise.all([
      pairTool.execute(
        { participantId: 'alice', connector: 'teams', externalId: 'aad-1' },
        context,
      ),
      pairTool.execute(
        { participantId: 'alice', connector: 'teams', externalId: 'aad-2' },
        context,
      ),
    ]);

    expect(results).toMatchObject([{ status: 'success' }, { status: 'success' }]);
    expect(participants.alice.identities).toEqual([
      { connector: 'teams', externalId: 'aad-1' },
      { connector: 'teams', externalId: 'aad-2' },
    ]);
  });
});
