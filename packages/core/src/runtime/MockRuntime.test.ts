import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { MockRuntime } from './MockRuntime.js';
import type { RuntimeContext } from './Runtime.js';
import type { MessageData } from '@legion-collective/types';

async function ctxFor(responses: string[]): Promise<RuntimeContext> {
  const storage = new MemoryStorage();
  await storage.writeJson('collective/participants/mock-1.json', {
    id: 'mock-1',
    name: 'Mock',
    type: 'mock',
    tools: {},
    responses,
    status: 'active',
  });
  const collective = await Collective.load(storage);
  return {
    participant: collective.getOrThrow('mock-1'),
    collective,
    conversationId: 'c1',
  } as unknown as RuntimeContext;
}

const inbound: MessageData = {
  id: 'm1',
  parentId: null,
  conversationId: 'c1',
  senderId: 'op',
  recipientId: 'mock-1',
  role: 'user',
  content: 'hi',
  status: 'active',
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('MockRuntime', () => {
  it('returns scripted responses in order then cycles', async () => {
    const runtime = new MockRuntime('mock-1');
    const context = await ctxFor(['one', 'two']);
    expect(await runtime.handle(inbound, context)).toEqual({ kind: 'response', content: 'one' });
    expect(await runtime.handle(inbound, context)).toEqual({ kind: 'response', content: 'two' });
    expect(await runtime.handle(inbound, context)).toEqual({ kind: 'response', content: 'one' });
  });

  it('returns a default acknowledgement when no responses are configured', async () => {
    const runtime = new MockRuntime('mock-1');
    const context = await ctxFor([]);
    expect(await runtime.handle(inbound, context)).toEqual({
      kind: 'response',
      content: '[mock:mock-1] no scripted response',
    });
  });
});
