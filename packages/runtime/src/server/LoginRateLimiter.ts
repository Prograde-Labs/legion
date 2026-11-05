export interface LoginRateLimiterOptions {
  /** Failed attempts allowed per IP within a window. */
  maxAttempts: number;
  /** Length of the fixed window in milliseconds. */
  windowMs: number;
  /** Upper bound on tracked IPs, so hostile traffic cannot grow the map without limit. */
  maxTrackedIps: number;
}

const DEFAULT_OPTIONS: LoginRateLimiterOptions = {
  maxAttempts: 5,
  windowMs: 60_000,
  maxTrackedIps: 10_000,
};

interface AttemptRecord {
  count: number;
  resetAt: number;
}

/**
 * Per-IP failed-login throttle. The window is fixed from the first failure:
 * once it elapses the IP starts fresh. Expired entries are pruned on insert,
 * and the oldest live entries are evicted once the tracking cap is reached.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly options: LoginRateLimiterOptions;

  constructor(options: Partial<LoginRateLimiterOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  allow(ip: string): boolean {
    const entry = this.attempts.get(ip);
    if (!entry) return true;
    if (Date.now() >= entry.resetAt) {
      this.attempts.delete(ip);
      return true;
    }
    return entry.count < this.options.maxAttempts;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now >= entry.resetAt) {
      if (!entry && this.attempts.size >= this.options.maxTrackedIps) {
        this.makeRoom(now);
      }
      this.attempts.set(ip, { count: 1, resetAt: now + this.options.windowMs });
      return;
    }
    entry.count += 1;
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
  }

  /** Whole seconds until the IP's window resets; 0 when it is not being throttled. */
  retryAfter(ip: string): number {
    const entry = this.attempts.get(ip);
    if (!entry) return 0;
    const remainingMs = entry.resetAt - Date.now();
    if (remainingMs <= 0) return 0;
    return Math.ceil(remainingMs / 1000);
  }

  /** Drop expired entries, then evict the oldest live ones if still at the cap. */
  private makeRoom(now: number): void {
    for (const [ip, entry] of this.attempts) {
      if (now >= entry.resetAt) this.attempts.delete(ip);
    }
    while (this.attempts.size >= this.options.maxTrackedIps) {
      const oldest = this.attempts.keys().next().value;
      if (oldest === undefined) break;
      this.attempts.delete(oldest);
    }
  }
}
