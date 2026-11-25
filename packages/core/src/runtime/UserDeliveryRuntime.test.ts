import { UserDeliveryRuntime } from './UserDeliveryRuntime.js';
import { ConnectorRegistry } from '../connectors/ConnectorRegistry.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { RuntimeContext } from './Runtime.js';
import type { MessageData } from '@legion-collective/types';
import type { Connector, DeliveryOutcome } from '../connectors/Connector.js';

function makeConnector(
  name: string,
  outcome: DeliveryOutcome = { status: 'delivered' },
  canDeliver?: (participantId: string) => boolean,
): Connector & { delivered: unknown[] } {
  return {
    name,
    delivered: [],
    ...(canDeliver ? { canDeliver } : {}),
    async start() {},
    async deliver(msg) {
      this.delivered.push(msg);
      return outcome;
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
  it('returns not-reachable when no registry is provided', async () => {
    const runtime = new UserDeliveryRuntime('user-a');
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({
      kind: 'void',
      delivery: { status: 'not-reachable', reason: 'no connector can reach user-a' },
    });
  });

  it('emits message:delivered regardless of connector presence', async () => {
    const ctx = makeCtx();
    const runtime = new UserDeliveryRuntime('user-a');
    await runtime.handle(inbound, ctx);
    expect((ctx as any)._emitted).toHaveLength(1);
  });

  it('calls deliver() on deliverable connectors without setActive', async () => {
    const registry = new ConnectorRegistry();
    const conn = makeConnector('web');
    registry.register(conn);
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await runtime.handle(inbound, makeCtx());
    expect(conn.delivered).toHaveLength(1);
    expect((conn.delivered[0] as any).content).toBe('hello');
  });

  it('passes structured approval requests to connectors', async () => {
    const approvals = new PendingApprovalRegistry();
    const { approvalId } = await approvals.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'write_file',
      args: { path: 'notes.txt' },
    });
    const registry = new ConnectorRegistry();
    const conn = makeConnector('web');
    registry.register(conn);
    const runtime = new UserDeliveryRuntime('user-a', registry);
    const ctx = { ...makeCtx(), pendingApprovalRegistry: approvals } as RuntimeContext;

    await runtime.handle(
      {
        ...inbound,
        toolCalls: [{ id: 'call-1', name: 'write_file', arguments: { path: 'notes.txt' } }],
        toolResults: [
          {
            id: 'call-1',
            name: 'write_file',
            result: { status: 'pending_approval', approvalId },
          },
        ],
      },
      ctx,
    );

    expect(conn.delivered).toHaveLength(1);
    expect((conn.delivered[0] as { approvalRequests?: unknown[] }).approvalRequests).toEqual([
      {
        approvalId,
        conversationId: 'c1',
        requesterId: 'agent-b',
        tool: 'write_file',
        args: { path: 'notes.txt' },
        createdAt: expect.any(String),
      },
    ]);
  });

  it('omits approvalRequests when the registry cannot resolve a tool result', async () => {
    const registry = new ConnectorRegistry();
    const conn = makeConnector('web');
    registry.register(conn);
    const runtime = new UserDeliveryRuntime('user-a', registry);

    await runtime.handle(
      {
        ...inbound,
        toolResults: [
          {
            id: 'call-1',
            name: 'write_file',
            result: { status: 'pending_approval', approvalId: 'missing' },
          },
        ],
      },
      makeCtx(),
    );

    expect(
      (conn.delivered[0] as { approvalRequests?: unknown[] }).approvalRequests,
    ).toBeUndefined();
  });

  it('omits approvalRequests when a pending record is missing', async () => {
    const approvals = new PendingApprovalRegistry();
    const registry = new ConnectorRegistry();
    const conn = makeConnector('web');
    registry.register(conn);
    const runtime = new UserDeliveryRuntime('user-a', registry);
    const ctx = { ...makeCtx(), pendingApprovalRegistry: approvals } as RuntimeContext;

    await runtime.handle(
      {
        ...inbound,
        toolResults: [
          {
            id: 'call-1',
            name: 'write_file',
            result: { status: 'pending_approval', approvalId: 'missing' },
          },
        ],
      },
      ctx,
    );

    expect(
      (conn.delivered[0] as { approvalRequests?: unknown[] }).approvalRequests,
    ).toBeUndefined();
  });

  it('excludes connectors whose canDeliver predicate rejects the participant', async () => {
    const registry = new ConnectorRegistry();
    const accepted = makeConnector('teams', { status: 'delivered' }, (id) => id === 'user-a');
    const rejected = makeConnector('web', { status: 'delivered' }, () => false);
    registry.register(accepted);
    registry.register(rejected);
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await runtime.handle(inbound, makeCtx());
    expect(accepted.delivered).toHaveLength(1);
    expect(rejected.delivered).toHaveLength(0);
  });

  it('fans out to every deliverable connector and reports the first success', async () => {
    const registry = new ConnectorRegistry();
    const first = makeConnector('teams', { status: 'delivered' });
    const second = makeConnector('web', { status: 'accepted' });
    registry.register(first);
    registry.register(second);
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({
      kind: 'void',
      delivery: { status: 'delivered' },
    });
    expect(first.delivered).toHaveLength(1);
    expect(second.delivered).toHaveLength(1);
  });

  it('reports accepted as a success', async () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector('web', { status: 'accepted' }));
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({
      kind: 'void',
      delivery: { status: 'accepted' },
    });
  });

  it('reports failed when every connector fails or is unreachable', async () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector('teams', { status: 'failed', reason: '403' }));
    registry.register(makeConnector('web', { status: 'not-reachable', reason: 'offline' }));
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({
      kind: 'void',
      delivery: { status: 'failed', reason: '403; offline' },
    });
  });

  it('reports not-reachable when every connector is unreachable', async () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector('teams', { status: 'not-reachable', reason: 'no bot' }));
    registry.register(makeConnector('web', { status: 'not-reachable', reason: 'no socket' }));
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({
      kind: 'void',
      delivery: { status: 'not-reachable', reason: 'no bot; no socket' },
    });
  });

  it('converts thrown connector errors to failed outcomes and continues', async () => {
    const registry = new ConnectorRegistry();
    const broken: Connector = {
      name: 'broken',
      async start() {},
      async stop() {},
      async deliver() {
        throw new Error('network error');
      },
    };
    const good = makeConnector('good');
    registry.register(broken);
    registry.register(good);
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({
      kind: 'void',
      delivery: { status: 'delivered' },
    });
    expect(good.delivered).toHaveLength(1);
  });

  it('reports failed when every connector throws', async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      name: 'broken',
      async start() {},
      async stop() {},
      async deliver() {
        throw new Error('network error');
      },
    });
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({
      kind: 'void',
      delivery: { status: 'failed', reason: "connector 'broken' failed during delivery" },
    });
  });
  it.each([false, true])('handles a legacy undefined outcome (healthy=%s)', async (healthy) => {
    const registry = new ConnectorRegistry();
    registry.register({
      ...makeConnector('broken'),
      deliver: async () => undefined as unknown as DeliveryOutcome,
    });
    if (healthy) registry.register(makeConnector('good'));
    const runtime = new UserDeliveryRuntime('user-a', registry);
    await expect(runtime.handle(inbound, makeCtx())).resolves.toEqual({
      kind: 'void',
      delivery: healthy
        ? { status: 'delivered' }
        : {
            status: 'failed',
            reason: "connector 'broken' returned no delivery outcome",
          },
    });
  });
});
