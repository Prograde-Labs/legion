import { computed, type Ref } from 'vue';
import { useAuth } from './useAuth.js';
import { useWebSocket } from './useWebSocket.js';
import { router } from '../router/index.js';

type EventHandler = (data: unknown) => void;

export function useLegionApi() {
  const auth = useAuth();
  const ws = useWebSocket();
  const connected = computed(() => ws.getConnectionId() !== null);
  const connectionId: Ref<string | null> = computed(() => ws.getConnectionId()) as Ref<
    string | null
  >;

  async function execute<T>(tool: string, args: unknown = {}): Promise<T> {
    const res = await fetch('/api/execute?stream=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.getToken() ?? ''}`,
      },
      body: JSON.stringify({ tool, args }),
    });
    if (res.status === 401) {
      auth.logout();
      void router.push('/login');
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { result: { status: string; data?: T; error?: string } };
    if (data.result.status === 'error') throw new Error(data.result.error ?? 'Tool error');
    return data.result.data as T;
  }

  async function login(name: string, password: string): Promise<void> {
    await auth.login(name, password);
    ws.connect();
  }

  function logout(): void {
    ws.disconnect();
    auth.logout();
  }

  function onEvent(type: string, handler: EventHandler): () => void {
    return ws.onMessage((msg) => {
      const typed = msg as Record<string, unknown>;
      if (typed['type'] === type) handler(typed['data']);
    });
  }

  return {
    execute,
    login,
    logout,
    onEvent,
    connected,
    connectionId,
    isAuthenticated: auth.isAuthenticated,
  };
}
