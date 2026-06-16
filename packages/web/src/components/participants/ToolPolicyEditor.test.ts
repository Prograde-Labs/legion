import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ToolPolicyEditor from './ToolPolicyEditor.vue';

const overrides = [
  { tool: 'create_agent', source: 'built-in', enabled: true, requireApproval: false },
  { tool: 'retire_agent', source: 'built-in', enabled: true, requireApproval: true },
];

describe('ToolPolicyEditor', () => {
  it('renders override rows', () => {
    const w = mount(ToolPolicyEditor, {
      props: { defaultPolicy: 'allow', overrides, availableTools: [] },
    });
    expect(w.findAll('[data-tool-row]')).toHaveLength(2);
  });

  it('emits update:overrides when checkbox toggled', async () => {
    const w = mount(ToolPolicyEditor, {
      props: { defaultPolicy: 'allow', overrides, availableTools: [] },
    });
    await w.find('[data-tool-row]').find('input[type=checkbox]').setValue(false);
    expect(w.emitted('update:overrides')).toBeTruthy();
  });
});
