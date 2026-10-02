import type { StreamChunk } from '@legion-collective/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';

export const watchConversationTool: StreamingTool = {
  name: 'watch_conversation',
  description: 'Stream message:sent and message:delivered events for a specific conversation.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation to watch.',
      },
    },
    required: ['conversationId'],
  },
  async *stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, void> {
    const { conversationId } = args as { conversationId?: string };
    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    const queue = new AsyncQueue<StreamChunk>();
    const unsubs = [
      context.eventBus.on('message:sent', (data) => {
        if (data.conversationId === conversationId) {
          queue.push({ type: 'message:sent', data });
        }
      }),
      context.eventBus.on('message:delivered', (data) => {
        if (data.conversationId === conversationId) {
          queue.push({ type: 'message:delivered', data });
        }
      }),
    ];

    try {
      while (true) {
        const chunk = await queue.next(context.signal);
        if (chunk === null) break;
        yield chunk;
      }
    } finally {
      for (const unsub of unsubs) unsub();
    }
  },
};
