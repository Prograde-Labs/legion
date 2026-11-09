import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { ToolScope } from '@legion-collective/types';
import ToolPolicyEditor from './ToolPolicyEditor.vue';

/** Mirrors the component's exported ToolOverride without importing a .vue named export. */
interface TestOverride {
  tool: string;
  source: string;
  enabled: boolean;
  requireApproval: boolean;
  scope?: ToolScope;
}

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
    const payload = w.emitted('update:overrides')![0][0] as TestOverride[];
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
    const payload = w.emitted('update:overrides')![0][0] as TestOverride[];
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

  it('lists declared arguments in a select', async () => {
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
    const payload = w.emitted('update:overrides')![0][0] as TestOverride[];
    await w.setProps({ overrides: payload });
    const select = w.find('select[data-arg-name]');
    expect(select.exists()).toBe(true);
    expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual(['path', 'content']);
  });

  it('uses a free-text argument name when the tool declares no parameters', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [{ tool: 'untyped', source: 'built-in', enabled: true, requireApproval: false }],
        availableTools: ['untyped'],
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    await w.find('[data-add-arg]').trigger('click');
    const payload = w.emitted('update:overrides')![0][0] as TestOverride[];
    await w.setProps({ overrides: payload });
    expect(w.find('select[data-arg-name]').exists()).toBe(false);
    expect(w.find('input[data-arg-name]').exists()).toBe(true);
  });

  it('shows string fields for a string argument and hides numeric fields', async () => {
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
    await w.find('[data-add-arg]').trigger('click');
    const payload = w.emitted('update:overrides')![0][0] as TestOverride[];
    await w.setProps({ overrides: payload });
    expect(w.find('input[placeholder="path prefix"]').exists()).toBe(true);
    expect(w.find('input[placeholder="min"]').exists()).toBe(false);
    expect(w.find('input[placeholder="max"]').exists()).toBe(false);
  });

  it('shows numeric fields for a number argument and hides string fields', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          { tool: 'set_timeout', source: 'built-in', enabled: true, requireApproval: false },
        ],
        availableTools: ['set_timeout'],
        parameters: {
          set_timeout: {
            type: 'object',
            properties: { timeoutMs: { type: 'integer' } },
          },
        },
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    await w.find('[data-add-arg]').trigger('click');
    const payload = w.emitted('update:overrides')![0][0] as TestOverride[];
    await w.setProps({ overrides: payload });
    expect(w.find('input[placeholder="min"]').exists()).toBe(true);
    expect(w.find('input[placeholder="max"]').exists()).toBe(true);
    expect(w.find('input[placeholder="pattern"]').exists()).toBe(false);
    expect(w.find('input[placeholder="path prefix"]').exists()).toBe(false);
  });

  it('shows only required for an unsupported argument type', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [{ tool: 'toggle', source: 'built-in', enabled: true, requireApproval: false }],
        availableTools: ['toggle'],
        parameters: {
          toggle: { type: 'object', properties: { enabled: { type: 'boolean' } } },
        },
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    await w.find('[data-add-arg]').trigger('click');
    const payload = w.emitted('update:overrides')![0][0] as TestOverride[];
    await w.setProps({ overrides: payload });
    expect(w.find('[data-scope-unsupported]').exists()).toBe(true);
    expect(w.find('input[placeholder="path prefix"]').exists()).toBe(false);
    expect(w.find('input[placeholder="min"]').exists()).toBe(false);
  });

  it('lets an unknown argument type choose text or number', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'untyped',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { value: { pattern: '^x' } },
          },
        ],
        availableTools: ['untyped'],
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    const kind = w.find('select[data-scope-kind]');
    expect(kind.exists()).toBe(true);
    expect((kind.element as HTMLSelectElement).value).toBe('string');
    await kind.setValue('number');
    const payload = w.emitted('update:overrides')![0][0] as TestOverride[];
    expect(payload[0].scope).toEqual({ value: {} });
    expect(w.find('input[placeholder="min"]').exists()).toBe(true);
  });

  it('shows an inline error for mixed string and numeric constraints', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'untyped',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { value: { enum: ['a'], min: 1 } },
          },
        ],
        availableTools: ['untyped'],
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    expect(w.find('[data-scope-error]').text()).toContain(
      'cannot combine string and numeric constraints',
    );
  });

  it('shows an inline error for numeric constraints on a string argument', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'file_write',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { path: { min: 1 } },
          },
        ],
        availableTools: ['file_write'],
        parameters: {
          file_write: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    expect(w.find('[data-scope-error]').text()).toContain(
      'numeric constraints require a number argument',
    );
  });

  it('flags an argument that the tool does not declare', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'file_write',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { legacy: {} },
          },
        ],
        availableTools: ['file_write'],
        parameters: {
          file_write: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    });
    await w.find('[data-scope-toggle]').trigger('click');
    expect(w.find('[data-scope-error]').text()).toContain('unknown argument');
  });

  it('disables add argument when every declared argument is already scoped', async () => {
    const w = mount(ToolPolicyEditor, {
      props: {
        overrides: [
          {
            tool: 'file_write',
            source: 'built-in',
            enabled: true,
            requireApproval: false,
            scope: { path: {}, content: {} },
          },
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
    expect((w.find('[data-add-arg]').element as HTMLButtonElement).disabled).toBe(true);
  });
});
