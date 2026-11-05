import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { StreamRegistry } from '@legion-collective/core';
import type { Collective, ConnectorContext, StreamChunk } from '@legion-collective/core';
import { signToken } from '../auth.js';
import { SECURITY_HEADERS } from '../securityHeaders.js';
import { registerExecuteRoute } from './execute.js';

const jwtSecret = new Uint8Array(32).fill(7);

function makeCollective(): Collective {
  return {
    get: (id: string) => (id === 'op-1' ? { id } : undefined),
  } as unknown as Collective;
}

async function makeApp(
  registry: StreamRegistry,
  ctx: ConnectorContext,
  sendToStream: (connectionId: string, participantId: string, data: object) => boolean = () => true,
) {
  const app = Fastify({ logger: false });
  await registerExecuteRoute(app, {
    collective: makeCollective(),
    ctx,
    jwtSecret,
    streamRegistry: registry,
    sendToStream,
  });
  return app;
}

async function bearerToken(): Promise<string> {
  const { token } = await signToken('op-1', jwtSecret);
  return `Bearer ${token}`;
}

describe('POST /api/execute', () => {
  it('buffered cancelStream cancels only streams owned by the caller', async () => {
    const registry = new StreamRegistry();
    registry.register('owned', 'conn-1', 'op-1');
    registry.register('foreign', 'conn-2', 'op-2');

    let captured: { cancelStream?: (streamId: string) => boolean } | undefined;
    const ctx = {
      callTool: vi.fn(
        async (
          _participantId: string,
          _tool: string,
          _args: unknown,
          opts: { cancelStream?: (streamId: string) => boolean },
        ) => {
          captured = opts;
          return { result: { status: 'success' }, conversationId: 'conv-1' };
        },
      ),
    } as unknown as ConnectorContext;

    const app = await makeApp(registry, ctx);
    const res = await app.inject({
      method: 'POST',
      url: '/api/execute?stream=false',
      headers: { authorization: await bearerToken() },
      payload: { tool: 'cancel_stream', args: { streamId: 'owned' } },
    });

    expect(res.statusCode).toBe(200);
    expect(captured?.cancelStream?.('owned')).toBe(true);
    expect(captured?.cancelStream?.('foreign')).toBe(false);
    await app.close();
  });

  it('streaming mode registers the stream for the caller and only the owner can cancel', async () => {
    const registry = new StreamRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gen = (async function* () {
      await gate;
      yield { type: 'stream:done', result: { status: 'success' } } as StreamChunk;
    })();

    const ctx = {
      streamTool: vi.fn(async () => ({ gen, conversationId: 'conv-1' })),
    } as unknown as ConnectorContext;

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const app = await makeApp(registry, ctx, (_connectionId, _participantId, data) => {
      const frame = data as { type?: string; data?: { type?: string } };
      if (frame.type === 'stream:chunk' && frame.data?.type === 'stream:done') resolveDone();
      return true;
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/execute',
      headers: {
        authorization: await bearerToken(),
        'x-stream-connection': 'conn-1',
      },
      payload: { tool: 'watch_conversations', args: {} },
    });

    expect(res.statusCode).toBe(200);
    const { streamId } = JSON.parse(res.body) as { streamId: string };
    expect(registry.cancelForParticipant(streamId, 'op-2')).toBe(false);
    expect(registry.cancelForParticipant(streamId, 'op-1')).toBe(true);

    release();
    await done;
    await app.close();
  });

  it('applies security headers to SSE responses', async () => {
    const registry = new StreamRegistry();
    const gen = (async function* () {
      yield { type: 'stream:done', result: { status: 'success' } } as StreamChunk;
    })();
    const ctx = {
      streamTool: vi.fn(async () => ({ gen, conversationId: 'conv-1' })),
    } as unknown as ConnectorContext;

    const app = await makeApp(registry, ctx);
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = app.server.address() as AddressInfo;
      const authorization = await bearerToken();
      const response = await new Promise<{
        statusCode: number | undefined;
        headers: IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/execute',
            method: 'POST',
            headers: {
              authorization,
              'content-type': 'application/json',
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              body += chunk;
            });
            res.on('end', () =>
              resolve({ statusCode: res.statusCode, headers: res.headers, body }),
            );
          },
        );
        req.once('error', reject);
        req.end(JSON.stringify({ tool: 'watch_conversations', args: {} }));
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers[name.toLowerCase()]).toBe(value);
      }
    } finally {
      await app.close();
    }
  });
});
