import type { MessageData } from '@legion/types';
import type { Runtime, RuntimeContext, RuntimeResult } from '../runtime/Runtime.js';
import type { IncomingMessage, LegionService, ServiceContext } from './LegionService.js';

/**
 * Runtime adapter for `service`-type participants (spec §8 step 4).
 *
 * Registered in `RuntimeRegistry` via the `service` factory (wired in Plan 10):
 *   `registry.registerFactory('service', (id) => serviceManager.getRuntime(id))`
 *
 * Lifecycle dependencies (stopped signal, scoped storage, etc.) are encapsulated in
 * the `makeContext` factory provided by `ServiceManager.loadService()`. This keeps
 * `ServiceRuntime` stateless and testable in isolation.
 */
export class ServiceRuntime implements Runtime {
  constructor(
    private readonly service: LegionService,
    /** Only `canReceive` is consulted — full config lives in ServiceManager. */
    private readonly config: { canReceive?: boolean },
    /**
     * Factory producing a fresh per-call `ServiceContext`.
     * Called with the inbound message's `conversationId`.
     */
    private readonly makeContext: (conversationId: string) => ServiceContext,
  ) {}

  async handle(incoming: MessageData, _context: RuntimeContext): Promise<RuntimeResult> {
    if (this.config.canReceive === false || !this.service.onMessage) {
      return { kind: 'response', content: 'Service does not accept incoming messages.' };
    }

    const msg: IncomingMessage = {
      id: incoming.id,
      conversationId: incoming.conversationId,
      senderId: incoming.senderId,
      recipientId: incoming.recipientId,
      replyTo: incoming.replyTo,
      content: incoming.content,
      timestamp: incoming.timestamp,
    };

    const svcCtx = this.makeContext(incoming.conversationId);
    const result = await this.service.onMessage(msg, svcCtx);

    if (result == null) return { kind: 'void' };
    return { kind: 'response', content: result };
  }
}
