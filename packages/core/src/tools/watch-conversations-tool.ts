import type { ConversationFilter, StreamChunk } from '@legion/types';
import { conversationMatchesFilter } from '../conversation/conversation-metadata.js';
import { AsyncQueue } from '../streaming/AsyncQueue.js';
import type { StreamingTool, ToolContext } from './Tool.js';

function parseFilter(args: unknown): ConversationFilter {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Invalid watch_conversations filters');
  }

  const input = args as Record<string, unknown>;
  const allowedKeys = new Set(['participantId', 'since', 'status', 'tags', 'includeSubThreads']);
  const { participantId, since, status, tags, includeSubThreads } = input;
  if (
    Object.keys(input).some((key) => !allowedKeys.has(key)) ||
    (participantId !== undefined && typeof participantId !== 'string') ||
    (since !== undefined && typeof since !== 'string') ||
    (status !== undefined && status !== 'active' && status !== 'archived' && status !== 'all') ||
    (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) ||
    (includeSubThreads !== undefined && typeof includeSubThreads !== 'boolean')
  ) {
    throw new Error('Invalid watch_conversations filters');
  }

  return {
    participantId,
    since,
    status,
    tags,
    includeSubThreads,
  };
}

export const watchConversationsTool: StreamingTool = {
  name: 'watch_conversations',
  description:
    'Stream filtered conversation lifecycle events, including creation, updates, and filter exits.',
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      since: { type: 'string' },
      status: { type: 'string', enum: ['active', 'archived', 'all'] },
      tags: { type: 'array', items: { type: 'string' } },
      includeSubThreads: { type: 'boolean' },
    },
    required: [],
    additionalProperties: false,
  },
  async *stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, void> {
    const filter = parseFilter(args);
    const queue = new AsyncQueue<StreamChunk>();
    const unsubs = [
      context.eventBus.on('conversation:created', (data) => {
        const snapshot = structuredClone(data);
        if (conversationMatchesFilter(snapshot.conversation, filter)) {
          queue.push({ type: 'conversation:created', data: snapshot });
        }
      }),
      context.eventBus.on('conversation:updated', (data) => {
        const snapshot = structuredClone(data);
        const beforeMatches = conversationMatchesFilter(snapshot.before, filter);
        if (conversationMatchesFilter(snapshot.after, filter)) {
          queue.push({ type: 'conversation:updated', data: snapshot });
        } else if (beforeMatches) {
          queue.push({
            type: 'conversation:removed',
            data: { conversationId: snapshot.conversationId, reason: 'filter_exit' },
          });
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
