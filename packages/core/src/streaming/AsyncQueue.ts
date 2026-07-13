/**
 * A simple async queue that bridges EventBus push-events into pull-based
 * AsyncGenerator consumption. Signal-aware: `next(signal)` returns null
 * if the signal is already aborted or aborts while waiting.
 */
interface Waiter<T> {
  resolve: (value: T | null) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  deliveryScheduled: boolean;
}

export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiting: Waiter<T> | null = null;

  push(value: T): void {
    this.buffer.push(value);
    this.scheduleDelivery();
  }

  async next(signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) return null;

    return new Promise<T | null>((resolve) => {
      const waiter: Waiter<T> = { resolve, signal, deliveryScheduled: false };
      this.waiting = waiter;

      if (signal) {
        waiter.onAbort = () => this.settle(waiter, null);
        signal.addEventListener('abort', waiter.onAbort);
      }

      this.scheduleDelivery();
    });
  }

  private scheduleDelivery(): void {
    const waiter = this.waiting;
    if (!waiter || waiter.deliveryScheduled || this.buffer.length === 0) return;

    waiter.deliveryScheduled = true;
    queueMicrotask(() => {
      waiter.deliveryScheduled = false;
      if (this.waiting !== waiter) return;
      if (waiter.signal?.aborted) {
        this.settle(waiter, null);
      } else if (this.buffer.length > 0) {
        this.settle(waiter, this.buffer.shift()!);
      }
    });
  }

  private settle(waiter: Waiter<T>, value: T | null): void {
    if (this.waiting !== waiter) return;
    this.waiting = null;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(value);
  }
}
