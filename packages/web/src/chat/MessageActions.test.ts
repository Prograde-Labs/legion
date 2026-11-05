import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import MessageActions from './MessageActions.vue';
import { useToolAccess } from '../composables/useToolAccess.js';
import { useParticipants } from '../composables/useParticipants.js';
import type { BaseParticipant } from '@legion-collective/types';

vi.mock('../composables/useToolAccess.js', () => ({ useToolAccess: vi.fn() }));

const message = { id: 'm1', content: 'hello world' };

const PARTICIPANTS: BaseParticipant[] = [
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

function okFetch(): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'success', data: {} } }), { status: 200 }),
    );
}

describe('MessageActions', () => {
  beforeEach(() => {
    mockCan(() => 'auto');
    useParticipants().__resetForTests();
    useParticipants().__setParticipantsForTests(PARTICIPANTS);
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
  });

  it('edit flow calls edit_message with the new content and emits mutated', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(MessageActions, { props: { conversationId: 'c1', message } });
    await wrapper.find('[data-test="actions-toggle"]').trigger('click');
    await wrapper.find('[data-test="action-edit"]').trigger('click');
    await wrapper.find('[data-test="edit-textarea"]').setValue('rewritten');
    await wrapper.find('[data-test="edit-save"]').trigger('click');
    await flushPromises(); // emit('mutated') fires after execute()'s fetch + json microtasks
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tool).toBe('edit_message');
    expect(body.args.newContent).toBe('rewritten');
    expect(wrapper.emitted('mutated')).toBeTruthy();
  });

  it('prune asks for confirmation then calls prune_message', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(MessageActions, { props: { conversationId: 'c1', message } });
    await wrapper.find('[data-test="actions-toggle"]').trigger('click');
    await wrapper.find('[data-test="action-prune"]').trigger('click');
    expect(fetchMock).not.toHaveBeenCalled(); // confirm step comes first
    await wrapper.find('[data-test="action-prune"]').trigger('click');
    await flushPromises(); // emit('mutated') fires after execute()'s fetch + json microtasks
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool).toBe('prune_message');
    expect(wrapper.emitted('mutated')).toBeTruthy();
  });

  it('re-run calls generate and emits mutated', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(MessageActions, { props: { conversationId: 'c1', message } });
    await wrapper.find('[data-test="actions-toggle"]').trigger('click');
    await wrapper.find('[data-test="action-rerun"]').trigger('click');
    await flushPromises(); // emit('mutated') fires after execute()'s fetch + json microtasks
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool).toBe('generate');
    expect(wrapper.emitted('mutated')).toBeTruthy();
  });

  it('re-run passes the message agent id to generate', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    useParticipants().__setParticipantsForTests([
      { id: 'agent-a', name: 'Agent A', type: 'agent', tools: {}, status: 'active' },
    ]);
    const wrapper = mount(MessageActions, {
      props: {
        conversationId: 'c1',
        message: { id: 'm1', content: 'hi', role: 'user', recipientId: 'agent-a' },
      },
    });
    await wrapper.find('[data-test="actions-toggle"]').trigger('click');
    await wrapper.find('[data-test="action-rerun"]').trigger('click');
    await flushPromises();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.tool).toBe('generate');
    expect(body.args).toEqual({ conversationId: 'c1', agentId: 'agent-a' });
  });

  it('surfaces an error and does not call generate when no agent is available', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    useParticipants().__resetForTests(); // no participants → no agent to re-run with
    const wrapper = mount(MessageActions, {
      props: { conversationId: 'c1', message: { id: 'm1', content: 'hi', role: 'user' } },
    });
    await wrapper.find('[data-test="actions-toggle"]').trigger('click');
    await wrapper.find('[data-test="action-rerun"]').trigger('click');
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="actions-error"]').text()).toBe(
      'No agent available to re-run this message.',
    );
  });

  it('falls back to an active agent when the addressed agent is retired', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    useParticipants().__setParticipantsForTests([
      { id: 'agent-old', name: 'Retired', type: 'agent', tools: {}, status: 'retired' },
      { id: 'agent-b', name: 'Agent B', type: 'agent', tools: {}, status: 'active' },
    ]);
    const wrapper = mount(MessageActions, {
      props: {
        conversationId: 'c1',
        message: { id: 'm1', content: 'hi', role: 'user', recipientId: 'agent-old' },
      },
    });
    await wrapper.find('[data-test="actions-toggle"]').trigger('click');
    await wrapper.find('[data-test="action-rerun"]').trigger('click');
    await flushPromises();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.args.agentId).toBe('agent-b');
  });

  it('failed edit surfaces the tool error and does not emit mutated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { status: 'error', error: 'locked' } }), {
          status: 200,
        }),
      ),
    );
    const wrapper = mount(MessageActions, { props: { conversationId: 'c1', message } });
    await wrapper.find('[data-test="actions-toggle"]').trigger('click');
    await wrapper.find('[data-test="action-edit"]').trigger('click');
    await wrapper.find('[data-test="edit-textarea"]').setValue('rewritten');
    await wrapper.find('[data-test="edit-save"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="actions-error"]').text()).toContain('locked');
    expect(wrapper.emitted('mutated')).toBeUndefined();
  });

  it('hides menu actions the caller cannot invoke', async () => {
    mockCan((t) => (t === 'edit_message' ? 'auto' : 'hidden'));
    vi.stubGlobal('fetch', okFetch());
    const w = mount(MessageActions, { props: { conversationId: 'c1', message } });
    await w.find('[data-test="actions-toggle"]').trigger('click');
    expect(w.find('[data-test="action-edit"]').exists()).toBe(true);
    expect(w.find('[data-test="action-rerun"]').exists()).toBe(false);
    expect(w.find('[data-test="action-prune"]').exists()).toBe(false);
  });

  it('hides the whole affordance when no gated tool is accessible', () => {
    mockCan(() => 'hidden');
    vi.stubGlobal('fetch', okFetch());
    const w = mount(MessageActions, { props: { conversationId: 'c1', message } });
    expect(w.find('[data-test="actions-toggle"]').exists()).toBe(false);
  });

  it('shows friendly text when edit_message is denied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('hidden')));
    const w = mount(MessageActions, { props: { conversationId: 'c1', message } });
    await w.find('[data-test="actions-toggle"]').trigger('click');
    await w.find('[data-test="action-edit"]').trigger('click');
    await w.find('[data-test="edit-textarea"]').setValue('rewritten');
    await w.find('[data-test="edit-save"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="actions-error"]').text()).toBe(
      'You do not have access to this action.',
    );
    expect(w.text()).not.toContain('hidden');
    expect(w.emitted('mutated')).toBeUndefined();
  });
});
