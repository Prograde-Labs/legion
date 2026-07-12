import { StreamRegistry } from './StreamRegistry.js';

describe('StreamRegistry', () => {
  it('register returns an AbortSignal that is not aborted', () => {
    const reg = new StreamRegistry();
    const signal = reg.register('s1', 'conn-1');
    expect(signal.aborted).toBe(false);
  });

  it('cancel aborts the signal and returns true', () => {
    const reg = new StreamRegistry();
    const signal = reg.register('s1', 'conn-1');
    expect(reg.cancel('s1')).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it('cancel returns false for unknown streamId', () => {
    const reg = new StreamRegistry();
    expect(reg.cancel('nope')).toBe(false);
  });

  it('cancelAll aborts all streams for a connectionId', () => {
    const reg = new StreamRegistry();
    const sig1 = reg.register('s1', 'conn-A');
    const sig2 = reg.register('s2', 'conn-A');
    const sig3 = reg.register('s3', 'conn-B');
    reg.cancelAll('conn-A');
    expect(sig1.aborted).toBe(true);
    expect(sig2.aborted).toBe(true);
    expect(sig3.aborted).toBe(false);
  });

  it('cancel after cancelAll returns false', () => {
    const reg = new StreamRegistry();
    reg.register('s1', 'conn-1');
    reg.cancelAll('conn-1');
    expect(reg.cancel('s1')).toBe(false);
  });
});
