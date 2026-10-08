import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import MessageActions from './MessageActions.vue';

const message = { id: 'm1', content: 'hello world' };

function okFetch(): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'success', data: {} } }), { status: 200 }),
    );
}

describe('MessageActions', () => {
  beforeEach(() => {
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
});
