import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MiddlewareSchemaForm from './MiddlewareSchemaForm.vue';

const schema = {
  type: 'object',
  required: ['endpoint', 'retries', 'enabled', 'credentialKey'],
  properties: {
    endpoint: { type: 'string', title: 'Endpoint', minLength: 8, maxLength: 80 },
    retries: { type: 'integer', title: 'Retries', minimum: 1, maximum: 5 },
    enabled: { type: 'boolean', title: 'Enabled' },
    mode: { type: 'string', title: 'Mode', enum: ['fast', 'safe'] },
    labels: {
      type: 'array',
      title: 'Labels',
      items: { type: 'string', minLength: 2 },
      uniqueItems: true,
    },
    credentialKey: {
      type: 'string',
      title: 'Credential',
      format: 'credential-reference',
    },
  },
};

describe('MiddlewareSchemaForm', () => {
  it('emits typed values for supported schema fields', async () => {
    const wrapper = mount(MiddlewareSchemaForm, {
      props: {
        schema,
        modelValue: {},
        credentialKeys: ['provider-key'],
      },
    });

    await wrapper.get('[data-field="endpoint"]').setValue('https://example.test');
    await wrapper.setProps({ modelValue: { endpoint: 'https://example.test' } });
    await wrapper.get('[data-field="retries"]').setValue('3');
    await wrapper.setProps({ modelValue: { endpoint: 'https://example.test', retries: 3 } });
    await wrapper.get('[data-field="enabled"]').setValue(true);
    await wrapper.setProps({
      modelValue: { endpoint: 'https://example.test', retries: 3, enabled: true },
    });
    await wrapper.get('[data-field="mode"]').setValue('safe');
    await wrapper.setProps({
      modelValue: { endpoint: 'https://example.test', retries: 3, enabled: true, mode: 'safe' },
    });
    await wrapper.get('[data-field="labels"]').setValue('alpha, beta');
    await wrapper.setProps({
      modelValue: {
        endpoint: 'https://example.test',
        retries: 3,
        enabled: true,
        mode: 'safe',
        labels: ['alpha', 'beta'],
      },
    });
    await wrapper.get('[data-field="credentialKey"]').setValue('provider-key');

    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      endpoint: 'https://example.test',
      retries: 3,
      enabled: true,
      mode: 'safe',
      labels: ['alpha', 'beta'],
      credentialKey: 'provider-key',
    });
  });

  it('renders credential references as a key selector without password or free-text input', () => {
    const wrapper = mount(MiddlewareSchemaForm, {
      props: { schema, modelValue: {}, credentialKeys: ['one', 'two'] },
    });

    const credential = wrapper.get('[data-field="credentialKey"]');
    expect(credential.element.tagName).toBe('SELECT');
    expect(credential.findAll('option').map((option) => option.text())).toEqual([
      'Select credential...',
      'one',
      'two',
    ]);
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
  });

  it('preserves an existing credential reference when discovery supplies no keys', () => {
    const wrapper = mount(MiddlewareSchemaForm, {
      props: { schema, modelValue: { credentialKey: 'existing-key' }, credentialKeys: [] },
    });

    expect(
      wrapper
        .get('[data-field="credentialKey"]')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual(['Select credential...', 'existing-key']);
    expect(wrapper.find('input[data-field="credentialKey"]').exists()).toBe(false);
  });

  it('recursively edits nested objects', async () => {
    const wrapper = mount(MiddlewareSchemaForm, {
      props: {
        schema: {
          type: 'object',
          required: ['connection'],
          properties: {
            connection: {
              type: 'object',
              title: 'Connection',
              required: ['endpoint'],
              properties: { endpoint: { type: 'string', title: 'Endpoint' } },
            },
          },
        },
        modelValue: { connection: {} },
        credentialKeys: [],
      },
    });

    expect(wrapper.emitted('validation')?.at(-1)?.[0]).toEqual(['Connection.Endpoint is required']);
    await wrapper.get('[data-field="connection.endpoint"]').setValue('https://example.test');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      connection: { endpoint: 'https://example.test' },
    });
  });

  it('reactively validates numeric, string, enum, and unique-array constraints', async () => {
    const wrapper = mount(MiddlewareSchemaForm, {
      props: {
        schema,
        modelValue: {
          endpoint: 'short',
          retries: 1.5,
          enabled: true,
          mode: 'invalid',
          labels: ['x', 'x'],
          credentialKey: 'missing-key',
        },
        credentialKeys: ['known-key'],
      },
    });
    expect(wrapper.emitted('validation')?.at(-1)?.[0]).toEqual([
      'Endpoint must contain at least 8 characters',
      'Retries must be an integer',
      'Mode must be one of fast, safe',
      'Labels entries must be unique',
      'Labels[0] must contain at least 2 characters',
      'Labels[1] must contain at least 2 characters',
    ]);

    await wrapper.setProps({
      modelValue: {
        endpoint: 'x'.repeat(81),
        retries: 0,
        enabled: true,
        mode: 'safe',
        labels: ['alpha', 'beta'],
        credentialKey: 'known-key',
      },
    });
    expect(wrapper.emitted('validation')?.at(-1)?.[0]).toEqual([
      'Endpoint must contain at most 80 characters',
      'Retries must be at least 1',
    ]);

    await wrapper.setProps({
      modelValue: {
        endpoint: 'https://example.test',
        retries: 6,
        enabled: true,
        mode: 'safe',
        labels: ['alpha', 'beta'],
        credentialKey: 'known-key',
      },
    });
    expect(wrapper.emitted('validation')?.at(-1)?.[0]).toEqual(['Retries must be at most 5']);

    await wrapper.setProps({
      modelValue: {
        endpoint: 'https://example.test',
        retries: 3,
        enabled: true,
        mode: 'safe',
        labels: ['alpha', 'beta'],
        credentialKey: 'known-key',
      },
    });
    expect(wrapper.emitted('validation')?.at(-1)?.[0]).toEqual([]);
  });

  it('emits an object without the key when a numeric field is cleared', async () => {
    const wrapper = mount(MiddlewareSchemaForm, {
      props: {
        schema,
        modelValue: { endpoint: 'https://example.test', retries: 3 },
        credentialKeys: [],
      },
    });

    await wrapper.get('[data-field="retries"]').setValue('');

    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      endpoint: 'https://example.test',
    });
  });

  it('renders each nested validation error exactly once', () => {
    const wrapper = mount(MiddlewareSchemaForm, {
      props: {
        schema: {
          type: 'object',
          required: ['connection'],
          properties: {
            connection: {
              type: 'object',
              title: 'Connection',
              required: ['endpoint'],
              properties: { endpoint: { type: 'string', title: 'Endpoint' } },
            },
          },
        },
        modelValue: { connection: {} },
        credentialKeys: [],
      },
    });

    const occurrences = wrapper
      .findAll('p')
      .filter((paragraph) => paragraph.text() === 'Connection.Endpoint is required');
    expect(occurrences).toHaveLength(1);
  });
});
