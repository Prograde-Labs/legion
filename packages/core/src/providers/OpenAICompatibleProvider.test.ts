import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion/types';

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
      makeOkResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'Hello!', tool_calls: null },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const provider = new OpenAICompatibleProvider('https://example.test/v1/', 'constructor-key');
    const result = await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

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

    expect(result.content).toBe('Hello!');
    expect(result.stopReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it('does not read API keys from environment variables', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    fetchMock.mockResolvedValue(
      makeOkResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'Hello!', tool_calls: null },
            finish_reason: 'stop',
          },
        ],
      }),
    );

    const provider = new OpenAICompatibleProvider('https://example.test/v1');
    await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toMatchObject({ Authorization: 'Bearer env-key' });
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('maps a tool_calls response to ProviderToolCall[]', async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'echo', arguments: '{"text":"hello world"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await provider.complete([], [], MODEL);

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
      makeOkResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'ok', tool_calls: null },
            finish_reason: 'stop',
          },
        ],
      }),
    );

    const provider = new OpenAICompatibleProvider();
    await provider.complete(
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

  it('throws ProviderError on a non-ok HTTP response', async () => {
    fetchMock.mockResolvedValue(makeErrResponse(401, 'Unauthorized'));
    const provider = new OpenAICompatibleProvider();
    await expect(provider.complete([], [], MODEL)).rejects.toThrow(ProviderError);
    await expect(provider.complete([], [], MODEL)).rejects.toThrow(/401/);
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
      makeOkResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'thinking...', tool_calls: null },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 2006,
          completion_tokens: 300,
          total_tokens: 2306,
          prompt_tokens_details: { cached_tokens: 1920 },
          completion_tokens_details: { reasoning_tokens: 50 },
        },
      }),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

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
      makeOkResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'hi', tool_calls: null },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
        },
      }),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

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
      makeOkResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'no usage', tool_calls: null },
            finish_reason: 'stop',
          },
        ],
      }),
    );

    const provider = new OpenAICompatibleProvider();
    const result = await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

    expect(result.usage).toBeUndefined();
  });
});

describe('Provider interface: stream() contract', () => {
  it('Provider type has stream() but not complete() at interface level', () => {
    // Compile-time assertions — file fails to compile if these don't hold
    type HasStream = 'stream' extends keyof import('./Provider.js').Provider ? true : false;
    type NoComplete = 'complete' extends keyof import('./Provider.js').Provider ? true : false;
    // Conditional types that resolve to `never` if the assertion fails, causing a compile error
    type _AssertStream = HasStream extends true ? true : never;
    type _AssertNoComplete = NoComplete extends false ? true : never;
    // Assign to consts used in expect() so they're not unused
    const _streamCheck: _AssertStream = true;
    const _noCompleteCheck: _AssertNoComplete = true;
    expect(_streamCheck).toBe(true);
    expect(_noCompleteCheck).toBe(true);
  });
});
