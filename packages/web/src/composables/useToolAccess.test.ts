import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeMock = vi.fn();
vi.mock('./useLegionApi.js', () => ({ useLegionApi: () => ({ execute: executeMock }) }));

import { useToolAccess } from './useToolAccess.js';

describe('useToolAccess', () => {
  beforeEach(() => {
    executeMock.mockReset();
    useToolAccess().__resetForTests?.();
  });
  it('can() defaults to hidden before any refresh', () => {
    expect(useToolAccess().can('communicate')).toBe('hidden');
  });
  it('refresh() stores the caller policy and can() maps it', async () => {
    executeMock.mockResolvedValue({
      tools: ['communicate', 'edit_message'],
      callerPolicy: { communicate: 'auto', edit_message: 'requires_approval' },
    });
    await useToolAccess().refresh();
    const access = useToolAccess();
    expect(executeMock).toHaveBeenCalledWith('list_tools', {});
    expect(access.access.value).toEqual({ communicate: 'auto', edit_message: 'requires_approval' });
    expect(access.can('communicate')).toBe('auto');
    expect(access.can('edit_message')).toBe('requires_approval');
    expect(access.can('start_process')).toBe('hidden');
  });
  it('can() keys on callerPolicy alone, even for tools absent from the registry list', async () => {
    executeMock.mockResolvedValue({
      tools: ['communicate'],
      callerPolicy: { communicate: 'auto', mcp__docs__search: 'requires_approval' },
    });
    await useToolAccess().refresh();
    expect(useToolAccess().can('mcp__docs__search')).toBe('requires_approval');
  });
  it('fails closed when refresh rejects', async () => {
    executeMock.mockRejectedValue(new Error('boom'));
    await expect(useToolAccess().refresh()).rejects.toThrow('boom');
    expect(useToolAccess().can('communicate')).toBe('hidden');
  });
  it('reset() clears loaded policies so can() fails closed until the next identity refresh', async () => {
    executeMock.mockResolvedValue({
      tools: ['communicate'],
      callerPolicy: { communicate: 'auto' },
    });
    await useToolAccess().refresh(); // identity A
    expect(useToolAccess().can('communicate')).toBe('auto');
    useToolAccess().reset(); // logout flips isAuthenticated false → App.vue calls reset()
    expect(useToolAccess().can('communicate')).toBe('hidden'); // B must not inherit A's policy
    executeMock.mockResolvedValue({
      tools: ['communicate'],
      callerPolicy: { communicate: 'requires_approval' },
    });
    await useToolAccess().refresh(); // identity B logs in
    expect(useToolAccess().can('communicate')).toBe('requires_approval');
  });
  it('drops a refresh response that was in flight across a reset (stale identity cannot land)', async () => {
    let resolveA!: (value: {
      tools: string[];
      callerPolicy: Record<string, 'auto' | 'requires_approval'>;
    }) => void;
    executeMock.mockImplementation(
      () =>
        new Promise<{
          tools: string[];
          callerPolicy: Record<string, 'auto' | 'requires_approval'>;
        }>((resolve) => {
          resolveA = resolve;
        }),
    );
    const pending = useToolAccess().refresh(); // identity A refresh in flight
    useToolAccess().reset(); // logout before the response lands
    resolveA({ tools: ['communicate'], callerPolicy: { communicate: 'auto' } });
    await pending;
    expect(useToolAccess().can('communicate')).toBe('hidden'); // stays fail closed after logout
    executeMock.mockResolvedValue({
      tools: ['communicate'],
      callerPolicy: { communicate: 'auto' },
    });
    await useToolAccess().refresh(); // next identity's successful refresh
    expect(useToolAccess().can('communicate')).toBe('auto');
  });
});
