import type { LegionEventName, StreamChunk } from '@legion/types';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';

type ActivityEventName =
  | 'tool:call'
  | 'tool:result'
  | 'iteration'
  | 'approval:requested'
  | 'approval:resolved'
  | 'error';

const ACTIVITY_EVENTS: ActivityEventName[] = [
  'tool:call',
  'tool:result',
  'iteration',
  'approval:requested',
  'approval:resolved',
  'error',
];

export const watchActivityTool: StreamingTool = {
  name: 'watch_activity',
  description:
    'Stream real-time tool:call, tool:result, iteration, approval:requested, approval:resolved, and error events. Optionally filter by conversationId.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Only yield events from this conversation. Omit to receive all.',
      },
    },
    required: [],
  },
  async *stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, void> {
    const { conversationId: filterConvId } = (args ?? {}) as { conversationId?: string };
    const queue = new AsyncQueue<StreamChunk>();

    const unsubs = ACTIVITY_EVENTS.map((event) =>
      context.eventBus.on(event as LegionEventName, (data) => {
        if (filterConvId) {
          const payload = data as { conversationId?: string };
          if (payload.conversationId !== filterConvId) return;
        }
        queue.push({ type: event, data } as unknown as StreamChunk);
      }),
    );

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
