import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CodexProvider } from './CodexProvider.js';
import type { CodexAuthStore } from './CodexAuthStore.js';
import { ProviderError } from '../errors/LegionError.js';
import type { ProviderStreamChunk } from './Provider.js';

const AUTH = {
  clientId: 'client-1',
  issuer: 'https://auth.openai.com',
  accountId: 'acct-1',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  savedAt: '2026-11-17T05:00:00.000Z',
};

function makeStore(ensureFresh = vi.fn(async () => AUTH)): CodexAuthStore {
  return { ensureFresh } as unknown as CodexAuthStore;
}

function makeSse(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
}

function sse(events: Record<string, unknown>[]): Response {
  return new Response(makeSse(events.map((e) => `data: ${JSON.stringify(e)}`)), { status: 200 });
}

function textEvents(text: string): Record<string, unknown>[] {
  return [
    { type: 'response.created', response: { id: 'r1' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: { id: 'r1', usage: { input_tokens: 4, output_tokens: 2 } },
    },
  ];
}

async function drain(
  provider: CodexProvider,
  messages: Parameters<CodexProvider['stream']>[0],
  tools: Parameters<CodexProvider['stream']>[1] = [],
  model: Parameters<CodexProvider['stream']>[2] = { model: 'gpt-5.5' },
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream(messages, tools, model)) chunks.push(chunk);
  return chunks;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CodexProvider', () => {
  it('preserves the status of a redacted stream error', async () => {
    class FailingProvider extends CodexProvider {
      protected override async *parseStream(): AsyncGenerator<ProviderStreamChunk> {
        throw new ProviderError('access-token failed', 429);
      }
    }
    fetchMock.mockResolvedValue(sse([]));
    const provider = new FailingProvider(
      { name: 'Codex', type: 'codex', priority: 10 },
      makeStore(),
    );
    const error = await drain(provider, []).catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 429, message: '[redacted] failed' });
  });
  it('redacts all attempted tokens in a failed SSE event', async () => {
    const ensureFresh = vi
      .fn()
      .mockResolvedValueOnce(AUTH)
      .mockResolvedValueOnce({ ...AUTH, accessToken: 'new-token' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(
      sse([
        {
          type: 'response.failed',
          response: { error: { code: 'failed', message: 'access-token and new-token' } },
        },
      ]),
    );
    const provider = new CodexProvider(
      { name: 'Codex', type: 'codex', priority: 10 },
      makeStore(ensureFresh),
    );
    const error = await drain(provider, []).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain('[redacted] and [redacted]');
    expect((error as Error).message).not.toContain('access-token');
    expect((error as Error).message).not.toContain('new-token');
  });
  it('posts sanitized body and Codex headers, and records cost 0', async () => {
    fetchMock.mockResolvedValue(sse(textEvents('Hello')));

    const provider = new CodexProvider({ name: 'Codex', type: 'codex', priority: 10 }, makeStore());
    const chunks = await drain(
      provider,
      [
        { role: 'system', content: 'Be terse.' },
        { role: 'system', content: 'No filler.' },
        { role: 'user', content: 'hi' },
      ],
      [],
      { model: 'gpt-5.5', temperature: 0.2, maxTokens: 100 },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'chatgpt-account-id': 'acct-1',
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/0.0.1',
      'OpenAI-Beta': 'responses=experimental',
    });

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['temperature']).toBeUndefined();
    expect(body['max_output_tokens']).toBeUndefined();
    expect(body['instructions']).toBe('Be terse.\n\nNo filler.');
    expect(body['input']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body['parallel_tool_calls']).toBe(false);
    expect(body['include']).toEqual(['reasoning.encrypted_content']);

    expect(chunks.filter((c) => c.type === 'text_delta')).toEqual([
      { type: 'text_delta', delta: 'Hello' },
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop', cost: 0 });
  });

  it('defaults empty instructions and retries once on 401 with a forced refresh', async () => {
    const ensureFresh = vi
      .fn()
      .mockResolvedValueOnce(AUTH)
      .mockResolvedValueOnce({ ...AUTH, accessToken: 'new-token' });
    fetchMock
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(sse(textEvents('ok')));

    const provider = new CodexProvider(
      { name: 'Codex', type: 'codex', priority: 10 },
      makeStore(ensureFresh),
    );
    await drain(provider, [{ role: 'user', content: 'hi' }]);

    expect(ensureFresh).toHaveBeenNthCalledWith(1, 'Codex');
    expect(ensureFresh).toHaveBeenNthCalledWith(2, 'Codex', true);
    const second = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(second[1].headers).toMatchObject({ Authorization: 'Bearer new-token' });
    const body = JSON.parse(second[1].body as string) as Record<string, unknown>;
    expect(body['instructions']).toBe('Follow the user request.');
  });

  it('propagates HTTP status on non-OK responses', async () => {
    fetchMock.mockResolvedValue(new Response('slow down', { status: 429 }));
    const provider = new CodexProvider({ name: 'Codex', type: 'codex', priority: 10 }, makeStore());

    await expect(drain(provider, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      status: 429,
    });
  });

  it('parses the Codex model catalog', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-5.5',
              display_name: 'GPT-5.5',
              context_window: 200000,
              input_modalities: ['text', 'image'],
            },
            { slug: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex' },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = new CodexProvider({ name: 'Codex', type: 'codex', priority: 10 }, makeStore());

    await expect(provider.listModels()).resolves.toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 200000, capabilities: ['vision'] },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    ]);
  });

  it('fetches and normalizes usage', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 10 } },
        }),
        { status: 200 },
      ),
    );
    const provider = new CodexProvider({ name: 'Codex', type: 'codex', priority: 10 }, makeStore());

    const usage = await provider.usage();
    expect(usage.planType).toBe('plus');
    expect(usage.windows[0]).toMatchObject({ label: '5-hour', remainingPercent: 90 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'chatgpt-account-id': 'acct-1',
      'OpenAI-Beta': 'responses=experimental',
    });
  });

  it.each(['usage', 'listModels'] as const)('refreshes once after a 401 for %s', async (method) => {
    const ensureFresh = vi
      .fn()
      .mockResolvedValueOnce(AUTH)
      .mockResolvedValueOnce({
        ...AUTH,
        accessToken: 'new-token',
      });
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [], plan_type: 'plus' })));
    const provider = new CodexProvider(
      { name: 'Codex', type: 'codex', priority: 10 },
      makeStore(ensureFresh),
    );
    await provider[method]();
    expect(ensureFresh.mock.calls).toEqual([['Codex'], ['Codex', true]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].headers).toMatchObject({
      Authorization: 'Bearer new-token',
      'OpenAI-Beta': 'responses=experimental',
    });
  });

  it.each(['stream', 'usage'] as const)(
    'redacts the refreshed token in %s errors after a single retry',
    async (method) => {
      const ensureFresh = vi
        .fn()
        .mockResolvedValueOnce(AUTH)
        .mockResolvedValueOnce({
          ...AUTH,
          accessToken: 'new-token',
        });
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(new Response('new-token new-token', { status: 401 }));
      const provider = new CodexProvider(
        { name: 'Codex', type: 'codex', priority: 10 },
        makeStore(ensureFresh),
      );
      const result = method === 'stream' ? drain(provider, []) : provider.usage();
      const error = await result.catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ status: 401 });
      expect((error as Error).message).not.toContain('new-token');
      expect((error as Error).message).toContain('[redacted] [redacted]');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('returns an empty model list after a second 401', async () => {
    const ensureFresh = vi.fn(async () => AUTH);
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    const provider = new CodexProvider(
      { name: 'Codex', type: 'codex', priority: 10 },
      makeStore(ensureFresh),
    );
    await expect(provider.listModels()).resolves.toEqual([]);
    expect(ensureFresh.mock.calls).toEqual([['Codex'], ['Codex', true]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses models after refreshing on a 401', async () => {
    const ensureFresh = vi.fn().mockResolvedValue(AUTH);
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ slug: 'gpt-5.5' }] })));
    const provider = new CodexProvider(
      { name: 'Codex', type: 'codex', priority: 10 },
      makeStore(ensureFresh),
    );
    await expect(provider.listModels()).resolves.toMatchObject([{ id: 'gpt-5.5' }]);
    expect(ensureFresh.mock.calls).toEqual([['Codex'], ['Codex', true]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns an empty model list for a server error', async () => {
    fetchMock.mockResolvedValue(new Response('unavailable', { status: 500 }));
    const provider = new CodexProvider({ name: 'Codex', type: 'codex', priority: 10 }, makeStore());
    await expect(provider.listModels()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['stream', 'usage'] as const)(
    'redacts the original token in a retried %s error',
    async (method) => {
      const ensureFresh = vi
        .fn()
        .mockResolvedValueOnce(AUTH)
        .mockResolvedValueOnce({
          ...AUTH,
          accessToken: 'new-token',
        });
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(new Response('access-token and new-token', { status: 500 }));
      const provider = new CodexProvider(
        { name: 'Codex', type: 'codex', priority: 10 },
        makeStore(ensureFresh),
      );
      const result = method === 'stream' ? drain(provider, []) : provider.usage();
      const error = await result.catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ status: 500 });
      expect((error as Error).message).not.toContain('access-token');
      expect((error as Error).message).not.toContain('new-token');
      expect((error as Error).message).toContain('[redacted] and [redacted]');
    },
  );

  it('fails usage with a clear error when the account id is missing', async () => {
    const provider = new CodexProvider(
      { name: 'Codex', type: 'codex', priority: 10 },
      makeStore(vi.fn(async () => ({ ...AUTH, accountId: undefined }))),
    );

    await expect(provider.usage()).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.usage()).rejects.toThrow('sign in again');
  });
});
