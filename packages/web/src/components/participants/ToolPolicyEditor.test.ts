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

  it('renders an existing scope rule', () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'file_write',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { path: { pathPrefix: 'work' } },
          },
        ],
        availableTools: ['file_write'],
        parameters: { file_write: { type: 'object', properties: { path: { type: 'string' } } } },
      },
    });
    expect(w.find('[data-scope-editor]').exists()).toBe(false);
    expect(w.find('[data-scope-count]').text()).toContain('1');
  });

  it('adds an argument rule when the scope editor is opened', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          { tool: 'file_write', source: 'built-in', enabled: true, requireApproval: false },
        ],
        availableTools: ['file_write'],
        parameters: {
          file_write: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
          },
        },
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    await w.find('[data-add-arg]').trigger('click');
    const payload = w.emitted('update:overrides')![0][0] as Array<{
      tool: string;
      scope?: Record<string, unknown>;
    }>;
    expect(payload[0].scope).toEqual({ path: {} });
  });

  it('shows an inline error for an invalid pattern', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'file_write',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { path: { pattern: '[' } },
          },
        ],
        availableTools: ['file_write'],
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    expect(w.find('[data-scope-error]').text()).toContain('invalid pattern');
  });
});
