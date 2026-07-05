import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ApprovalCard from './ApprovalCard.vue';

const mockExecute = vi.fn().mockResolvedValue({ status: 'success' });

vi.mock('../../composables/useExecute.js', () => ({
  useExecute: () => ({
    execute: mockExecute,
  }),
}));

beforeEach(() => {
  mockExecute.mockClear();
});

const pendingProps = {
  approvalId: 'apr-1',
  toolName: 'file_write',
  args: { path: 'report.md', content: '# Report' },
  resolved: false,
  decision: null as null | 'approve' | 'reject',
};

describe('ApprovalCard', () => {
  it('renders tool name and args', () => {
    const wrapper = mount(ApprovalCard, { props: pendingProps });
    expect(wrapper.text()).toContain('file_write');
  });

  it('shows Allow and Deny buttons when pending', () => {
    const wrapper = mount(ApprovalCard, { props: pendingProps });
    expect(wrapper.find('[data-allow]').exists()).toBe(true);
    expect(wrapper.find('[data-deny]').exists()).toBe(true);
  });

  it('calls approval_response with approve decision on Allow click', async () => {
    const wrapper = mount(ApprovalCard, { props: pendingProps });
    await wrapper.find('[data-allow]').trigger('click');

    expect(mockExecute).toHaveBeenCalledWith('approval_response', {
      decisions: [{ approvalId: 'apr-1', decision: 'approve', message: '' }],
    });
  });

  it('calls approval_response with reject decision and message on Deny click', async () => {
    const wrapper = mount(ApprovalCard, { props: pendingProps });
    await wrapper.find('textarea').setValue('Not allowed on prod');
    await wrapper.find('[data-deny]').trigger('click');

    expect(mockExecute).toHaveBeenCalledWith('approval_response', {
      decisions: [{ approvalId: 'apr-1', decision: 'reject', message: 'Not allowed on prod' }],
    });
  });

  it('shows resolved state when decision prop is approve', () => {
    const wrapper = mount(ApprovalCard, {
      props: { ...pendingProps, resolved: true, decision: 'approve' },
    });
    expect(wrapper.text()).toContain('Approved');
    expect(wrapper.find('[data-allow]').exists()).toBe(false);
  });

  it('shows resolved state when decision prop is reject', () => {
    const wrapper = mount(ApprovalCard, {
      props: {
        ...pendingProps,
        resolved: true,
        decision: 'reject',
        resolvedMessage: 'Not allowed',
      },
    });
    expect(wrapper.text()).toContain('Denied');
    expect(wrapper.text()).toContain('Not allowed');
  });
});
