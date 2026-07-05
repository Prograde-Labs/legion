import { AuthEngine } from './AuthEngine.js';
import type { ApprovalAuthority, ToolPolicy } from '@legion/types';

describe('AuthEngine.authorize', () => {
  it('honors a participant per-tool auto policy', () => {
    const engine = new AuthEngine();
    const policies: Record<string, ToolPolicy> = { file_read: 'auto' };
    const result = engine.authorize('p1', 'file_read', {}, policies);
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('auto');
  });

  it('returns not-authorized with requires_approval reason when policy is requires_approval', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'danger', {}, { danger: 'requires_approval' });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('requires_approval');
  });

  it('absent tool is hidden — not authorized, reason hidden', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'unknown_tool', {}, {});
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('hidden');
  });

  it('absent tool with undefined policies is hidden', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'any_tool', {}, undefined);
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('hidden');
  });
});

describe('AuthEngine.hasAuthority', () => {
  it('wildcard tools + wildcard participants grants all', () => {
    const engine = new AuthEngine();
    const authority: ApprovalAuthority = { tools: '*', participants: '*' };
    expect(engine.hasAuthority(authority, 'b', 'anything', {})).toBe(true);
  });

  it('denies when requester not in participants list', () => {
    const engine = new AuthEngine();
    const authority: ApprovalAuthority = { tools: '*', participants: ['x'] };
    expect(engine.hasAuthority(authority, 'b', 'anything', {})).toBe(false);
  });

  it('denies when tool not permitted', () => {
    const engine = new AuthEngine();
    const authority: ApprovalAuthority = { tools: { file_read: true }, participants: '*' };
    expect(engine.hasAuthority(authority, 'b', 'file_write', {})).toBe(false);
    expect(engine.hasAuthority(authority, 'b', 'file_read', {})).toBe(true);
  });

  it('undefined authority grants nothing', () => {
    const engine = new AuthEngine();
    expect(engine.hasAuthority(undefined, 'b', 'x', {})).toBe(false);
  });
});
