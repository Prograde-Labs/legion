import type { Storage } from '../storage/Storage.js';
import type {
  ConversationData,
  ConversationFilter,
  ConversationMeta,
  MessageData,
} from '@legion/types';
import { ConversationNotFoundError } from '../errors/LegionError.js';
import { createConversationId, nowIso } from '../util/ids.js';
import type { ConversationStore } from './ConversationStore.js';

export class FileConversationStore implements ConversationStore {
  constructor(private storage: Storage) {}

  private key(conversationId: string): string {
    return `conversations/${conversationId}.json`;
  }

  async create(
    data: Omit<ConversationData, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ConversationData> {
    const now = nowIso();
    const conversation: ConversationData = {
      ...data,
      id: createConversationId(),
      createdAt: now,
      updatedAt: now,
    };
    await this.save(conversation);
    return conversation;
  }

  async load(conversationId: string): Promise<ConversationData | null> {
    return this.storage.readJson<ConversationData>(this.key(conversationId));
  }

  async save(data: ConversationData): Promise<void> {
    const now = nowIso();
    await this.storage.writeJson(this.key(data.id), { ...data, updatedAt: now });
    data.updatedAt = now;
  }

  private async loadOrThrow(conversationId: string): Promise<ConversationData> {
    const conversation = await this.load(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);
    return conversation;
  }

  async appendMessage(conversationId: string, message: MessageData): Promise<void> {
    const conversation = await this.loadOrThrow(conversationId);
    conversation.messages[message.id] = message;
    await this.save(conversation);
  }

  async updateMessage(
    conversationId: string,
    messageId: string,
    patch: Partial<MessageData>,
  ): Promise<void> {
    const conversation = await this.loadOrThrow(conversationId);
    const existing = conversation.messages[messageId];
    if (!existing) throw new ConversationNotFoundError(`${conversationId}#${messageId}`);
    conversation.messages[messageId] = { ...existing, ...patch };
    await this.save(conversation);
  }

  async updateHead(conversationId: string, newHeadId: string): Promise<void> {
    const conversation = await this.loadOrThrow(conversationId);
    conversation.activeBranchHead = newHeadId;
    await this.save(conversation);
  }

  async list(filter?: ConversationFilter): Promise<ConversationMeta[]> {
    const files = await this.storage.list('conversations');
    const metas: ConversationMeta[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      const conversation = await this.load(id);
      if (!conversation) continue;
      if (filter?.since && conversation.updatedAt < filter.since) continue;
      if (
        filter?.participantId &&
        !Object.values(conversation.messages).some(
          (m) => m.senderId === filter.participantId || m.recipientId === filter.participantId,
        )
      ) {
        continue;
      }
      metas.push({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: Object.keys(conversation.messages).length,
      });
    }
    return metas;
  }

  async exists(conversationId: string): Promise<boolean> {
    return this.storage.exists(this.key(conversationId));
  }
}
