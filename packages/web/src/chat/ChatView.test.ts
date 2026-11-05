import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';

// FakeWS harness (same as Thread.test.ts, transcribed from useToolStream.test.ts):
// the stream path needs a connectionId; the real useWebSocket module never
// connects in happy-dom so start() would error before fetching.
const mocks = vi.hoisted(() => ({
  connectionId: null as string | null,
  streamChunkHandler: null as ((chunk: { type: string; [k: string]: unknown }) => void) | null,
}));

vi.mock('../composables/useWebSocket.js', () => ({
  useWebSocket: () => ({
    getConnectionId: () => mocks.connectionId,
    onMessage: vi.fn((_handler: (msg: unknown) => void) => () => undefined),
    onStreamChunk: vi.fn(
      (_streamId: string, handler: (chunk: { type: string; [k: string]: unknown }) => void) => {
        mocks.streamChunkHandler = handler;
        return () => undefined;
      },
    ),
  }),
}));

vi.mock('../composables/useAuth.js', () => ({
  useAuth: () => ({ getToken: () => 'tok', participantId: { value: 'operator' } }),
}));

// Thread also opens a conversation-scoped watch_activity stream. Stub only that
// tool so the stream-count assertions below see just the communicate POST.
vi.mock('../composables/useToolStream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../composables/useToolStream.js')>();
  const { ref } = await import('vue');
  return {
    ...actual,
    useToolStream: (
      toolName: string,
      getArgs: () => unknown,
      options: { onChunk?: (chunk: unknown) => void },
    ) => {
      if (toolName !== 'watch_activity') return actual.useToolStream(toolName, getArgs, options);
      return {
        start: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        chunks: ref([]),
        done: ref(false),
        error: ref<string | null>(null),
        active: ref(false),
        cancelling: ref(false),
        conversationId: ref<string | null>(null),
        result: ref<unknown>(null),
      };
    },
  };
});

import ChatView from './ChatView.vue';
import Composer from './Composer.vue';
import { useParticipants } from '../composables/useParticipants.js';
import { useConversations } from '../composables/useConversations.js';
import { useApprovals } from '../composables/useApprovals.js';
import { useReadState } from '../composables/useReadState.js';
import type { BaseParticipant } from '@legion-collective/types';

const AGENTS: BaseParticipant[] = [
  { id: 'agent-a', name: 'Agent A', type: 'agent', tools: {} },
  { id: 'agent-b', name: 'Agent B', type: 'agent', tools: {} },
  { id: 'op', name: 'Operator', type: 'user', tools: {} },
];

// communicate over /api/execute: the sent-path needs the new conversation id;
// get_conversation/list_pending_approvals (post-replace reload + badge) get
// minimal success bodies so the replaced route mounts cleanly. list_participants
// serves the draft-flow mount-time load. The streaming shape (streamId) is
// served when the request carries X-Stream-Connection — Thread.send posts it.
function stubExecute(conversationId: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['X-Stream-Connection']) {
      return Promise.resolve(
        new Response(JSON.stringify({ streamId: 's1', conversationId }), { status: 200 }),
      );
    }
    let tool = '';
    try {
      tool = (JSON.parse(String(init?.body)) as { tool?: string }).tool ?? '';
    } catch {
      tool = '';
    }
    let data: unknown = {};
    if (tool === 'communicate') data = { conversationId };
    else if (tool === 'get_conversation') data = { id: conversationId, messages: [] };
    else if (tool === 'list_pending_approvals') data = [];
    else if (tool === 'list_conversations')
      data = {
        conversations: [
          {
            id: conversationId,
            title: 'Conv 1',
            status: 'active',
            tags: [],
            createdAt: '2026-10-09T00:00:00Z',
            updatedAt: '2026-10-09T00:00:00Z',
            participants: ['operator', 'agent-a'],
            messageCount: 2,
          },
        ],
      };
    // ChatView loads participants on mount (e2e product fix); without this the
    // stub's default {} branch makes participants.value a non-array.
    else if (tool === 'list_participants') data = AGENTS;
    return Promise.resolve(
      new Response(JSON.stringify({ result: { status: 'success', data } }), { status: 200 }),
    );
  });
}

function makeRouter(): ReturnType<typeof createRouter> {
  return createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/', redirect: '/chat' },
      { path: '/chat', component: ChatView },
      { path: '/chat/:id', component: ChatView },
      { path: '/login', component: { template: '<div />' } },
    ],
  });
}

describe('ChatView draft flow', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
    mocks.connectionId = 'conn-1';
    mocks.streamChunkHandler = null;
    useParticipants().__resetForTests();
    useParticipants().__setParticipantsForTests(AGENTS);
    useConversations().__resetForTests();
    useApprovals().__setPendingForTests([]);
    useReadState().__resetForTests();
  });

  it('shows recipient picker and composer on /chat with no id', async () => {
    vi.stubGlobal('fetch', stubExecute('new-conv'));
    const router = makeRouter();
    await router.push('/chat');
    await router.isReady();
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    expect(wrapper.find('[data-test="recipient-picker"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="composer"]').exists()).toBe(true);
  });

  it('routes to /chat/:id after the first send', async () => {
    const fetchMock = stubExecute('new-conv');
    vi.stubGlobal('fetch', fetchMock);
    const router = makeRouter();
    await router.push('/chat');
    await router.isReady();
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    await flushPromises();
    // Pick the draft recipient through the picker (send is a no-op without one).
    const pickerInput = wrapper.find('[data-test="recipient-picker"] input');
    await pickerInput.trigger('focus'); // opens the option list
    await pickerInput.setValue('agent');
    await wrapper.findAll('[data-test="recipient-picker"] [data-option]')[0].trigger('mousedown');
    await wrapper.find('[data-test="composer"] textarea').setValue('hello');
    await wrapper
      .find('[data-test="composer"] textarea')
      .trigger('keydown.enter', { key: 'Enter' });
    await flushPromises();
    // The first send streams through Thread's communicate POST — the same path
    // as any other send. The server-created id only arrives with the terminal
    // stream result, so feed the terminal chunk to the FakeWS handler.
    const streamCalls = fetchMock.mock.calls.filter((call) => {
      const headers = ((call[1] as RequestInit | undefined)?.headers ?? {}) as Record<
        string,
        string
      >;
      return headers['X-Stream-Connection'] !== undefined;
    }) as Array<[string, RequestInit]>;
    expect(streamCalls.length).toBe(1);
    expect(JSON.parse(String(streamCalls[0][1].body))).toEqual({
      tool: 'communicate',
      args: { to: 'agent-a', message: 'hello' },
    });
    mocks.streamChunkHandler?.({
      type: 'stream:done',
      result: { status: 'success', data: { conversationId: 'new-conv' } },
    });
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/chat/new-conv'));
    // The draft conversation id becomes the active one.
    expect(useConversations().activeId.value).toBe('new-conv');
  });

  it('streams the first send of a draft conversation (root-cause regression)', async () => {
    const fetchMock = stubExecute('new-conv');
    vi.stubGlobal('fetch', fetchMock);
    const router = makeRouter();
    await router.push('/chat');
    await router.isReady();
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    await flushPromises();
    const pickerInput = wrapper.find('[data-test="recipient-picker"] input');
    await pickerInput.trigger('focus'); // opens the option list
    await pickerInput.setValue('agent');
    await wrapper.findAll('[data-test="recipient-picker"] [data-option]')[0].trigger('mousedown');
    await wrapper.find('[data-test="composer"] textarea').setValue('hello');
    await wrapper
      .find('[data-test="composer"] textarea')
      .trigger('keydown.enter', { key: 'Enter' });
    await flushPromises();
    // FakeWS delivers a text_delta for the communicate stream: the reply must
    // render live in the (now always-mounted) Thread instead of the first
    // message falling back to a non-streaming execute.
    mocks.streamChunkHandler?.({ type: 'text_delta', delta: 'hi there' });
    await flushPromises();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="streaming-part"]').exists()).toBe(true),
    );
    expect(wrapper.find('[data-test="streaming-part"]').text()).toContain('hi there');
  });

  it('non-draft send routes through the streaming path, not a plain communicate execute', async () => {
    const fetchMock = stubExecute('conv-1');
    vi.stubGlobal('fetch', fetchMock);
    // The reply target derives from the active conversation's participants.
    useConversations().__setConversationsForTests([
      {
        id: 'conv-1',
        title: 'Conv 1',
        status: 'active',
        tags: [],
        createdAt: '2026-10-09T00:00:00Z',
        updatedAt: '2026-10-09T00:00:00Z',
        participants: ['operator', 'agent-a'],
        messageCount: 2,
      },
    ]);
    const router = makeRouter();
    await router.push('/chat/conv-1');
    await router.isReady();
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    // Wait for the mount-time loads (get_conversation + approvals + participants).
    await flushPromises();

    const area = wrapper.find('[data-test="composer"] textarea');
    expect(area.exists()).toBe(true);
    await area.setValue('second message');
    await area.trigger('keydown.enter', { key: 'Enter' });
    await flushPromises();

    // Exactly one fetch carried the streaming marker with the right args — the
    // send went through Thread.send's streaming POST, no duplicate communicate.
    const streamCalls = fetchMock.mock.calls.filter((call) => {
      const headers = ((call[1] as RequestInit | undefined)?.headers ?? {}) as Record<
        string,
        string
      >;
      return headers['X-Stream-Connection'] !== undefined;
    }) as Array<[string, RequestInit]>;
    expect(streamCalls.length).toBe(1);
    expect(JSON.parse(String(streamCalls[0][1].body))).toEqual({
      tool: 'communicate',
      args: { to: 'agent-a', message: 'second message', conversationId: 'conv-1' },
    });
    const plainCommunicate = fetchMock.mock.calls.filter((call) => {
      const headers = ((call[1] as RequestInit | undefined)?.headers ?? {}) as Record<
        string,
        string
      >;
      if (headers['X-Stream-Connection'] !== undefined) return false;
      try {
        const body = JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as {
          tool?: string;
        };
        return body.tool === 'communicate';
      } catch {
        return false;
      }
    });
    expect(plainCommunicate.length).toBe(0);
  });

  it('closes the mobile drawer when selecting a new conversation', async () => {
    vi.stubGlobal('fetch', stubExecute('conv-1'));
    const router = makeRouter();
    await router.push('/chat');
    await router.isReady();
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    await flushPromises();
    await wrapper.find('[data-test="drawer-toggle"]').trigger('click');
    expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(true);
    await wrapper.find('[data-test="new-conv"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(false);
  });

  it('closes the mobile drawer when the route returns to the draft', async () => {
    vi.stubGlobal('fetch', stubExecute('conv-1'));
    const router = makeRouter();
    await router.push('/chat/conv-1');
    await router.isReady();
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    await flushPromises();
    await wrapper.find('[data-test="drawer-toggle"]').trigger('click');
    expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(true);
    await router.push('/chat');
    await flushPromises();
    expect(wrapper.find('[data-test="drawer-backdrop"]').exists()).toBe(false);
  });

  it('falls back to a non-agent thread counterpart when the list is empty', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['X-Stream-Connection']) {
        return Promise.resolve(
          new Response(JSON.stringify({ streamId: 's1', conversationId: 'conv-3' }), {
            status: 200,
          }),
        );
      }
      const tool = (JSON.parse(String(init?.body ?? '{}')) as { tool?: string }).tool ?? '';
      let data: unknown = {};
      if (tool === 'get_conversation')
        data = {
          id: 'conv-3',
          messages: [
            {
              id: 'm1',
              parentId: null,
              conversationId: 'conv-3',
              senderId: 'operator',
              recipientId: 'svc-1',
              role: 'user',
              content: 'ping',
              timestamp: '2026-10-09T00:00:00Z',
              status: 'active',
            },
            {
              id: 'm2',
              parentId: 'm1',
              conversationId: 'conv-3',
              senderId: 'svc-1',
              recipientId: 'operator',
              role: 'assistant',
              content: 'pong',
              timestamp: '2026-10-09T00:00:01Z',
              status: 'active',
            },
          ],
        };
      else if (tool === 'list_conversations') data = { conversations: [] };
      else if (tool === 'list_pending_approvals') data = [];
      else if (tool === 'list_participants')
        data = [...AGENTS, { id: 'svc-1', name: 'Service', type: 'service', tools: {} }];
      return Promise.resolve(
        new Response(JSON.stringify({ result: { status: 'success', data } }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = makeRouter();
    await router.push('/chat/conv-3');
    await router.isReady();
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    await vi.waitFor(() =>
      expect(wrapper.findComponent(Composer).props('recipientId')).toBe('svc-1'),
    );
  });

  it('prefers the thread’s last counterpart for the reply target', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['X-Stream-Connection']) {
        return Promise.resolve(
          new Response(JSON.stringify({ streamId: 's1', conversationId: 'conv-2' }), {
            status: 200,
          }),
        );
      }
      const tool = (JSON.parse(String(init?.body ?? '{}')) as { tool?: string }).tool ?? '';
      let data: unknown = {};
      if (tool === 'get_conversation')
        data = {
          id: 'conv-2',
          messages: [
            {
              id: 'm1',
              parentId: null,
              conversationId: 'conv-2',
              senderId: 'operator',
              recipientId: 'agent-a',
              role: 'user',
              content: 'first',
              timestamp: '2026-10-09T00:00:00Z',
              status: 'active',
            },
            {
              id: 'm2',
              parentId: 'm1',
              conversationId: 'conv-2',
              senderId: 'agent-b',
              recipientId: 'operator',
              role: 'assistant',
              content: 'last',
              timestamp: '2026-10-09T00:00:01Z',
              status: 'active',
            },
          ],
        };
      else if (tool === 'list_conversations')
        data = {
          conversations: [
            {
              id: 'conv-2',
              title: 'Two agents',
              status: 'active',
              tags: [],
              createdAt: '2026-10-09T00:00:00Z',
              updatedAt: '2026-10-09T00:00:01Z',
              participants: ['operator', 'agent-a', 'agent-b'],
              messageCount: 2,
            },
          ],
        };
      else if (tool === 'list_pending_approvals') data = [];
      else if (tool === 'list_participants') data = AGENTS;
      return Promise.resolve(
        new Response(JSON.stringify({ result: { status: 'success', data } }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = makeRouter();
    await router.push('/chat/conv-2');
    await router.isReady();
    const wrapper = mount(ChatView, { global: { plugins: [router] } });
    await vi.waitFor(() =>
      expect(wrapper.findComponent(Composer).props('recipientId')).toBe('agent-b'),
    );
  });
});
