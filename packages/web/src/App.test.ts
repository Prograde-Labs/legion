import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createWebHashHistory } from 'vue-router';
import type { BaseParticipant, ConversationMeta } from '@legion-collective/types';
import App from './App.vue';
import { useAuth } from './composables/useAuth.js';
import { useApprovals } from './composables/useApprovals.js';
import { useParticipants } from './composables/useParticipants.js';
import { useConversations } from './composables/useConversations.js';
import { useReadState } from './composables/useReadState.js';

// App.vue calls connect/disconnect; AppShell and the module stores reach the
// same singleton through useLegionApi/useToolStream, so the fake must expose
// the whole surface they touch.
vi.mock('./composables/useWebSocket.js', () => ({
  useWebSocket: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnectionId: () => null,
    onMessage: () => () => undefined,
    onStreamChunk: () => () => undefined,
  }),
}));

const PARTICIPANTS: BaseParticipant[] = [{ id: 'agent-a', name: 'A', type: 'agent', tools: {} }];

const CONVS: ConversationMeta[] = [
  {
    id: 'c1',
    title: 'First',
    participants: ['operator', 'agent-a'],
    status: 'active',
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    tags: [],
    messageCount: 1,
  },
];

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuth().logout();
    useApprovals().reset();
    useParticipants().reset();
    useReadState().reset();
  });

  it('clears module stores when the session ends', async () => {
    const router = createRouter({
      history: createWebHashHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/chat', component: { template: '<div />' } },
        { path: '/participants', component: { template: '<div />' } },
        { path: '/processes', component: { template: '<div />' } },
        { path: '/config', component: { template: '<div />' } },
        { path: '/login', component: { template: '<div />' } },
      ],
    });
    await router.push('/');
    await router.isReady();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'tok', participantId: 'p1', expiresAt: 9999999999 }),
    } as Response);
    await useAuth().login('op', 'pw');

    // Mount first: useConversations() registers its module-level stream watch
    // inside App's setup, so the lifecycle hooks bind to the component.
    const wrapper = mount(App, { global: { plugins: [router] } });

    useApprovals().__setPendingForTests([{ conversationId: 'c1' }]);
    useParticipants().__setParticipantsForTests(PARTICIPANTS);
    useConversations().__setConversationsForTests(CONVS);
    useConversations().select('c1');
    useReadState().markRead('c1');

    expect(useApprovals().pendingCount.value).toBe(1);
    expect(useParticipants().participants.value).toHaveLength(1);
    expect(useConversations().conversations.value).toHaveLength(1);

    useAuth().logout();
    await flushPromises();

    expect(useApprovals().pending.value).toHaveLength(0);
    expect(useParticipants().participants.value).toHaveLength(0);
    expect(useConversations().conversations.value).toHaveLength(0);
    expect(useConversations().activeId.value).toBeNull();
    expect(useReadState().isUnread('c1', '2026-01-01T00:00:00Z')).toBe(true);
    wrapper.unmount();
  });
});
