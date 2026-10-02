import { ref, onUnmounted, type Ref } from 'vue';
import { useWebSocket } from './useWebSocket.js';
import { useAuth } from './useAuth.js';
import type { StreamChunk } from '@legion-collective/types';

export interface UseToolStreamOptions<TChunk extends StreamChunk> {
  onChunk?: (chunk: TChunk) => void;
  cancelOnUnmount?: boolean;
}

export interface UseToolStreamReturn<TChunk extends StreamChunk> {
  start(): Promise<void>;
  cancel(): Promise<void>;
  chunks: Ref<TChunk[]>;
  done: Ref<boolean>;
  error: Ref<string | null>;
  active: Ref<boolean>;
  cancelling: Ref<boolean>;
  conversationId: Ref<string | null>;
  result: Ref<unknown>;
}

/**
 * Vue composable for streaming a tool call over WebSocket.
 *
 * Usage:
 * ```ts
 * const stream = useToolStream('watch_conversations', {});
 * watch(ws.getConnectionId, async (id) => {
 *   if (id) await stream.start();
 * });
 * ```
 */
export function useToolStream<TChunk extends StreamChunk = StreamChunk>(
  toolName: string,
  getArgs: () => unknown = () => ({}),
  options: UseToolStreamOptions<TChunk> = {},
): UseToolStreamReturn<TChunk> {
  const ws = useWebSocket();
  const { getToken } = useAuth();

  const chunks = ref<TChunk[]>([]) as Ref<TChunk[]>;
  const done = ref(false);
  const error = ref<string | null>(null);
  const active = ref(false);
  const cancelling = ref(false);
  const conversationId = ref<string | null>(null);
  const result = ref<unknown>(null);

  let activeStreamId: string | null = null;
  let unregister: (() => void) | null = null;
  let streamCompletion: Promise<void> | null = null;
  let resolveStreamCompletion: (() => void) | null = null;
  let generation = 0;
  let terminalGeneration: number | null = null;
  let cancelRequest: Promise<void> | null = null;

  async function start(): Promise<void> {
    // Cancel any in-flight stream before starting a new one
    if (activeStreamId) await cancel();

    done.value = false;
    error.value = null;
    chunks.value = [];
    conversationId.value = null;
    result.value = null;

    const cid = ws.getConnectionId();
    if (!cid) {
      error.value = 'Not connected — connectionId unavailable';
      return;
    }

    const token = getToken();
    if (!token) {
      error.value = 'Not authenticated';
      return;
    }

    let res: Response;
    try {
      res = await fetch('/api/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Stream-Connection': cid,
        },
        body: JSON.stringify({ tool: toolName, args: getArgs() }),
      });
    } catch (err) {
      error.value = `Network error: ${String(err)}`;
      return;
    }

    if (!res.ok) {
      error.value = `Execute failed: ${res.status}`;
      return;
    }

    const body = (await res.json()) as { streamId: string; conversationId: string };
    const streamGeneration = ++generation;
    terminalGeneration = null;
    activeStreamId = body.streamId;
    conversationId.value = body.conversationId ?? null;
    streamCompletion = new Promise<void>((resolve) => {
      resolveStreamCompletion = resolve;
    });

    active.value = true;
    const unsubscribe = ws.onStreamChunk(activeStreamId, (chunk: StreamChunk) => {
      if (streamGeneration !== generation || activeStreamId !== body.streamId) return;
      if (chunk.type === 'stream:done') {
        terminalGeneration = streamGeneration;
        done.value = true;
        result.value = (chunk as { result?: unknown }).result;
        cleanup(streamGeneration);
        return;
      }
      if (chunk.type === 'stream:error') {
        terminalGeneration = streamGeneration;
        error.value = (chunk as { type: string; error: string }).error;
        cleanup(streamGeneration);
        return;
      }
      const typed = chunk as TChunk;
      chunks.value.push(typed);
      options.onChunk?.(typed);
    });
    if (streamGeneration === generation && activeStreamId === body.streamId)
      unregister = unsubscribe;
    else unsubscribe();
  }

  function cleanup(streamGeneration: number): void {
    if (streamGeneration !== generation) return;
    unregister?.();
    unregister = null;
    activeStreamId = null;
    active.value = false;
    cancelling.value = false;
    resolveStreamCompletion?.();
    resolveStreamCompletion = null;
    streamCompletion = null;
  }

  async function cancel(): Promise<void> {
    if (cancelRequest) return cancelRequest;
    const sid = activeStreamId;
    if (!sid) return;
    const completion = streamCompletion;
    const streamGeneration = generation;
    cancelling.value = true;

    const request = (async () => {
      try {
        const token = getToken();
        if (!token) throw new Error('Cancel failed: Not authenticated');
        const response = await fetch('/api/execute?stream=false', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ tool: 'cancel_stream', args: { streamId: sid } }),
        });
        if (!response.ok) throw new Error(`Cancel failed: ${response.status}`);
        const payload = (await response.json()) as {
          result?: { status?: string; error?: string };
        };
        const cancelResult = payload.result;
        if (cancelResult?.status !== 'success') {
          if (
            cancelResult?.error === 'Stream not found or already complete' &&
            terminalGeneration === streamGeneration
          ) {
            return;
          }
          throw new Error(`Cancel failed: ${cancelResult?.error ?? 'Unknown error'}`);
        }
        await completion;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : `Cancel failed: ${String(cause)}`;
        if (streamGeneration === generation && activeStreamId === sid) {
          error.value = message;
          cancelling.value = false;
        }
        throw cause instanceof Error ? cause : new Error(message);
      }
    })();
    cancelRequest = request;
    try {
      await request;
    } finally {
      if (cancelRequest === request) cancelRequest = null;
    }
  }

  onUnmounted(() => {
    if (options.cancelOnUnmount !== false) void cancel().catch(() => undefined);
  });

  return { start, cancel, chunks, done, error, active, cancelling, conversationId, result };
}
