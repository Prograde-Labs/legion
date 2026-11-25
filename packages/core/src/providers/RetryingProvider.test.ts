import timers from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRetryConfig } from '@legion-collective/types';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { SystemProviderStore } from './SystemProviderStore.js';

const failed = {
  type: 'response.failed',
  response: { error: { code: 'rate_limit_exceeded', message: 'TPM' } },
};
const success = [
  { type: 'response.output_text.delta', delta: 'hello' },
  { type: 'response.completed' },
];

function stream(...events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

async function setup(retry?: ProviderRetryConfig, signal?: AbortSignal) {
  const store = new SystemProviderStore(new MemoryStorage());
  await store.save({ name: 'test', type: 'openai-responses', priority: 1, retry });
  const provider = (await store.get('test'))!;
  return provider.stream([{ role: 'user', content: 'hi' }], [], { model: 'test' }, { signal });
}

describe('inference retries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('repeats the same request for an admission failure and yields the successful output once', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(stream(failed))
      .mockResolvedValueOnce(stream(...success));
    vi.stubGlobal('fetch', fetch);
    const gen = await setup({ baseDelayMs: 1 });
    const chunks = [];
    for await (const chunk of gen) chunks.push(chunk);
    expect(chunks.map((c) => c.type)).toEqual(['text_delta', 'done']);
    expect(chunks[0]).toEqual({ type: 'text_delta', delta: 'hello' });
    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);
  });

  it.each([
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.reasoning_text.delta', delta: 'partial' },
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: '1', name: 'echo' },
    },
    { type: 'response.function_call_arguments.delta', delta: '{' },
  ])('does not replay a request after $type', async (event) => {
    const fetch = vi.fn().mockResolvedValueOnce(stream(event, failed));
    vi.stubGlobal('fetch', fetch);
    const gen = await setup();
    expect((await gen.next()).done).toBe(false);
    await expect(gen.next()).rejects.toThrow('rate_limit_exceeded');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, 4],
    [0, 1],
    [1, 2],
  ] as const)(
    'exhausts a budget of %s and propagates the last error',
    async (maxRetries, attempts) => {
      let calls = 0;
      const fetch = vi.fn(async () => new Response(`overloaded ${++calls}`, { status: 503 }));
      vi.stubGlobal('fetch', fetch);
      const gen = await setup({
        ...(maxRetries === undefined ? {} : { maxRetries }),
        baseDelayMs: 1,
      });
      await expect(gen.next()).rejects.toThrow(`overloaded ${attempts}`);
      expect(fetch).toHaveBeenCalledTimes(attempts);
    },
  );

  it('waits for the capped Retry-After before issuing a new request', async () => {
    const sleep = vi.spyOn(timers, 'setTimeout').mockResolvedValue(undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('busy', { status: 429, headers: { 'Retry-After': '15' } }),
      )
      .mockResolvedValueOnce(stream(...success));
    vi.stubGlobal('fetch', fetch);
    const gen = await setup({ maxDelayMs: 8000 });
    expect((await gen.next()).value).toEqual({ type: 'text_delta', delta: 'hello' });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([8000]);
    await gen.return(undefined);
  });

  it('backs off exponentially with full jitter up to the provider ceiling', async () => {
    const sleep = vi.spyOn(timers, 'setTimeout').mockResolvedValue(undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let calls = 0;
    vi.stubGlobal('fetch', async () => (++calls < 4 ? stream(failed) : stream(...success)));
    const gen = await setup({ baseDelayMs: 100, maxDelayMs: 300 });
    expect((await gen.next()).value).toEqual({ type: 'text_delta', delta: 'hello' });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([50, 100, 150]);
    await gen.return(undefined);
  });

  it('cancels during backoff without making another attempt', async () => {
    const sleep = vi.spyOn(timers, 'setTimeout');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('busy', { status: 429, headers: { 'Retry-After': '30' } }),
      );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const gen = await setup(undefined, controller.signal);
    const result = expect(gen.next()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    controller.abort();
    await result;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
