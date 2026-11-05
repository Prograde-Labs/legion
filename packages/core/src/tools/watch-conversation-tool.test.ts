import { watchConversationTool } from './watch-conversation-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';
import type { ConversationData, StreamChunk } from '@legion-collective/types';

interface FakeConversation {
  id: string;
  participants: string[];
  messages: ConversationData['messages'];
}

function conversation(id: string, participants: string[]): FakeConversation {
  return { id, participants, messages: {} };
}

function fakeCtx(
  eventBus: EventBus,
  signal?: AbortSignal,
  options: { operator?: boolean; conversations?: Record<string, FakeConversation> } = {},
): ToolContext {
  const { operator = false, conversations = { 'conv-1': conversation('conv-1', ['p']) } } = options;
  return {
    participant: {
      id: 'p',
      name: 'P',
      type: 'user',
      tools: {},
      status: 'active',
      operator,
    },
    conversationId: '',
    eventBus,
    signal,
    conversationStore: {
      load: async (id: string) => conversations[id] ?? null,
    },
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

    // Let the async membership check finish and subscribe before emitting
    await new Promise((r) => setTimeout(r, 0));
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

  it('rejects a non-operator who does not participate in the conversation', async () => {
    const bus = new EventBus();
    const gen = watchConversationTool.stream(
      { conversationId: 'conv-9' },
      fakeCtx(bus, undefined, {
        conversations: { 'conv-9': conversation('conv-9', ['someone-else']) },
      }),
    );
    await expect(async () => {
      for await (const _chunk of gen) {
        /* empty */
      }
    }).rejects.toThrow(/unauthorized/i);
  });

  it('rejects a non-operator watching a conversation that does not exist', async () => {
    const bus = new EventBus();
    const gen = watchConversationTool.stream(
      { conversationId: 'missing' },
      fakeCtx(bus, undefined, { conversations: {} }),
    );
    await expect(async () => {
      for await (const _chunk of gen) {
        /* empty */
      }
    }).rejects.toThrow(/unauthorized/i);
  });

  it('lets an operator watch any conversation', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchConversationTool.stream(
      { conversationId: 'conv-9' },
      fakeCtx(bus, controller.signal, { operator: true, conversations: {} }),
    );

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of gen) chunks.push(chunk);
    })();
    await new Promise((r) => setTimeout(r, 0));
    bus.emit('message:sent', {
      conversationId: 'conv-9',
      senderId: 'u1',
      recipientId: 'a1',
      messageId: 'm1',
    });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await consumer;

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('message:sent');
  });
});
