import { AuthEngine } from './AuthEngine.js';
import type { ApprovalAuthority, ToolPolicy } from '@legion/types';

describe('AuthEngine.authorize', () => {
  it('honors a participant per-tool auto policy', () => {
    const engine = new AuthEngine();
    const policies: Record<string, ToolPolicy> = { file_read: 'auto' };
    const result = engine.authorize('p1', 'file_read', {}, policies);
    expect(result.authorized).toBe(true);
  });

  it('honors a participant per-tool deny policy', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'file_write', {}, { file_write: 'deny' });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('deny');
  });

  it('returns not-authorized with requires_approval reason', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'danger', {}, { danger: 'requires_approval' });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('requires_approval');
  });

  it('falls back to engine per-tool policy when participant has none', () => {
    const engine = new AuthEngine({ toolPolicies: { file_read: 'auto' } });
    expect(engine.authorize('p1', 'file_read', {}, {}).authorized).toBe(true);
  });

  it('falls back to engine default policy', () => {
    const engine = new AuthEngine({ defaultPolicy: 'auto' });
    expect(engine.authorize('p1', 'whatever', {}, {}).authorized).toBe(true);
  });

  it('fail-safe is requires_approval when nothing matches', () => {
    const engine = new AuthEngine();
    const result = engine.authorize('p1', 'unknown_tool', {}, {});
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('requires_approval');
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
