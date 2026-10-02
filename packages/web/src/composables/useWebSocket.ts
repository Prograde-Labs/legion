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

  ws.addEventListener('close', (evt) => {
    connectionId.value = null;
    for (const handler of [...streamHandlers.values()]) {
      try {
        handler({ type: 'stream:error', error: 'WebSocket disconnected' });
      } catch {
        /* isolate */
      }
    }
    streamHandlers.clear();
    pendingStreamChunks.length = 0;
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
    /** Register a handler for chunks of a specific stream. Returns unsubscribe fn. */
    onStreamChunk(streamId: string, handler: StreamChunkHandler): () => void {
      streamHandlers.set(streamId, handler);
      for (let index = 0; index < pendingStreamChunks.length; ) {
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
