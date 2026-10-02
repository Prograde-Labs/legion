import type { MessageUsage } from '@legion-collective/types';

export type GroupBy = 'model' | 'participant' | 'conversation' | 'day';

export interface UsageFilter {
  conversationId?: string;
  participantId?: string;
  modelId?: string;
  providerId?: string;
  since?: string;
  until?: string;
}

export interface MessageUsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
  cost: number;
  messageCount: number;
}

export interface UsageGroup {
  key: string;
  totals: MessageUsageTotals;
  messageCount: number;
}

export interface UsageReport {
  totals: MessageUsageTotals;
  groups?: UsageGroup[];
}

export const EMPTY_TOTALS: Readonly<MessageUsageTotals> = Object.freeze({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: Object.freeze({ read: 0, write: 0 }),
  cost: 0,
  messageCount: 0,
});

export function addUsageToTotals(
  totals: MessageUsageTotals,
  usage: MessageUsage,
): MessageUsageTotals {
  return {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    reasoning: totals.reasoning + usage.reasoning,
    cache: {
      read: totals.cache.read + usage.cache.read,
      write: totals.cache.write + usage.cache.write,
    },
    cost: totals.cost + usage.cost,
    messageCount: totals.messageCount + 1,
  };
}
