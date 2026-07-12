import type { ToolResult, LLMChunk } from '@legion/types';
import type { MessageRouterResult, StreamingTool, ToolContext } from './Tool.js';

export const communicateTool: StreamingTool = {
  name: 'communicate',
  description:
    "Send a message to another participant. Streams the recipient's response as it is generated. Pass replyTo for fire-and-forget (returns immediately, response routed elsewhere).",
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
        context: {
          ...context,
          communicationDepth: (context.communicationDepth ?? 0) + 1,
        },
      });
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (result.status === 'error') {
      return { status: 'error', error: result.error };
    }
    if (result.status === 'pending_approval') {
      return {
        status: 'pending_approval',
        data: { conversationId: result.conversationId, approvalRequests: result.approvalRequests },
      };
    }
    return {
      status: 'success',
      data: { conversationId: result.conversationId, response: result.response },
    };
  },
};
