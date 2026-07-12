import type { StreamChunk } from '@legion/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';

export const watchConversationsTool: StreamingTool = {
  name: 'watch_conversations',
  description: 'Stream real-time conversation:created events.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async *stream(_args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, void> {
    const queue = new AsyncQueue<StreamChunk>();
    const unsub = context.eventBus.on('conversation:created', (data) => {
      queue.push({ type: 'conversation:created', data });
    });
    try {
      while (true) {
        const chunk = await queue.next(context.signal);
        if (chunk === null) break; // signal aborted
        yield chunk;
      }
    } finally {
      unsub();
    }
  },
};
