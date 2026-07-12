import type {
  ConversationData,
  ConversationEventMetadata,
  ConversationFilter,
  ConversationMutation,
  ConversationStatus,
} from '@legion/types';

type ConversationFilterInput = ConversationData | ConversationEventMetadata;

export function getConversationStatus(conversation: ConversationData): ConversationStatus {
  return conversation.status ?? 'active';
}

export function resolveConversationTitle(
  conversation: Pick<ConversationData, 'title' | 'titles'>,
  viewerParticipantId?: string,
): string | undefined {
  return (
    (viewerParticipantId ? conversation.titles?.[viewerParticipantId] : undefined) ??
    conversation.title
  );
}

export function getConversationEventMetadata(
  conversation: ConversationData,
): ConversationEventMetadata {
  return {
    id: conversation.id,
    title: conversation.title,
    titles: conversation.titles ? { ...conversation.titles } : undefined,
    status: getConversationStatus(conversation),
    tags: [...(conversation.tags ?? [])],
    origin: conversation.origin ? { ...conversation.origin } : undefined,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    participants: getParticipants(conversation),
    parentConversationId: conversation.parentConversationId,
    parentToolCallId: conversation.parentToolCallId,
  };
}

export function conversationMatchesFilter(
  conversation: ConversationFilterInput,
  filter: ConversationFilter,
): boolean {
  const status = conversation.status ?? 'active';
  if ((filter.status ?? 'active') !== 'all' && status !== (filter.status ?? 'active')) return false;
  if (!filter.includeSubThreads && conversation.parentConversationId) return false;
  if (filter.since) {
    const since = Date.parse(filter.since);
    const updatedAt = Date.parse(conversation.updatedAt);
    if (Number.isNaN(since) || Number.isNaN(updatedAt) || updatedAt < since) return false;
  }
  if (filter.tags?.some((tag) => !(conversation.tags ?? []).includes(tag))) return false;
  if (filter.participantId && !getParticipants(conversation).includes(filter.participantId)) {
    return false;
  }
  return true;
}

function getParticipants(conversation: ConversationFilterInput): string[] {
  if ('participants' in conversation) return conversation.participants;

  const participants = new Set<string>();
  for (const message of Object.values(conversation.messages)) {
    participants.add(message.senderId);
    participants.add(message.recipientId);
  }
  return [...participants];
}

export function applyConversationMutation(
  conversation: ConversationData,
  mutation: ConversationMutation,
): ConversationData {
  let result = { ...conversation };

  if (mutation.title) {
    if (mutation.title.scope === 'shared') {
      if (mutation.titleMode !== 'first_write_wins' || conversation.title === undefined) {
        result.title = mutation.title.value;
      }
    } else {
      const participantId = mutation.title.participantId;
      if (!participantId) throw new Error('participantId is required for participant title scope');
      if (
        mutation.titleMode !== 'first_write_wins' ||
        conversation.titles?.[participantId] === undefined
      ) {
        result.titles = { ...conversation.titles, [participantId]: mutation.title.value };
      }
    }
  }

  if (mutation.addTags || mutation.removeTags) {
    const tags = new Set(conversation.tags ?? []);
    for (const tag of mutation.addTags ?? []) tags.add(tag);
    for (const tag of mutation.removeTags ?? []) tags.delete(tag);
    result.tags = [...tags];
  }

  if (mutation.middlewareState) {
    const { participantId, instanceId, value } = mutation.middlewareState;
    result.middlewareState = {
      ...conversation.middlewareState,
      [participantId]: {
        ...conversation.middlewareState?.[participantId],
        [instanceId]: structuredClone(value),
      },
    };
  }

  if (mutation.status) result.status = mutation.status;
  return result;
}
