import { isDeepStrictEqual } from 'node:util';
import type { Storage } from '../storage/Storage.js';
import type {
  ConversationData,
  ConversationFilter,
  ConversationMeta,
  MessageData,
} from '@legion/types';
import { ConversationNotFoundError } from '../errors/LegionError.js';
import type { EventBus } from '../events/EventBus.js';
import { createConversationId, nowIso } from '../util/ids.js';
import {
  conversationMatchesFilter,
  getConversationEventMetadata,
  resolveConversationTitle,
} from './conversation-metadata.js';
import type {
  ConversationMutationGuard,
  ConversationMutationResult,
  ConversationStore,
} from './ConversationStore.js';

const storageLocks = new WeakMap<Storage, Map<string, Promise<void>>>();

export class FileConversationStore implements ConversationStore {
  constructor(
    private storage: Storage,
    private eventBus?: EventBus,
  ) {}

  private key(conversationId: string): string {
    return `conversations/${conversationId}.json`;
  }

  async create(
    data: Omit<ConversationData, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ConversationData> {
    const now = nowIso();
    const conversation: ConversationData = {
      ...data,
      messages: data?.messages ?? {},
      id: createConversationId(),
      createdAt: now,
      updatedAt: now,
    };
    const persisted = await this.persist(conversation);
    this.eventBus?.emit('conversation:created', {
      conversation: getConversationEventMetadata(persisted),
    });
    return structuredClone(persisted);
  }

  async load(conversationId: string): Promise<ConversationData | null> {
    return this.storage.readJson<ConversationData>(this.key(conversationId));
  }

  private async persist(data: ConversationData): Promise<ConversationData> {
    const now = nowIso();
    const persisted = { ...data, updatedAt: now };
    await this.storage.writeJson(this.key(data.id), persisted);
    return persisted;
  }

  /** Fixture-only whole-record replacement. Production code must use mutate(). */
  async replaceForTesting(data: ConversationData): Promise<void> {
    await this.withLock(data.id, async () => {
      await this.persist(structuredClone(data));
    });
  }

  private async loadOrThrow(conversationId: string): Promise<ConversationData> {
    const conversation = await this.load(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);
    return conversation;
  }

  private async withLock<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    let locks = storageLocks.get(this.storage);
    if (!locks) {
      locks = new Map();
      storageLocks.set(this.storage, locks);
    }
    const previous = locks.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    locks.set(conversationId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(conversationId) === queued) {
        locks.delete(conversationId);
        if (locks.size === 0) storageLocks.delete(this.storage);
      }
    }
  }

  async mutate(
    conversationId: string,
    callback: (conversation: ConversationData) => ConversationData | Promise<ConversationData>,
    guard?: ConversationMutationGuard,
  ): Promise<ConversationMutationResult> {
    return this.withLock(conversationId, async () => {
      const current = await this.loadOrThrow(conversationId);
      if (
        guard?.expectedActiveBranchHead !== undefined &&
        current.activeBranchHead !== guard.expectedActiveBranchHead
      ) {
        throw new Error(
          `Conversation active branch head changed: expected ${guard.expectedActiveBranchHead}, got ${current.activeBranchHead}`,
        );
      }

      const before = structuredClone(current);
      const candidate = await callback(structuredClone(current));
      if (!isDeepStrictEqual(candidate.origin, current.origin)) {
        throw new Error('Conversation origin is immutable');
      }
      if (isDeepStrictEqual(candidate, current)) {
        return { before, after: structuredClone(current), changed: false };
      }

      const beforeMetadata = getConversationEventMetadata(current);
      const persisted = await this.persist(structuredClone(candidate));
      const afterMetadata = getConversationEventMetadata(persisted);
      if (!isDeepStrictEqual(beforeMetadata, afterMetadata)) {
        this.eventBus?.emit('conversation:updated', {
          conversationId,
          before: beforeMetadata,
          after: afterMetadata,
        });
      }
      return { before, after: structuredClone(persisted), changed: true };
    });
  }

  async appendMessage(conversationId: string, message: MessageData): Promise<void> {
    await this.mutate(conversationId, (conversation) => ({
      ...conversation,
      messages: { ...conversation.messages, [message.id]: message },
    }));
  }

  async updateMessage(
    conversationId: string,
    messageId: string,
    patch: Partial<MessageData>,
  ): Promise<void> {
    await this.mutate(conversationId, (conversation) => {
      const existing = conversation.messages[messageId];
      if (!existing) throw new ConversationNotFoundError(`${conversationId}#${messageId}`);
      return {
        ...conversation,
        messages: { ...conversation.messages, [messageId]: { ...existing, ...patch } },
      };
    });
  }

  async updateHead(conversationId: string, newHeadId: string): Promise<void> {
    await this.mutate(conversationId, (conversation) => ({
      ...conversation,
      activeBranchHead: newHeadId,
    }));
  }

  async list(filter?: ConversationFilter): Promise<ConversationMeta[]> {
    const files = await this.storage.list('conversations');
    const metas: ConversationMeta[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      const conversation = await this.load(id);
      if (!conversation) continue;
      if (!conversationMatchesFilter(conversation, filter ?? {})) continue;

      const metadata = getConversationEventMetadata(conversation);
      const resolvedTitle = resolveConversationTitle(conversation, filter?.viewerParticipantId);

      const meta: ConversationMeta = {
        ...metadata,
        title: resolvedTitle,
        resolvedTitle,
        sharedTitle: conversation.title,
        messageCount: Object.keys(conversation.messages).length,
      };

      metas.push(meta);
    }
    return metas;
  }

  async exists(conversationId: string): Promise<boolean> {
    return this.storage.exists(this.key(conversationId));
  }

  async listByParent(parentId: string): Promise<ConversationData[]> {
    const files = await this.storage.list('conversations');
    const results: ConversationData[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      const conversation = await this.load(id);
      if (conversation?.parentConversationId === parentId) {
        results.push(conversation);
      }
    }
    return results;
  }

  async delete(conversationId: string): Promise<void> {
    await this.withLock(conversationId, async () => {
      const conversation = await this.load(conversationId);
      if (!conversation) return;
      const children = await this.listByParent(conversationId);
      for (const child of children) {
        await this.delete(child.id);
      }
      await this.storage.delete(this.key(conversationId));
    });
  }
}
