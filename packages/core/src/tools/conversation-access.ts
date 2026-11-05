import { getConversationParticipants } from '../conversation/conversation-metadata.js';
import type { ToolContext } from './Tool.js';

/**
 * Fail-closed viewer check for conversation-scoped streaming tools.
 *
 * Operators may watch any conversation. Everyone else must be a participant
 * (sender/recipient) of the conversation. A missing conversation or store is
 * treated as unauthorized rather than leaking a global feed.
 */
export async function assertConversationAccess(
  context: ToolContext,
  conversationId: string,
): Promise<void> {
  if (context.participant.operator === true) return;

  const conversation = context.conversationStore
    ? await context.conversationStore.load(conversationId)
    : null;
  if (
    !conversation ||
    !getConversationParticipants(conversation).includes(context.participant.id)
  ) {
    throw new Error('unauthorized');
  }
}
