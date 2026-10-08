import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import ChatView from './ChatView.vue';
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
// minimal success bodies so the replaced route mounts cleanly.
function stubExecute(conversationId: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
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
    useParticipants().__resetForTests();
    useParticipants().__setParticipantsForTests(AGENTS);
    useConversations().__resetForTests();
    useApprovals().__setPendingForTests([]);
    useReadState().__resetForTests();
  });

  it('shows recipient picker and composer on /chat with no id', async () => {
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
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/chat/new-conv'));
    // The draft conversation id becomes the active one.
    expect(useConversations().activeId.value).toBe('new-conv');
  });
});
