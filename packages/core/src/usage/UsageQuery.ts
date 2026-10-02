import type { ConversationData, MessageData } from '@legion-collective/types';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import {
  type GroupBy,
  type UsageFilter,
  type UsageReport,
  type MessageUsageTotals,
  type UsageGroup,
  EMPTY_TOTALS,
  addUsageToTotals,
} from './usage-types.js';

function emptyTotals(): MessageUsageTotals {
  return { ...EMPTY_TOTALS, cache: { read: 0, write: 0 } };
}

export class UsageQuery {
  constructor(private conversationStore: ConversationStore) {}

  async query(filter: UsageFilter & { groupBy?: GroupBy }): Promise<UsageReport> {
    const { groupBy, ...rest } = filter;
    let totals = emptyTotals();
    const groupMap = new Map<string, MessageUsageTotals>();

    const conversations = await this.getConversations(rest);

    for (const conv of conversations) {
      for (const msg of Object.values(conv.messages)) {
        if (!msg.usage) continue;
        if (msg.status === 'superseded' || msg.status === 'pruned') continue;
        if (!this.matchesFilter(msg, rest)) continue;

        totals = addUsageToTotals(totals, msg.usage);

        if (groupBy) {
          const key = this.groupKey(msg, groupBy, conv);
          const existing = groupMap.get(key) ?? emptyTotals();
          groupMap.set(key, addUsageToTotals(existing, msg.usage));
        }
      }
    }

    let groups: UsageGroup[] | undefined;
    if (groupBy) {
      groups = Array.from(groupMap.entries())
        .map(([key, gTotals]) => ({ key, totals: gTotals, messageCount: gTotals.messageCount }))
        .sort((a, b) => b.totals.cost - a.totals.cost);
    }

    return { totals, groups };
  }

  private async getConversations(filter: UsageFilter): Promise<ConversationData[]> {
    if (filter.conversationId) {
      const conv = await this.conversationStore.load(filter.conversationId);
      return conv ? [conv] : [];
    }
    const metas = await this.conversationStore.list({
      participantId: filter.participantId,
      since: filter.since,
    });
    const conversations: ConversationData[] = [];
    for (const meta of metas) {
      const conv = await this.conversationStore.load(meta.id);
      if (conv) conversations.push(conv);
    }
    return conversations;
  }

  private matchesFilter(msg: MessageData, filter: UsageFilter): boolean {
    if (msg.role !== 'assistant') return false;
    if (filter.modelId && msg.usage?.modelId !== filter.modelId) return false;
    if (filter.providerId && msg.usage?.providerId !== filter.providerId) return false;
    if (filter.since && msg.timestamp < filter.since) return false;
    if (filter.until && msg.timestamp > filter.until) return false;
    return true;
  }

  private groupKey(msg: MessageData, groupBy: GroupBy, conv: ConversationData): string {
    switch (groupBy) {
      case 'model':
        return msg.usage?.modelId ?? 'unknown';
      case 'participant':
        return msg.senderId;
      case 'conversation':
        return conv.id;
      case 'day':
        return msg.timestamp.slice(0, 10); // YYYY-MM-DD (UTC, ISO 8601)
    }
  }
}
