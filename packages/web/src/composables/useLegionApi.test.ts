import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useLegionApi } from './useLegionApi.js';

// useAuth holds module-scoped @vueuse/core useLocalStorage refs that read storage ONCE at
// module init. Seeding via localStorage.setItem() in beforeEach (after those refs exist)
// never propagates, so seed at hoist time — before the module graph (and its refs) initializes.
vi.hoisted(() => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
});

function seedToken() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
}

describe('useLegionApi.execute', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    seedToken();
  });

  it('posts the tool call and unwraps result.data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'success', data: { id: 'x' } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { execute } = useLegionApi();
    const data = await execute<{ id: string }>('list_participants', {});
    expect(data).toEqual({ id: 'x' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/execute?stream=false');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ tool: 'list_participants', args: {} });
    expect(init.headers.Authorization).toBe('Bearer tok-123');
  });

  it('throws the tool error message on status:error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'error', error: 'boom' } }), {
          status: 200,
        }),
      ),
    );
    const { execute } = useLegionApi();
    await expect(execute('nope', {})).rejects.toThrow('boom');
  });

  it('logs out and rethrows on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })));
    const { execute, isAuthenticated } = useLegionApi();
    await expect(execute('list_participants', {})).rejects.toThrow('Unauthorized');
    expect(isAuthenticated.value).toBe(false);
  });
});
