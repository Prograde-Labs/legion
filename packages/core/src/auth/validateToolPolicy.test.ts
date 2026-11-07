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
