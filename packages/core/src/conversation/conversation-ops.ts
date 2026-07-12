import type { ConversationData, MessageData } from '@legion/types';
import { createConversationId, createId, nowIso } from '../util/ids.js';
import { ConversationNotFoundError } from '../errors/LegionError.js';

export function createConversation(title?: string): ConversationData {
  const now = nowIso();
  return {
    id: createConversationId(),
    schemaVersion: '2.0',
    createdAt: now,
    updatedAt: now,
    title,
    activeBranchHead: '',
    messages: {},
  };
}

export type NewMessageInput = Pick<MessageData, 'senderId' | 'recipientId' | 'role' | 'content'> &
  Partial<
    Pick<
      MessageData,
      'replyTo' | 'type' | 'toolCalls' | 'toolResults' | 'parentId' | 'id' | 'usage' | 'reasoning'
    >
  >;

export function createMessage(
  conversationId: string,
  parentId: string | null,
  input: NewMessageInput,
): MessageData {
  return {
    id: input.id ?? createId('msg'),
    parentId,
    conversationId,
    senderId: input.senderId,
    recipientId: input.recipientId,
    replyTo: input.replyTo,
    role: input.role,
    content: input.content,
    reasoning: input.reasoning,
    type: input.type ?? 'message',
    status: 'active',
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
    usage: input.usage,
    timestamp: nowIso(),
  };
}

export function appendMessage(
  conversation: ConversationData,
  input: NewMessageInput,
): ConversationData {
  const parentId = conversation.activeBranchHead || null;
  const message = createMessage(conversation.id, parentId, input);
  return {
    ...conversation,
    updatedAt: nowIso(),
    activeBranchHead: message.id,
    messages: { ...conversation.messages, [message.id]: message },
  };
}

export function getActiveChain(conversation: ConversationData): MessageData[] {
  const chain: MessageData[] = [];
  if (!conversation.activeBranchHead) return chain;
  let current: MessageData | undefined = conversation.messages[conversation.activeBranchHead];
  while (current) {
    if (current.status !== 'active') {
      // A non-active node in the line of ancestry invalidates this path.
      return [];
    }
    chain.unshift(current);
    current = current.parentId ? conversation.messages[current.parentId] : undefined;
  }
  return chain;
}

function requireMessage(conversation: ConversationData, messageId: string): MessageData {
  const message = conversation.messages[messageId];
  if (!message) {
    throw new ConversationNotFoundError(conversation.id, messageId);
  }
  return message;
}

export function editMessage(
  conversation: ConversationData,
  messageId: string,
  newContent: string,
): ConversationData {
  const original = requireMessage(conversation, messageId);
  const edit = createMessage(conversation.id, original.parentId, {
    senderId: original.senderId,
    recipientId: original.recipientId,
    role: original.role,
    content: newContent,
  });
  edit.editOf = original.id;

  const messages: Record<string, MessageData> = {
    ...conversation.messages,
    [original.id]: { ...original, status: 'superseded', supersededBy: edit.id },
    [edit.id]: edit,
  };

  return {
    ...conversation,
    updatedAt: nowIso(),
    activeBranchHead: edit.id,
    messages,
  };
}

export function validateConversation(conversation: ConversationData): string[] {
  const errors: string[] = [];
  const ids = Object.keys(conversation.messages);

  // activeBranchHead must reference an existing key (empty allowed for new threads).
  if (conversation.activeBranchHead && !conversation.messages[conversation.activeBranchHead]) {
    errors.push(`activeBranchHead references missing message: ${conversation.activeBranchHead}`);
  }

  // Exactly one non-compacted root (parentId null) when there is at least one message.
  const roots = ids.filter(
    (id) =>
      conversation.messages[id].parentId === null &&
      conversation.messages[id].status !== 'compacted',
  );
  if (ids.length > 0 && roots.length !== 1) {
    errors.push(`expected exactly one non-compacted root message, found ${roots.length}`);
  }

  // Parent references must exist.
  for (const id of ids) {
    const parentId = conversation.messages[id].parentId;
    if (parentId !== null && !conversation.messages[parentId]) {
      errors.push(`message ${id} has dangling parentId: ${parentId}`);
    }
  }

  // No cycles reachable from any message walking up to root.
  for (const id of ids) {
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push(`cycle detected involving message: ${cursor}`);
        break;
      }
      seen.add(cursor);
      cursor = conversation.messages[cursor]?.parentId ?? null;
    }
  }

  // superseded => valid supersededBy reference.
  for (const id of ids) {
    const m = conversation.messages[id];
    if (m.status === 'superseded' && (!m.supersededBy || !conversation.messages[m.supersededBy])) {
      errors.push(`superseded message ${id} has invalid supersededBy`);
    }
  }

  // compacted => appears in exactly one summary's compacts array.
  const summaries = ids.map((id) => conversation.messages[id]).filter((m) => m.type === 'summary');
  for (const id of ids) {
    if (conversation.messages[id].status !== 'compacted') continue;
    const count = summaries.filter((s) => s.compacts?.includes(id)).length;
    if (count !== 1) {
      errors.push(`compacted message ${id} appears in ${count} summary nodes (expected 1)`);
    }
  }

  return errors;
}

export function pruneMessage(
  conversation: ConversationData,
  messageId: string,
  prunedBy: string,
): ConversationData {
  const target = requireMessage(conversation, messageId);
  const chain = getActiveChain(conversation);
  const targetIdx = chain.findIndex((m) => m.id === messageId);
  const now = nowIso();
  const messages: Record<string, MessageData> = { ...conversation.messages };

  // Always prune the target message.
  messages[target.id] = { ...target, status: 'pruned', prunedAt: now, prunedBy };

  let head = conversation.activeBranchHead;

  if (targetIdx !== -1) {
    // Target is in the active chain: cascade-prune all descendants and retract head.
    for (let i = targetIdx + 1; i < chain.length; i++) {
      const m = chain[i];
      messages[m.id] = { ...m, status: 'pruned', prunedAt: now, prunedBy };
    }
    head = target.parentId ?? '';
  }

  return {
    ...conversation,
    updatedAt: now,
    activeBranchHead: head,
    messages,
  };
}

export function compactRange(
  conversation: ConversationData,
  compactedIds: string[],
  summaryContent: string,
): ConversationData {
  if (compactedIds.length === 0) return conversation;
  const first = requireMessage(conversation, compactedIds[0]);
  const last = requireMessage(conversation, compactedIds[compactedIds.length - 1]);

  const summary = createMessage(conversation.id, first.parentId, {
    senderId: first.senderId,
    recipientId: first.recipientId,
    role: 'assistant',
    content: summaryContent,
    type: 'summary',
  });
  summary.compacts = [...compactedIds];

  const messages: Record<string, MessageData> = { ...conversation.messages };
  messages[summary.id] = summary;
  for (const id of compactedIds) {
    messages[id] = { ...messages[id], status: 'compacted' };
  }

  // Re-point the message that followed the last compacted node to the summary.
  for (const message of Object.values(messages)) {
    if (message.parentId === last.id && !compactedIds.includes(message.id)) {
      messages[message.id] = { ...message, parentId: summary.id };
    }
  }

  // If the head itself was the last compacted node, advance head to the summary.
  let head = conversation.activeBranchHead;
  if (head === last.id) head = summary.id;

  return {
    ...conversation,
    updatedAt: nowIso(),
    activeBranchHead: head,
    messages,
  };
}
