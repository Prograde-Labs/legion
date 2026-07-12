import type { ConversationData, JSONValue, MessageData, ToolCallResult } from '@legion/types';
import type { ConversationStore } from './ConversationStore.js';
import { appendMessage, getActiveChain, type NewMessageInput } from './conversation-ops.js';

export type AppendGuard = <T>(thread: ConversationThread, append: () => Promise<T>) => Promise<T>;

export class ConversationThread {
  constructor(
    public data: ConversationData,
    private store: ConversationStore,
    private appendGuard?: AppendGuard,
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

  async append(input: NewMessageInput): Promise<MessageData> {
    const doAppend = async () => {
      const result = await this.store.mutate(this.data.id, (conversation) =>
        appendMessage(conversation, input),
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
    await this.store.updateMessage(this.data.id, messageId, { toolResults });
    // Keep local data in sync so activeChain reflects the update immediately.
    const msg = this.data.messages[messageId];
    if (msg) {
      this.data.messages[messageId] = { ...msg, toolResults };
    }
  }

  async updateMiddlewareState(
    participantId: string,
    instanceId: string,
    value: JSONValue,
  ): Promise<void> {
    const result = await this.store.mutate(this.data.id, (conversation) => ({
      ...conversation,
      middlewareState: {
        ...conversation.middlewareState,
        [participantId]: {
          ...conversation.middlewareState?.[participantId],
          [instanceId]: structuredClone(value),
        },
      },
    }));
    this.data = result.after;
  }

  async reload(): Promise<void> {
    const fresh = await this.store.load(this.data.id);
    if (fresh) this.data = fresh;
  }
}
