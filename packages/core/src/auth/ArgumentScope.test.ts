import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateScope } from './ArgumentScope.js';

describe('evaluateScope', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'legion-scope-'));
    await mkdir(join(root, 'work'), { recursive: true });
    await mkdir(join(root, 'other'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes an empty scope', () => {
    expect(evaluateScope('t', { path: 'anything' }, {}, { workspaceRoot: root })).toEqual({
      ok: true,
    });
  });

  it('passes an absent argument by default', () => {
    expect(evaluateScope('t', {}, { path: { enum: ['a'] } }, { workspaceRoot: root })).toEqual({
      ok: true,
    });
  });

  it('fails a required argument when it is absent', () => {
    expect(evaluateScope('t', {}, { path: { required: true } }, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'path',
      reason: 'is required',
    });
  });

  it('fails a required argument when it is null', () => {
    expect(
      evaluateScope('t', { path: null }, { path: { required: true } }, { workspaceRoot: root }),
    ).toEqual({ ok: false, arg: 'path', reason: 'is required' });
  });

  it('enforces enum membership', () => {
    const scope = { detail: { enum: ['minimal', 'standard'] } };
    expect(evaluateScope('t', { detail: 'standard' }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { detail: 'full' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'detail',
      reason: 'must be one of: minimal, standard',
    });
  });

  it('enforces pattern matches', () => {
    const scope = { model: { pattern: '^claude-' } };
    expect(evaluateScope('t', { model: 'claude-3' }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { model: 'gpt-4' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'model',
      reason: 'does not match /^claude-/',
    });
  });

  it('fails an invalid pattern closed', () => {
    expect(
      evaluateScope('t', { model: 'x' }, { model: { pattern: '[' } }, { workspaceRoot: root }),
    ).toEqual({ ok: false, arg: 'model', reason: 'has an invalid pattern' });
  });

  it('enforces string length bounds', () => {
    const scope = { message: { minLength: 2, maxLength: 4 } };
    expect(evaluateScope('t', { message: 'abc' }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { message: 'a' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'message',
      reason: 'must be at least 2 characters',
    });
    expect(evaluateScope('t', { message: 'abcde' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'message',
      reason: 'must be at most 4 characters',
    });
  });

  it('enforces numeric bounds', () => {
    const scope = { timeoutMs: { min: 1, max: 60000 } };
    expect(evaluateScope('t', { timeoutMs: 1000 }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { timeoutMs: 0 }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'timeoutMs',
      reason: 'must be at least 1',
    });
    expect(evaluateScope('t', { timeoutMs: 60001 }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'timeoutMs',
      reason: 'must be at most 60000',
    });
  });

  it('fails a type mismatch closed', () => {
    expect(
      evaluateScope('t', { message: 5 }, { message: { maxLength: 10 } }, { workspaceRoot: root }),
    ).toEqual({ ok: false, arg: 'message', reason: 'must be a string' });
    expect(
      evaluateScope('t', { timeoutMs: '5' }, { timeoutMs: { max: 10 } }, { workspaceRoot: root }),
    ).toEqual({ ok: false, arg: 'timeoutMs', reason: 'must be a finite number' });
  });

  it('passes a relative path inside the allowed prefix', () => {
    expect(
      evaluateScope(
        't',
        { path: 'work/a.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: true });
  });

  it('fails a parent-directory escape', () => {
    expect(
      evaluateScope(
        't',
        { path: '../escape.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('fails an absolute path outside the workspace prefix', () => {
    expect(
      evaluateScope(
        't',
        { path: '/etc/passwd' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('does not match a sibling prefix that shares a name', () => {
    expect(
      evaluateScope(
        't',
        { path: 'workspace/a.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('passes a non-existent path under an allowed parent', () => {
    expect(
      evaluateScope(
        't',
        { path: 'work/new/file.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: true });
  });

  it('fails a non-existent path outside the allowed prefix', () => {
    expect(
      evaluateScope(
        't',
        { path: 'other/new/file.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('fails a symlink that escapes the allowed prefix', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(root, 'work', 'link.txt'));
    expect(
      evaluateScope(
        't',
        { path: 'work/link.txt' },
        { path: { pathPrefix: 'work' } },
        { workspaceRoot: root },
      ),
    ).toEqual({ ok: false, arg: 'path', reason: 'must be under work' });
  });

  it('fails when arguments are not an object', () => {
    expect(evaluateScope('t', 'nope', { path: { enum: ['a'] } }, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: '<args>',
      reason: 'arguments must be an object',
    });
  });

  it('ands multiple constraints on one argument', () => {
    const scope = { message: { minLength: 2, pattern: '^hi' } };
    expect(evaluateScope('t', { message: 'hi' }, scope, { workspaceRoot: root })).toEqual({
      ok: true,
    });
    expect(evaluateScope('t', { message: 'yo' }, scope, { workspaceRoot: root })).toEqual({
      ok: false,
      arg: 'message',
      reason: 'does not match /^hi/',
    });
  });
});
