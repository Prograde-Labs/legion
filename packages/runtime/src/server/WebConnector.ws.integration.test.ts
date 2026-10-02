import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WebConnector } from './WebConnector.js';
import { MemoryStorage } from '@legion-collective/core';
import { Collective } from '@legion-collective/core';
import { EventBus } from '@legion-collective/core';
import { FileCredentialStore } from '@legion-collective/core';

const LIVE = Boolean(process.env['LEGION_INTEGRATION']);

function getPort(server: { address: () => { port: number } | null }): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No port');
  return addr.port;
}

async function setup(port: number) {
  const storage = new MemoryStorage();
  await storage.writeJson('collective/participants/op-1.json', {
    id: 'op-1',
    name: 'Operator',
    type: 'user',
    tools: {},
    operator: true,
    protected: true,
    status: 'active',
  });
  const collective = await Collective.load(storage);
  const credentials = new FileCredentialStore(storage);
  await credentials.setCredential('op-1', 'hunter2');
  const eventBus = new EventBus();

  const connector = new WebConnector({
    collective,
    credentials,
    eventBus,
    serverConfig: { port, host: '127.0.0.1' },
  });

  const ctx: any = {
    submit: async () => ({ status: 'success', conversationId: 'c1' }),
    callTool: async () => ({ result: { status: 'success', data: 'ok' }, conversationId: 'c1' }),
    registry: {
      setActive: () => {},
      clearActive: () => {},
      register: () => {},
      deregister: () => {},
      get: () => undefined,
      getAll: () => [],
      getActiveConnectors: () => [],
    },
  };

  await connector.start(ctx);
  return { connector, eventBus, ctx };
}

describe.skipIf(!LIVE)('WebConnector: WebSocket (integration)', () => {
  let dir: string;
  let connector: WebConnector;
  let eventBus: EventBus;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-ws-'));
  });

  afterEach(async () => {
    await connector?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('closes connection if no auth message arrives within timeout', async () => {
    const { connector: c } = await setup(4321);
    connector = c;
    const ws = new WebSocket('ws://127.0.0.1:4321/ws');
    await new Promise<void>((resolve, reject) => {
      ws.on('close', (code) => {
        expect([4401, 1005, 1006]).toContain(code);
        resolve();
      });
      ws.on('error', reject);
    });
  }, 15000);

  it('receives "connected" ack after sending a valid auth message', async () => {
    const { connector: c, eventBus: eb } = await setup(4322);
    connector = c;
    eventBus = eb;

    // First login to get a token
    const loginRes = await fetch('http://127.0.0.1:4322/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Operator', password: 'hunter2' }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const ws = new WebSocket('ws://127.0.0.1:4322/ws');
    const messages: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        messages.push(msg);
        if ((msg as any).type === 'connected') resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    expect((messages[0] as any).type).toBe('connected');
    expect((messages[0] as any).participantId).toBe('op-1');
    ws.close();
  });

  it('receives EventBus events as {"type":"event",...} after auth', async () => {
    const { connector: c, eventBus: eb } = await setup(4323);
    connector = c;
    eventBus = eb;

    const loginRes = await fetch('http://127.0.0.1:4323/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Operator', password: 'hunter2' }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const ws = new WebSocket('ws://127.0.0.1:4323/ws');
    const events: unknown[] = [];
    const eventBusRef = eb;

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if ((msg as any).type === 'connected') {
          eventBusRef.emit('process:ready', { workspaceRoot: '/test' });
        } else if ((msg as any).type === 'event') {
          events.push(msg);
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    expect((events[0] as any).event).toBe('process:ready');
    ws.close();
  });

  it('respond to ping with pong', async () => {
    const { connector: c } = await setup(4324);
    connector = c;

    const loginRes = await fetch('http://127.0.0.1:4324/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Operator', password: 'hunter2' }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const ws = new WebSocket('ws://127.0.0.1:4324/ws');
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if ((msg as any).type === 'connected') {
          ws.send(JSON.stringify({ type: 'ping' }));
        } else if ((msg as any).type === 'pong') {
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    ws.close();
  });

  it('cancels a WebSocket tool stream and removes it from the registry', async () => {
    const { connector: c, ctx } = await setup(4325);
    connector = c;
    let generatorAborted = false;
    ctx.streamTool = vi.fn(async (_participantId, _tool, _args, options) => ({
      conversationId: 'c1',
      gen: (async function* () {
        yield { type: 'text_delta', delta: 'partial' };
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', resolve, { once: true }),
        );
        generatorAborted = true;
        yield {
          type: 'stream:done',
          result: { status: 'success', data: { conversationId: 'c1' } },
        };
      })(),
    }));
    ctx.callTool = vi.fn(async (_participantId, _tool, args, options) => ({
      result: options.cancelStream(args.streamId)
        ? { status: 'success', data: { streamId: args.streamId } }
        : { status: 'error', error: 'Stream not found or already complete' },
      conversationId: 'c1',
    }));

    const loginRes = await fetch('http://127.0.0.1:4325/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Operator', password: 'hunter2' }),
    });
    const { token } = (await loginRes.json()) as { token: string };
    const ws = new WebSocket('ws://127.0.0.1:4325/ws');
    let resolvePartial!: () => void;
    let resolveTerminal!: () => void;
    const partial = new Promise<void>((resolve) => (resolvePartial = resolve));
    const terminal = new Promise<void>((resolve) => (resolveTerminal = resolve));
    const connected = new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'connected') resolve(message.connectionId);
        if (message.type !== 'stream:chunk') return;
        if (message.data.type === 'text_delta') resolvePartial();
        if (message.data.type === 'stream:done') resolveTerminal();
      });
      ws.on('error', reject);
    });
    const connectionId = await connected;

    const startRes = await fetch('http://127.0.0.1:4325/api/execute', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-stream-connection': connectionId,
      },
      body: JSON.stringify({ tool: 'communicate', args: {} }),
    });
    const { streamId } = (await startRes.json()) as { streamId: string };
    await partial;
    const cancel = async () => {
      const response = await fetch('http://127.0.0.1:4325/api/execute?stream=false', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'cancel_stream', args: { streamId } }),
      });
      return (await response.json()) as { result: { status: string } };
    };

    expect((await cancel()).result.status).toBe('success');
    await terminal;
    expect(generatorAborted).toBe(true);
    expect((await cancel()).result.status).toBe('error');
    ws.close();
  });
});
