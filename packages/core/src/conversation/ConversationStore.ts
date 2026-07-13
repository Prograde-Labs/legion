import type {
  ConversationData,
  ConversationFilter,
  ConversationMeta,
  MessageData,
} from '@legion/types';

export interface ConversationStore {
  create(data: Omit<ConversationData, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConversationData>;
  load(conversationId: string): Promise<ConversationData | null>;
  mutate(
    conversationId: string,
    callback: (conversation: ConversationData) => ConversationData | Promise<ConversationData>,
    guard?: ConversationMutationGuard,
  ): Promise<ConversationMutationResult>;
  appendMessage(conversationId: string, message: MessageData): Promise<void>;
  updateMessage(
    conversationId: string,
    messageId: string,
    patch: Partial<MessageData>,
  ): Promise<void>;
  updateHead(conversationId: string, newHeadId: string): Promise<void>;
  list(filter?: ConversationFilter): Promise<ConversationMeta[]>;
  listByParent(parentId: string): Promise<ConversationData[]>;
  /** Delete a conversation and all of its descendants. Idempotent: no error if the id does not exist. */
  delete(conversationId: string): Promise<void>;
  exists(conversationId: string): Promise<boolean>;
}

export interface ConversationMutationGuard {
  expectedActiveBranchHead?: string;
  signal?: AbortSignal;
}

export interface ConversationMutationResult {
  before: ConversationData;
  after: ConversationData;
  changed: boolean;
}
