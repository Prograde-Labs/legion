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

describe('useLegionApi.onEvent', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('filters bus messages by type and unsubscribes', async () => {
    vi.doMock('./useAuth.js', () => ({
      useAuth: () => ({
        getToken: () => 'tok-1',
        logout: () => {},
        isAuthenticated: { value: true },
        login: async () => {},
      }),
    }));
    vi.doMock('../router/index.js', () => ({ router: { push: vi.fn() } }));

    class FakeWS {
      static instances: FakeWS[] = [];
      static OPEN = 1;
      readyState = 1;
      listeners: Record<string, EventListener[]> = {};
      sent: string[] = [];
      constructor(public url: string) {
        FakeWS.instances.push(this);
      }
      addEventListener(type: string, listener: EventListener) {
        (this.listeners[type] ??= []).push(listener);
      }
      dispatchEvent(ev: Event) {
        for (const l of this.listeners[ev.type] ?? []) l(ev);
        return true;
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3;
      }
    }

    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });

    const { useLegionApi } = await import('./useLegionApi.js');
    const { useWebSocket } = await import('./useWebSocket.js');

    const seen: unknown[] = [];
    const api = useLegionApi();
    const off = api.onEvent('approval:requested', (d) => seen.push(d));

    // The WS singleton only starts listeners on connect(); connect via the
    // api facade to register them.
    await api.login('operator', 'pw'); // seeds auth (mocked) + ws.connect()

    // Drive the transport directly: emit a matching frame, a non-matching
    // frame, then unsubscribe and emit again.
    const wsApi = useWebSocket();
    wsApi.onMessage; // transport handlers receive frames via dispatchEvent below
    const sock = FakeWS.instances[FakeWS.instances.length - 1];
    const emit = (frame: unknown) =>
      sock.dispatchEvent({
        type: 'message',
        data: JSON.stringify(frame),
      } as unknown as Event);

    emit({ type: 'approval:requested', data: { approvalId: 'a1' } });
    emit({ type: 'approval:resolved', data: { approvalId: 'a1' } });
    await Promise.resolve(); // let any microtasks settle
    expect(seen).toEqual([{ approvalId: 'a1' }]);

    off();
    emit({ type: 'approval:requested', data: { approvalId: 'a2' } });
    await Promise.resolve();
    expect(seen).toEqual([{ approvalId: 'a1' }]); // after unsubscribe nothing arrives

    vi.unstubAllGlobals();
  });
});
