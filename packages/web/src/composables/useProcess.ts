import { ref, onMounted, onUnmounted } from 'vue';
import type { Ref } from 'vue';
import { useExecute } from './useExecute.js';
import { useWebSocket } from './useWebSocket.js';
import type { ProcessHandle } from '@legion/types';

export function useProcess(processId: string) {
  const { execute } = useExecute();
  const { send: wsSend, onMessage } = useWebSocket();

  const handle: Ref<ProcessHandle | null> = ref(null);
  const chunks: Ref<string[]> = ref([]);
  const error: Ref<string | null> = ref(null);

  let subscribed = false;
  let offMessage: (() => void) | null = null;

  function handleWsMessage(raw: unknown): void {
    const msg = raw as {
      type: string;
      processId: string;
      data?: string;
      exitCode?: number | null;
      signal?: string | null;
      error?: string;
    };
    if (msg.processId !== processId) return;

    if (msg.type === 'process:output' && msg.data) {
      chunks.value.push(atob(msg.data));
    } else if (msg.type === 'process:exited') {
      if (handle.value) {
        handle.value = {
          ...handle.value,
          status: msg.signal != null ? 'killed' : 'exited',
          exitCode: msg.exitCode ?? null,
          exitedAt: new Date().toISOString(),
        };
      }
      // Server auto-detaches subscription; just clean up our listener
      if (offMessage) {
        offMessage();
        offMessage = null;
      }
      subscribed = false;
    } else if (msg.type === 'process:error') {
      error.value = msg.error ?? 'Unknown process error';
    }
  }

  function cleanup(): void {
    if (offMessage) {
      offMessage();
      offMessage = null;
    }
    if (subscribed) {
      wsSend({ type: 'unsubscribe_process', processId });
      subscribed = false;
    }
  }

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

      offMessage = onMessage(handleWsMessage);
      wsSend({ type: 'subscribe_process', processId });
      subscribed = true;
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
    cleanup();
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
