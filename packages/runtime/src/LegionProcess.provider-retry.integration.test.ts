import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegionProcess } from './LegionProcess.js';

const prompt = 'Please verify the retry.';
const answer = 'Recovered on the second request.';

function loopbackUrl(server: Server): string {
  const { address, port } = server.address() as AddressInfo;
  expect(address).toBe('127.0.0.1');
  return `http://${address}:${port}`;
}

it.skipIf(process.env.LEGION_INTEGRATION !== '1')(
  'communicate retries a pre-content Responses rate limit and persists a single turn',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'legion-provider-retry-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const requests: string[] = [];
    const mock = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(body);
      const events =
        requests.length === 1
          ? [
              {
                type: 'response.failed',
                response: {
                  error: { code: 'rate_limit_exceeded', message: 'Temporary rate limit' },
                },
              },
            ]
          : [
              { type: 'response.output_text.delta', delta: answer },
              { type: 'response.completed', response: {} },
            ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    let legion: LegionProcess | undefined;
    try {
      await Promise.all([mkdir(home), mkdir(workspace)]);
      vi.stubEnv('HOME', home);
      vi.stubEnv('PORT', '0');
      vi.stubEnv('LEGION_BOOTSTRAP_PASSWORD', 'retry-test-password');
      mock.listen(0, '127.0.0.1');
      await once(mock, 'listening');
      legion = await LegionProcess.start(workspace);
      const web = legion.connectors.get('web') as unknown as { app: { server: Server } };
      const url = loopbackUrl(web.app.server);
      let token = '';
      async function post(path: string, data: unknown) {
        const response = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(data),
        });
        expect(response.status).toBe(200);
        return response.json();
      }
      async function execute(tool: string, args: Record<string, unknown>) {
        const { result } = await post('/api/execute?stream=false', { tool, args });
        expect(
          result,
          `${tool}: ${JSON.stringify(result)} (provider requests: ${requests.length})`,
        ).toMatchObject({ status: 'success' });
        return result.data;
      }
      ({ token } = await post('/api/auth/login', {
        name: 'Operator',
        password: 'retry-test-password',
      }));
      await execute('save_provider', {
        name: 'retry-mock',
        type: 'openai-responses',
        baseUrl: `${loopbackUrl(mock)}/v1`,
        apiKey: 'test-only',
        priority: 1,
      });
      await execute('create_agent', {
        id: 'retry-agent',
        name: 'Retry Agent',
        systemPrompt: 'Answer briefly.',
        model: { provider: 'retry-mock', model: 'mock-model' },
        tools: {},
      });
      const turn = await execute('communicate', {
        to: 'retry-agent',
        message: prompt,
        timeoutMs: 10000,
      });
      expect(turn.response, `provider requests: ${requests.length}`).toBe(answer);
      expect(requests).toHaveLength(2);
      expect(JSON.parse(requests[1])).toEqual(JSON.parse(requests[0]));
      const { messages } = await execute('get_conversation', {
        conversationId: turn.conversationId,
      });
      expect(
        messages.filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant'),
      ).toEqual([
        expect.objectContaining({ role: 'user', content: prompt }),
        expect.objectContaining({ role: 'assistant', content: answer }),
      ]);
    } finally {
      try {
        await legion?.stop();
      } finally {
        if (mock.listening) await new Promise<void>((resolve) => mock.close(() => resolve()));
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  20000,
);
