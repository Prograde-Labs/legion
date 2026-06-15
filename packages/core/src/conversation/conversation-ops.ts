import type { ConversationData, MessageData } from '@legion/types';
import { createConversationId, createId, nowIso } from '../util/ids.js';

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
  Partial<Pick<MessageData, 'replyTo' | 'type' | 'toolCalls' | 'toolResults' | 'parentId' | 'id'>>;

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
    type: input.type ?? 'message',
    status: 'active',
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
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
    chain.unshift(current);
    current = current.parentId ? conversation.messages[current.parentId] : undefined;
  }
  return chain;
}
