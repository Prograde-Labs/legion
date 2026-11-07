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

  it('lets a read-only caller inspect an existing scope', async () => {
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
        readonly: true,
      },
    });
    const toggle = w.find('[data-scope-toggle]');
    expect((toggle.element as HTMLButtonElement).disabled).toBe(false);
    await toggle.trigger('click');
    const editor = w.find('[data-scope-editor]');
    expect(editor.exists()).toBe(true);
    const inputs = editor.findAll('input');
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect((input.element as HTMLInputElement).disabled).toBe(true);
    }
    for (const button of editor.findAll('button')) {
      expect((button.element as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('rejects renaming an argument onto an existing rule', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'file_write',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { path: { pathPrefix: 'work' }, content: { maxLength: 10 } },
          },
        ],
        availableTools: ['file_write'],
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    const rows = w.findAll('[data-scope-row]');
    expect(rows).toHaveLength(2);
    const nameInput = rows[1].find('input');
    (nameInput.element as HTMLInputElement).value = 'path';
    await nameInput.trigger('change');
    expect(w.emitted('update:overrides')).toBeUndefined();
    expect((nameInput.element as HTMLInputElement).value).toBe('content');
  });

  it('picks a fresh argN fallback instead of overwriting a gapped rule', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'file_write',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { arg2: {} },
          },
        ],
        availableTools: ['file_write'],
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    await w.find('[data-add-arg]').trigger('click');
    const payload = w.emitted('update:overrides')![0][0] as Array<{
      tool: string;
      scope?: Record<string, unknown>;
    }>;
    expect(payload[0].scope).toEqual({ arg2: {}, arg3: {} });
  });

  it('hides the scope count badge when the scope is empty', () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'file_write',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: {},
          },
        ],
        availableTools: ['file_write'],
      },
    });
    expect(w.find('[data-scope-count]').exists()).toBe(false);
  });

  it('does not list an empty sentinel in the argument datalist', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          { tool: 'file_write', source: 'built-in', enabled: true, requireApproval: false },
        ],
        availableTools: ['file_write'],
        parameters: {
          file_write: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    expect(w.findAll('datalist option').map((o) => o.attributes('value'))).toEqual(['path']);
  });
});
