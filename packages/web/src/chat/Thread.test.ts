import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';

// FakeWS harness transcribed from composables/useToolStream.test.ts: Thread's
// stream path reads connectionId/token from useWebSocket/useAuth and registers
// a chunk handler via onStreamChunk.
const mocks = vi.hoisted(() => ({
  connectionId: null as string | null,
  token: null as string | null,
  streamChunkHandler: null as ((chunk: { type: string; [k: string]: unknown }) => void) | null,
  streamUnregister: vi.fn(),
}));

vi.mock('../composables/useWebSocket.js', () => ({
  useWebSocket: () => ({
    getConnectionId: () => mocks.connectionId,
    onMessage: vi.fn((_handler: (msg: unknown) => void) => () => undefined),
    onStreamChunk: vi.fn(
      (_streamId: string, handler: (chunk: { type: string; [k: string]: unknown }) => void) => {
        mocks.streamChunkHandler = handler;
        return mocks.streamUnregister;
      },
    ),
  }),
}));

vi.mock('../composables/useAuth.js', () => ({
  useAuth: () => ({ getToken: () => mocks.token }),
}));

import Thread from './Thread.vue';

const CHAIN = [
  {
    id: 'm1',
    role: 'user',
    content: 'list the files',
    timestamp: '2026-10-08T01:00:00Z',
    status: 'complete',
  },
  {
    id: 'm2',
    role: 'assistant',
    content: 'Here you go.',
    timestamp: '2026-10-08T01:00:05Z',
    status: 'complete',
    toolCalls: [{ id: 'tc1', name: 'mcp__filesystem__read_file', arguments: {} }],
    toolResults: [
      {
        id: 'tc1',
        name: 'mcp__filesystem__read_file',
        result: { status: 'success', data: 'file-a\nfile-b' },
      },
    ],
  },
];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: CHAIN } } }),
          { status: 200 },
        ),
      ),
  );
}

describe('Thread', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
    mocks.connectionId = 'conn-1';
    mocks.token = 'tok';
    mocks.streamChunkHandler = null;
    mocks.streamUnregister.mockReset();
    stubFetch();
  });

  it('renders text parts as markdown and tool calls as chips', async () => {
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));
    expect(wrapper.find('.md-content').exists()).toBe(true);
    const chip = wrapper.find('[data-test="tool-chip"]');
    expect(chip.text()).toContain('mcp__filesystem__read_file');
  });

  it('emits open(tool, payload) on chip click', async () => {
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    // vi.waitFor only retries on a thrown error in vitest 5 (a falsy return
    // resolves immediately), so use the throwing-assertion form (same as test 1).
    await vi.waitFor(() => expect(wrapper.find('[data-test="tool-chip"]').exists()).toBe(true));
    await wrapper.find('[data-test="tool-chip"]').trigger('click');
    expect(wrapper.emitted('open')?.[0]?.[0]).toBe('mcp__filesystem__read_file');
  });

  it('send() issues the streaming communicate POST, streams tokens, reloads on done', async () => {
    // First fetch = initial load (get_conversation). Second = the streaming
    // communicate POST issued by send() → stream.start().
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: CHAIN } } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ streamId: 's1', conversationId: 'c1' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));

    await (wrapper.vm as unknown as { send: (to: string, message: string) => Promise<void> }).send(
      'agent-a',
      'do the thing',
    );

    // The streaming POST: X-Stream-Connection header, communicate args from send().
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/execute');
    expect((init.headers as Record<string, string>)['X-Stream-Connection']).toBe('conn-1');
    expect(JSON.parse(String(init.body))).toEqual({
      tool: 'communicate',
      args: { to: 'agent-a', message: 'do the thing', conversationId: 'c1' },
    });

    // Chunks stream in: typing indicator visible, then cleared + reload on done.
    mocks.streamChunkHandler?.({ type: 'iteration_start' });
    mocks.streamChunkHandler?.({ type: 'text_delta', delta: 'work' });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="streaming-part"]').exists()).toBe(true),
    );
    mocks.streamChunkHandler?.({ type: 'stream:done', result: null });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="streaming-part"]').exists()).toBe(false),
    );
    // load() re-fetched after done (3rd call: get_conversation).
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    // Exposed streaming state settled back to false.
    await vi.waitFor(() => expect((wrapper.vm as { streaming?: boolean }).streaming).toBe(false));
  });

  it('exposes streaming=true while chunks arrive and cancelStream for Stop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: CHAIN } } }),
          { status: 200 },
        ),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ streamId: 's2', conversationId: 'c1' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));

    const vm = wrapper.vm as unknown as {
      send: (to: string, message: string) => Promise<void>;
      streaming?: boolean;
      cancelStream: () => Promise<void>;
    };
    expect(typeof vm.cancelStream).toBe('function');
    const pending = vm.send('agent-a', 'hello again');
    await vi.waitFor(() => expect(vm.streaming).toBe(true));
    mocks.streamChunkHandler?.({ type: 'iteration_start' });
    mocks.streamChunkHandler?.({ type: 'stream:done', result: null });
    await pending;
    await vi.waitFor(() => expect(vm.streaming).toBe(false));
  });
});
