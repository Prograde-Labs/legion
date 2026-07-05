import { getCurrentInstance, onUnmounted } from 'vue';
import { useWebSocket } from './useWebSocket.js';
import type { LegionEventMap } from '@legion/types';

type EventName = keyof LegionEventMap;
type EventHandler<K extends EventName> = (payload: LegionEventMap[K]) => void;
type FilterOptions = { conversationId?: string };

// Module-level set of all active typed subscriptions
type AnySubscription = { event: EventName; handler: (p: unknown) => void; filter?: FilterOptions };
const subscriptions = new Set<AnySubscription>();
let unsubscribeFromWs: (() => void) | null = null;

function ensureConnected(): void {
  const ws = useWebSocket();
  if (unsubscribeFromWs) return;
  ws.connect();
  unsubscribeFromWs = ws.onMessage((data) => {
    const msg = data as { type: string; event: string; data: unknown };
    if (msg.type !== 'event') return;
    for (const sub of [...subscriptions]) {
      if (sub.event !== msg.event) continue;
      if (sub.filter?.conversationId) {
        const payload = msg.data as Record<string, unknown>;
        if (payload['conversationId'] !== sub.filter.conversationId) continue;
      }
      try {
        sub.handler(msg.data);
      } catch {
        /* isolate */
      }
    }
  });
}

export function useEventStream() {
  const instance = getCurrentInstance();

  function on<K extends EventName>(
    event: K,
    handler: EventHandler<K>,
    filter?: FilterOptions,
  ): () => void {
    ensureConnected();
    const sub: AnySubscription = { event, handler: handler as (p: unknown) => void, filter };
    subscriptions.add(sub);

    const off = () => subscriptions.delete(sub);

    // Auto-cleanup when called inside a component setup()
    if (instance) {
      onUnmounted(off);
    }

    return off;
  }

  return { on };
}
