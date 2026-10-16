import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ApprovalBadge from './ApprovalBadge.vue';

describe('ApprovalBadge', () => {
  it('renders the needs-approval label with the contract test hook', () => {
    const wrapper = mount(ApprovalBadge);
    expect(wrapper.find('[data-test="approval-badge"]').exists()).toBe(true);
    expect(wrapper.text()).toBe('needs approval');
  });

  it('uses warning theme tokens, not raw hex colors', () => {
    const wrapper = mount(ApprovalBadge);
    const html = wrapper.html();
    expect(html).toContain('text-warning');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
