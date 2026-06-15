import type { ConversationData, MessageData } from '@legion/types';
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

  async reload(): Promise<void> {
    const fresh = await this.store.load(this.data.id);
    if (fresh) this.data = fresh;
  }
}
