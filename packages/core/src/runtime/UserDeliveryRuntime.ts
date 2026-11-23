import type { MessageData } from '@legion-collective/types';
import type { Runtime, RuntimeContext, RuntimeResult } from './Runtime.js';
import type { ConnectorRegistry } from '../connectors/ConnectorRegistry.js';
import type { DeliveryOutcome } from '../connectors/Connector.js';

export class UserDeliveryRuntime implements Runtime {
  constructor(
    private participantId: string,
    private connectorRegistry?: ConnectorRegistry,
  ) {}

  async handle(incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    const connectors = this.connectorRegistry?.getDeliverableConnectors(this.participantId) ?? [];

    const outcomes: DeliveryOutcome[] = [];
    if (connectors.length === 0) {
      outcomes.push({
        status: 'not-reachable',
        reason: `no connector can reach ${this.participantId}`,
      });
    } else {
      for (const connector of connectors) {
        try {
          outcomes.push(
            await connector.deliver({
              id: incoming.id,
              conversationId: incoming.conversationId,
              senderId: incoming.senderId,
              recipientId: incoming.recipientId,
              replyTo: incoming.replyTo,
              content: incoming.content,
              timestamp: incoming.timestamp,
            }),
          );
        } catch (error) {
          outcomes.push({
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    context.eventBus.emit('message:delivered', {
      conversationId: context.conversationId,
      recipientId: this.participantId,
      messageId: incoming.id,
    });

    const successful = outcomes.find(
      (outcome) => outcome.status === 'delivered' || outcome.status === 'accepted',
    );
    if (successful) return { kind: 'void', delivery: successful };

    const failed = outcomes.find((outcome) => outcome.status === 'failed');
    const reason = outcomes.map((outcome) => outcome.reason ?? outcome.status).join('; ');
    return {
      kind: 'void',
      delivery: {
        status: failed ? 'failed' : 'not-reachable',
        reason,
      },
    };
  }
}
