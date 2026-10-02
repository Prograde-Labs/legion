import type {
  ConversationData,
  JSONValue,
  MessageData,
  ToolCallResult,
} from '@legion-collective/types';
import { ConversationNotFoundError } from '../errors/LegionError.js';
import type { ConversationStore } from './ConversationStore.js';
import { appendMessage, getActiveChain, type NewMessageInput } from './conversation-ops.js';
import { getConversationStatus } from './conversation-metadata.js';

export type AppendGuard = <T>(thread: ConversationThread, append: () => Promise<T>) => Promise<T>;

export class ConversationThread {
  constructor(
    public data: ConversationData,
    private store: ConversationStore,
    private appendGuard?: AppendGuard,
    private appendSignal?: AbortSignal,
  ) {}

  get id(): string {
    return this.data.id;
  }

  get activeChain(): MessageData[] {
    return getActiveChain(this.data);
  }

  get latest(): MessageData | undefined {
    return this.data.activeBranchHead ? this.data.messages[this.data.activeBranchHead] : undefined;
  }

  async append(
    input: NewMessageInput,
    options?: { reactivate?: boolean; signal?: AbortSignal },
  ): Promise<MessageData> {
    const signals = [this.appendSignal, options?.signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    );
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const doAppend = async () => {
      if (signal?.aborted) throw new Error('Conversation append aborted before persistence');
      const result = await this.store.mutate(
        this.data.id,
        (conversation) => {
          const current =
            options?.reactivate && getConversationStatus(conversation) === 'archived'
              ? { ...conversation, status: 'active' as const }
              : conversation;
          return appendMessage(current, input);
        },
        { signal },
      );
      this.data = result.after;
      return this.data.messages[this.data.activeBranchHead];
    };
    return this.appendGuard ? this.appendGuard(this, doAppend) : doAppend();
  }

  /**
   * Replace the toolResults array on an existing message. Used by AgentRuntime to
   * swap pending_approval results with resolved outcomes after an approval decision.
   */
  async updateToolResults(messageId: string, toolResults: ToolCallResult[]): Promise<void> {
    this.throwIfAborted('tool result update');
    const result = await this.store.mutate(
      this.data.id,
      (conversation) => {
        const message = conversation.messages[messageId];
        if (!message) throw new ConversationNotFoundError(conversation.id, messageId);
        return {
          ...conversation,
          messages: {
            ...conversation.messages,
            [messageId]: { ...message, toolResults },
          },
        };
      },
      { signal: this.appendSignal },
    );
    this.data = result.after;
  }

  async updateMiddlewareState(
    participantId: string,
    instanceId: string,
    value: JSONValue,
  ): Promise<void> {
    this.throwIfAborted('middleware state update');
    const result = await this.store.mutate(
      this.data.id,
      (conversation) => ({
        ...conversation,
        middlewareState: {
          ...conversation.middlewareState,
          [participantId]: {
            ...conversation.middlewareState?.[participantId],
            [instanceId]: structuredClone(value),
          },
        },
      }),
      { signal: this.appendSignal },
    );
    this.data = result.after;
  }

  async reload(): Promise<void> {
    this.throwIfAborted('reload');
    const fresh = await this.store.load(this.data.id);
    if (fresh) this.data = fresh;
  }

  private throwIfAborted(operation: string): void {
    if (this.appendSignal?.aborted) throw new Error(`Conversation ${operation} aborted`);
  }
}
