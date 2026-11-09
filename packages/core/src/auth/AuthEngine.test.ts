import { AuthEngine } from './AuthEngine.js';
import type { ApprovalAuthority, ToolPolicy } from '@legion-collective/types';

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

describe('AuthEngine.authorize argument scope', () => {
  const ctx = { workspaceRoot: '/tmp' };

  it('authorizes an object policy whose arguments fit the scope', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_read',
      { path: 'work/a.txt' },
      { file_read: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } } },
      ctx,
    );
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('auto');
  });

  it('returns a scope reason with detail when an argument is out of scope', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_read',
      { path: '../escape.txt' },
      { file_read: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } } },
      ctx,
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('scope');
    expect(result.detail).toBe('argument scope violation: file_read.path must be under work');
  });

  it('checks scope before requires_approval', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_write',
      { path: '../escape.txt' },
      { file_write: { policy: 'requires_approval', scope: { path: { pathPrefix: 'work' } } } },
      ctx,
    );
    expect(result.reason).toBe('scope');
  });

  it('returns requires_approval when the scope passes', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_write',
      { path: 'work/a.txt' },
      { file_write: { policy: 'requires_approval', scope: { path: { pathPrefix: 'work' } } } },
      ctx,
    );
    expect(result.reason).toBe('requires_approval');
  });

  it('fails closed when a scope is configured but context is missing', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_read',
      { path: 'work/a.txt' },
      {
        file_read: { policy: 'auto', scope: { path: { pathPrefix: 'work' } } },
      },
    );
    expect(result.reason).toBe('scope');
    expect(result.detail).toBe('argument scope unavailable: workspaceRoot missing');
  });

  it('fails closed when a stored scope is malformed', () => {
    const engine = new AuthEngine();
    const result = engine.authorize(
      'p1',
      'file_read',
      {},
      {
        file_read: { policy: 'auto', scope: null },
      } as unknown as Record<string, ToolPolicy>,
      ctx,
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('scope');
    expect(result.detail).toBe(
      'argument scope violation: file_read.<scope> scope must be an object',
    );
  });

  it('keeps the legacy string policies working without a scope context', () => {
    const engine = new AuthEngine();
    expect(engine.authorize('p1', 'file_read', {}, { file_read: 'auto' }).reason).toBe('auto');
    expect(engine.authorize('p1', 'danger', {}, { danger: 'requires_approval' }).reason).toBe(
      'requires_approval',
    );
  });
});
