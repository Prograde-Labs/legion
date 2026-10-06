import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIResponsesProvider } from './OpenAIResponsesProvider.js';
import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion-collective/types';
import type { ProviderMessage, ProviderStreamChunk, ProviderTool } from './Provider.js';

const MODEL: ModelConfig = { model: 'mock-model' };

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

type SseEvent = Record<string, unknown>;

function sse(
  events: SseEvent[],
  opts: { withDoneSentinel?: boolean } = {},
): { ok: true; status: number; body: ReadableStream<Uint8Array> } {
  const lines = events.map((e) => `data: ${JSON.stringify(e)}`);
  if (opts.withDoneSentinel) lines.push('data: [DONE]');
  return { ok: true, status: 200, body: makeSseBody(lines) };
}

function errResponse(status: number, text: string) {
  return { ok: false, status, text: () => Promise.resolve(text) };
}

function ev(type: string, extra: Record<string, unknown> = {}): SseEvent {
  return { type, ...extra };
}

function textCompleted(text: string, usage?: Record<string, unknown>): SseEvent[] {
  const events: SseEvent[] = [
    ev('response.created', { response: { id: 'resp_1' } }),
    ev('response.output_item.added', {
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: 'msg_0' },
    }),
    ev('response.output_text.delta', { item_id: 'msg_0', output_index: 0, delta: text }),
    ev('response.output_text.done', { item_id: 'msg_0', output_index: 0, text }),
    ev('response.output_item.done', {
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: 'msg_0' },
    }),
  ];
  const response: Record<string, unknown> = { id: 'resp_1' };
  if (usage) response['usage'] = usage;
  events.push(ev('response.completed', { response }));
  return events;
}

function completedOnly(usage?: Record<string, unknown>): SseEvent {
  const response: Record<string, unknown> = { id: 'resp_1' };
  if (usage) response['usage'] = usage;
  return ev('response.completed', { response });
}

interface Collected {
  reasoning: string[];
  text: string[];
  toolStarts: Array<{ index: number; id: string; name: string }>;
  toolArgs: Array<{ index: number; delta: string }>;
  done: Extract<ProviderStreamChunk, { type: 'done' }> | null;
}

async function drain(
  provider: OpenAIResponsesProvider,
  messages: ProviderMessage[],
  tools: ProviderTool[] = [],
  model: ModelConfig = MODEL,
): Promise<Collected> {
  const out: Collected = { reasoning: [], text: [], toolStarts: [], toolArgs: [], done: null };
  for await (const chunk of provider.stream(messages, tools, model)) {
    if (chunk.type === 'reasoning_delta') out.reasoning.push(chunk.delta);
    else if (chunk.type === 'text_delta') out.text.push(chunk.delta);
    else if (chunk.type === 'tool_call_start')
      out.toolStarts.push({ index: chunk.index, id: chunk.id, name: chunk.name });
    else if (chunk.type === 'tool_call_args_delta')
      out.toolArgs.push({ index: chunk.index, delta: chunk.delta });
    else if (chunk.type === 'done') out.done = chunk;
  }
  return out;
}

describe('OpenAIResponsesProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to {baseUrl}/responses with instructions, input items, store:false, stream:true', async () => {
    fetchMock.mockResolvedValue(sse(textCompleted('Hello!'), { withDoneSentinel: true }));

    const provider = new OpenAIResponsesProvider('https://example.test/v1/', 'sk-key');
    const result = await drain(provider, [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/responses');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-key',
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('mock-model');
    expect(body['instructions']).toBe('Be terse.');
    expect(body['input']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(true);
    expect(body['tools']).toBeUndefined();
    expect(body['tool_choice']).toBeUndefined();
    expect(body['previous_response_id']).toBeUndefined();
    expect(body['reasoning']).toBeUndefined();

    expect(result.text).toEqual(['Hello!']);
    expect(result.done?.stopReason).toBe('stop');
    expect(result.done?.usage).toBeUndefined();
  });

  it('maps temperature and maxTokens to temperature and max_output_tokens', async () => {
    fetchMock.mockResolvedValue(sse([completedOnly()]));

    const provider = new OpenAIResponsesProvider('https://example.test/v1');
    await drain(provider, [{ role: 'user', content: 'hi' }], [], {
      model: 'mock-model',
      temperature: 0.3,
      maxTokens: 256,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['temperature']).toBe(0.3);
    expect(body['max_output_tokens']).toBe(256);
  });

  it('maps assistant text and tool history to typed input items', async () => {
    fetchMock.mockResolvedValue(sse([completedOnly()]));

    const provider = new OpenAIResponsesProvider('https://example.test/v1');
    await drain(provider, [
      { role: 'system', content: 'sys one' },
      { role: 'system', content: 'sys two' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'x' } }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'echo', content: '{"ok":true}' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['instructions']).toBe('sys one');
    expect(body['input']).toEqual([
      { role: 'system', content: 'sys two' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"text":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ]);
  });

  it('maps terminal usage fields to ProviderUsage', async () => {
    fetchMock.mockResolvedValue(
      sse([
        ev('response.output_item.added', {
          output_index: 0,
          item: { type: 'message', id: 'msg_0' },
        }),
        ev('response.output_text.delta', { delta: 'hi' }),
        completedOnly({
          input_tokens: 100,
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 7 },
          input_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
        }),
      ]),
    );

    const provider = new OpenAIResponsesProvider('https://example.test/v1');
    const result = await drain(provider, [{ role: 'user', content: 'hi' }]);

    expect(result.done?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 7,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 3,
    });
  });

  it('throws ProviderError on non-OK HTTP', async () => {
    fetchMock.mockResolvedValue(errResponse(404, '{"error":{"message":"no route"}}'));

    const provider = new OpenAIResponsesProvider('https://example.test/v1');
    await expect(drain(provider, [{ role: 'user', content: 'hi' }])).rejects.toThrow(ProviderError);
  });
});
