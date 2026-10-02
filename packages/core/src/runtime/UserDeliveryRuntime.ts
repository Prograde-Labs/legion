import type { MessageData } from '@legion-collective/types';
import type { Runtime, RuntimeContext, RuntimeResult } from './Runtime.js';
import type { ConnectorRegistry } from '../connectors/ConnectorRegistry.js';

export class UserDeliveryRuntime implements Runtime {
  constructor(
    private participantId: string,
    private connectorRegistry?: ConnectorRegistry,
  ) {}

  async handle(incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    const connectors = this.connectorRegistry?.getActiveConnectors(this.participantId) ?? [];

    for (const connector of connectors) {
      try {
        await connector.deliver({
          id: incoming.id,
          conversationId: incoming.conversationId,
          senderId: incoming.senderId,
          recipientId: incoming.recipientId,
          replyTo: incoming.replyTo,
          content: incoming.content,
          timestamp: incoming.timestamp,
        });
      } catch {
        // Delivery failures are non-fatal: the message is already persisted.
        // The connector will deliver on next reconnect per its own policy.
      }
    }

    context.eventBus.emit('message:delivered', {
      conversationId: context.conversationId,
      recipientId: this.participantId,
      messageId: incoming.id,
    });

    return { kind: 'void' };
  }
}
