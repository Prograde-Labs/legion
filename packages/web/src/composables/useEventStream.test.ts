import { describe, expect, it, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';

beforeEach(() => vi.restoreAllMocks());

// We mock useWebSocket so useEventStream doesn't need a real WebSocket
vi.mock('./useWebSocket.js', () => {
  const handlers = new Set<(data: unknown) => void>();
  return {
    useWebSocket: () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      onMessage: (h: (data: unknown) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      send: vi.fn(),
      // Expose for test use
      _emit: (data: unknown) => handlers.forEach((h) => h(data)),
    }),
    __handlers: handlers,
  };
});

describe('useEventStream', () => {
  it('exports on', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const stream = useEventStream();
    expect(typeof stream.on).toBe('function');
  });

  it('on returns an off function', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const stream = useEventStream();
    const off = stream.on('process:ready', () => {});
    expect(typeof off).toBe('function');
    off();
  });
});

describe('useEventStream on()', () => {
  it('on() delivers matching events to handler', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const { useWebSocket } = await import('./useWebSocket.js');
    const ws = useWebSocket() as any;

    const received: unknown[] = [];
    const { on } = useEventStream();
    const off = on('message:sent', (payload) => received.push(payload));

    ws._emit({ type: 'event', event: 'message:sent', data: { conversationId: 'c1', senderId: 'op', recipientId: 'ag' } });
    expect(received).toHaveLength(1);

    off();
  });

  it('on() with conversationId filter drops events for other conversations', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const { useWebSocket } = await import('./useWebSocket.js');
    const ws = useWebSocket() as any;

    const received: unknown[] = [];
    const { on } = useEventStream();
    const off = on('message:sent', (p) => received.push(p), { conversationId: 'c1' });

    ws._emit({ type: 'event', event: 'message:sent', data: { conversationId: 'c2', senderId: 'op', recipientId: 'ag' } });
    expect(received).toHaveLength(0);

    ws._emit({ type: 'event', event: 'message:sent', data: { conversationId: 'c1', senderId: 'op', recipientId: 'ag' } });
    expect(received).toHaveLength(1);

    off();
  });

  it('auto-cleans up handlers when component unmounts', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const { useWebSocket } = await import('./useWebSocket.js');
    const ws = useWebSocket() as any;

    const received: unknown[] = [];

    const TestComponent = defineComponent({
      setup() {
        const { on } = useEventStream();
        on('iteration', (p) => received.push(p));
      },
      template: '<div/>',
    });

    const wrapper = mount(TestComponent);
    ws._emit({ type: 'event', event: 'iteration', data: { conversationId: 'c1', participantId: 'ag', iteration: 0 } });
    expect(received).toHaveLength(1);

    await wrapper.unmount();
    ws._emit({ type: 'event', event: 'iteration', data: { conversationId: 'c1', participantId: 'ag', iteration: 1 } });
    // handler should have been removed — no new events
    expect(received).toHaveLength(1);
  });
});
