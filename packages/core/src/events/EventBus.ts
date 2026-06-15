import type { LegionEventMap, LegionEventName } from '@legion/types';

type Handler<E extends LegionEventName> = (payload: LegionEventMap[E]) => void;

export class EventBus {
  private handlers = new Map<LegionEventName, Set<Handler<LegionEventName>>>();

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

  emit<E extends LegionEventName>(event: E, payload: LegionEventMap[E]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {
        // Subscriber errors must not break emission for other handlers.
      }
    }
  }
}
