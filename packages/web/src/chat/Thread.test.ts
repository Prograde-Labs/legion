import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
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
});
