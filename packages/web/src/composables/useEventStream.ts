import { useAuth } from './useAuth.js';

interface StreamEvent {
  type: 'event';
  event: string;
  data: unknown;
}

type EventHandler = (evt: StreamEvent) => void;

// Singleton state
const subscribers = new Set<EventHandler>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;

function dispatch(evt: StreamEvent) {
  for (const handler of subscribers) {
    try {
      handler(evt);
    } catch {
      /* isolate */
    }
  }
}

function connect() {
  const { getToken, isAuthenticated } = useAuth();
  if (!isAuthenticated.value) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    backoff = 1000;
    ws!.send(JSON.stringify({ type: 'auth', token: getToken() }));
  });

  ws.addEventListener('message', (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data as string) as StreamEvent;
      if (msg.type === 'event') dispatch(msg);
    } catch {
      /* ignore malformed */
    }
  });

  ws.addEventListener('close', () => scheduleReconnect());
  ws.addEventListener('error', () => {
    ws?.close();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoff = Math.min(backoff * 2, 30_000);
    connect();
  }, backoff);
}

export function useEventStream() {
  function subscribe(handler: EventHandler): () => void {
    subscribers.add(handler);
    if (!ws || ws.readyState > WebSocket.OPEN) connect();
    return () => subscribers.delete(handler);
  }

  function unsubscribe(handler: EventHandler) {
    subscribers.delete(handler);
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
  }

  return { subscribe, unsubscribe, disconnect };
}

// Test escape hatch — not imported in production
export function _testDispatch(evt: StreamEvent) {
  dispatch(evt);
}
