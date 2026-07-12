import type { ToolResult } from '@legion/types';
import type { Tool, ToolContext } from './Tool.js';

export const cancelStreamTool: Tool = {
  name: 'cancel_stream',
  description: 'Cancel an active streaming tool call by its stream ID.',
  parameters: {
    type: 'object',
    properties: {
      streamId: {
        type: 'string',
        description: 'The streamId returned when the streaming call was started.',
      },
    },
    required: ['streamId'],
  },
  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const { streamId } = args as { streamId: string };
    if (!context.cancelStream) {
      return { status: 'error', error: 'Streaming not supported in this context' };
    }
    const cancelled = context.cancelStream(streamId);
    return cancelled
      ? { status: 'success' }
      : { status: 'error', error: 'Stream not found or already complete' };
  },
};
