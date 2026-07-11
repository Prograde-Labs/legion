import { cancelStreamTool } from './cancel-stream-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';

function fakeContext(cancelStream?: (sid: string) => boolean): ToolContext {
  return {
    participant: { id: 'p', name: 'P', type: 'mock', tools: {}, responses: [] },
    conversationId: '',
    eventBus: new EventBus(),
    cancelStream,
  } as unknown as ToolContext;
}

describe('cancel_stream tool', () => {
  it('calls cancelStream and returns success when found', async () => {
    const cancel = vi.fn().mockReturnValue(true);
    const result = await cancelStreamTool.execute({ streamId: 'abc' }, fakeContext(cancel));
    expect(cancel).toHaveBeenCalledWith('abc');
    expect(result).toEqual({ status: 'success' });
  });

  it('returns error when stream not found', async () => {
    const cancel = vi.fn().mockReturnValue(false);
    const result = await cancelStreamTool.execute({ streamId: 'abc' }, fakeContext(cancel));
    expect(result.status).toBe('error');
  });

  it('returns error when cancelStream is not in context', async () => {
    const result = await cancelStreamTool.execute({ streamId: 'abc' }, fakeContext());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/streaming not supported/i);
  });
});
