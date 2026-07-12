import { watchConversationsTool } from './watch-conversations-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';
import type { StreamChunk } from '@legion/types';

function fakeCtx(eventBus: EventBus, signal?: AbortSignal): ToolContext {
  return {
    participant: { id: 'p', name: 'P', type: 'user', tools: {}, status: 'active' },
    conversationId: '',
    eventBus,
    signal,
  } as unknown as ToolContext;
}

describe('watch_conversations tool', () => {
  it('yields conversation:created chunks when event fires', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchConversationsTool.stream({}, fakeCtx(bus, controller.signal));

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of gen) {
        chunks.push(chunk);
      }
    })();

    // Let generator body run and subscribe before emitting
    await Promise.resolve();
    bus.emit('conversation:created', { conversationId: 'conv-1' });
    controller.abort();

    await consumer;

    expect(chunks).toContainEqual({
      type: 'conversation:created',
      data: { conversationId: 'conv-1' },
    });
  });

  it('terminates cleanly when signal is aborted immediately', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    controller.abort();
    const chunks: StreamChunk[] = [];
    for await (const chunk of watchConversationsTool.stream({}, fakeCtx(bus, controller.signal))) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });
});
