import { watchParticipantsTool } from './watch-participants-tool.js';
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

// Macrotask tick: drains ALL pending microtasks before resuming.
// Needed so the async-generator consumer fully processes each emitted
// event (yield -> for-await body -> next queue.next()) before we proceed.
// A single `await Promise.resolve()` is insufficient for >1 event because
// abort would preempt draining a buffered second chunk.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('watch_participants tool', () => {
  it('yields participant:active and participant:retired chunks', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const gen = watchParticipantsTool.stream({}, fakeCtx(bus, controller.signal));

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of gen) chunks.push(chunk);
    })();

    // Let generator body run and subscribe before emitting
    await tick();
    bus.emit('participant:active', { participantId: 'u1' });
    // Let consumer fully drain the active chunk before emitting next
    await tick();
    bus.emit('participant:retired', { participantId: 'u2' });
    // Let consumer fully drain the retired chunk before aborting
    await tick();
    controller.abort();

    await consumer;

    expect(chunks).toContainEqual({ type: 'participant:active', data: { participantId: 'u1' } });
    expect(chunks).toContainEqual({ type: 'participant:retired', data: { participantId: 'u2' } });
  });

  it('terminates cleanly when signal is aborted immediately', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    controller.abort();
    const chunks: StreamChunk[] = [];
    for await (const chunk of watchParticipantsTool.stream({}, fakeCtx(bus, controller.signal))) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });
});
