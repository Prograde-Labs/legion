import type { StreamChunk } from '@legion-collective/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';

export const watchParticipantsTool: StreamingTool = {
  name: 'watch_participants',
  description: 'Stream real-time participant:active and participant:retired events.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async *stream(_args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, void> {
    const queue = new AsyncQueue<StreamChunk>();
    const unsubs = [
      context.eventBus.on('participant:active', (data) => {
        queue.push({ type: 'participant:active', data });
      }),
      context.eventBus.on('participant:retired', (data) => {
        queue.push({ type: 'participant:retired', data });
      }),
    ];
    try {
      while (true) {
        const chunk = await queue.next(context.signal);
        if (chunk === null) break; // signal aborted
        yield chunk;
      }
    } finally {
      for (const unsub of unsubs) unsub();
    }
  },
};
