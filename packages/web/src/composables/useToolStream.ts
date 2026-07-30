import { ref, onUnmounted, type Ref } from 'vue';
import { useWebSocket } from './useWebSocket.js';
import { useAuth } from './useAuth.js';
import type { StreamChunk } from '@legion/types';

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
  const conversationId = ref<string | null>(null);
  const result = ref<unknown>(null);

  let activeStreamId: string | null = null;
  let unregister: (() => void) | null = null;
  let streamCompletion: Promise<void> | null = null;
  let resolveStreamCompletion: (() => void) | null = null;

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
    activeStreamId = body.streamId;
    conversationId.value = body.conversationId ?? null;
    streamCompletion = new Promise<void>((resolve) => {
      resolveStreamCompletion = resolve;
    });

    unregister = ws.onStreamChunk(activeStreamId, (chunk: StreamChunk) => {
      if (chunk.type === 'stream:done') {
        done.value = true;
        result.value = (chunk as { result?: unknown }).result;
        cleanup();
        return;
      }
      if (chunk.type === 'stream:error') {
        error.value = (chunk as { type: string; error: string }).error;
        cleanup();
        return;
      }
      const typed = chunk as TChunk;
      chunks.value.push(typed);
      options.onChunk?.(typed);
    });

    active.value = true;
  }

  function cleanup(): void {
    unregister?.();
    unregister = null;
    activeStreamId = null;
    active.value = false;
    resolveStreamCompletion?.();
    resolveStreamCompletion = null;
    streamCompletion = null;
  }

  async function cancel(): Promise<void> {
    const sid = activeStreamId;
    if (!sid) return;
    const completion = streamCompletion;
    active.value = false;

    const token = getToken();
    if (!token) {
      await completion;
      return;
    }

    // Use buffered mode (?stream=false) so this doesn't itself create a stream.
    try {
      await fetch('/api/execute?stream=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tool: 'cancel_stream', args: { streamId: sid } }),
      });
    } catch {
      // The original stream may still complete; keep its terminal handler registered.
    }
    await completion;
  }

  onUnmounted(() => {
    if (options.cancelOnUnmount !== false) void cancel();
  });

  return { start, cancel, chunks, done, error, active, conversationId, result };
}
