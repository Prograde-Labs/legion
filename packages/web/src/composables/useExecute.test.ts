import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./useAuth.js', () => ({
  useAuth: vi.fn<() => {
    getToken: () => string | null;
    logout: () => void;
  }>(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useExecute', () => {
  it('POSTs to /api/execute with bearer token and returns result', async () => {
    const { useExecute } = await import('./useExecute.js');
    const { useAuth } = (await import('./useAuth.js')) as unknown as {
      useAuth: ReturnType<typeof vi.fn>;
    };

    useAuth.mockReturnValue({
      getToken: () => 'tok-1',
      logout: () => {},
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ['p1', 'p2'], conversationId: 'c1' }),
    } as Response);

    const { execute } = useExecute();
    const result = await execute<string[]>('list_participants', {});
    expect(result).toEqual(['p1', 'p2']);
    expect(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers['Authorization'],
    ).toBe('Bearer tok-1');
  });

  it('throws on non-ok response', async () => {
    const { useExecute } = await import('./useExecute.js');
    const { useAuth } = (await import('./useAuth.js')) as unknown as {
      useAuth: ReturnType<typeof vi.fn>;
    };

    useAuth.mockReturnValue({
      getToken: () => 'tok-1',
      logout: () => {},
    });

    global.fetch =
      vi.fn()
      .mockResolvedValue({ ok: false, text: async () => 'Forbidden' } as Response);

    const { execute } = useExecute();
    await expect(execute('list_participants', {})).rejects.toThrow('Forbidden');
  });
});
