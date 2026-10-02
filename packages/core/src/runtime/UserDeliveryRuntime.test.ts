import { UserDeliveryRuntime } from './UserDeliveryRuntime.js';
import { ConnectorRegistry } from '../connectors/ConnectorRegistry.js';
import type { RuntimeContext } from './Runtime.js';
import type { MessageData } from '@legion-collective/types';
import type { Connector } from '../connectors/Connector.js';

function makeConnector(name: string): Connector & { delivered: unknown[] } {
  return {
    name,
    delivered: [],
    async start() {},
    async deliver(msg) {
      this.delivered.push(msg);
    },
    async stop() {},
  };
}

const inbound: MessageData = {
  id: 'm1',
  parentId: null,
  conversationId: 'c1',
  senderId: 'op',
  recipientId: 'user-a',
  role: 'user',
  content: 'hello',
  status: 'active',
  timestamp: '2026-01-01T00:00:00.000Z',
};

function makeCtx(): RuntimeContext {
  const emitted: unknown[] = [];
  return {
    participant: { id: 'user-a', name: 'Alice', type: 'user', tools: {} },
    conversationId: 'c1',
    eventBus: { emit: (_e: string, p: unknown) => emitted.push(p), on: () => () => {} } as any,
    _emitted: emitted,
  } as any;
}

describe('UserDeliveryRuntime', () => {
  it('returns { kind: "void" }', async () => {
    const runtime = new UserDeliveryRuntime('user-a');
    const result = await runtime.handle(inbound, makeCtx());
    expect(result).toEqual({ kind: 'void' });
  });

  it('emits message:delivered regardless of connector presence', async () => {
    const ctx = makeCtx();
    const runtime = new UserDeliveryRuntime('user-a');
    await runtime.handle(inbound, ctx);
    expect((ctx as any)._emitted).toHaveLength(1);
  });

  it('calls deliver() on all active connectors for the participant', async () => {
    const registry = new ConnectorRegistry();
    const connA = makeConnector('web');
    registry.register(connA);
    registry.setActive('user-a', 'web');
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await runtime.handle(inbound, makeCtx());
    expect(connA.delivered).toHaveLength(1);
    expect((connA.delivered[0] as any).content).toBe('hello');
  });

  it('does not call deliver() on connectors for other participants', async () => {
    const registry = new ConnectorRegistry();
    const connA = makeConnector('web');
    registry.register(connA);
    registry.setActive('user-b', 'web');
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await runtime.handle(inbound, makeCtx());
    expect(connA.delivered).toHaveLength(0);
  });

  it('swallows connector.deliver() errors and continues', async () => {
    const registry = new ConnectorRegistry();
    const failConnector: Connector = {
      name: 'broken',
      async start() {},
      async stop() {},
      async deliver() {
        throw new Error('network error');
      },
    };
    const goodConnector = makeConnector('good');
    registry.register(failConnector);
    registry.register(goodConnector);
    registry.setActive('user-a', 'broken');
    registry.setActive('user-a', 'good');
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({ kind: 'void' });
    expect(goodConnector.delivered).toHaveLength(1);
  });

  it('no-op deliver when no registry provided', async () => {
    const runtime = new UserDeliveryRuntime('user-a');
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({ kind: 'void' });
  });

  it('no-op deliver when participant has no active connectors', async () => {
    const registry = new ConnectorRegistry();
    const conn = makeConnector('web');
    registry.register(conn);
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await runtime.handle(inbound, makeCtx());
    expect(conn.delivered).toHaveLength(0);
  });
});
