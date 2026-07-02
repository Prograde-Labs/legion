import type { LegionEventMap } from '@legion/types';

type EventName = keyof LegionEventMap;

/**
 * Returns true if this event should be delivered to the given participant's WebSocket connection.
 *
 * NOTE: This is a domain-driven switch over event names. It must be updated when new event types
 * are added to LegionEventMap. The long-term fix is event metadata / scope fields so routing
 * does not require knowledge of each event's payload shape.
 */
export function isRelevantToParticipant(
  event: string,
  payload: unknown,
  participantId: string,
  isOperator: boolean,
): boolean {
  const p = payload as Record<string, unknown>;

  switch (event as EventName) {
    // Always broadcast — collective/process state changes affect all participants
    case 'process:ready':
    case 'conversation:created':
    case 'participant:active':
    case 'participant:retired':
    case 'error':
      return true;

    // Scoped to participants involved in the message
    case 'message:sent':
      return p['senderId'] === participantId || p['recipientId'] === participantId;

    case 'message:delivered':
      return p['recipientId'] === participantId;

    // Scoped to the agent doing the work
    case 'tool:call':
    case 'tool:result':
    case 'iteration':
      return p['participantId'] === participantId;

    // Approvals go to operators (they have authority) or the requesting participant
    case 'approval:requested':
    case 'approval:resolved':
      return isOperator || p['requesterId'] === participantId;

    default:
      return false;
  }
}
