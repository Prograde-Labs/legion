import { describe, expect, it } from 'vitest';
import type { AnyTool } from '../tools/Tool.js';
import { validateToolPolicy, validateToolsMap } from './validateToolPolicy.js';

const fileTool: AnyTool = {
  name: 'file_write',
  description: 'write',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  execute: async () => ({ status: 'success' }),
};

describe('validateToolPolicy', () => {
  it('accepts the legacy string forms', () => {
    expect(validateToolPolicy(fileTool, 'auto')).toEqual({ ok: true, policy: 'auto' });
    expect(validateToolPolicy(fileTool, 'requires_approval')).toEqual({
      ok: true,
      policy: 'requires_approval',
    });
  });

  it('accepts an object policy with a valid scope', () => {
    expect(
      validateToolPolicy(fileTool, {
        policy: 'auto',
        scope: { path: { pathPrefix: 'work' }, content: { maxLength: 100 } },
      }),
    ).toEqual({
      ok: true,
      policy: {
        policy: 'auto',
        scope: { path: { pathPrefix: 'work' }, content: { maxLength: 100 } },
      },
    });
  });

  it('accepts an empty scope', () => {
    expect(validateToolPolicy(fileTool, { policy: 'auto', scope: {} })).toEqual({
      ok: true,
      policy: { policy: 'auto', scope: {} },
    });
  });

  it('rejects a non-object policy', () => {
    const result = validateToolPolicy(fileTool, 42);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/policy must be/);
  });

  it('rejects an invalid policy literal', () => {
    const result = validateToolPolicy(fileTool, { policy: 'always' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/policy.policy/);
  });

  it('rejects a non-object scope', () => {
    const result = validateToolPolicy(fileTool, { policy: 'auto', scope: 'work' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/scope must be an object/);
  });

  it('rejects an unknown argument name when the tool declares properties', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { destination: { pathPrefix: 'work' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unknown argument "destination" for tool file_write');
  });

  it('allows any argument name when the tool is unknown', () => {
    expect(
      validateToolPolicy(undefined, { policy: 'auto', scope: { anything: { enum: ['x'] } } }),
    ).toEqual({ ok: true, policy: { policy: 'auto', scope: { anything: { enum: ['x'] } } } });
  });

  it('rejects an unknown constraint field', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { path: { prefix: 'work' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown constraint "prefix"/);
  });

  it('rejects an empty enum', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { path: { enum: [] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/enum must be a non-empty array/);
  });

  it('rejects an invalid regex', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { path: { pattern: '[' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a valid regular expression/);
  });

  it('rejects inconsistent numeric bounds', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { content: { minLength: 10, maxLength: 2 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/minLength.*maxLength/);
  });

  it('rejects a non-finite numeric bound', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { content: { maxLength: Number.POSITIVE_INFINITY } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-negative integer/);
  });

  it('rejects an empty pathPrefix', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { path: { pathPrefix: '' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pathPrefix/);
  });
});

const numericTool: AnyTool = {
  name: 'set_timeout',
  description: 'set a timeout',
  parameters: {
    type: 'object',
    properties: {
      timeoutMs: { type: 'integer' },
      label: { type: 'string' },
    },
  },
  execute: async () => ({ status: 'success' }),
};

const booleanTool: AnyTool = {
  name: 'toggle',
  description: 'toggle a flag',
  parameters: {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
  },
  execute: async () => ({ status: 'success' }),
};

const unknownTypeTool: AnyTool = {
  name: 'untyped',
  description: 'an untyped argument',
  parameters: {
    type: 'object',
    properties: { value: {} },
  },
  execute: async () => ({ status: 'success' }),
};

describe('constraint compatibility', () => {
  it('accepts combined string constraints', () => {
    expect(
      validateToolPolicy(fileTool, {
        policy: 'auto',
        scope: {
          path: {
            enum: ['work/a.txt'],
            pattern: '^work/',
            minLength: 1,
            maxLength: 100,
            pathPrefix: 'work',
          },
        },
      }).ok,
    ).toBe(true);
  });

  it('accepts a numeric range', () => {
    expect(
      validateToolPolicy(numericTool, {
        policy: 'auto',
        scope: { timeoutMs: { min: 1, max: 60000 } },
      }).ok,
    ).toBe(true);
  });

  it('allows required alongside numeric constraints', () => {
    expect(
      validateToolPolicy(numericTool, {
        policy: 'auto',
        scope: { timeoutMs: { required: true, min: 1 } },
      }).ok,
    ).toBe(true);
  });

  it('rejects numeric constraints on a declared string argument', () => {
    const result = validateToolPolicy(fileTool, {
      policy: 'auto',
      scope: { path: { min: 1 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/numeric constraints require a number argument/);
  });

  it('rejects string constraints on a declared number argument', () => {
    const result = validateToolPolicy(numericTool, {
      policy: 'auto',
      scope: { timeoutMs: { enum: ['1000'] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/string constraints require a string argument/);
  });

  it('rejects constraints on an unsupported argument type', () => {
    const result = validateToolPolicy(booleanTool, {
      policy: 'auto',
      scope: { enabled: { maxLength: 5 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not supported for this argument type/);
  });

  it('allows required on an unsupported argument type', () => {
    expect(
      validateToolPolicy(booleanTool, {
        policy: 'auto',
        scope: { enabled: { required: true } },
      }).ok,
    ).toBe(true);
  });

  it('rejects mixed constraints on an argument with no declared type', () => {
    const result = validateToolPolicy(unknownTypeTool, {
      policy: 'auto',
      scope: { value: { pattern: '^x', min: 1 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot combine string and numeric constraints/);
  });

  it('rejects mixed constraints when the tool is unknown', () => {
    const result = validateToolPolicy(undefined, {
      policy: 'auto',
      scope: { anything: { enum: ['x'], min: 1 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot combine string and numeric constraints/);
  });
});

describe('validateToolsMap', () => {
  it('validates every entry', () => {
    const registry = { get: (name: string) => (name === 'file_write' ? fileTool : undefined) };
    expect(
      validateToolsMap(registry, {
        file_write: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } },
      }),
    ).toEqual({ ok: true });
  });

  it('returns the first invalid entry', () => {
    const registry = { get: (name: string) => (name === 'file_write' ? fileTool : undefined) };
    const result = validateToolsMap(registry, {
      file_write: { policy: 'auto', scope: { nope: { enum: ['x'] } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown argument "nope"/);
  });

  it('skips tool lookup when no registry is available', () => {
    expect(validateToolsMap(undefined, { anything: 'auto' })).toEqual({ ok: true });
  });
});
