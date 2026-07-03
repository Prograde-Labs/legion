import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./useAuth.js', () => ({
  useAuth: vi.fn<() => {
    getToken: () => string | null;
    logout: () => void;
  }>(),
}));

vi.mock('../router/index.js', () => ({
  router: { push: vi.fn() },
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
      json: async () => ({ result: { status: 'success', data: ['p1', 'p2'] } }),
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

  it('calls logout and redirects to /login on 401', async () => {
    const { useExecute } = await import('./useExecute.js');
    const { useAuth } = (await import('./useAuth.js')) as unknown as {
      useAuth: ReturnType<typeof vi.fn>;
    };
    const { router } = await import('../router/index.js');

    const logout = vi.fn();
    useAuth.mockReturnValue({
      getToken: () => 'tok-dead',
      logout,
    });

    global.fetch = vi.fn().mockResolvedValue({ status: 401 } as Response);

    const { execute } = useExecute();
    await expect(execute('list_participants', {})).rejects.toThrow('Unauthorized');
    expect(logout).toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith('/login');
  });
});
