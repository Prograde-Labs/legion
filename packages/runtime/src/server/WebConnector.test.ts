import { WebConnector } from './WebConnector.js';
import type { ConnectorContext } from '@legion/core';
import type { ToolResult } from '@legion/core';
import { MemoryStorage } from '@legion/core';
import { Collective } from '@legion/core';
import { EventBus } from '@legion/core';
import { FileCredentialStore } from '@legion/core';

// ── Test helpers ─────────────────────────────────────────────────────────────

async function makeCollective() {
  const storage = new MemoryStorage();
  await storage.writeJson('collective/participants/op-1.json', {
    id: 'op-1',
    name: 'Operator',
    type: 'user',
    tools: { list_participants: 'auto' },
    operator: true,
    protected: true,
    status: 'active',
  });
  return Collective.load(storage);
}

function makeCredentials(storage: MemoryStorage) {
  return new FileCredentialStore(storage);
}

function makeConnectorContext(
  toolResult: ToolResult = { status: 'success', data: 'ok' },
): ConnectorContext {
  return {
    submit: vi.fn().mockResolvedValue({ status: 'success', conversationId: 'conv-1' }),
    callTool: vi.fn().mockResolvedValue({ result: toolResult, conversationId: 'conv-test' }),
    streamTool: vi.fn().mockResolvedValue({
      gen: (async function* () {
        yield { type: 'stream:done', result: toolResult };
      })(),
      conversationId: 'conv-test',
    }),
    registry: {
      setActive: vi.fn(),
      clearActive: vi.fn(),
      register: vi.fn(),
      deregister: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      getActiveConnectors: vi.fn().mockReturnValue([]),
    } as any,
  };
}

async function makeConnector(opts: { toolResult?: ToolResult } = {}) {
  const storage = new MemoryStorage();
  const collective = await makeCollective();
  const credentials = makeCredentials(storage);
  const eventBus = new EventBus();
  await credentials.setCredential('op-1', 'hunter2');

  const connector = new WebConnector({
    collective,
    credentials,
    eventBus,
    serverConfig: { port: 0 },
  });

  const ctx = makeConnectorContext(opts.toolResult);
  await connector.start(ctx);

  return { connector, ctx, collective, credentials, eventBus };
}

// Helper: call app.inject() through the connector's internal Fastify instance.
async function inject(
  connector: WebConnector,
  opts: Parameters<ReturnType<typeof Fastify>['inject']>[0],
) {
  return (connector as any).app!.inject(opts);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebConnector: GET /api/health', () => {
  afterEach(async () => {
    // cleanup handled per-test
  });

  it('returns { status: "ok" }', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, { method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    await connector.stop();
  });
});

describe('WebConnector: POST /api/auth/login', () => {
  it('returns 400 when name or password is missing', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator' },
    });
    expect(res.statusCode).toBe(400);
    await connector.stop();
  });

  it('returns 401 for unknown participant name', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Ghost', password: 'x' },
    });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 401 for wrong password', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 200 and a JWT token on success', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3);
    expect(body.participantId).toBe('op-1');
    await connector.stop();
  });
});

describe('WebConnector: GET /api/auth/me', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, { method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 401 for an invalid token', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer invalid.token.here' },
    });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 200 + participant info for a valid token', async () => {
    const { connector } = await makeConnector();
    const loginRes = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    const { token } = JSON.parse(loginRes.body) as { token: string };

    const meRes = await inject(connector, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);
    const body = JSON.parse(meRes.body);
    expect(body.id).toBe('op-1');
    expect(body.name).toBe('Operator');
    await connector.stop();
  });
});

describe('WebConnector: POST /api/execute', () => {
  it('returns 401 when unauthenticated', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/execute',
      payload: { tool: 'list_participants', args: {} },
    });
    expect(res.statusCode).toBe(401);
    await connector.stop();
  });

  it('returns 400 when tool name is missing', async () => {
    const { connector } = await makeConnector();
    const loginRes = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    const { token } = JSON.parse(loginRes.body) as { token: string };
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { args: {} },
    });
    expect(res.statusCode).toBe(400);
    await connector.stop();
  });

  it('returns 200 + result on success', async () => {
    const { connector } = await makeConnector();
    const loginRes = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    const { token } = JSON.parse(loginRes.body) as { token: string };
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/execute?stream=false',
      headers: { authorization: `Bearer ${token}` },
      payload: { tool: 'list_participants', args: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBeDefined();
    expect(body.conversationId).toBe('conv-test');
    await connector.stop();
  });

  it('returns conversationId even when not supplied in request', async () => {
    const { connector } = await makeConnector();
    const loginRes = await inject(connector, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'hunter2' },
    });
    const { token } = JSON.parse(loginRes.body) as { token: string };
    const res = await inject(connector, {
      method: 'POST',
      url: '/api/execute?stream=false',
      headers: { authorization: `Bearer ${token}` },
      payload: { tool: 'list_participants' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.conversationId).toBe('string');
    await connector.stop();
  });
});

describe('WebConnector: POST /api/auth/logout', () => {
  it('returns 200 (JWT is stateless; acknowledgement only)', async () => {
    const { connector } = await makeConnector();
    const res = await inject(connector, { method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(200);
    await connector.stop();
  });
});

describe('WebConnector: deliver()', () => {
  it('is a no-op when the recipient has no active connections', async () => {
    const { connector } = await makeConnector();
    await expect(
      connector.deliver({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'agent-1',
        recipientId: 'op-1',
        content: 'hello',
        timestamp: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
    await connector.stop();
  });

  it('sends to all open sockets for the recipient', async () => {
    const { connector } = await makeConnector();
    const sent: string[] = [];
    const fakeSocket = {
      readyState: 1,
      send: (data: string) => {
        sent.push(data);
      },
    };
    (connector as any).connections.set('op-1', new Set([fakeSocket]));

    await connector.deliver({
      id: 'm1',
      conversationId: 'c1',
      senderId: 'agent-1',
      recipientId: 'op-1',
      content: 'hi',
      timestamp: new Date().toISOString(),
    });

    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]) as { type: string };
    expect(msg.type).toBe('message');
    await connector.stop();
  });

  it('skips closed sockets (readyState !== OPEN)', async () => {
    const { connector } = await makeConnector();
    const sent: string[] = [];
    const closedSocket = {
      readyState: 3,
      send: (data: string) => {
        sent.push(data);
      },
    };
    (connector as any).connections.set('op-1', new Set([closedSocket]));

    await connector.deliver({
      id: 'm1',
      conversationId: 'c1',
      senderId: 'agent-1',
      recipientId: 'op-1',
      content: 'hi',
      timestamp: new Date().toISOString(),
    });
    expect(sent).toHaveLength(0);
    await connector.stop();
  });
});
