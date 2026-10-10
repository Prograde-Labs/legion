import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import TopologyMap from './TopologyMap.vue';
import { useParticipants } from '../composables/useParticipants.js';

const PARTICIPANTS = [
  { id: 'agent-a', name: 'Agent A', type: 'agent', status: 'active', tools: {} },
  { id: 'agent-b', name: 'Agent B', type: 'agent', status: 'active', tools: {} },
  { id: 'operator', name: 'Operator', type: 'user', status: 'active', tools: {} },
];

const MCP = [{ name: 'filesystem', command: 'npx' }];

describe('TopologyMap', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
    useParticipants().__setParticipantsForTests(PARTICIPANTS as never);
  });

  it('renders one node per participant and per MCP source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'success', data: MCP } }), {
          status: 200,
        }),
      ),
    );
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'success', data: MCP } }), {
          status: 200,
        }),
      ),
    );
    const wrapper = mount(TopologyMap);
    await vi.waitFor(() => wrapper.find('[data-test="topo-node"]').exists());
    await wrapper.findAll('[data-test="topo-node"]')[0].trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['agent-a']);
  });

  it('activity events add a transient edge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'success', data: MCP } }), {
          status: 200,
        }),
      ),
    );
    const wrapper = mount(TopologyMap);
    await vi.waitFor(() => wrapper.find('[data-test="topo-node"]').exists());
    (
      wrapper.vm as unknown as { __handleActivityForTests: (a: unknown) => void }
    ).__handleActivityForTests({
      conversationId: 'c1',
      participantId: 'agent-a',
      tool: 'communicate',
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-test="topo-edge"]').length).toBeGreaterThan(0);
  });
});
