import type {
  ConversationData,
  ConversationEventMetadata,
  ConversationFilter,
  ConversationMutation,
  ConversationStatus,
} from '@legion-collective/types';

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
  if (filter.since && !timestampIsAtOrAfter(conversation.updatedAt, filter.since)) return false;
  if (filter.tags?.some((tag) => !(conversation.tags ?? []).includes(tag))) return false;
  if (filter.participantId && !getParticipants(conversation).includes(filter.participantId)) {
    return false;
  }
  return true;
}

interface ParsedTimestamp {
  wholeSeconds: number;
  fraction: string;
}

function timestampIsAtOrAfter(value: string, minimum: string): boolean {
  const timestamp = parseIsoTimestamp(value);
  const minimumTimestamp = parseIsoTimestamp(minimum);
  if (!timestamp || !minimumTimestamp) return false;
  if (timestamp.wholeSeconds !== minimumTimestamp.wholeSeconds) {
    return timestamp.wholeSeconds > minimumTimestamp.wholeSeconds;
  }

  const length = Math.max(timestamp.fraction.length, minimumTimestamp.fraction.length);
  return timestamp.fraction.padEnd(length, '0') >= minimumTimestamp.fraction.padEnd(length, '0');
}

function parseIsoTimestamp(value: string): ParsedTimestamp | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return undefined;

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), 0);

  const zone = match[8];
  const offsetMinutes =
    zone === 'Z'
      ? 0
      : (zone[0] === '+' ? 1 : -1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return {
    wholeSeconds: local.getTime() / 1000 - offsetMinutes * 60,
    fraction: match[7] ?? '',
  };
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
