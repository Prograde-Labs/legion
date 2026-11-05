import { describe, expect, it, vi } from 'vitest';
import { setSecretTool, listSecretsTool } from './secret-tools.js';
import type { ToolContext } from './Tool.js';

function caller(overrides: Partial<ToolContext['participant']> = {}): ToolContext['participant'] {
  return {
    id: 'operator',
    name: 'Operator',
    type: 'user',
    tools: {},
    operator: true,
    ...overrides,
  } as ToolContext['participant'];
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    participant: caller(),
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

  it('refuses another participant’s secret unless the caller is an operator', async () => {
    const c = ctx({ participant: caller({ id: 'worker', operator: false }) });
    const result = await setSecretTool.execute(
      { participantId: 'other', key: 'k', secret: 's' },
      c,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('operator');
    expect(c.secretStore!.setSecret).not.toHaveBeenCalled();
  });

  it('lets a participant set its own secret', async () => {
    const c = ctx({ participant: caller({ id: 'worker', operator: false }) });
    const result = await setSecretTool.execute(
      { participantId: 'worker', key: 'k', secret: 's' },
      c,
    );
    expect(result.status).toBe('success');
    expect(c.secretStore!.setSecret).toHaveBeenCalledWith('worker', 'k', 's');
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

  it('refuses another participant’s keys unless the caller is an operator', async () => {
    const c = ctx({ participant: caller({ id: 'worker', operator: false }) });
    const result = await listSecretsTool.execute({ participantId: 'other' }, c);
    expect(result.status).toBe('error');
    expect(result.error).toContain('operator');
    expect(c.secretStore!.listKeys).not.toHaveBeenCalled();
  });

  it('lets a participant list its own keys', async () => {
    const c = ctx({ participant: caller({ id: 'worker', operator: false }) });
    const result = await listSecretsTool.execute({ participantId: 'worker' }, c);
    expect(result.status).toBe('success');
    expect(c.secretStore!.listKeys).toHaveBeenCalledWith('worker');
  });
});
