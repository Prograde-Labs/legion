import type {
  JSONSchema,
  MiddlewareDefinition,
  PostMessageContext,
  PostMessageResult,
} from '@legion/types';
import type { ConversationStore } from '../../conversation/ConversationStore.js';

export interface ConversationNamingConfig {
  namingParticipantId: string;
  maximumLength: number;
  guidance: string;
  scope: 'participant' | 'shared';
  excludedTags: string[];
}

const HELPER_TAGS = new Set(['compaction', 'conversation-title']);

export function createConversationNamingMiddleware(
  conversationStore: ConversationStore,
): MiddlewareDefinition<ConversationNamingConfig> {
  async function maybeName(
    context: PostMessageContext<ConversationNamingConfig>,
  ): Promise<PostMessageResult> {
    const conversation = await conversationStore.load(context.conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${context.conversationId}`);
    const tags = new Set(conversation.tags ?? []);
    if ([...HELPER_TAGS, ...context.config.excludedTags].some((tag) => tags.has(tag)))
      return { kind: 'continue' };
    const existing =
      context.config.scope === 'shared'
        ? conversation.title
        : conversation.titles?.[context.participant.id];
    if (
      existing ||
      context.actions.some(
        (action) =>
          action.tool === 'generate_conversation_title' &&
          action.instanceId === context.instance.id,
      )
    )
      return { kind: 'continue' };
    const responses = context.activeChain.filter((message) => message.role === 'assistant');
    if (responses.length !== 1 || responses[0].id !== context.message.id)
      return { kind: 'continue' };
    return {
      kind: 'tool',
      requestId: `title:${context.conversationId}:${context.participant.id}:${context.config.scope}`,
      tool: 'generate_conversation_title',
      arguments: {
        conversationId: context.conversationId,
        namingParticipantId: context.config.namingParticipantId,
        middlewareInstanceId: context.instance.id,
        parentMessageId: context.message.id,
        scope: context.config.scope,
        attachedParticipantId: context.participant.id,
        maximumLength: context.config.maximumLength,
        guidance: context.config.guidance,
      },
    };
  }

  return {
    type: 'builtin:conversation-naming',
    displayName: 'Conversation Naming',
    description: 'Generate shared or participant-scoped title after first response.',
    defaultFailureMode: 'open',
    configSchema: {
      type: 'object',
      properties: {
        namingParticipantId: { type: 'string', minLength: 1 },
        maximumLength: { type: 'number', minimum: 1 },
        guidance: { type: 'string' },
        scope: { type: 'string', enum: ['participant', 'shared'] },
        excludedTags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      },
      required: ['namingParticipantId', 'maximumLength', 'guidance', 'scope', 'excludedTags'],
      additionalProperties: false,
    } as JSONSchema,
    hooks: {
      afterSend: maybeName,
      afterReceive: async (context) =>
        context.mode === 'post_response'
          ? maybeName(context as unknown as PostMessageContext<ConversationNamingConfig>)
          : { kind: 'continue' },
    },
  };
}
