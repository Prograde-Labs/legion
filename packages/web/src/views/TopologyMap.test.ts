import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import TopologyMap from './TopologyMap.vue';
import { useParticipants } from '../composables/useParticipants.js';

const wsMocks = vi.hoisted(() => ({
  connectionId: 'conn-1' as string | null,
  streamChunkHandler: null as
    ((chunk: { type: string; data?: Record<string, unknown> }) => void) | null,
}));

// useToolStream requires a token; the module-level useLocalStorage refs are
// captured at import time, so stub auth rather than seeding localStorage.
vi.mock('../composables/useAuth.js', () => ({
  useAuth: () => ({ getToken: () => 'tok' }),
}));

vi.mock('../composables/useWebSocket.js', () => ({
  useWebSocket: () => ({
    getConnectionId: () => wsMocks.connectionId,
    onMessage: () => () => undefined,
    onStreamChunk: (
      _streamId: string,
      handler: (chunk: { type: string; data?: Record<string, unknown> }) => void,
    ) => {
      wsMocks.streamChunkHandler = handler;
      return () => undefined;
    },
  }),
}));

const PARTICIPANTS = [
  { id: 'agent-a', name: 'Agent A', type: 'agent', status: 'active', tools: {} },
  { id: 'agent-b', name: 'Agent B', type: 'agent', status: 'active', tools: {} },
  { id: 'operator', name: 'Operator', type: 'user', status: 'active', tools: {} },
];

const MCP = [{ name: 'filesystem', command: 'npx' }];

/** Serve the MCP load and the watch_activity stream POST from one mock. */
function stubExecute(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { tool?: string };
    if (body.tool === 'watch_activity') {
      return new Response(JSON.stringify({ streamId: 'activity', conversationId: '' }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ result: { status: 'success', data: MCP } }), {
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('TopologyMap', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
    useParticipants().__setParticipantsForTests(PARTICIPANTS as never);
    wsMocks.connectionId = 'conn-1';
    wsMocks.streamChunkHandler = null;
  });

  it('renders one node per participant and per MCP source', async () => {
    stubExecute();
    const wrapper = mount(TopologyMap);
    // Ledger (test 1 adaptation): verbatim waitFor predicate was toBeGreaterThan(0),
    // which passed synchronously on the 3 participant nodes before the async MCP
    // load landed (one macrotask later) — making the toBe(4) assertion below fail
    // deterministically. Predicate tightened to toBe(4): same assertion, same intent.
    await vi.waitFor(() => expect(wrapper.findAll('[data-test="topo-node"]').length).toBe(4));
    // 3 participant nodes + 1 mcp node
    expect(wrapper.findAll('[data-test="topo-node"]').length).toBe(4);
  });

  it('clicking a node emits select', async () => {
    stubExecute();
    const wrapper = mount(TopologyMap);
    await vi.waitFor(() => wrapper.find('[data-test="topo-node"]').exists());
    await wrapper.findAll('[data-test="topo-node"]')[0].trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['agent-a']);
  });

  it('activates a node with Enter and Space for keyboard users', async () => {
    stubExecute();
    const wrapper = mount(TopologyMap);
    await vi.waitFor(() => wrapper.find('[data-test="topo-node"]').exists());
    const node = wrapper.findAll('[data-test="topo-node"]')[0];
    expect(node.attributes('tabindex')).toBe('0');

    await node.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')?.[0]).toEqual(['agent-a']);

    await node.trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('select')?.[1]).toEqual(['agent-a']);
  });

  it('tool:call chunks from the activity stream add a transient edge', async () => {
    stubExecute();
    const wrapper = mount(TopologyMap);
    await vi.waitFor(() => wrapper.find('[data-test="topo-node"]').exists());
    await vi.waitFor(() => expect(wsMocks.streamChunkHandler).not.toBeNull());

    wsMocks.streamChunkHandler?.({
      type: 'tool:call',
      data: { conversationId: 'c1', participantId: 'agent-a', tool: 'communicate' },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-test="topo-edge"]').length).toBeGreaterThan(0);
  });
});
