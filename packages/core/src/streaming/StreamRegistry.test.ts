import { StreamRegistry } from './StreamRegistry.js';

describe('StreamRegistry', () => {
  it('register returns an AbortSignal that is not aborted', () => {
    const reg = new StreamRegistry();
    const signal = reg.register('s1', 'conn-1', 'p1');
    expect(signal.aborted).toBe(false);
  });

  it('cancelForParticipant aborts the signal and returns true for the owner', () => {
    const reg = new StreamRegistry();
    const signal = reg.register('s1', 'conn-1', 'p1');
    expect(reg.cancelForParticipant('s1', 'p1')).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it('cancels only when the participant owns the stream', () => {
    const registry = new StreamRegistry();
    registry.register('s1', 'conn-1', 'p1');
    expect(registry.cancelForParticipant('s1', 'p2')).toBe(false);
    expect(registry.cancelForParticipant('s1', 'p1')).toBe(true);
  });

  it('cancelForParticipant returns false for unknown streamId', () => {
    const reg = new StreamRegistry();
    expect(reg.cancelForParticipant('nope', 'p1')).toBe(false);
  });

  it('cancelAll aborts all streams for a connectionId', () => {
    const reg = new StreamRegistry();
    const sig1 = reg.register('s1', 'conn-A', 'p1');
    const sig2 = reg.register('s2', 'conn-A', 'p2');
    const sig3 = reg.register('s3', 'conn-B', 'p1');
    reg.cancelAll('conn-A');
    expect(sig1.aborted).toBe(true);
    expect(sig2.aborted).toBe(true);
    expect(sig3.aborted).toBe(false);
  });

  it('cancelForParticipant after cancelAll returns false', () => {
    const reg = new StreamRegistry();
    reg.register('s1', 'conn-1', 'p1');
    reg.cancelAll('conn-1');
    expect(reg.cancelForParticipant('s1', 'p1')).toBe(false);
  });
});
