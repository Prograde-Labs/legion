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
});
