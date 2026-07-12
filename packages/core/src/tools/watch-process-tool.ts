import type { ProcessChunk, StreamChunk } from '@legion/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';
import type { ProcessManager } from '../process/ProcessManager.js';

export const watchProcessTool: StreamingTool = {
  name: 'watch_process',
  description:
    'Stream stdout/stderr output and exit events for a running process. The caller must own the process or be an operator.',
  parameters: {
    type: 'object',
    properties: {
      processId: { type: 'string', description: 'ID of the process to watch.' },
    },
    required: ['processId'],
  },
  async *stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, void> {
    const { processId } = args as { processId: string };
    const pm = context.processManager as ProcessManager;

    const handle = pm.get(processId);
    if (!handle) {
      throw new Error(`Process not found: ${processId}`);
    }

    const isOperator = (context.participant as { operator?: boolean }).operator === true;
    if (handle.startedByParticipantId !== context.participant.id && !isOperator) {
      throw new Error(`Not authorized to watch process ${processId}`);
    }

    const queue = new AsyncQueue<ProcessChunk>();

    const offOutput = pm.subscribe(processId, 'output', (evt: unknown) => {
      const e = evt as { stream: 'stdout' | 'stderr'; data: Buffer };
      queue.push({
        type: 'process:output',
        processId,
        stream: e.stream,
        data: e.data.toString('base64'),
      });
    });

    const offExited = pm.subscribe(processId, 'exited', (evt: unknown) => {
      const e = evt as { exitCode: number | null };
      queue.push({ type: 'process:exited', processId, exitCode: e.exitCode ?? null });
    });

    const offError = pm.subscribe(processId, 'error', (evt: unknown) => {
      const e = evt as { error: unknown };
      queue.push({ type: 'process:error', processId, error: String(e.error) });
    });

    try {
      while (true) {
        const chunk = await queue.next(context.signal);
        if (chunk === null) break; // signal aborted
        yield chunk;
        if (chunk.type === 'process:exited' || chunk.type === 'process:error') break;
      }
    } finally {
      offOutput();
      offExited();
      offError();
    }
  },
};
