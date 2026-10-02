import type { ConversationEventMetadata, StreamChunk } from '@legion-collective/types';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';
import { watchConversationsTool } from './watch-conversations-tool.js';

function fakeCtx(eventBus: EventBus, signal?: AbortSignal): ToolContext {
  return {
    participant: { id: 'p', name: 'P', type: 'user', tools: {}, status: 'active' },
    conversationId: '',
    eventBus,
    signal,
  } as unknown as ToolContext;
}

function metadata(
  id: string,
  overrides: Partial<ConversationEventMetadata> = {},
): ConversationEventMetadata {
  return {
    id,
    title: `Conversation ${id}`,
    titles: { p: `Participant title ${id}` },
    status: 'active',
    tags: ['project', 'priority'],
    origin: {
      kind: 'middleware',
      participantId: 'p',
      middlewareInstanceId: 'middleware-1',
      parentConversationId: 'origin-parent',
      parentMessageId: 'message-1',
      parentToolCallId: 'tool-call-1',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    participants: ['p', 'agent-1'],
    ...overrides,
  };
}

async function startWatch(args: unknown, controller = new AbortController()) {
  const eventBus = new EventBus();
  const chunks: StreamChunk[] = [];
  const consumer = (async () => {
    for await (const chunk of watchConversationsTool.stream(
      args,
      fakeCtx(eventBus, controller.signal),
    )) {
      chunks.push(chunk);
    }
  })();

  await Promise.resolve();
  return { eventBus, controller, chunks, consumer };
}

async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('watch_conversations tool', () => {
  it('declares optional conversation filters in its schema', () => {
    expect(watchConversationsTool.parameters).toEqual({
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
    });
  });

  it('emits conversation:created only when status and tags match', async () => {
    const { eventBus, controller, chunks, consumer } = await startWatch({
      status: 'active',
      tags: ['project', 'priority'],
    });
    const matching = metadata('matching');

    eventBus.emit('conversation:created', { conversation: matching });
    eventBus.emit('conversation:created', {
      conversation: metadata('wrong-status', { status: 'archived' }),
    });
    eventBus.emit('conversation:created', {
      conversation: metadata('wrong-tags', { tags: ['project'] }),
    });
    await flushEvents();
    controller.abort();
    await consumer;

    expect(chunks).toEqual([{ type: 'conversation:created', data: { conversation: matching } }]);
  });

  it('emits updates on filter entry and retention, removal on exit, and nothing outside', async () => {
    const { eventBus, controller, chunks, consumer } = await startWatch({
      participantId: 'p',
      status: 'active',
      tags: ['watched'],
      includeSubThreads: false,
    });
    const outside = metadata('conv-1', { tags: ['other'] });
    const entered = metadata('conv-1', { tags: ['watched'] });
    const retained = metadata('conv-1', {
      tags: ['watched', 'extra'],
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    const exited = metadata('conv-1', {
      status: 'archived',
      tags: ['watched', 'extra'],
      updatedAt: '2026-01-04T00:00:00.000Z',
    });
    const stillOutside = metadata('conv-1', {
      status: 'archived',
      tags: ['other'],
      updatedAt: '2026-01-05T00:00:00.000Z',
    });

    eventBus.emit('conversation:updated', {
      conversationId: 'conv-1',
      before: outside,
      after: entered,
    });
    eventBus.emit('conversation:updated', {
      conversationId: 'conv-1',
      before: entered,
      after: retained,
    });
    eventBus.emit('conversation:updated', {
      conversationId: 'conv-1',
      before: retained,
      after: exited,
    });
    eventBus.emit('conversation:updated', {
      conversationId: 'conv-1',
      before: exited,
      after: stillOutside,
    });
    await flushEvents();
    controller.abort();
    await consumer;

    expect(chunks).toEqual([
      {
        type: 'conversation:updated',
        data: { conversationId: 'conv-1', before: outside, after: entered },
      },
      {
        type: 'conversation:updated',
        data: { conversationId: 'conv-1', before: entered, after: retained },
      },
      {
        type: 'conversation:removed',
        data: { conversationId: 'conv-1', reason: 'filter_exit' },
      },
    ]);
  });

  it.each([
    null,
    [],
    { participantId: 1 },
    { since: false },
    { status: 'completed' },
    { tags: 'project' },
    { tags: ['project', 1] },
    { includeSubThreads: 'yes' },
    { statuz: 'active' },
  ])('rejects malformed filters: %j', async (args) => {
    const eventBus = new EventBus();
    const generator = watchConversationsTool.stream(args, fakeCtx(eventBus));

    await expect(generator.next()).rejects.toThrow('Invalid watch_conversations filters');
  });

  it('terminates an already-aborted stream without chunks and removes both listeners', async () => {
    const eventBus = new EventBus();
    const off = vi.spyOn(eventBus, 'off');
    const controller = new AbortController();
    controller.abort();
    const chunks: StreamChunk[] = [];

    for await (const chunk of watchConversationsTool.stream(
      {},
      fakeCtx(eventBus, controller.signal),
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
    expect(off).toHaveBeenCalledTimes(2);
    expect(off.mock.calls.map(([event]) => event)).toEqual([
      'conversation:created',
      'conversation:updated',
    ]);
  });

  it('snapshots matching event payloads before queueing', async () => {
    const { eventBus, controller, chunks, consumer } = await startWatch({ tags: ['watched'] });
    const conversation = metadata('conv-1', { tags: ['watched'] });

    eventBus.emit('conversation:created', { conversation });
    conversation.tags.splice(0, 1, 'mutated');
    conversation.title = 'Mutated after emit';
    await flushEvents();
    controller.abort();
    await consumer;

    expect(chunks).toEqual([
      {
        type: 'conversation:created',
        data: {
          conversation: expect.objectContaining({
            title: 'Conversation conv-1',
            tags: ['watched'],
          }),
        },
      },
    ]);
  });

  it('removes listeners when aborted while waiting', async () => {
    const { eventBus, controller, consumer } = await startWatch({});
    const off = vi.spyOn(eventBus, 'off');

    controller.abort();
    await consumer;

    expect(off).toHaveBeenCalledTimes(2);
  });

  it('drops a queued event when aborted before delivery and removes listeners', async () => {
    const { eventBus, controller, chunks, consumer } = await startWatch({});
    const off = vi.spyOn(eventBus, 'off');

    eventBus.emit('conversation:created', { conversation: metadata('conv-1') });
    controller.abort();
    await consumer;

    expect(chunks).toEqual([]);
    expect(off).toHaveBeenCalledTimes(2);
  });
});
