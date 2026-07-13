import { AsyncQueue } from './AsyncQueue.js';

describe('AsyncQueue', () => {
  it('returns pushed values in order', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBe(2);
  });

  it('awaits a value that arrives after next() is called', async () => {
    const q = new AsyncQueue<string>();
    const prom = q.next();
    q.push('hello');
    expect(await prom).toBe('hello');
  });

  it('returns null when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const q = new AsyncQueue<number>();
    const result = await q.next(controller.signal);
    expect(result).toBeNull();
  });

  it('returns null when signal aborts while waiting', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const q = new AsyncQueue<number>();
    const prom = q.next(controller.signal);
    controller.abort();
    expect(await prom).toBeNull();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('delivers value pushed before abort fires', async () => {
    const controller = new AbortController();
    const q = new AsyncQueue<number>();
    q.push(42);
    const result = await q.next(controller.signal);
    // Value was in buffer — should return it even though signal exists
    expect(result).toBe(42);
  });

  it('removes the abort listener after every signal-backed delivery', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const q = new AsyncQueue<number>();

    for (let value = 0; value < 5; value++) {
      const result = q.next(controller.signal);
      q.push(value);
      expect(await result).toBe(value);
    }

    expect(add).toHaveBeenCalledTimes(5);
    expect(remove).toHaveBeenCalledTimes(5);
  });

  it('lets same-turn cancellation win and preserves the queued value', async () => {
    const controller = new AbortController();
    const q = new AsyncQueue<number>();
    const result = q.next(controller.signal);

    q.push(42);
    controller.abort();

    expect(await result).toBeNull();
    expect(await q.next()).toBe(42);
  });
});
