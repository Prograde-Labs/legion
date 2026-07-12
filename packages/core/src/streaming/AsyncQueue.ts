/**
 * A simple async queue that bridges EventBus push-events into pull-based
 * AsyncGenerator consumption. Signal-aware: `next(signal)` returns null
 * if the signal is already aborted or aborts while waiting.
 */
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiting: ((value: T | null) => void) | null = null;

  push(value: T): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(value);
    } else {
      this.buffer.push(value);
    }
  }

  async next(signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) return null;
    if (this.buffer.length > 0) return this.buffer.shift()!;

    return new Promise<T | null>((resolve) => {
      this.waiting = resolve;

      if (signal) {
        const onAbort = () => {
          // Only resolve if we're still the waiting callback.
          if (this.waiting === resolve) {
            this.waiting = null;
            resolve(null);
          }
        };
        // { once: true } auto-removes the listener after it fires.
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
