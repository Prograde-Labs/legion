import type { ToolCallData, ToolCallResult } from './tool.js';
import type { MessageUsage } from './usage.js';
import type { JSONValue } from './middleware.js';

export type MessageRole = 'user' | 'assistant';
export type MessageType = 'message' | 'summary';
export type MessageStatus = 'active' | 'superseded' | 'pruned' | 'compacted';
export type ConversationStatus = 'active' | 'archived';
export type ConversationStatusFilter = ConversationStatus | 'all';

export interface MessageDraft {
  readonly senderId: string;
  readonly recipientId: string;
  readonly role: MessageRole;
  readonly replyTo?: string;
  content: string;
  reasoning?: string;
}

export interface ConversationOrigin {
  readonly kind: 'middleware' | 'tool' | 'participant';
  readonly participantId?: string;
  readonly middlewareInstanceId?: string;
  readonly parentConversationId?: string;
  readonly parentMessageId?: string;
  readonly parentToolCallId?: string;
}

export interface ConversationEventMetadata {
  id: string;
  title?: string;
  titles?: Record<string, string>;
  status: ConversationStatus;
  tags: string[];
  origin?: ConversationOrigin;
  createdAt: string;
  updatedAt: string;
  participants: string[];
  parentConversationId?: string;
  parentToolCallId?: string;
}

export interface ConversationTitleMutation {
  scope: 'shared' | 'participant';
  participantId?: string;
  value: string;
}

export interface ConversationMutation {
  title?: ConversationTitleMutation;
  titleMode?: 'replace' | 'first_write_wins';
  status?: ConversationStatus;
  addTags?: string[];
  removeTags?: string[];
  middlewareState?: {
    participantId: string;
    instanceId: string;
    value: JSONValue;
  };
}

export interface MessageData {
  id: string;
  parentId: string | null;
  conversationId: string;
  senderId: string;
  recipientId: string;
  replyTo?: string;
  role: MessageRole;
  content: string;
  reasoning?: string;
  type?: MessageType;
  status: MessageStatus;
  toolCalls?: ToolCallData[];
  toolResults?: ToolCallResult[];
  usage?: MessageUsage;
  timestamp: string;

  editOf?: string;
  supersededBy?: string;

  compacts?: string[];

  prunedAt?: string;
  prunedBy?: string;
}

export interface ConversationData {
  id: string;
  schemaVersion: '2.0';
  createdAt: string;
  updatedAt: string;
  title?: string;
  titles?: Record<string, string>;
  status?: ConversationStatus;
  tags?: string[];
  origin?: ConversationOrigin;
  middlewareState?: Record<string, Record<string, JSONValue>>;
  activeBranchHead: string;
  messages: Record<string, MessageData>;
  parentConversationId?: string;
  parentToolCallId?: string;
}

export interface ConversationMeta extends ConversationEventMetadata {
  resolvedTitle?: string;
  sharedTitle?: string;
  messageCount: number;
}

export interface ConversationFilter {
  participantId?: string;
  since?: string;
  includeSubThreads?: boolean;
  status?: ConversationStatusFilter;
  tags?: string[];
  viewerParticipantId?: string;
}

export interface ConversationSummary {
  id: string;
  participantIds: string[];
  status: 'active' | 'completed';
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}
