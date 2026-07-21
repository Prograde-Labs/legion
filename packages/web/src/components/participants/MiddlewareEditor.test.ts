import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MiddlewareEditor from './MiddlewareEditor.vue';
import type { MiddlewareDefinitionInfo } from './middleware-ui-types.js';

const definitions: MiddlewareDefinitionInfo[] = [
  {
    type: 'builtin:skills',
    displayName: 'Skills',
    defaultFailureMode: 'closed' as const,
    configSchema: {
      type: 'object',
      properties: { skills: { type: 'array', items: { type: 'string' } } },
    },
    source: 'builtin',
  },
  {
    type: 'workspace:audit',
    displayName: 'Audit',
    defaultFailureMode: 'open' as const,
    configSchema: {
      type: 'object',
      properties: { endpoint: { type: 'string', title: 'Endpoint', minLength: 8 } },
      required: ['endpoint'],
    },
    source: 'workspace',
  },
];

describe('MiddlewareEditor', () => {
  it('reorders instances and removes one without changing ids', async () => {
    const wrapper = mount(MiddlewareEditor, {
      props: {
        modelValue: [
          { id: 'skills-1', type: 'builtin:skills', config: { skills: [] } },
          { id: 'audit-1', type: 'workspace:audit', config: {} },
        ],
        definitions,
        skills: [],
        credentialKeys: [],
      },
    });
    await wrapper.get('[data-move-up="audit-1"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      { id: 'audit-1', type: 'workspace:audit', config: {} },
      { id: 'skills-1', type: 'builtin:skills', config: { skills: [] } },
    ]);
    await wrapper.get('[data-remove="audit-1"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      { id: 'skills-1', type: 'builtin:skills', config: { skills: [] } },
    ]);
  });

  it('shows inherited failure mode and emits explicit override', async () => {
    const wrapper = mount(MiddlewareEditor, {
      props: {
        modelValue: [{ id: 'audit-1', type: 'workspace:audit', config: {} }],
        definitions,
        skills: [],
        credentialKeys: [],
      },
    });
    expect(wrapper.get('[data-failure="audit-1"]').text()).toContain('Inherited: open');
    await wrapper.get('[data-failure="audit-1"]').setValue('closed');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      { id: 'audit-1', type: 'workspace:audit', failureMode: 'closed', config: {} },
    ]);
  });

  it('preserves unknown disabled config and prevents enabling it', async () => {
    const wrapper = mount(MiddlewareEditor, {
      props: {
        modelValue: [
          { id: 'gone-1', type: 'workspace:gone', enabled: false, config: { keep: 'raw' } },
        ],
        definitions,
        skills: [],
        credentialKeys: [],
      },
    });
    expect(wrapper.get('[data-unknown="gone-1"]').text()).toContain('Definition unavailable');
    expect(wrapper.get('[data-raw-config="gone-1"]').text()).toContain('"keep": "raw"');
    expect(wrapper.get('[data-enabled="gone-1"]').attributes('disabled')).toBeDefined();
  });

  it('uses dedicated skills selector and schema form for workspace definitions', async () => {
    const wrapper = mount(MiddlewareEditor, {
      props: {
        modelValue: [
          { id: 'skills-1', type: 'builtin:skills', config: { skills: ['alpha'] } },
          { id: 'audit-1', type: 'workspace:audit', config: {} },
        ],
        definitions,
        skills: [
          {
            name: 'alpha',
            description: 'A',
            scope: 'project',
            location: '/a/SKILL.md',
            baseDirectory: '/a',
          },
        ],
        credentialKeys: [],
      },
    });
    expect(wrapper.findComponent({ name: 'SkillsSelector' }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'MiddlewareSchemaForm' }).exists()).toBe(true);
  });

  it('aggregates validation reactively and clears errors when an instance is removed', async () => {
    const wrapper = mount(MiddlewareEditor, {
      props: {
        modelValue: [{ id: 'audit-1', type: 'workspace:audit', config: {} }],
        definitions,
        skills: [],
        credentialKeys: [],
      },
    });
    expect(wrapper.emitted('validation')?.at(-1)?.[0]).toEqual(['Endpoint is required']);

    await wrapper.get('[data-field="endpoint"]').setValue('short');
    await wrapper.setProps({
      modelValue: [{ id: 'audit-1', type: 'workspace:audit', config: { endpoint: 'short' } }],
    });
    expect(wrapper.emitted('validation')?.at(-1)?.[0]).toEqual([
      'Endpoint must contain at least 8 characters',
    ]);

    await wrapper.get('[data-remove="audit-1"]').trigger('click');
    expect(wrapper.emitted('validation')?.at(-1)?.[0]).toEqual([]);
  });
});
