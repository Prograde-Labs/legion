import type {
  CommunicateResult,
  IncomingMessage,
  LegionService,
  ServiceContext,
  ServiceInfo,
  ServiceStatus,
} from './LegionService.js';

describe('LegionService SDK type shapes', () => {
  it('LegionService can be implemented with only start and stop', () => {
    const svc: LegionService = {
      async start(_ctx: ServiceContext) {},
      async stop() {},
    };
    expect(typeof svc.start).toBe('function');
    expect(typeof svc.stop).toBe('function');
    expect(svc.onMessage).toBeUndefined();
  });

  it('LegionService can implement optional onMessage', () => {
    const svc: LegionService = {
      async start(_ctx) {},
      async stop() {},
      async onMessage(msg, _ctx) {
        return `echo: ${msg.content}`;
      },
    };
    expect(typeof svc.onMessage).toBe('function');
  });

  it('ServiceStatus covers all five lifecycle states', () => {
    const states: ServiceStatus[] = ['starting', 'running', 'stopping', 'stopped', 'failed'];
    expect(states).toHaveLength(5);
  });

  it('CommunicateResult includes all three status values', () => {
    const ok: CommunicateResult = { conversationId: 'c1', response: 'hi', status: 'success' };
    const dispatched: CommunicateResult = { conversationId: 'c1', status: 'dispatched' };
    const err: CommunicateResult = { conversationId: 'c1', status: 'error', error: 'oops' };
    expect(ok.status).toBe('success');
    expect(dispatched.status).toBe('dispatched');
    expect(err.error).toBe('oops');
  });

  it('IncomingMessage has all required fields and optional replyTo', () => {
    const msg: IncomingMessage = {
      id: 'msg-1',
      conversationId: 'c-1',
      senderId: 'agent-a',
      recipientId: 'svc-1',
      content: 'hello',
      timestamp: new Date().toISOString(),
    };
    expect(msg.replyTo).toBeUndefined();
  });

  it('ServiceInfo can carry an error', () => {
    const info: ServiceInfo = {
      participantId: 'svc-1',
      status: 'failed',
      error: 'Module not found',
    };
    expect(info.error).toBe('Module not found');
  });
});
