import { watchConversationTool } from './watch-conversation-tool.js';
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

describe('watch_conversation tool', () => {
  it('yields message:sent and message:delivered for the given conversationId', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchConversationTool.stream(
      { conversationId: 'conv-1' },
      fakeCtx(bus, controller.signal),
    );

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of gen) chunks.push(chunk);
    })();

    // Let generator body run and subscribe before emitting
    await Promise.resolve();
    bus.emit('message:sent', {
      conversationId: 'conv-1',
      senderId: 'u1',
      recipientId: 'a1',
      messageId: 'm1',
    });
    bus.emit('message:sent', {
      conversationId: 'conv-2',
      senderId: 'u2',
      recipientId: 'a2',
      messageId: 'm2',
    }); // filtered
    // Let the first emit flow through the queue before the next
    await new Promise((r) => setTimeout(r, 0));
    bus.emit('message:delivered', {
      conversationId: 'conv-1',
      recipientId: 'u1',
      messageId: 'm1',
    });
    // Delivery is microtask-scheduled so same-turn abort can deterministically win.
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();

    await consumer;

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('message:sent');
    expect(chunks[1].type).toBe('message:delivered');
  });

  it('throws when conversationId arg is missing', async () => {
    const bus = new EventBus();
    const gen = watchConversationTool.stream({}, fakeCtx(bus));
    await expect(async () => {
      for await (const _chunk of gen) {
        /* empty */
      }
    }).rejects.toThrow(/conversationId/i);
  });
});
