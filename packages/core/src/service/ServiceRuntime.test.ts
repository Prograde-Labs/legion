import type { MessageData } from '@legion/types';
import type { RuntimeContext } from '../runtime/Runtime.js';
import type { LegionService, ServiceContext } from './LegionService.js';
import { ServiceRuntime } from './ServiceRuntime.js';

function makeIncoming(overrides: Partial<MessageData> = {}): MessageData {
  return {
    id: 'msg-1',
    parentId: null,
    conversationId: 'conv-1',
    senderId: 'agent-a',
    recipientId: 'svc-1',
    role: 'user',
    content: 'hello',
    status: 'active',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function stubRuntimeCtx(): RuntimeContext {
  return {} as RuntimeContext;
}

function stubContextFactory(_conversationId: string): ServiceContext {
  return {
    participantId: 'svc-1',
    stopped: new AbortController().signal,
    communicate: vi.fn(),
    callTool: vi.fn(),
    sleep: vi.fn(),
    storage: {} as ServiceContext['storage'],
    eventBus: {} as ServiceContext['eventBus'],
  };
}

describe('ServiceRuntime', () => {
  it('calls onMessage and returns a response RuntimeResult', async () => {
    const svc: LegionService = {
      async start() {},
      async stop() {},
      async onMessage(msg) {
        return `echo: ${msg.content}`;
      },
    };
    const runtime = new ServiceRuntime(svc, {}, stubContextFactory);
    const result = await runtime.handle(makeIncoming(), stubRuntimeCtx());
    expect(result).toEqual({ kind: 'response', content: 'echo: hello' });
  });

  it('returns void RuntimeResult when onMessage returns undefined', async () => {
    const svc: LegionService = {
      async start() {},
      async stop() {},
      async onMessage() {
        return undefined;
      },
    };
    const runtime = new ServiceRuntime(svc, {}, stubContextFactory);
    const result = await runtime.handle(makeIncoming(), stubRuntimeCtx());
    expect(result).toEqual({ kind: 'void' });
  });

  it('declines gracefully when canReceive is false', async () => {
    const svc: LegionService = {
      async start() {},
      async stop() {},
      async onMessage() {
        return 'never called';
      },
    };
    const runtime = new ServiceRuntime(svc, { canReceive: false }, stubContextFactory);
    const result = await runtime.handle(makeIncoming(), stubRuntimeCtx());
    expect(result).toEqual({
      kind: 'response',
      content: expect.stringContaining('does not accept'),
    });
  });

  it('declines gracefully when onMessage is absent', async () => {
    const svc: LegionService = { async start() {}, async stop() {} };
    const runtime = new ServiceRuntime(svc, {}, stubContextFactory);
    const result = await runtime.handle(makeIncoming(), stubRuntimeCtx());
    expect(result).toEqual({
      kind: 'response',
      content: expect.stringContaining('does not accept'),
    });
  });

  it('passes the incoming conversationId to the context factory', async () => {
    const seen: string[] = [];
    const factory = (id: string): ServiceContext => {
      seen.push(id);
      return stubContextFactory(id);
    };
    const svc: LegionService = {
      async start() {},
      async stop() {},
      async onMessage() {
        return 'ok';
      },
    };
    const runtime = new ServiceRuntime(svc, {}, factory);
    await runtime.handle(makeIncoming({ conversationId: 'conv-42' }), stubRuntimeCtx());
    expect(seen).toEqual(['conv-42']);
  });

  it('maps all IncomingMessage fields from MessageData', async () => {
    let seen: unknown;
    const svc: LegionService = {
      async start() {},
      async stop() {},
      async onMessage(msg) {
        seen = msg;
        return 'ok';
      },
    };
    const runtime = new ServiceRuntime(svc, {}, stubContextFactory);
    const incoming = makeIncoming({ senderId: 'op-1', replyTo: 'user-1', content: 'ping' });
    await runtime.handle(incoming, stubRuntimeCtx());
    expect(seen).toMatchObject({
      id: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'op-1',
      recipientId: 'svc-1',
      replyTo: 'user-1',
      content: 'ping',
    });
  });
});
