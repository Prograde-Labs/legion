import { describe, expect, it } from 'vitest';
import { friendlyToolError } from './friendlyToolError.js';

describe('friendlyToolError', () => {
  it('maps a bare hidden denial to friendly text', () => {
    expect(friendlyToolError(new Error('hidden'))).toBe('You do not have access to this action.');
    expect(friendlyToolError('hidden')).toBe('You do not have access to this action.');
  });

  it('maps whitespace/case variants of hidden too', () => {
    expect(friendlyToolError(new Error('  Hidden '))).toBe(
      'You do not have access to this action.',
    );
  });

  it('passes real errors through unchanged', () => {
    expect(friendlyToolError(new Error('boom'))).toBe('boom');
  });
});
