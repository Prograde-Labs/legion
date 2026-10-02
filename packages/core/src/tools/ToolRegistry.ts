import { randomUUID } from 'node:crypto';
import type { ToolResult, StreamChunk } from '@legion-collective/types';
import { ConflictError, ToolNotFoundError } from '../errors/LegionError.js';
import type { AnyTool, Tool, ToolContext, ToolRegistryLike } from './Tool.js';
import { isStreamingTool } from './Tool.js';
import type { ToolResultStatus } from '@legion-collective/types';

async function* managedStream(
  tool: AnyTool,
  args: unknown,
  context: ToolContext,
): AsyncGenerator<StreamChunk> {
  try {
    if (isStreamingTool(tool)) {
      const toolResult = yield* tool.stream(args, context);
      yield { type: 'stream:done', result: toolResult ?? { status: 'success' } };
    } else {
      const result = (await (tool as Tool).execute(args, context)) as ToolResult;
      yield { type: 'stream:done', result };
    }
  } catch (err) {
    yield { type: 'stream:error', error: err instanceof Error ? err.message : String(err) };
  }
}

export class ToolRegistry implements ToolRegistryLike {
  private tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      throw new ConflictError(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  listAll(): string[] {
    return [...this.tools.keys()];
  }

  async *stream(name: string, args: unknown, context: ToolContext): AsyncGenerator<StreamChunk> {
    const tool = this.tools.get(name);
    if (!tool) {
      yield { type: 'stream:error', error: new ToolNotFoundError(name).message };
      return;
    }

    const callId = randomUUID();
    context.eventBus.emit('tool:call', {
      conversationId: context.conversationId ?? '',
      participantId: context.participant.id,
      tool: name,
      callId,
    });

    let finalStatus: ToolResultStatus = 'error';
    try {
      for await (const chunk of managedStream(tool, args, context)) {
        yield chunk;
        if (chunk.type === 'stream:done') finalStatus = chunk.result.status;
        else if (chunk.type === 'stream:error') finalStatus = 'error';
      }
    } finally {
      context.eventBus.emit('tool:result', {
        conversationId: context.conversationId ?? '',
        participantId: context.participant.id,
        tool: name,
        callId,
        status: finalStatus,
      });
    }
  }

  async execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { status: 'error', error: new ToolNotFoundError(name).message };
    }

    const callId = randomUUID();
    context.eventBus.emit('tool:call', {
      conversationId: context.conversationId ?? '',
      participantId: context.participant.id,
      tool: name,
      callId,
    });

    if (isStreamingTool(tool)) {
      try {
        for await (const chunk of managedStream(tool, args, context)) {
          if (chunk.type === 'stream:done') {
            context.eventBus.emit('tool:result', {
              conversationId: context.conversationId ?? '',
              participantId: context.participant.id,
              tool: name,
              callId,
              status: chunk.result.status,
            });
            return chunk.result;
          }
          if (chunk.type === 'stream:error') {
            context.eventBus.emit('tool:result', {
              conversationId: context.conversationId ?? '',
              participantId: context.participant.id,
              tool: name,
              callId,
              status: 'error',
            });
            return { status: 'error', error: chunk.error };
          }
        }
        return { status: 'error', error: 'Stream ended without terminal chunk' };
      } catch (err) {
        const errorResult = {
          status: 'error' as const,
          error: err instanceof Error ? err.message : String(err),
        };
        context.eventBus.emit('tool:result', {
          conversationId: context.conversationId ?? '',
          participantId: context.participant.id,
          tool: name,
          callId,
          status: 'error',
        });
        return errorResult;
      }
    }

    try {
      const result = (await (tool as Tool).execute(args, context)) as ToolResult;
      context.eventBus.emit('tool:result', {
        conversationId: context.conversationId ?? '',
        participantId: context.participant.id,
        tool: name,
        callId,
        status: result.status,
      });
      return result;
    } catch (err) {
      const errorResult = {
        status: 'error' as const,
        error: err instanceof Error ? err.message : String(err),
      };
      context.eventBus.emit('tool:result', {
        conversationId: context.conversationId ?? '',
        participantId: context.participant.id,
        tool: name,
        callId,
        status: 'error',
      });
      return errorResult;
    }
  }
}
