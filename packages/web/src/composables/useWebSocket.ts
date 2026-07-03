import { useAuth } from './useAuth.js';
import { router } from '../router/index.js';

type MessageHandler = (data: unknown) => void;

// Module-level singleton state — one WebSocket for the entire app
const handlers = new Set<MessageHandler>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;
let stoppedByAuth = false;

function connect(): void {
  const { getToken } = useAuth();
  const token = getToken();
  if (!token) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    backoff = 1000;
    ws!.send(JSON.stringify({ type: 'auth', token }));
  });

  ws.addEventListener('message', (evt) => {
    let parsed: unknown;
    try { parsed = JSON.parse(evt.data as string); } catch { return; }
    for (const handler of [...handlers]) {
      try { handler(parsed); } catch { /* isolate */ }
    }
  });

  ws.addEventListener('close', (evt) => {
    if (evt.code === 4401) {
      stoppedByAuth = true;
      const { logout } = useAuth();
      logout();
      router.push('/login');
      return;
    }
    scheduleReconnect();
  });
  ws.addEventListener('error', () => ws?.close());
}

function scheduleReconnect(): void {
  if (stoppedByAuth) return;
  if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stoppedByAuth) return;
      backoff = Math.min(backoff * 2, 30_000);
      connect();
    }, backoff);
}

export function useWebSocket() {
  return {
    connect() {
      stoppedByAuth = false;
      if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    },
    disconnect() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stoppedByAuth = false;
      ws?.close();
      ws = null;
    },
    onMessage(handler: MessageHandler): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    send(data: unknown): void {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    },
  };
}
