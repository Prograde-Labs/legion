import { createServer, type Server, type ServerResponse } from 'node:http';

type ChatMessage = {
  role?: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
};
type ChatRequest = {
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
};

function isChatRequest(value: unknown): value is ChatRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const messages = (value as Record<string, unknown>)['messages'];
  if (messages === undefined) return true;
  if (!Array.isArray(messages)) return false;

  return messages.every((message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
    const record = message as Record<string, unknown>;
    const role = record['role'];
    const content = record['content'];
    return (
      (role === undefined || typeof role === 'string') &&
      (content === undefined || content === null || typeof content === 'string') &&
      (record['tool_call_id'] === undefined || typeof record['tool_call_id'] === 'string') &&
      (record['tool_calls'] === undefined || Array.isArray(record['tool_calls']))
    );
  });
}

const MODELS_RESPONSE = JSON.stringify({
  object: 'list',
  data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'mock' }],
});

async function writeSse(res: ServerResponse, chunks: unknown[], delayMs = 0): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.writeHead(200);
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  res.end('data: [DONE]\n\n');
}

function defaultChunks(): unknown[] {
  return [
    {
      choices: [
        {
          delta: { content: 'mock response' },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    },
  ];
}

const firstReasoningChunks = [
  {
    choices: [{ delta: { reasoning_content: '**tool reasoning**' }, finish_reason: null }],
  },
  {
    choices: [{ delta: { content: 'temporary preface' }, finish_reason: null }],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'reasoning-tool-call',
              type: 'function',
              function: { name: 'list_participants', arguments: '{}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  },
];

const finalReasoningChunks = [
  {
    choices: [{ delta: { reasoning: '*final reasoning*' }, finish_reason: null }],
  },
  {
    choices: [{ delta: { content: 'final reasoning answer' }, finish_reason: 'stop' }],
  },
  {
    choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  },
];

function textChunks(content: string, promptTokens = 20): unknown[] {
  return [
    { choices: [{ delta: { content }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 5 } },
  ];
}

function toolChunks(id: string, name: string, args: Record<string, unknown>): unknown[] {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ];
}

function includesText(messages: ChatMessage[], marker: string): boolean {
  return messages.some((message) => message.content?.includes(marker));
}

function containsToolResultForCall(messages: ChatMessage[], callId: string): boolean {
  return messages.some((message) => message.role === 'tool' && message.tool_call_id === callId);
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
        void (async () => {
          if (req.method === 'GET' && req.url === '/v1/models') {
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(MODELS_RESPONSE);
            return;
          }

          if (req.method === 'POST' && req.url === '/v1/chat/completions') {
            let parsed: unknown;
            try {
              parsed = JSON.parse(_body) as unknown;
            } catch {
              res.setHeader('Content-Type', 'application/json');
              res.writeHead(400);
              res.end(
                JSON.stringify({
                  error: { message: 'invalid JSON', type: 'invalid_request_error' },
                }),
              );
              return;
            }
            if (!isChatRequest(parsed)) {
              res.setHeader('Content-Type', 'application/json');
              res.writeHead(400);
              res.end(
                JSON.stringify({
                  error: { message: 'invalid request', type: 'invalid_request_error' },
                }),
              );
              return;
            }

            const { messages = [] } = parsed;
            const isReasoningScenario = messages.some(
              (message) =>
                message.role === 'user' && message.content?.includes('E2E_REASONING_SCENARIO'),
            );
            const hasToolResult = messages.some((message) => message.role === 'tool');

            if (isReasoningScenario && !hasToolResult) {
              await writeSse(res, firstReasoningChunks, 300);
              return;
            }
            if (isReasoningScenario && hasToolResult) {
              await writeSse(res, finalReasoningChunks, 300);
              return;
            }

            if (includesText(messages, 'E2E_SKILL_SCENARIO')) {
              if (!containsToolResultForCall(messages, 'skill-load')) {
                const systemCatalogPresent = messages.some(
                  (message) =>
                    message.role === 'system' && message.content?.includes('e2e-proof-skill'),
                );
                await writeSse(
                  res,
                  systemCatalogPresent
                    ? toolChunks('skill-load', 'load_skills', { names: ['e2e-proof-skill'] })
                    : textChunks('SKILL_CATALOG_MISSING'),
                );
              } else {
                const instructionsPresent = messages.some((message) =>
                  message.content?.includes('E2E_SKILL_INSTRUCTION_LOADED'),
                );
                await writeSse(
                  res,
                  textChunks(instructionsPresent ? 'SKILL_LOADED_OK' : 'SKILL_LOAD_MISSING'),
                );
              }
              return;
            }

            if (includesText(messages, 'E2E_COMPACTION_SUMMARY')) {
              await writeSse(res, textChunks('E2E_COMPACTED_SUMMARY'));
              return;
            }
            if (includesText(messages, 'E2E_AUTO_COMPACT')) {
              await writeSse(res, textChunks('AUTO_COMPACTION_RESPONSE', 500));
              return;
            }

            if (includesText(messages, 'E2E_SHARED_TITLE')) {
              await writeSse(res, textChunks('Shared Middleware Title'));
              return;
            }
            if (includesText(messages, 'E2E_PARTICIPANT_TITLE')) {
              await writeSse(res, textChunks('Participant Middleware Title'));
              return;
            }
            if (includesText(messages, 'E2E_NAMING_PARENT')) {
              await writeSse(res, textChunks('NAMING_PARENT_RESPONSE'));
              return;
            }

            if (includesText(messages, 'E2E_APPROVAL_SCENARIO')) {
              await writeSse(res, textChunks('APPROVAL_RESUMED_OK'));
              return;
            }

            await writeSse(res, defaultChunks());
            return;
          }

          res.setHeader('Content-Type', 'application/json');
          res.writeHead(404);
          res.end(
            JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }),
          );
        })().catch((error: unknown) => {
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(500);
            res.end(JSON.stringify({ error: { message: 'internal error', type: 'server_error' } }));
            return;
          }
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        stop: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}
