import { ToolRegistry } from './ToolRegistry.js';
import type { Tool, ToolContext } from './Tool.js';
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
