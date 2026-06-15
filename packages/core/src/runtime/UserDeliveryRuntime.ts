import type { MessageData } from '@legion/types';
import type { Runtime, RuntimeContext } from './Runtime.js';

export class UserDeliveryRuntime implements Runtime {
  constructor(private participantId: string) {}

  async handle(incoming: MessageData, context: RuntimeContext): Promise<void> {
    // No internal driver. Persistence already happened in the router; signal delivery.
    // Plan 10 replaces this with ConnectorRegistry-based delivery.
    context.eventBus.emit('message:delivered', {
      conversationId: context.conversationId,
      recipientId: this.participantId,
      messageId: incoming.id,
    });
  }
}
