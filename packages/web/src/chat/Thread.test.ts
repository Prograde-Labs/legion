import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

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

// Compact action is gated by Cluster A's tool-access gate (Task 2 cross-cluster
// dependency): same vi.mock pattern as MessageActions.test.ts / ForkControls.test.ts.
vi.mock('../composables/useToolAccess.js', () => ({ useToolAccess: vi.fn() }));

import Thread from './Thread.vue';
import { useToolAccess } from '../composables/useToolAccess.js';
import { useParticipants } from '../composables/useParticipants.js';
import type { BaseParticipant } from '@legion-collective/types';

const AGENTS: BaseParticipant[] = [
  {
    id: 'user-1',
    name: 'operator',
    type: 'user',
    tools: {},
  },
  {
    id: 'agent-a',
    name: 'Agent A',
    type: 'agent',
    tools: {},
    status: 'active',
  },
];

function mockCan(can: (tool: string) => 'auto' | 'requires_approval' | 'hidden'): void {
  vi.mocked(useToolAccess).mockReturnValue({ can } as never);
}

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
    mockCan(() => 'auto');
    useParticipants().__resetForTests();
    useParticipants().__setParticipantsForTests(AGENTS);
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

  it('accumulates reasoning deltas into the streaming part', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: CHAIN } } }),
          { status: 200 },
        ),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ streamId: 's1', conversationId: 'c1' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));

    await (wrapper.vm as unknown as { send: (to: string, message: string) => Promise<void> }).send(
      'agent-a',
      'think then reply',
    );

    mocks.streamChunkHandler?.({ type: 'iteration_start' });
    mocks.streamChunkHandler?.({ type: 'reasoning_delta', delta: 'step 1 ' });
    mocks.streamChunkHandler?.({ type: 'reasoning_delta', delta: 'step 2' });

    // Live reasoning accumulates in the streaming part's forced-open disclosure:
    // streamingReasoning flows into MessagePart's reasoning prop, and the
    // `streaming` flag renders ReasoningDisclosure's open (non-details) branch
    // marked data-streaming-reasoning.
    await vi.waitFor(() =>
      expect(
        wrapper
          .get('[data-test="streaming-part"]')
          .find('[data-reasoning][data-streaming-reasoning]')
          .exists(),
      ).toBe(true),
    );
    expect(
      wrapper
        .get('[data-test="streaming-part"]')
        .find('[data-reasoning][data-streaming-reasoning]')
        .text(),
    ).toContain('step 1 step 2');
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

  it('emits created with the server conversation id after a draft send completes', async () => {
    // Draft mount: conversationId null, so the only fetch is the streaming POST.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ streamId: 's3' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Thread, { props: { conversationId: null } });
    await flushPromises();

    await (wrapper.vm as unknown as { send: (to: string, message: string) => Promise<void> }).send(
      'agent-a',
      'hello',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      tool: 'communicate',
      args: { to: 'agent-a', message: 'hello' },
    });

    // Terminal chunk carries the full ToolResult; the created id is in its data.
    mocks.streamChunkHandler?.({
      type: 'stream:done',
      result: { status: 'success', data: { conversationId: 'new-conv' } },
    });
    await flushPromises();
    expect(wrapper.emitted('created')?.[0]).toEqual(['new-conv']);
  });

  it('does not emit created for an existing conversation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: CHAIN } } }),
          { status: 200 },
        ),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ streamId: 's4', conversationId: 'c1' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));

    const pending = (
      wrapper.vm as unknown as { send: (to: string, message: string) => Promise<void> }
    ).send('agent-a', 'again');
    mocks.streamChunkHandler?.({
      type: 'stream:done',
      result: { status: 'success', data: { conversationId: 'c1' } },
    });
    await pending;
    await flushPromises();
    expect(wrapper.emitted('created')).toBeUndefined();
  });

  it('highlights persisted messages by id only, never by recipientId', async () => {
    // Outbound copy of a freshly-persisted draft send (senderId = self,
    // recipientId = the agent). Highlighting matches by message id ONLY: an
    // outboundMessageId sitting in the recipient id-space must not ring the
    // message (the removed carry-across clause compared recipientId against
    // ChatView's literal 'streaming-outbound', which is never a real id).
    const chain = [
      {
        id: 'mo',
        role: 'user',
        content: 'hello agent',
        senderId: 'user-1',
        recipientId: 'agent-a',
        timestamp: '2026-10-08T01:00:00Z',
        status: 'complete',
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: chain } } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Thread, {
      props: { conversationId: 'c1', highlight: { outboundMessageId: 'agent-a' } },
    });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));
    expect(wrapper.find('[data-highlight="true"]').exists()).toBe(false);

    // The id-match contract is unchanged: a real message id still rings.
    await wrapper.setProps({ highlight: { outboundMessageId: 'mo' } });
    expect(wrapper.find('[data-highlight="true"]').exists()).toBe(true);
  });

  it('compacts the active conversation from the thread header', async () => {
    // Fresh Response per call — a shared mockResolvedValue Response's body is
    // single-read (res.json() disturbs it), so each fetch needs its own.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: CHAIN } } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { status: 'success', data: {} } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: [] } } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));

    await wrapper.find('[data-test="compact-btn"]').trigger('click');
    expect(wrapper.find('[data-test="compact-confirm"]').exists()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // confirm step comes first — no API call yet

    await wrapper.find('[data-test="compact-confirm"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3); // compact POST + post-compact reload
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/execute?stream=false');
    const body = JSON.parse(String(init.body));
    expect(body.tool).toBe('compact_conversation');
    expect(body.args.conversationId).toBe('c1');
    expect(body.args.messageIds).toEqual(['m1', 'm2']);
    expect(body.args.agentId).toBe('agent-a');
    // Third call reloads the thread after compaction.
    const [reloadUrl, reloadInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(reloadUrl).toBe('/api/execute?stream=false');
    expect(JSON.parse(String(reloadInit.body)).tool).toBe('get_conversation');
    expect(wrapper.find('[data-test="compact-btn"]').exists()).toBe(true); // confirm UI reset
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(false));
  });

  it('hides the compact action when access is not auto', async () => {
    mockCan(() => 'hidden');
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));
    expect(wrapper.find('[data-test="compact-btn"]').exists()).toBe(false);
  });

  it('compacts without an agentId and surfaces the backend error when no active agent exists', async () => {
    useParticipants().__resetForTests(); // no participants → no agent summarizer
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { status: 'success', data: { id: 'c1', messages: CHAIN } } }),
          { status: 200 },
        ),
      )
      // compact POST returns a tool error (backend rejects agentId-less manual
      // compaction) — the raw error must surface in the thread error banner.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { status: 'error', error: 'Summary agent did not complete' } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(Thread, { props: { conversationId: 'c1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="msg"]').exists()).toBe(true));

    await wrapper.find('[data-test="compact-btn"]').trigger('click');
    await wrapper.find('[data-test="compact-confirm"]').trigger('click');
    await flushPromises();

    const body = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(body.args.agentId).toBeUndefined();
    expect(body.args.messageIds).toEqual(['m1', 'm2']);
    expect(wrapper.find('[data-test="thread-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="thread-error"]').text()).toContain(
      'Summary agent did not complete',
    );
  });
});
