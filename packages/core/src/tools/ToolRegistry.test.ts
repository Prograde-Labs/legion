import { ToolRegistry } from './ToolRegistry.js';
import { isStreamingTool } from './Tool.js';
import type { Tool, ToolContext, AnyTool, StreamingTool } from './Tool.js';
import type { StreamChunk } from '@legion/types';
import { EventBus } from '../events/EventBus.js';

const echoTool: Tool = {
  name: 'echo',
  description: 'returns its input',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(args) {
    const { text } = args as { text: string };
    return { status: 'success', data: text };
  },
};

function fakeContext(): ToolContext {
  return {
    participant: { id: 'p', name: 'P', type: 'mock', tools: {}, responses: [] },
    conversationId: '',
    eventBus: new EventBus(),
  } as unknown as ToolContext;
}

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(reg.has('echo')).toBe(true);
    expect(reg.get('echo')?.name).toBe('echo');
    expect(reg.list().map((t) => t.name)).toEqual(['echo']);
  });

  it('rejects duplicate registration', () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(() => reg.register(echoTool)).toThrow(/already registered/i);
  });

  it('executes a registered tool', async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    const result = await reg.execute('echo', { text: 'hi' }, fakeContext());
    expect(result).toEqual({ status: 'success', data: 'hi' });
  });

  it('returns a tool error when executing an unknown tool', async () => {
    const reg = new ToolRegistry();
    const result = await reg.execute('nope', {}, fakeContext());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not found/i);
  });

  it('converts a thrown error into a tool error result', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'boom',
      description: 'throws',
      parameters: { type: 'object' },
      async execute() {
        throw new Error('kaboom');
      },
    });
    const result = await reg.execute('boom', {}, fakeContext());
    expect(result.status).toBe('error');
    expect(result.error).toContain('kaboom');
  });
});

describe('isStreamingTool', () => {
  it('returns false for a regular Tool', () => {
    const tool: AnyTool = {
      name: 'echo',
      description: 'desc',
      parameters: { type: 'object' },
      async execute() {
        return { status: 'success' };
      },
    };
    expect(isStreamingTool(tool)).toBe(false);
  });

  it('returns true for a StreamingTool', () => {
    const tool: StreamingTool = {
      name: 'watch',
      description: 'desc',
      parameters: { type: 'object' },
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'stream:done', result: { status: 'success' } };
      },
    };
    expect(isStreamingTool(tool)).toBe(true);
  });
});

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

describe('ToolRegistry streaming', () => {
  it('register accepts a StreamingTool', () => {
    const reg = new ToolRegistry();
    const tool: StreamingTool = {
      name: 'streamer',
      description: 'yields chunks',
      parameters: { type: 'object' },
      async *stream() {
        yield { type: 'text_delta', delta: 'hi' } satisfies StreamChunk;
      },
    };
    expect(() => reg.register(tool)).not.toThrow();
    expect(reg.has('streamer')).toBe(true);
  });

  it('stream() on a regular Tool yields stream:done with the result', async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    const chunks = await collect(reg.stream('echo', { text: 'hi' }, fakeContext()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: 'stream:done', result: { status: 'success', data: 'hi' } });
  });

  it('stream() on a StreamingTool yields tool chunks then stream:done', async () => {
    const reg = new ToolRegistry();
    const tool: StreamingTool = {
      name: 'delta',
      description: 'yields text deltas',
      parameters: { type: 'object' },
      async *stream() {
        yield { type: 'iteration_start', iteration: 0 } satisfies StreamChunk;
        yield { type: 'reasoning_delta', delta: 'why' } satisfies StreamChunk;
        yield { type: 'text_delta', delta: 'answer' } satisfies StreamChunk;
      },
    };
    reg.register(tool);
    const chunks = await collect(reg.stream('delta', {}, fakeContext()));
    expect(chunks).toEqual([
      { type: 'iteration_start', iteration: 0 },
      { type: 'reasoning_delta', delta: 'why' },
      { type: 'text_delta', delta: 'answer' },
      { type: 'stream:done', result: { status: 'success' } },
    ]);
  });

  it('stream() yields stream:error when tool throws', async () => {
    const reg = new ToolRegistry();
    const tool: StreamingTool = {
      name: 'exploder',
      description: 'throws',
      parameters: { type: 'object' },
      async *stream() {
        throw new Error('boom');
        yield { type: 'text_delta', delta: '' } satisfies StreamChunk;
      },
    };
    reg.register(tool);
    const chunks = await collect(reg.stream('exploder', {}, fakeContext()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: 'stream:error', error: 'boom' });
  });

  it('stream() yields stream:error for unknown tool', async () => {
    const reg = new ToolRegistry();
    const chunks = await collect(reg.stream('nope', {}, fakeContext()));
    expect(chunks[0].type).toBe('stream:error');
  });

  it('execute() on a StreamingTool drains and returns result', async () => {
    const reg = new ToolRegistry();
    const tool: StreamingTool = {
      name: 'quick',
      description: 'streaming but finite',
      parameters: { type: 'object' },
      async *stream() {
        yield { type: 'iteration_start', iteration: 0 } satisfies StreamChunk;
        yield { type: 'reasoning_delta', delta: 'why' } satisfies StreamChunk;
        yield { type: 'text_delta', delta: 'answer' } satisfies StreamChunk;
      },
    };
    reg.register(tool);
    const result = await reg.execute('quick', {}, fakeContext());
    expect(result).toEqual({ status: 'success' });
  });
});
