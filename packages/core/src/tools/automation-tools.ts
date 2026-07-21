import { isDeepStrictEqual } from 'node:util';
import type { JSONSchema, JSONValue, ToolResult } from '@legion/types';
import { compactRange, getActiveChain } from '../conversation/conversation-ops.js';
import type { ConversationData } from '@legion/types';
import type { Tool } from './Tool.js';

const SUMMARY_INSTRUCTION =
  'Summarize this conversation segment concisely. Preserve key facts, decisions, and current work so conversation can continue without original messages.';
const TITLE_INSTRUCTION =
  'Generate exactly one concise title for this conversation. Return only title text, with no quotation marks or explanation.';

interface CompactConversationArgs {
  conversationId: string;
  messageIds: string[];
  middlewareInstanceId: string;
  parentMessageId: string;
}

interface GenerateConversationTitleArgs {
  conversationId: string;
  namingParticipantId: string;
  middlewareInstanceId: string;
  parentMessageId: string;
  scope: 'participant' | 'shared';
  attachedParticipantId: string;
  maximumLength: number;
  guidance: string;
}

export interface AutomationTools {
  compactConversation: Tool;
  generateConversationTitle: Tool;
}

export function createAutomationTools(): AutomationTools {
  return {
    compactConversation: createCompactConversationTool(),
    generateConversationTitle: createGenerateConversationTitleTool(),
  };
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
          const approvalContinuationSeed =
            context.pendingApprovalRegistry && context.middlewareCheckpoint
              ? {
                  parentConversationId: parent.id,
                  helperConversationId: helper.id,
                  participantId: context.participant.id,
                  middlewareInstanceId: instance.id,
                  middlewareRevision: context.participant.middlewareRevision ?? 0,
                  middlewareType: instance.type,
                  middlewareConfig: structuredClone(instance.config),
                  observedParentHead: observedHead,
                  selectedMessages,
                  parentMessageId: input.parentMessageId,
                  parentCheckpoint: context.middlewareCheckpoint,
                }
              : undefined;
          const summary = await context.messageRouter.send({
            senderId: context.participant.id,
            recipientId: summarizerParticipantId,
            conversationId: helper.id,
            message: `${SUMMARY_INSTRUCTION}\n\n${transcript(parent, input.messageIds)}`,
            replyTo: undefined,
            context: {
              ...context,
              ...(approvalContinuationSeed === undefined ? {} : { approvalContinuationSeed }),
            },
          });
          if (summary.status === 'pending_approval') {
            if (!context.pendingApprovalRegistry || !context.middlewareCheckpoint) {
              archiveHelper = true;
              return { status: 'error', error: 'Durable middleware continuation unavailable' };
            }
            if (!summary.approvalId) {
              archiveHelper = true;
              return { status: 'error', error: 'Summary approval continuation unavailable' };
            }
            const helperApproval = context.pendingApprovalRegistry.getRecord(summary.approvalId);
            if (helperApproval?.continuation?.kind !== 'automation_compaction') {
              archiveHelper = true;
              return { status: 'error', error: 'Summary approval continuation unavailable' };
            }
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

export function createGenerateConversationTitleTool(): Tool {
  return {
    name: 'generate_conversation_title',
    description:
      'Generate and atomically assign a conversation title through a helper conversation.',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        namingParticipantId: { type: 'string' },
        middlewareInstanceId: { type: 'string' },
        parentMessageId: { type: 'string' },
        scope: { type: 'string', enum: ['participant', 'shared'] },
        attachedParticipantId: { type: 'string' },
        maximumLength: { type: 'integer', minimum: 1 },
        guidance: { type: 'string' },
      },
      required: [
        'conversationId',
        'namingParticipantId',
        'middlewareInstanceId',
        'parentMessageId',
        'scope',
        'attachedParticipantId',
        'maximumLength',
        'guidance',
      ],
      additionalProperties: false,
    } as JSONSchema,
    async execute(args, context): Promise<ToolResult> {
      try {
        const input = validateTitleArgs(args);
        if (!input)
          return { status: 'error', error: 'Invalid generate_conversation_title arguments' };
        if (!context.conversationStore) {
          return { status: 'error', error: 'conversationStore unavailable in context' };
        }
        if (!context.messageRouter) {
          return { status: 'error', error: 'messageRouter unavailable in context' };
        }
        if (context.conversationId !== input.conversationId) {
          return { status: 'error', error: 'Parent conversation does not match tool context' };
        }

        const parent = await context.conversationStore.load(input.conversationId);
        if (!parent) {
          return { status: 'error', error: `Conversation not found: ${input.conversationId}` };
        }
        const existingTitle = titleFor(parent, input);
        if (existingTitle !== undefined) {
          return { status: 'success', data: { title: existingTitle, written: false } };
        }

        const helper = await context.conversationStore.create(
          {
            schemaVersion: '2.0',
            activeBranchHead: '',
            messages: {},
            tags: ['conversation-title'],
            origin: {
              kind: 'middleware',
              participantId: context.participant.id,
              middlewareInstanceId: input.middlewareInstanceId,
              parentConversationId: parent.id,
              parentMessageId: input.parentMessageId,
            },
          },
          { signal: context.signal },
        );

        let archiveHelper = false;
        try {
          const titleResponse = await context.messageRouter.send({
            senderId: context.participant.id,
            recipientId: input.namingParticipantId,
            conversationId: helper.id,
            message: `${TITLE_INSTRUCTION}\nMaximum length: ${input.maximumLength}.\nGuidance: ${input.guidance}\n\n${transcript(
              parent,
              getActiveChain(parent).map((message) => message.id),
            )}`,
            replyTo: undefined,
            context,
          });
          if (titleResponse.status === 'pending_approval') {
            archiveHelper = true;
            if (context.pendingApprovalRegistry && titleResponse.approvalId) {
              await context.pendingApprovalRegistry.cancelPending(
                titleResponse.approvalId,
                'Title generation requires approval',
              );
            }
            return { status: 'error', error: 'Title generation requires approval' };
          }
          if (titleResponse.status === 'error') {
            archiveHelper = true;
            return { status: 'error', error: titleResponse.error ?? 'Title generation failed' };
          }
          if (titleResponse.status !== 'success' || !titleResponse.response) {
            archiveHelper = true;
            return { status: 'error', error: 'Title agent returned no response' };
          }

          const title = titleResponse.response.trim();
          archiveHelper = true;
          if (title.length === 0 || /[\r\n]/.test(title)) {
            return { status: 'error', error: 'Generated title must be a single nonempty line' };
          }
          if (title.length > input.maximumLength) {
            return {
              status: 'error',
              error: `Generated title exceeds maximum length of ${input.maximumLength}`,
            };
          }

          const mutation = await context.conversationStore.mutate(
            parent.id,
            (current) => {
              if (titleFor(current, input) !== undefined) return current;
              if (input.scope === 'shared') return { ...current, title };
              return {
                ...current,
                titles: { ...current.titles, [input.attachedParticipantId]: title },
              };
            },
            { signal: context.signal },
          );
          const effectiveTitle = titleFor(mutation.after, input)!;
          return {
            status: 'success',
            data: { title: effectiveTitle, written: mutation.changed },
          };
        } catch (error) {
          archiveHelper = true;
          throw error;
        } finally {
          if (archiveHelper)
            await context.conversationStore.mutate(helper.id, (current) => ({
              ...current,
              status: 'archived',
            }));
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

function validateTitleArgs(args: unknown): GenerateConversationTitleArgs | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const input = args as Partial<GenerateConversationTitleArgs>;
  if (
    typeof input.conversationId !== 'string' ||
    typeof input.namingParticipantId !== 'string' ||
    typeof input.middlewareInstanceId !== 'string' ||
    typeof input.parentMessageId !== 'string' ||
    (input.scope !== 'participant' && input.scope !== 'shared') ||
    typeof input.attachedParticipantId !== 'string' ||
    typeof input.maximumLength !== 'number' ||
    !Number.isInteger(input.maximumLength) ||
    input.maximumLength <= 0 ||
    typeof input.guidance !== 'string'
  ) {
    return undefined;
  }
  return input as GenerateConversationTitleArgs;
}

function titleFor(
  conversation: ConversationData,
  input: Pick<GenerateConversationTitleArgs, 'scope' | 'attachedParticipantId'>,
): string | undefined {
  return input.scope === 'shared'
    ? conversation.title
    : conversation.titles?.[input.attachedParticipantId];
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
