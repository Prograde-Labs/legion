import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { MessageData } from '@legion-collective/types';
import DockPanel from './DockPanel.vue';
import { useDock, registerPanel } from './registry.js';

// CommunicatePanel embeds the real Thread, which pulls useLegionApi for
// get_conversation (and approvals event wiring). Mock the API layer so the
// dock-level test drives Thread through the same executeMock.
const executeMock = vi.hoisted(() => vi.fn());

vi.mock('../composables/useLegionApi.js', () => ({
  useLegionApi: () => ({
    execute: executeMock,
    onEvent: () => () => undefined,
  }),
}));

function mkMsg(overrides: Partial<MessageData> = {}): MessageData {
  return {
    id: 'm1',
    parentId: null,
    conversationId: 'c1',
    senderId: 'user-1',
    recipientId: 'agent-a',
    role: 'user',
    content: 'hi',
    timestamp: '2026-10-13T00:00:00Z',
    status: 'active',
    ...overrides,
  };
}

function mountDockWithPanel(tab: { kind: 'communicate'; payload: Record<string, unknown> }) {
  const dock = useDock();
  dock.setConversation('c1');
  dock.open({
    kind: tab.kind,
    title: '@subchat',
    icon: '💬',
    payload: tab.payload,
  });
  return mount(DockPanel);
}

const Fake = { template: '<div data-test="fake-panel">fake</div>' };

describe('DockPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    useDock().__resetForTests();
  });

  it('renders the tab strip with titles and closes on ×', async () => {
    registerPanel('mystery_tool', { component: Fake, title: () => 'Mystery' });
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({
      kind: 'tool-detail',
      title: 'Mystery',
      icon: '🔧',
      payload: { tool: 'mystery_tool' },
    });
    dock.open({
      kind: 'tool-detail',
      title: 'Second',
      icon: '🔧',
      payload: { tool: 'other_tool' },
    });
    const wrapper = mount(DockPanel);
    const tabs = wrapper.findAll('[data-test="dock-tab"]');
    expect(tabs.length).toBe(2);
    expect(tabs[0].text()).toContain('Mystery');
    await wrapper.findAll('[data-test="dock-tab-close"]')[0].trigger('click');
    expect(useDock().tabs.value.length).toBe(1);
  });

  it('renders the active panel component', () => {
    registerPanel('mystery_tool', { component: Fake, title: () => 'Mystery' });
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({
      kind: 'tool-detail',
      title: 'Mystery',
      icon: '🔧',
      payload: { tool: 'mystery_tool' },
    });
    const wrapper = mount(DockPanel);
    expect(wrapper.find('[data-test="fake-panel"]').exists()).toBe(true);
  });

  it('narrow viewport: dock container carries the fixed overlay classes', () => {
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({
      kind: 'tool-detail',
      title: 'Mystery',
      icon: '🔧',
      payload: { tool: 'mystery_tool' },
    });
    const wrapper = mount(DockPanel);
    const root = wrapper.find('[data-test="dock-root"]');
    expect(root.classes().some((c) => c.startsWith('max-md:fixed'))).toBe(true);
  });

  // Task 13: the chip payload carries { tool, args, result } — the NEW
  // conversation id arrives in result.data.conversationId (args carries one
  // only when the side-conversation already existed), so CommunicatePanel must
  // resolve from either location before mounting the embedded Thread.
  it('resolves the subchat conversation id from args or result', async () => {
    executeMock.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'get_conversation')
        return {
          id: args['conversationId'],
          messages: [mkMsg({ id: 'm1', content: 'subchat line' })],
        };
      return undefined;
    });
    const w = mountDockWithPanel({
      kind: 'communicate',
      payload: {
        tool: 'communicate',
        args: { to: 'researcher', message: 'go' },
        result: { status: 'success', data: { conversationId: 'sub-1' } },
      },
    });
    await flushPromises();
    expect(executeMock).toHaveBeenCalledWith(
      'get_conversation',
      expect.objectContaining({ conversationId: 'sub-1' }),
    );
    expect(w.text()).toContain('subchat line');
  });

  it('shows a placeholder when no conversation id can be resolved', () => {
    const w = mountDockWithPanel({
      kind: 'communicate',
      payload: { tool: 'communicate', args: { to: 'x' }, result: null },
    });
    expect(w.find('[data-test="subchat-empty"]').exists()).toBe(true);
  });
});
