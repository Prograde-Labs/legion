import type { JSONSchema, ToolResult } from '@legion/types';
import type { Tool, ToolContext } from './Tool.js';

export const communicateTool: Tool = {
  name: 'communicate',
  description:
    'Send a message to another participant. Synchronous by default; pass replyTo to fire-and-forget.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target participant id' },
      message: { type: 'string' },
      conversationId: { type: 'string', description: 'Join an existing thread' },
      replyTo: { type: 'string', description: 'Route the response to this participant instead' },
    },
    required: ['to', 'message'],
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    const { to, message, conversationId, replyTo } = args as {
      to: string;
      message: string;
      conversationId?: string;
      replyTo?: string;
    };
    if (!context.messageRouter) {
      return { status: 'error', error: 'messageRouter unavailable in context' };
    }
    const result = await context.messageRouter.send({
      senderId: context.participant.id,
      recipientId: to,
      message,
      conversationId: conversationId ?? context.conversationId,
      replyTo,
      context: { ...context, communicationDepth: (context.communicationDepth ?? 0) + 1 },
    });
    if (result.status === 'error') {
      return { status: 'error', error: result.error };
    }
    if (result.status === 'pending_approval') {
      return {
        status: 'pending_approval',
        data: {
          conversationId: result.conversationId,
          approvalRequests: result.approvalRequests,
        },
      };
    }
    return {
      status: 'success',
      data: {
        conversationId: result.conversationId,
        response: result.response,
        status: result.status,
      },
    };
  },
};
