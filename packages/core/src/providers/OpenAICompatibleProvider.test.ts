import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion-collective/types';
import type { ProviderStreamChunk, ProviderUsage } from './Provider.js';

const MODEL: ModelConfig = { model: 'gpt-4o-mini' };

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function makeErrResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(text),
  };
}

function makeSseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = lines.map((l) => encoder.encode(l + '\n'));
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function makeSseOkResponse(data: unknown, usage?: unknown, opts: { finishReason?: string } = {}) {
  const finishReason = opts.finishReason ?? 'stop';
  const lines: string[] = [];
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: data, finish_reason: null }] })}`);
  if (usage) {
    lines.push(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }], usage })}`,
    );
  } else {
    lines.push(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}`,
    );
  }
  lines.push('data: [DONE]');

  return {
    ok: true,
    status: 200,
    body: makeSseBody(lines),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

function makeSseToolCallResponse(
  toolCallDeltas: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>,
  opts: { finishReason?: string; usage?: unknown } = {},
) {
  const finishReason = opts.finishReason ?? 'tool_calls';
  const lines: string[] = [];
  for (const tc of toolCallDeltas) {
    lines.push(
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [tc] }, finish_reason: null }],
      })}`,
    );
  }
  if (opts.usage) {
    lines.push(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: finishReason }],
        usage: opts.usage,
      })}`,
    );
  } else {
    lines.push(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}`,
    );
  }
  lines.push('data: [DONE]');

  return {
    ok: true,
    status: 200,
    body: makeSseBody(lines),
    text: () => Promise.resolve(JSON.stringify(toolCallDeltas)),
  };
}

async function drainStream(
  provider: OpenAICompatibleProvider,
  messages: Parameters<OpenAICompatibleProvider['stream']>[0],
  tools: Parameters<OpenAICompatibleProvider['stream']>[1],
  model: Parameters<OpenAICompatibleProvider['stream']>[2],
) {
  let lastDone: { type: 'done'; stopReason: string; usage?: ProviderUsage } | null = null;
  const deltas: string[] = [];
  const toolCalls: Array<{ id: string; name: string; argsBuffer: string }> = [];
  for await (const chunk of provider.stream(messages, tools, model)) {
    if (chunk.type === 'text_delta') deltas.push(chunk.delta);
    if (chunk.type === 'tool_call_start')
      toolCalls.push({ id: chunk.id, name: chunk.name, argsBuffer: '' });
    if (chunk.type === 'tool_call_args_delta') {
      const tc = toolCalls[chunk.index];
      if (tc) tc.argsBuffer += chunk.delta;
    }
    if (chunk.type === 'done') lastDone = chunk;
  }
  const done = lastDone as { type: 'done'; stopReason: string; usage?: ProviderUsage } | null;
  return {
    content: deltas.join('') || null,
    toolCalls: toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: (() => {
        try {
          return JSON.parse(tc.argsBuffer || '{}') as Record<string, unknown>;
        } catch {
          return {} as Record<string, unknown>;
        }
      })(),
    })),
    stopReason: done?.stopReason ?? 'stop',
    usage: done?.usage,
  };
}

describe('OpenAICompatibleProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses constructor base URL and API key for chat completion requests', async () => {
    fetchMock.mockResolvedValue(
      makeSseOkResponse(
        { role: 'assistant', content: 'Hello!', tool_calls: null },
        { prompt_tokens: 10, completion_tokens: 5 },
      ),
    );

    const provider = new OpenAICompatibleProvider('https://example.test/v1/', 'constructor-key');
    const result = await drainStream(provider, [{ role: 'user', content: 'hi' }], [], MODEL);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer constructor-key',
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o-mini');
    expect((body['messages'] as unknown[]).length).toBe(1);
    expect(body['tools']).toBeUndefined();
    expect(body['stream']).toBe(true);

    expect(result.content).toBe('Hello!');
    expect(result.stopReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it('does not read API keys from environment variables', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    fetchMock.mockResolvedValue(
      makeSseOkResponse({ role: 'assistant', content: 'Hello!', tool_calls: null }),
    );

    const provider = new OpenAICompatibleProvider('https://example.test/v1');
    await drainStream(provider, [{ role: 'user', content: 'hi' }], [], MODEL);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toMatchObject({ Authorization: 'Bearer env-key' });
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('maps a tool_calls response to ProviderToolCall[]', async () => {
    fetchMock.mockResolvedValue(
      makeSseToolCallResponse([
        { index: 0, id: 'call_abc', function: { name: 'echo', arguments: '' } },
        { index: 0, function: { arguments: '{"text":"hello world"}' } },
      ]),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await drainStream(provider, [], [], MODEL);

    expect(result.stopReason).toBe('tool_calls');
    expect(result.content).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'call_abc',
      name: 'echo',
      arguments: { text: 'hello world' },
    });
  });

  it('includes tools and tool_choice in the request when tools are provided', async () => {
    fetchMock.mockResolvedValue(
      makeSseOkResponse({ role: 'assistant', content: 'ok', tool_calls: null }),
    );

    const provider = new OpenAICompatibleProvider();
    await drainStream(
      provider,
      [],
      [{ name: 'echo', description: 'echoes', parameters: { type: 'object' } }],
      MODEL,
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect((body['tools'] as unknown[]).length).toBe(1);
    expect(
      ((body['tools'] as Record<string, unknown>[])[0]['function'] as Record<string, unknown>)[
        'name'
      ],
    ).toBe('echo');
    expect(body['tool_choice']).toBe('auto');
  });

  it('adds empty properties to object tool schemas missing them', async () => {
    fetchMock.mockResolvedValue(
      makeSseOkResponse({ role: 'assistant', content: 'ok', tool_calls: null }),
    );

    const provider = new OpenAICompatibleProvider();
    await drainStream(
      provider,
      [],
      [
        {
          name: 'no_args',
          description: 'takes nothing',
          parameters: { type: 'object', additionalProperties: false },
        },
      ],
      MODEL,
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    const parameters = (
      (body['tools'] as Record<string, unknown>[])[0]['function'] as Record<string, unknown>
    )['parameters'] as Record<string, unknown>;
    expect(parameters).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {},
    });
  });

  it('throws ProviderError on a non-ok HTTP response', async () => {
    fetchMock.mockResolvedValue(makeErrResponse(401, 'Unauthorized'));
    const provider = new OpenAICompatibleProvider();
    const gen1 = provider.stream([], [], MODEL);
    await expect(gen1.next()).rejects.toThrow(ProviderError);
    const gen2 = provider.stream([], [], MODEL);
    await expect(gen2.next()).rejects.toThrow(/401/);
  });

  it('lists model IDs from the models endpoint with known metadata merged in', async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse({
        data: [{ id: 'gpt-4o' }, { id: 'local-model' }],
      }),
    );

    const provider = new OpenAICompatibleProvider('https://example.test/v1/', 'constructor-key');
    const models = await provider.listModels();

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/models', {
      headers: { Authorization: 'Bearer constructor-key' },
    });
    expect(models).toEqual([
      expect.objectContaining({ id: 'gpt-4o', capabilities: ['vision', 'tools', 'json_mode'] }),
      { id: 'local-model' },
    ]);
  });

  it('returns an empty model list on non-ok responses', async () => {
    fetchMock.mockResolvedValue(makeErrResponse(500, 'nope'));
    const provider = new OpenAICompatibleProvider('https://example.test/v1');

    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it('returns an empty model list on fetch errors', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const provider = new OpenAICompatibleProvider('https://example.test/v1');

    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it('extracts cache and reasoning tokens from prompt_tokens_details and completion_tokens_details', async () => {
    fetchMock.mockResolvedValue(
      makeSseOkResponse(
        { role: 'assistant', content: 'thinking...', tool_calls: null },
        {
          prompt_tokens: 2006,
          completion_tokens: 300,
          total_tokens: 2306,
          prompt_tokens_details: { cached_tokens: 1920 },
          completion_tokens_details: { reasoning_tokens: 50 },
        },
      ),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await drainStream(provider, [{ role: 'user', content: 'hi' }], [], MODEL);

    expect(result.usage).toEqual({
      inputTokens: 2006,
      outputTokens: 300,
      reasoningTokens: 50,
      cacheReadInputTokens: 1920,
      cacheWriteInputTokens: undefined,
    });
  });

  it('falls back to cache_read_input_tokens when prompt_tokens_details is absent', async () => {
    fetchMock.mockResolvedValue(
      makeSseOkResponse(
        { role: 'assistant', content: 'hi', tool_calls: null },
        {
          prompt_tokens: 1000,
          completion_tokens: 100,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
        },
      ),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await drainStream(provider, [{ role: 'user', content: 'hi' }], [], MODEL);

    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      reasoningTokens: undefined,
      cacheReadInputTokens: 800,
      cacheWriteInputTokens: 200,
    });
  });

  it('returns undefined usage when API omits usage object', async () => {
    fetchMock.mockResolvedValue(
      makeSseOkResponse({ role: 'assistant', content: 'no usage', tool_calls: null }),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await drainStream(provider, [{ role: 'user', content: 'hi' }], [], MODEL);

    expect(result.usage).toBeUndefined();
  });
});

describe('OpenAICompatibleProvider.stream()', () => {
  it('forwards abort signal to fetch and cancels reader on generator return', async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn(async () => ({
        done: false,
        value: new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n`,
        ),
      })),
      cancel,
      releaseLock,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider();
    const stream = provider.stream([], [], MODEL, { signal: controller.signal });
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'text_delta', delta: 'partial' },
    });
    await stream.return(undefined as never);
    vi.unstubAllGlobals();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it.each([
    ['reasoning_content', 'first thought'],
    ['reasoning', 'fallback thought'],
  ] as const)('maps %s to reasoning_delta', async (field, value) => {
    const reasoningChunk = JSON.stringify({
      choices: [{ delta: { [field]: value }, finish_reason: null }],
    });
    const textChunk = JSON.stringify({
      choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody([`data: ${reasoningChunk}`, `data: ${textChunk}`, 'data: [DONE]']),
      }),
    );

    const chunks: ProviderStreamChunk[] = [];
    const provider = new OpenAICompatibleProvider();
    for await (const chunk of provider.stream([], [], MODEL)) chunks.push(chunk);
    vi.unstubAllGlobals();

    expect(chunks.slice(0, 2)).toEqual([
      { type: 'reasoning_delta', delta: value },
      { type: 'text_delta', delta: 'answer' },
    ]);
  });

  it('prefers reasoning_content and ignores malformed reasoning without suppressing output', async () => {
    const lines = [
      JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: 'canonical',
              reasoning: 'duplicate',
              content: 'A',
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        choices: [
          { delta: { reasoning_content: { bad: true }, content: 'B' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody(lines.map((line) => `data: ${line}`).concat('data: [DONE]')),
      }),
    );

    const chunks: ProviderStreamChunk[] = [];
    const provider = new OpenAICompatibleProvider();
    for await (const chunk of provider.stream([], [], MODEL)) chunks.push(chunk);
    vi.unstubAllGlobals();

    expect(chunks.filter((chunk) => chunk.type !== 'done')).toEqual([
      { type: 'reasoning_delta', delta: 'canonical' },
      { type: 'text_delta', delta: 'A' },
      { type: 'text_delta', delta: 'B' },
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' });
  });

  it('yields text_delta chunks from SSE stream', async () => {
    const data1 = JSON.stringify({
      choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    });
    const data2 = JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody([`data: ${data1}`, `data: ${data2}`, 'data: [DONE]']),
      }),
    );

    const provider = new OpenAICompatibleProvider('https://api.openai.com/v1', 'test-key');
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], [], {
      model: 'gpt-4o',
    })) {
      chunks.push(chunk);
    }

    vi.unstubAllGlobals();

    expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'Hello')).toBe(true);
    const done = chunks.find((c) => c.type === 'done');
    expect(done).toBeDefined();
    expect((done as { type: 'done'; stopReason: string }).stopReason).toBe('stop');
  });

  it('yields tool_call chunks for tool calls', async () => {
    const data1 = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'tc1', type: 'function', function: { name: 'echo', arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    const data2 = JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"hi"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody([`data: ${data1}`, `data: ${data2}`, 'data: [DONE]']),
      }),
    );

    const provider = new OpenAICompatibleProvider('https://api.openai.com/v1', 'test-key');
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of provider.stream([], [], { model: 'gpt-4o' })) {
      chunks.push(chunk);
    }

    vi.unstubAllGlobals();

    expect(chunks.some((c) => c.type === 'tool_call_start')).toBe(true);
    expect(chunks.some((c) => c.type === 'tool_call_args_delta')).toBe(true);
  });

  it('captures usage from a separate final chunk with empty choices (real OpenAI format)', async () => {
    const textChunk = JSON.stringify({
      choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    });
    const finishChunk = JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    });
    const usageChunk = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseBody([
          `data: ${textChunk}`,
          `data: ${finishChunk}`,
          `data: ${usageChunk}`,
          'data: [DONE]',
        ]),
      }),
    );

    const provider = new OpenAICompatibleProvider('https://api.openai.com/v1', 'test-key');
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], [], {
      model: 'gpt-4o',
    })) {
      chunks.push(chunk);
    }
    vi.unstubAllGlobals();

    const done = chunks.find((c) => c.type === 'done');
    expect(done).toBeDefined();
    const doneChunk = done as {
      type: 'done';
      stopReason: string;
      usage?: { inputTokens: number; outputTokens: number };
    };
    expect(doneChunk.stopReason).toBe('stop');
    expect(doneChunk.usage).toBeDefined();
    expect(doneChunk.usage!.inputTokens).toBe(10);
    expect(doneChunk.usage!.outputTokens).toBe(5);
  });
});

describe('Provider interface: stream() contract', () => {
  it('Provider type has stream() but not complete() at interface level', () => {
    type HasStream = 'stream' extends keyof import('./Provider.js').Provider ? true : false;
    type NoComplete = 'complete' extends keyof import('./Provider.js').Provider ? true : false;
    type _AssertStream = HasStream extends true ? true : never;
    type _AssertNoComplete = NoComplete extends false ? true : never;
    const _streamCheck: _AssertStream = true;
    const _noCompleteCheck: _AssertNoComplete = true;
    expect(_streamCheck).toBe(true);
    expect(_noCompleteCheck).toBe(true);
  });
});
