import type { ToolCallData, ToolCallResult } from './tool.js';
import type { MessageUsage } from './usage.js';

export type MessageRole = 'user' | 'assistant';
export type MessageType = 'message' | 'summary';
export type MessageStatus = 'active' | 'superseded' | 'pruned' | 'compacted';

export interface MessageData {
  id: string;
  parentId: string | null;
  conversationId: string;
  senderId: string;
  recipientId: string;
  replyTo?: string;
  role: MessageRole;
  content: string;
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
  activeBranchHead: string;
  messages: Record<string, MessageData>;
  parentConversationId?: string;
  parentToolCallId?: string;
}

export interface ConversationMeta {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  participants: string[];
  parentConversationId?: string;
  parentToolCallId?: string;
}

export interface ConversationFilter {
  participantId?: string;
  since?: string;
  includeSubThreads?: boolean;
}

export interface ConversationSummary {
  id: string;
  participantIds: string[];
  status: 'active' | 'completed';
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}
