import { ref } from 'vue';
import { useAuth } from './useAuth.js';
import { router } from '../router/index.js';
import type { StreamChunk } from '@legion-collective/types';

type MessageHandler = (data: unknown) => void;
type StreamChunkHandler = (chunk: StreamChunk) => void;

// Module-level singleton state — one WebSocket for the entire app
const handlers = new Set<MessageHandler>();
const streamHandlers = new Map<string, StreamChunkHandler>();
const pendingStreamChunks: Array<{ streamId: string; chunk: StreamChunk }> = [];
const MAX_PENDING_STREAM_CHUNKS = 100;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;
let stoppedByAuth = false;
const connectionId = ref<string | null>(null);

/** Fail every registered stream so in-flight UI work settles instead of hanging. */
function terminateStreams(): void {
  for (const handler of [...streamHandlers.values()]) {
    try {
      handler({ type: 'stream:error', error: 'WebSocket disconnected' });
    } catch {
      /* isolate */
    }
  }
  streamHandlers.clear();
  pendingStreamChunks.length = 0;
}

function connect(): void {
  const { getToken } = useAuth();
  const token = getToken();
  if (!token) return;
  // Idempotent while a socket is already connecting or open: a second connect()
  // must not leak the first socket.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  ws = socket;

  socket.addEventListener('open', () => {
    backoff = 1000;
    socket.send(JSON.stringify({ type: 'auth', token }));
  });

  socket.addEventListener('message', (evt) => {
    // A retired socket's late frame must not be dispatched for the new connection.
    if (socket !== ws) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(evt.data as string);
    } catch {
      return;
    }

    const msg = parsed as Record<string, unknown>;

    // Handle stream:chunk frames (O(1) routing to registered handler)
    if (msg['type'] === 'stream:chunk') {
      const sid = msg['streamId'] as string;
      const chunk = msg['data'] as StreamChunk;
      const handler = streamHandlers.get(sid);
      if (handler) handler(chunk);
      else {
        pendingStreamChunks.push({ streamId: sid, chunk });
        if (pendingStreamChunks.length > MAX_PENDING_STREAM_CHUNKS) pendingStreamChunks.shift();
      }
      return;
    }

    // Handle connected frame — store connectionId
    if (msg['type'] === 'connected') {
      connectionId.value = (msg['connectionId'] as string) ?? null;
    }

    // Dispatch to all general message handlers
    for (const handler of [...handlers]) {
      try {
        handler(parsed);
      } catch {
        /* isolate */
      }
    }
  });

  socket.addEventListener('close', (evt) => {
    // A retired socket's late close must not disturb the current connection.
    if (socket !== ws) return;
    connectionId.value = null;
    terminateStreams();
    if (evt.code === 4401) {
      stoppedByAuth = true;
      const { logout } = useAuth();
      logout();
      router.push('/login');
      return;
    }
    if (!stoppedByAuth) scheduleReconnect();
  });

  socket.addEventListener('error', () => socket.close());
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
      // A deliberate (re)connect starts a fresh backoff sequence rather than
      // inheriting the previous session's capped delay.
      backoff = 1000;
      connect();
    },
    disconnect() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // Intentional teardown: never schedule a reconnect afterwards.
      stoppedByAuth = true;
      backoff = 1000;
      const socket = ws;
      ws = null;
      connectionId.value = null;
      terminateStreams();
      socket?.close();
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
    /** Register a handler for chunks of a specific stream. Returns unsubscribe fn. */
    onStreamChunk(streamId: string, handler: StreamChunkHandler): () => void {
      streamHandlers.set(streamId, handler);
      for (let index = 0; index < pendingStreamChunks.length;) {
        const pending = pendingStreamChunks[index];
        if (pending.streamId !== streamId) {
          index += 1;
          continue;
        }
        pendingStreamChunks.splice(index, 1);
        handler(pending.chunk);
        if (streamHandlers.get(streamId) !== handler) break;
      }
      return () => {
        if (streamHandlers.get(streamId) === handler) streamHandlers.delete(streamId);
      };
    },
    /** Returns the connectionId issued by the server on auth, or null if not connected. */
    getConnectionId(): string | null {
      return connectionId.value;
    },
  };
}
