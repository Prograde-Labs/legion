import { describe, expect, it, vi } from 'vitest';
import { setSecretTool, listSecretsTool } from './secret-tools.js';
import type { ToolContext } from './Tool.js';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    participant: { id: 'operator' } as ToolContext['participant'],
    secretStore: {
      getSecret: vi.fn(),
      setSecret: vi.fn().mockResolvedValue(undefined),
      removeSecret: vi.fn(),
      listKeys: vi.fn().mockResolvedValue(['telegram-bot/my_bot', 'other']),
    },
    ...overrides,
  } as unknown as ToolContext;
}

describe('set_secret', () => {
  it('stores via the secret store', async () => {
    const c = ctx();
    const result = await setSecretTool.execute(
      { participantId: 'worker', key: 'telegram-bot/my_bot', secret: 'tok' },
      c,
    );
    expect(result.status).toBe('success');
    expect(c.secretStore!.setSecret).toHaveBeenCalledWith('worker', 'telegram-bot/my_bot', 'tok');
  });

  it('errors when the store is unavailable', async () => {
    const result = await setSecretTool.execute(
      { participantId: 'w', key: 'k', secret: 's' },
      ctx({ secretStore: undefined }),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('secretStore');
  });
});

describe('list_secrets', () => {
  it('returns keys only, never values', async () => {
    const result = await listSecretsTool.execute({ participantId: 'worker' }, ctx());
    expect(result.status).toBe('success');
    expect(result.data).toEqual({
      participantId: 'worker',
      keys: ['telegram-bot/my_bot', 'other'],
    });
  });
});
