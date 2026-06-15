import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion/types';

const MODEL: ModelConfig = { provider: 'openai-compatible', model: 'gpt-4o-mini' };

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

  it('sends a well-formed chat completion request and maps a text response', async () => {
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

    const provider = new OpenAICompatibleProvider();
    const result = await provider.complete([{ role: 'user', content: 'hi' }], [], MODEL);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/chat/completions');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o-mini');
    expect((body['messages'] as unknown[]).length).toBe(1);
    expect(body['tools']).toBeUndefined();

    expect(result.content).toBe('Hello!');
    expect(result.stopReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage?.promptTokens).toBe(10);
    expect(result.usage?.completionTokens).toBe(5);
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
});
