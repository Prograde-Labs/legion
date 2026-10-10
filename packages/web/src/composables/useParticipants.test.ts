import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { BaseParticipant } from '@legion-collective/types';
import { useParticipants } from './useParticipants.js';

const PARTICIPANTS: BaseParticipant[] = [
  { id: 'agent-a', name: 'Agent A', type: 'agent', tools: {} },
  { id: 'operator', name: 'Operator', type: 'user', tools: {} },
];

describe('useParticipants', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
    useParticipants().__resetForTests();
  });

  it('loads participants via list_participants', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'success', data: PARTICIPANTS } }), {
          status: 200,
        }),
      ),
    );
    const store = useParticipants();
    await store.load();
    expect(store.participants.value.length).toBe(2);
    expect(store.loading.value).toBe(false);
  });

  it('byId finds and misses correctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'success', data: PARTICIPANTS } }), {
          status: 200,
        }),
      ),
    );
    const store = useParticipants();
    await store.load();
    expect(store.byId('agent-a')?.name).toBe('Agent A');
    expect(store.byId('operator')?.type).toBe('user');
    expect(store.byId('nobody')).toBeUndefined();
  });

  it('shares module state across useParticipants() calls', () => {
    useParticipants().__setParticipantsForTests(PARTICIPANTS);
    const second = useParticipants();
    expect(second.participants.value.map((p) => p.id)).toEqual(['agent-a', 'operator']);
    expect(second.byId('operator')?.name).toBe('Operator');
    expect(second.loading.value).toBe(false);
  });
});
