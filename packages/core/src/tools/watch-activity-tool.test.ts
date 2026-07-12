import { watchActivityTool } from './watch-activity-tool.js';
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

describe('watch_activity tool', () => {
  it('yields tool:call and tool:result chunks', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchActivityTool.stream({}, fakeCtx(bus, controller.signal));

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of gen) chunks.push(chunk);
    })();

    // Let generator body run and subscribe before emitting
    await Promise.resolve();
    bus.emit('tool:call', {
      conversationId: 'c1',
      participantId: 'a1',
      tool: 'echo',
      callId: '1',
    });
    // Let the generator drain the chunk before the next emit
    await new Promise((r) => setTimeout(r, 0));
    bus.emit('tool:result', {
      conversationId: 'c1',
      participantId: 'a1',
      tool: 'echo',
      callId: '1',
      status: 'success',
    });
    // Let the generator drain before aborting
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await consumer;

    expect(chunks.some((c) => c.type === 'tool:call')).toBe(true);
    expect(chunks.some((c) => c.type === 'tool:result')).toBe(true);
  });

  it('filters by conversationId when provided', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchActivityTool.stream({ conversationId: 'c1' }, fakeCtx(bus, controller.signal));

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of gen) chunks.push(chunk);
    })();

    // Let generator body run and subscribe before emitting
    await Promise.resolve();
    bus.emit('tool:call', {
      conversationId: 'c2',
      participantId: 'a1',
      tool: 'echo',
      callId: '1',
    });
    // Let the generator drain (c2 filtered out — nothing yielded)
    await new Promise((r) => setTimeout(r, 0));
    bus.emit('tool:call', {
      conversationId: 'c1',
      participantId: 'a1',
      tool: 'echo',
      callId: '2',
    });
    // Let the generator drain before aborting
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await consumer;

    // Only c1 call passes filter
    expect(chunks).toHaveLength(1);
    const c = chunks[0] as { type: string; data: { conversationId: string } };
    expect(c.data.conversationId).toBe('c1');
  });

  it('terminates cleanly when signal is aborted immediately', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    controller.abort();
    const chunks: StreamChunk[] = [];
    for await (const chunk of watchActivityTool.stream({}, fakeCtx(bus, controller.signal))) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });
});
