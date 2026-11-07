import { describe, expect, it } from 'vitest';
import { normalizeToolPolicy, type ToolPolicy } from './tool.js';

describe('normalizeToolPolicy', () => {
  it('maps the legacy auto string', () => {
    expect(normalizeToolPolicy('auto')).toEqual({ policy: 'auto' });
  });

  it('maps the legacy requires_approval string', () => {
    expect(normalizeToolPolicy('requires_approval')).toEqual({ policy: 'requires_approval' });
  });

  it('returns undefined for an absent policy', () => {
    expect(normalizeToolPolicy(undefined)).toBeUndefined();
  });

  it('passes through the object form with a scope', () => {
    const policy: ToolPolicy = {
      policy: 'auto',
      scope: { path: { pathPrefix: 'work' } },
    };
    expect(normalizeToolPolicy(policy)).toEqual(policy);
  });

  it('accepts an object form without a scope', () => {
    expect(normalizeToolPolicy({ policy: 'requires_approval' })).toEqual({
      policy: 'requires_approval',
    });
  });
});
