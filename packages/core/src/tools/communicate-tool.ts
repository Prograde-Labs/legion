import type { DetailLevel, ToolResult, LLMChunk } from '@legion-collective/types';
import type { MessageRouterResult, StreamingTool, ToolContext } from './Tool.js';

const DETAIL_LEVELS: readonly DetailLevel[] = ['minimal', 'standard', 'full'];
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseDetail(value: unknown): Parsed<DetailLevel> {
  if (value === undefined) return { ok: true, value: 'standard' };
  if (typeof value === 'string' && (DETAIL_LEVELS as readonly string[]).includes(value)) {
    return { ok: true, value: value as DetailLevel };
  }
  return {
    ok: false,
    error: `communicate: invalid detail '${String(value)}' (expected minimal, standard or full)`,
  };
}

function parseTimeout(value: unknown): Parsed<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'communicate: timeoutMs must be a positive integer' };
  }
  return { ok: true, value: Math.min(value, MAX_TIMEOUT_MS) };
}

function parseModel(value: unknown): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: 'communicate: model must be a non-empty string' };
  }
  return { ok: true, value };
}

export const communicateTool: StreamingTool = {
  name: 'communicate',
  description:
    "Send a message to another participant. Streams the recipient's response as it is generated. Pass replyTo for fire-and-forget (returns immediately, response routed elsewhere). detail is a presentation hint for connectors; model overrides the recipient's model for this call; timeoutMs bounds a synchronous call.",
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target participant id' },
      message: { type: 'string' },
      conversationId: { type: 'string', description: 'Join an existing thread' },
      replyTo: {
        type: 'string',
        description: 'Route the response to this participant (fire-and-forget)',
      },
      detail: {
        type: 'string',
        enum: ['minimal', 'standard', 'full'],
        description: 'Presentation detail requested from connectors (default standard)',
      },
      model: { type: 'string', description: 'Override the recipient model for this call' },
      timeoutMs: {
        type: 'integer',
        description: 'Deadline in milliseconds for a synchronous call (max 24h)',
      },
    },
    required: ['to', 'message'],
  },

  async *stream(args: unknown, context: ToolContext): AsyncGenerator<LLMChunk, ToolResult> {
    const { to, message, conversationId, replyTo } = args as {
      to: string;
      message: string;
      conversationId?: string;
      replyTo?: string;
    };
    const raw = args as Record<string, unknown>;

    const detail = parseDetail(raw.detail);
    if (!detail.ok) return { status: 'error', error: detail.error };
    const timeoutMs = parseTimeout(raw.timeoutMs);
    if (!timeoutMs.ok) return { status: 'error', error: timeoutMs.error };
    const model = parseModel(raw.model);
    if (!model.ok) return { status: 'error', error: model.error };

    if (!context.messageRouter) {
      return { status: 'error', error: 'communicate: messageRouter not available in context' };
    }

    let result: MessageRouterResult;
    try {
      result = yield* context.messageRouter.sendStream({
        senderId: context.participant.id,
        recipientId: to,
        message,
        conversationId,
        replyTo,
        detail: detail.value,
        model: model.value,
        timeoutMs: timeoutMs.value,
        context: {
          ...context,
          communicationDepth: (context.communicationDepth ?? 0) + 1,
        },
      });
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    if (result.status === 'error') {
      return {
        status: 'error',
        error: result.error,
        data: { conversationId: result.conversationId },
      };
    }
    if (result.status === 'pending_approval') {
      return {
        status: 'pending_approval',
        data: { conversationId: result.conversationId, approvalRequests: result.approvalRequests },
      };
    }
    if (result.status === 'timeout') {
      return {
        status: 'error',
        error: 'deadline exceeded',
        data: {
          conversationId: result.conversationId,
          response: result.response,
          partial: true,
        },
      };
    }
    const data: Record<string, unknown> = {
      conversationId: result.conversationId,
      response: result.response,
      status: result.status,
    };
    if (detail.value === 'full' && result.meta !== undefined) data.meta = result.meta;
    return { status: 'success', data };
  },
};
