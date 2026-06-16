import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => vi.restoreAllMocks());

describe('useEventStream', () => {
  it('exports subscribe and unsubscribe', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const stream = useEventStream();
    expect(typeof stream.subscribe).toBe('function');
    expect(typeof stream.unsubscribe).toBe('function');
  });

  it('subscribe returns an unsubscribe function', async () => {
    const { useEventStream } = await import('./useEventStream.js');
    const stream = useEventStream();
    const off = stream.subscribe(() => {});
    expect(typeof off).toBe('function');
    off();
  });

  it('notifies subscribers when dispatchEvent is called', async () => {
    const { useEventStream, _testDispatch } = await import('./useEventStream.js');
    const stream = useEventStream();
    const received: unknown[] = [];
    stream.subscribe((evt) => received.push(evt));
    _testDispatch({ type: 'event', event: 'message:sent', data: { conversationId: 'c1' } });
    expect(received).toHaveLength(1);
  });
});
