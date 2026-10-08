import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ApprovalCard from './ApprovalCard.vue';

const approval = {
  approvalId: 'a1',
  conversationId: 'c1',
  requesterId: 'agent-a',
  tool: 'file_write',
  args: { path: '/tmp/x.txt' },
  createdAt: '2026-10-08T00:00:00Z',
};

function okFetch(): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'success', data: {} } }), { status: 200 }),
    );
}

describe('ApprovalCard', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
  });

  it('shows the tool and args summary', () => {
    const wrapper = mount(ApprovalCard, { props: { approval } });
    expect(wrapper.find('[data-test="approval-tool"]').text()).toContain('file_write');
    expect(wrapper.find('[data-test="approval-args"]').text()).toContain('/tmp/x.txt');
  });

  it('approve calls approval_response approved:true and emits resolved', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ApprovalCard, { props: { approval } });
    await wrapper.find('[data-test="approval-approve"]').trigger('click');
    // trigger() only flushes nextTick; the resolved emit lands after execute()'s
    // fetch microtask chain settles, so drain it before asserting.
    await flushPromises();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tool).toBe('approval_response');
    expect(body.args.approvalId).toBe('a1');
    expect(body.args.approved).toBe(true);
    expect(wrapper.emitted('resolved')?.[0]).toEqual([true]);
  });

  it('reject with reason includes the message and emits resolved', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ApprovalCard, { props: { approval } });
    await wrapper.find('[data-test="approval-reason-toggle"]').trigger('click');
    await wrapper.find('[data-test="approval-reason"]').setValue('not today');
    await wrapper.find('[data-test="approval-reject"]').trigger('click');
    await flushPromises();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.args.approved).toBe(false);
    expect(body.args.message).toBe('not today');
    expect(wrapper.emitted('resolved')?.[0]).toEqual([false]);
  });

  it('surfaces a tool error instead of dying silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ result: { status: 'error', error: 'approval window closed' } }),
            { status: 200 },
          ),
        ),
    );
    const wrapper = mount(ApprovalCard, { props: { approval } });
    await wrapper.find('[data-test="approval-approve"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="approval-error"]').text()).toContain(
        'approval window closed',
      ),
    );
    expect(wrapper.emitted('resolved')).toBeUndefined();
  });
});
