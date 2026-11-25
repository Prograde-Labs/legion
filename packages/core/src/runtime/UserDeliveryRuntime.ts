import type { ApprovalRequestView, MessageData } from '@legion-collective/types';
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
    const approvalRequests = this.approvalRequests(incoming, context);

    const outcomes: DeliveryOutcome[] = [];
    if (connectors.length === 0) {
      outcomes.push({
        status: 'not-reachable',
        reason: `no connector can reach ${this.participantId}`,
      });
    } else {
      for (const connector of connectors) {
        try {
          const outcome = (await connector.deliver({
            id: incoming.id,
            conversationId: incoming.conversationId,
            senderId: incoming.senderId,
            recipientId: incoming.recipientId,
            replyTo: incoming.replyTo,
            content: incoming.content,
            timestamp: incoming.timestamp,
            ...(approvalRequests.length === 0 ? {} : { approvalRequests }),
          })) as DeliveryOutcome | undefined;
          outcomes.push(
            outcome && typeof outcome === 'object' && typeof outcome.status === 'string'
              ? outcome
              : {
                  status: 'failed',
                  reason: `connector '${connector.name}' returned no delivery outcome`,
                },
          );
        } catch (error) {
          console.error(`[delivery] connector '${connector.name}' threw during delivery`, error);
          outcomes.push({
            status: 'failed',
            reason: `connector '${connector.name}' failed during delivery`,
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

  /**
   * Resolve the structured approval requests carried by a pending-approval
   * message. Connectors use these to render approval cards; the message's
   * tool results remain the durable record in the conversation.
   */
  private approvalRequests(incoming: MessageData, context: RuntimeContext): ApprovalRequestView[] {
    const registry = context.pendingApprovalRegistry;
    if (!registry || !incoming.toolResults) return [];

    const seen = new Set<string>();
    const requests: ApprovalRequestView[] = [];
    for (const toolResult of incoming.toolResults) {
      if (toolResult.result.status !== 'pending_approval') continue;
      const approvalId = toolResult.result.approvalId;
      if (!approvalId || seen.has(approvalId)) continue;
      seen.add(approvalId);
      const pending = registry.get(approvalId);
      if (!pending) continue;
      requests.push({
        approvalId: pending.approvalId,
        conversationId: pending.conversationId,
        requesterId: pending.requesterId,
        tool: pending.tool,
        args: pending.args,
        createdAt: pending.createdAt,
      });
    }
    return requests;
  }
}
