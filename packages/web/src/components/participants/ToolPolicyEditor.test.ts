import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ToolPolicyEditor from './ToolPolicyEditor.vue';

const overrides = [
  { tool: 'create_agent', source: 'built-in', enabled: true, requireApproval: false },
  { tool: 'retire_agent', source: 'built-in', enabled: true, requireApproval: true },
];

const availableTools = ['create_agent', 'retire_agent'];

describe('ToolPolicyEditor', () => {
  it('renders a row for every available tool', () => {
    const w = mount(ToolPolicyEditor, {
      props: { overrides, availableTools },
    });
    expect(w.findAll('[data-tool-row]')).toHaveLength(2);
  });

  it('emits update:overrides removing tool when checkbox unchecked', async () => {
    const w = mount(ToolPolicyEditor, {
      props: { overrides, availableTools },
    });
    await w.find('[data-tool-row]').find('input[type=checkbox]').setValue(false);
    const emitted = w.emitted('update:overrides');
    expect(emitted).toBeTruthy();
    const payload = emitted![0][0] as Array<{ tool: string }>;
    expect(payload.find((o) => o.tool === 'create_agent')).toBeUndefined();
    expect(payload.find((o) => o.tool === 'retire_agent')).toBeDefined();
  });
});
