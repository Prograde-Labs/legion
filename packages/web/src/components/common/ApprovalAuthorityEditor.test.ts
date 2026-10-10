import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ApprovalAuthorityEditor from './ApprovalAuthorityEditor.vue';

describe('ApprovalAuthorityEditor', () => {
  it('renders wildcard unchecked with no authority', () => {
    const wrapper = mount(ApprovalAuthorityEditor, {
      props: { modelValue: null, availableTools: ['communicate'] },
    });
    expect((wrapper.find('[data-test="wildcard"]').element as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('wildcard reflects a "*" authority', () => {
    const wrapper = mount(ApprovalAuthorityEditor, {
      props: { modelValue: { tools: '*' }, availableTools: [] },
    });
    expect((wrapper.find('[data-test="wildcard"]').element as HTMLInputElement).checked).toBe(true);
  });

  it('toggling a tool emits the per-tool map; wildcard emits "*"', async () => {
    const wrapper = mount(ApprovalAuthorityEditor, {
      props: { modelValue: null, availableTools: ['communicate', 'shell'] },
    });
    await wrapper.find('[data-test="tool-communicate"]').setValue(true);
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      tools: { communicate: true },
    });
    await wrapper.find('[data-test="wildcard"]').setValue(true);
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ tools: '*' });
  });

  it('unchecking the wildcard returns to the per-tool map', async () => {
    const wrapper = mount(ApprovalAuthorityEditor, {
      props: { modelValue: { tools: '*' }, availableTools: ['communicate'] },
    });
    await wrapper.find('[data-test="wildcard"]').setValue(false);
    const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0];
    expect(emitted).toEqual({ tools: {} });
  });
});
