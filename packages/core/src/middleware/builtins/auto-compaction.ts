import { Buffer } from 'node:buffer';
import type {
  AgentConfig,
  JSONSchema,
  MessageData,
  MiddlewareDefinition,
  ProviderModel,
} from '@legion/types';
import type { ConversationStore } from '../../conversation/ConversationStore.js';

export interface AutoCompactionConfig {
  triggerPercentage: number;
  targetPercentage: number;
  fallbackTokenThreshold: number;
  summarizerParticipantId: string;
  minimumRecentTokens: number;
  excludedTags: string[];
}

const HELPER_TAGS = new Set(['compaction', 'conversation-title']);

export function estimateProviderContextTokens(
  systemPrompt: string,
  chain: readonly MessageData[],
): number {
  const summaries = chain.filter((message) => message.type === 'summary');
  const regular = chain.filter((message) => message.type !== 'summary');
  const summaryText = summaries.map((message) => message.content).join('\n\n---\n\n');
  const effectiveSystem = summaryText
    ? `${systemPrompt}\n\n<previous_conversation_summary>\n${summaryText}\n</previous_conversation_summary>`
    : systemPrompt;
  let bytes = Buffer.byteLength(effectiveSystem);
  for (const message of regular) {
    bytes += Buffer.byteLength(message.content);
    for (const call of message.toolCalls ?? []) {
      bytes += Buffer.byteLength(call.id) + Buffer.byteLength(call.name);
      bytes += Buffer.byteLength(JSON.stringify(call.arguments));
    }
    for (const result of message.toolResults ?? []) {
      bytes += Buffer.byteLength(result.id) + Buffer.byteLength(result.name);
      bytes += Buffer.byteLength(JSON.stringify(result.result));
    }
  }
  return Math.ceil(bytes / 4);
}

export function selectCompactionPrefix(
  chain: readonly MessageData[],
  retainTokens: number,
  targetTokens: number,
): MessageData[] {
  const perMessage = chain.map((message) => estimateProviderContextTokens('', [message]));
  let retained = 0;
  let boundary = chain.length;
  if (boundary > 0) retained += perMessage[--boundary];
  while (boundary > 0 && retained < retainTokens) retained += perMessage[--boundary];
  let total = perMessage.reduce((sum, count) => sum + count, 0);
  let end = 0;
  while (end < boundary && total > targetTokens) total -= perMessage[end++];
  return chain.slice(0, end);
}

export function createAutoCompactionMiddleware(dependencies: {
  conversationStore: ConversationStore;
  getModelMetadata: (modelId: string) => Promise<Pick<ProviderModel, 'contextWindow'> | undefined>;
}): MiddlewareDefinition<AutoCompactionConfig> {
  return {
    type: 'builtin:auto-compaction',
    displayName: 'Automatic Compaction',
    description: 'Compact old active context before provider invocation.',
    defaultFailureMode: 'closed',
    configSchema: {
      type: 'object',
      properties: {
        triggerPercentage: { type: 'number', minimum: 1, maximum: 100 },
        targetPercentage: { type: 'number', minimum: 1, maximum: 100 },
        fallbackTokenThreshold: { type: 'number', minimum: 1 },
        summarizerParticipantId: { type: 'string', minLength: 1 },
        minimumRecentTokens: { type: 'number', minimum: 1 },
        excludedTags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      },
      required: [
        'triggerPercentage',
        'targetPercentage',
        'fallbackTokenThreshold',
        'summarizerParticipantId',
        'minimumRecentTokens',
        'excludedTags',
      ],
      additionalProperties: false,
    } as JSONSchema,
    hooks: {
      async afterReceive(context) {
        if (context.participant.type !== 'agent') return { kind: 'continue' };
        if (
          context.actions.some(
            (action) =>
              action.instanceId === context.instance.id &&
              action.tool === 'compact_conversation' &&
              action.status === 'success',
          )
        ) {
          return { kind: 'continue' };
        }
        const conversation = await dependencies.conversationStore.load(context.conversationId);
        if (!conversation) throw new Error(`Conversation not found: ${context.conversationId}`);
        const tags = new Set(conversation.tags ?? []);
        if ([...HELPER_TAGS, ...context.config.excludedTags].some((tag) => tags.has(tag))) {
          return { kind: 'continue' };
        }
        const watermark = (context.getState() as { summaryMessageId?: string } | undefined)
          ?.summaryMessageId;
        if (watermark && context.activeChain.some((message) => message.id === watermark)) {
          return { kind: 'continue' };
        }
        const agent = context.participant as AgentConfig;
        const metadata = await dependencies.getModelMetadata(agent.model.model);
        const estimate = estimateProviderContextTokens(agent.systemPrompt, context.activeChain);
        const trigger = metadata?.contextWindow
          ? Math.floor((metadata.contextWindow * context.config.triggerPercentage) / 100)
          : context.config.fallbackTokenThreshold;
        if (estimate < trigger) return { kind: 'continue' };
        const target = metadata?.contextWindow
          ? Math.floor((metadata.contextWindow * context.config.targetPercentage) / 100)
          : Math.floor(
              (context.config.fallbackTokenThreshold * context.config.targetPercentage) /
                context.config.triggerPercentage,
            );
        const selected = selectCompactionPrefix(
          context.activeChain,
          context.config.minimumRecentTokens,
          target,
        );
        if (selected.length === 0) return { kind: 'continue' };
        const prefixEndId = selected[selected.length - 1].id;
        return {
          kind: 'tool',
          requestId: `compact:${context.conversationId}:${prefixEndId}`,
          tool: 'compact_conversation',
          arguments: {
            conversationId: context.conversationId,
            messageIds: selected.map((message) => message.id),
            agentId: context.config.summarizerParticipantId,
            middlewareInstanceId: context.instance.id,
            parentMessageId: prefixEndId,
          },
        };
      },
    },
  };
}
