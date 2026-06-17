import { createServer, type Server } from 'node:http';

const MODELS_RESPONSE = JSON.stringify({
  object: 'list',
  data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'mock' }],
});

function chatResponse(): string {
  return JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'mock response' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  });
}

export interface MockProvider {
  server: Server;
  stop: () => Promise<void>;
}

export function startMockProvider(port: number): Promise<MockProvider> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let _body = '';
      req.on('data', (chunk: Buffer) => {
        _body += chunk.toString();
      });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET' && req.url === '/v1/models') {
          res.writeHead(200);
          res.end(MODELS_RESPONSE);
        } else if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          res.writeHead(200);
          res.end(chatResponse());
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
        }
      });
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        stop: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}
