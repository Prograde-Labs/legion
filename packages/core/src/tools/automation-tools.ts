import { isDeepStrictEqual } from 'node:util';
import type { JSONSchema, JSONValue, ToolResult } from '@legion/types';
import { compactRange, getActiveChain } from '../conversation/conversation-ops.js';
import type { ConversationData } from '@legion/types';
import type { Tool } from './Tool.js';

const SUMMARY_INSTRUCTION =
  'Summarize this conversation segment concisely. Preserve key facts, decisions, and current work so conversation can continue without original messages.';

interface CompactConversationArgs {
  conversationId: string;
  messageIds: string[];
  middlewareInstanceId: string;
  parentMessageId: string;
}

export function createCompactConversationTool(): Tool {
  return {
    name: 'compact_conversation',
    description: 'Compact an automatic conversation prefix through a helper conversation.',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        messageIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
        middlewareInstanceId: { type: 'string' },
        parentMessageId: { type: 'string' },
      },
      required: ['conversationId', 'messageIds', 'middlewareInstanceId', 'parentMessageId'],
      additionalProperties: false,
    } as JSONSchema,
    async execute(args, context): Promise<ToolResult> {
      try {
        const input = validateArgs(args);
        if (!input) return { status: 'error', error: 'Invalid compact_conversation arguments' };
        if (!context.conversationStore) {
          return { status: 'error', error: 'conversationStore unavailable in context' };
        }
        if (!context.messageRouter) {
          return { status: 'error', error: 'messageRouter unavailable in context' };
        }
        if (context.conversationId !== input.conversationId) {
          return { status: 'error', error: 'Parent conversation does not match tool context' };
        }
        const instance = context.participant.middleware?.find(
          (candidate) =>
            candidate.id === input.middlewareInstanceId &&
            candidate.type === 'builtin:auto-compaction' &&
            candidate.enabled !== false,
        );
        if (
          !instance ||
          typeof instance.config.summarizerParticipantId !== 'string' ||
          instance.config.summarizerParticipantId.length === 0
        ) {
          return {
            status: 'error',
            error: 'Enabled auto-compaction middleware instance not found',
          };
        }
        const summarizerParticipantId = instance.config.summarizerParticipantId;

        const parent = await context.conversationStore.load(input.conversationId);
        if (!parent)
          return { status: 'error', error: `Conversation not found: ${input.conversationId}` };
        if (
          !isActivePrefix(parent, input.messageIds) ||
          input.parentMessageId !== input.messageIds.at(-1)
        ) {
          return {
            status: 'error',
            error: 'Messages must be oldest contiguous active chain prefix',
          };
        }
        const observedHead = parent.activeBranchHead;
        const selectedMessages = structuredClone(
          input.messageIds.map((messageId) => parent.messages[messageId]),
        );
        const helper = await context.conversationStore.create(
          {
            schemaVersion: '2.0',
            activeBranchHead: '',
            messages: {},
            tags: ['compaction'],
            origin: {
              kind: 'middleware',
              participantId: context.participant.id,
              middlewareInstanceId: instance.id,
              parentConversationId: parent.id,
              parentMessageId: input.parentMessageId,
            },
          },
          { signal: context.signal },
        );

        let archiveHelper = false;
        try {
          const summary = await context.messageRouter.send({
            senderId: context.participant.id,
            recipientId: summarizerParticipantId,
            conversationId: helper.id,
            message: `${SUMMARY_INSTRUCTION}\n\n${transcript(parent, input.messageIds)}`,
            replyTo: undefined,
            context,
          });
          if (summary.status === 'pending_approval') {
            return {
              status: 'pending_approval',
              approvalId: summary.approvalId,
              data: {
                conversationId: helper.id,
                checkpointId: summary.checkpointId,
                pendingParticipantId: summary.pendingParticipantId,
                approvalRequests: summary.approvalRequests,
              },
            };
          }
          if (summary.status === 'error') {
            archiveHelper = true;
            return { status: 'error', error: summary.error ?? 'Summary failed' };
          }
          if (summary.status !== 'success') {
            return { status: 'error', error: 'Summary agent did not complete' };
          }
          archiveHelper = true;
          if (!summary.response)
            return { status: 'error', error: 'Summary agent returned no response' };

          let summaryMessageId = '';
          await context.conversationStore.mutate(
            parent.id,
            (current) => {
              if (
                !isActivePrefix(current, input.messageIds) ||
                !selectedMessages.every((message, index) =>
                  isDeepStrictEqual(current.messages[input.messageIds[index]], message),
                )
              ) {
                throw new Error('Messages are no longer oldest contiguous active chain prefix');
              }
              const compacted = compactRange(current, input.messageIds, summary.response!);
              summaryMessageId = Object.keys(compacted.messages).find(
                (id) =>
                  !Object.hasOwn(current.messages, id) && compacted.messages[id].type === 'summary',
              )!;
              const existing = stateObject(
                compacted.middlewareState?.[context.participant.id]?.[instance.id],
              );
              return {
                ...compacted,
                middlewareState: {
                  ...compacted.middlewareState,
                  [context.participant.id]: {
                    ...compacted.middlewareState?.[context.participant.id],
                    [instance.id]: { ...existing, summaryMessageId },
                  },
                },
              };
            },
            { expectedActiveBranchHead: observedHead, signal: context.signal },
          );
          return { status: 'success', data: { summaryMessageId } };
        } catch (err) {
          archiveHelper = true;
          throw err;
        } finally {
          if (archiveHelper) {
            await context.conversationStore.mutate(helper.id, (current) => ({
              ...current,
              status: 'archived',
            }));
          }
        }
      } catch (err) {
        return { status: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function validateArgs(args: unknown): CompactConversationArgs | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const input = args as Partial<CompactConversationArgs>;
  if (
    typeof input.conversationId !== 'string' ||
    !Array.isArray(input.messageIds) ||
    input.messageIds.length === 0 ||
    !input.messageIds.every((id) => typeof id === 'string') ||
    typeof input.middlewareInstanceId !== 'string' ||
    typeof input.parentMessageId !== 'string'
  ) {
    return undefined;
  }
  return input as CompactConversationArgs;
}

function isActivePrefix(conversation: ConversationData, messageIds: string[]): boolean {
  const chain = getActiveChain(conversation);
  return messageIds.every((id, index) => chain[index]?.id === id);
}

function transcript(conversation: ConversationData, messageIds: string[]): string {
  return messageIds
    .map((id) => conversation.messages[id])
    .flatMap((message) => {
      if (message.type === 'summary') return `[summary of earlier messages]: ${message.content}`;
      const lines = [`${message.role}: ${message.content}`];
      for (const call of message.toolCalls ?? []) {
        lines.push(
          `tool_call id=${call.id} name=${call.name} arguments=${JSON.stringify(call.arguments)}`,
        );
      }
      for (const result of message.toolResults ?? []) {
        lines.push(
          `tool_result id=${result.id} name=${result.name} result=${JSON.stringify(result.result)}`,
        );
      }
      return lines;
    })
    .join('\n');
}

function stateObject(value: JSONValue | undefined): Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
