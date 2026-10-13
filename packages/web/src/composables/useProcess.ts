import { ref, onMounted, onUnmounted, watch } from 'vue';
import type { Ref } from 'vue';
import { useLegionApi } from './useLegionApi.js';
import { useToolStream } from './useToolStream.js';
import { useWebSocket } from './useWebSocket.js';
import type { ProcessHandle } from '@legion-collective/types';

export function useProcess(processId: string) {
  const { execute } = useLegionApi();
  const ws = useWebSocket();

  const handle: Ref<ProcessHandle | null> = ref(null);
  const chunks: Ref<string[]> = ref([]);
  const error: Ref<string | null> = ref(null);

  const procStream = useToolStream('watch_process', () => ({ processId }), {
    onChunk: (chunk) => {
      if (chunk.type === 'process:output') {
        const c = chunk as { data?: string };
        if (c.data) chunks.value.push(atob(c.data));
      } else if (chunk.type === 'process:exited') {
        const c = chunk as { exitCode?: number | null; signal?: string | null };
        if (handle.value) {
          handle.value = {
            ...handle.value,
            status: c.signal != null ? 'killed' : 'exited',
            exitCode: c.exitCode ?? null,
            exitedAt: new Date().toISOString(),
          };
        }
      } else if (chunk.type === 'process:error') {
        const c = chunk as { error?: string };
        error.value = c.error ?? 'Unknown process error';
      }
    },
  });

  watch(
    () => ws.getConnectionId(),
    (id) => {
      if (id && handle.value?.status === 'running') void procStream.start();
    },
  );

  onMounted(async () => {
    try {
      handle.value = await execute<ProcessHandle>('get_process', { id: processId });
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return;
    }

    if (handle.value.status === 'running') {
      try {
        const tail = await execute<{ data: string; totalBytes: number; from: number }>(
          'read_process_output',
          { id: processId, bytes: 65536, decode: 'base64' },
        );
        if (tail.data) chunks.value.push(atob(tail.data));
      } catch {
        // non-fatal — live stream will provide output
      }

      const cid = ws.getConnectionId();
      if (cid) void procStream.start();
    } else {
      // Historical: fetch tail from log file (may be large)
      try {
        const tail = await execute<{ data: string; totalBytes: number; from: number }>(
          'read_process_output',
          { id: processId, bytes: 65536, decode: 'base64' },
        );
        if (tail.data) chunks.value.push(atob(tail.data));
      } catch {
        // non-fatal
      }
    }
  });

  onUnmounted(() => {
    void procStream.cancel();
  });

  async function stop(): Promise<void> {
    const result = await execute<ProcessHandle>('stop_process', { id: processId });
    handle.value = result;
  }

  async function send(data: string): Promise<void> {
    await execute('write_process_input', { id: processId, data });
  }

  async function del(): Promise<void> {
    await execute('delete_process', { id: processId });
  }

  return { handle, chunks, error, stop, send, del };
}
