import { EventBus } from './EventBus.js';

describe('EventBus', () => {
  it('delivers a typed payload to a subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('message:sent', (p) => seen.push(p.messageId));
    bus.emit('message:sent', {
      conversationId: 'c1',
      senderId: 'a',
      recipientId: 'b',
      messageId: 'm1',
    });
    expect(seen).toEqual(['m1']);
  });

  it('supports multiple subscribers and unsubscribe', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('process:ready', () => (count += 1));
    bus.on('process:ready', () => (count += 1));
    bus.emit('process:ready', { workspaceRoot: '/w' });
    expect(count).toBe(2);
    off();
    bus.emit('process:ready', { workspaceRoot: '/w' });
    expect(count).toBe(3);
  });

  it('once fires a handler a single time', () => {
    const bus = new EventBus();
    let count = 0;
    bus.once('iteration', () => (count += 1));
    bus.emit('iteration', { conversationId: 'c', participantId: 'a', iteration: 1 });
    bus.emit('iteration', { conversationId: 'c', participantId: 'a', iteration: 2 });
    expect(count).toBe(1);
  });

  it('does not run handlers added during the current emit', () => {
    const bus = new EventBus();
    const calls: string[] = [];
    const lateHandler = () => calls.push('late');

    bus.on('process:ready', () => {
      calls.push('first');
      bus.on('process:ready', lateHandler);
    });

    bus.emit('process:ready', { workspaceRoot: '/w' });
    expect(calls).toEqual(['first']);

    bus.emit('process:ready', { workspaceRoot: '/w' });
    expect(calls).toEqual(['first', 'first', 'late']);
  });

  it('isolates subscriber errors so other handlers still run', () => {
    const bus = new EventBus();
    let reached = false;
    bus.on('process:ready', () => {
      throw new Error('boom');
    });
    bus.on('process:ready', () => (reached = true));
    expect(() => bus.emit('process:ready', { workspaceRoot: '/w' })).not.toThrow();
    expect(reached).toBe(true);
  });

  it('calls onError with the event name and error when a subscriber throws', () => {
    const errors: Array<{ event: string; err: unknown }> = [];
    const bus = new EventBus({
      onError: (event, err) => errors.push({ event, err }),
    });
    const boom = new Error('boom');
    bus.on('process:ready', () => {
      throw boom;
    });
    bus.emit('process:ready', { workspaceRoot: '/w' });
    expect(errors).toHaveLength(1);
    expect(errors[0].event).toBe('process:ready');
    expect(errors[0].err).toBe(boom);
  });
});
