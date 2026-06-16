import type { LegionEventMap, LegionEventName } from '@legion/types';

type Handler<E extends LegionEventName> = (payload: LegionEventMap[E]) => void;

export class EventBus {
  private handlers = new Map<LegionEventName, Set<Handler<LegionEventName>>>();
  private anyHandlers = new Set<(event: string, payload: unknown) => void>();
  private onError?: (event: LegionEventName, err: unknown) => void;

  constructor(options?: { onError?: (event: LegionEventName, err: unknown) => void }) {
    this.onError = options?.onError;
  }

  on<E extends LegionEventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<LegionEventName>);
    return () => this.off(event, handler);
  }

  once<E extends LegionEventName>(event: E, handler: Handler<E>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<E extends LegionEventName>(event: E, handler: Handler<E>): void {
    this.handlers.get(event)?.delete(handler as Handler<LegionEventName>);
  }

  onAny(handler: (event: string, payload: unknown) => void): () => void {
    this.anyHandlers.add(handler);
    return () => this.offAny(handler);
  }

  offAny(handler: (event: string, payload: unknown) => void): void {
    this.anyHandlers.delete(handler);
  }

  emit<E extends LegionEventName>(event: E, payload: LegionEventMap[E]): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of [...set]) {
        try { handler(payload); } catch (err) {
          this.onError?.(event, err);
        }
      }
    }
    for (const handler of [...this.anyHandlers]) {
      try { handler(event as string, payload); } catch { /* isolate */ }
    }
  }
}
