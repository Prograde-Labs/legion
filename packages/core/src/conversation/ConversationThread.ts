import type { ConversationData, MessageData, ToolCallResult } from '@legion/types';
import type { ConversationStore } from './ConversationStore.js';
import { appendMessage, getActiveChain, type NewMessageInput } from './conversation-ops.js';

export class ConversationThread {
  constructor(
    public data: ConversationData,
    private store: ConversationStore,
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
    this.data = appendMessage(this.data, input);
    await this.store.save(this.data);
    return this.data.messages[this.data.activeBranchHead];
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

  async reload(): Promise<void> {
    const fresh = await this.store.load(this.data.id);
    if (fresh) this.data = fresh;
  }
}
