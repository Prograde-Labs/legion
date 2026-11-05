import { LoginRateLimiter } from './LoginRateLimiter.js';

describe('LoginRateLimiter', () => {
  it('allows attempts while under the limit', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
    for (let i = 0; i < 4; i += 1) limiter.recordFailure('127.0.0.1');
    expect(limiter.allow('127.0.0.1')).toBe(true);
  });

  it('blocks the sixth attempt within the window', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('127.0.0.1');
    expect(limiter.allow('127.0.0.1')).toBe(false);
  });

  it('tracks each IP independently', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('10.0.0.1');
    expect(limiter.allow('10.0.0.1')).toBe(false);
    expect(limiter.allow('10.0.0.2')).toBe(true);
  });

  it('reset() clears the failures for an IP (successful login)', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('127.0.0.1');
    limiter.reset('127.0.0.1');
    expect(limiter.allow('127.0.0.1')).toBe(true);
  });

  it('allows attempts again once the window expires', () => {
    vi.useFakeTimers();
    try {
      const limiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
      for (let i = 0; i < 5; i += 1) limiter.recordFailure('127.0.0.1');
      expect(limiter.allow('127.0.0.1')).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(limiter.allow('127.0.0.1')).toBe(true);
      limiter.recordFailure('127.0.0.1');
      expect(limiter.allow('127.0.0.1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes expired entries before evicting live ones when tracking is full', () => {
    vi.useFakeTimers();
    try {
      const limiter = new LoginRateLimiter({
        maxAttempts: 1,
        windowMs: 60_000,
        maxTrackedIps: 2,
      });
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.2');
      vi.advanceTimersByTime(60_000);
      // Both entries are expired; inserting a third IP must prune them, not evict a live one.
      limiter.recordFailure('10.0.0.3');
      expect(limiter.allow('10.0.0.3')).toBe(false);
      expect(limiter.allow('10.0.0.1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the number of tracked IPs, evicting the oldest', () => {
    const limiter = new LoginRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      maxTrackedIps: 2,
    });
    limiter.recordFailure('10.0.0.1');
    limiter.recordFailure('10.0.0.2');
    limiter.recordFailure('10.0.0.3');
    expect(limiter.allow('10.0.0.1')).toBe(true);
    expect(limiter.allow('10.0.0.2')).toBe(false);
    expect(limiter.allow('10.0.0.3')).toBe(false);
  });

  it('reports seconds until the window resets', () => {
    vi.useFakeTimers();
    try {
      const limiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
      expect(limiter.retryAfter('127.0.0.1')).toBe(0);
      limiter.recordFailure('127.0.0.1');
      expect(limiter.retryAfter('127.0.0.1')).toBe(60);
      vi.advanceTimersByTime(15_000);
      expect(limiter.retryAfter('127.0.0.1')).toBe(45);
      vi.advanceTimersByTime(45_000);
      expect(limiter.retryAfter('127.0.0.1')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the documented defaults (5 attempts per 60s)', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('127.0.0.1');
    expect(limiter.allow('127.0.0.1')).toBe(false);
  });
});
