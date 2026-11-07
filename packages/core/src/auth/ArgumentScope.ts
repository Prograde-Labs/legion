import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { ArgScope, ToolScope } from '@legion-collective/types';

export interface ScopeContext {
  workspaceRoot: string;
}

export type ScopeResult = { ok: true } | { ok: false; arg: string; reason: string };

function fail(arg: string, reason: string): ScopeResult {
  return { ok: false, arg, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when the path exists as a directory entry, without following symlinks.
 * A dangling symlink counts as existing, so realpathSync will fail on it.
 */
function entryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Resolves symlinks in the deepest existing ancestor and appends missing segments. */
function realpathWithMissingTail(target: string): string {
  let current = target;
  const tail: string[] = [];
  while (!entryExists(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  const base = entryExists(current) ? realpathSync(current) : current;
  return join(base, ...tail);
}

function resolvePath(value: string, ctx: ScopeContext): string {
  return realpathWithMissingTail(resolve(ctx.workspaceRoot, value));
}

function evaluateArg(arg: string, value: unknown, rule: ArgScope, ctx: ScopeContext): ScopeResult {
  if (
    rule.enum ||
    rule.pattern !== undefined ||
    rule.minLength !== undefined ||
    rule.maxLength !== undefined
  ) {
    if (typeof value !== 'string') return fail(arg, 'must be a string');
    if (rule.enum && !rule.enum.includes(value)) {
      return fail(arg, `must be one of: ${rule.enum.join(', ')}`);
    }
    if (rule.pattern !== undefined) {
      let expression: RegExp;
      try {
        expression = new RegExp(rule.pattern);
      } catch {
        return fail(arg, 'has an invalid pattern');
      }
      if (!expression.test(value)) return fail(arg, `does not match /${rule.pattern}/`);
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      return fail(arg, `must be at least ${rule.minLength} characters`);
    }
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      return fail(arg, `must be at most ${rule.maxLength} characters`);
    }
  }

  if (rule.min !== undefined || rule.max !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(arg, 'must be a finite number');
    }
    if (rule.min !== undefined && value < rule.min) {
      return fail(arg, `must be at least ${rule.min}`);
    }
    if (rule.max !== undefined && value > rule.max) {
      return fail(arg, `must be at most ${rule.max}`);
    }
  }

  if (rule.pathPrefix !== undefined) {
    if (typeof value !== 'string') return fail(arg, 'must be a string');
    try {
      const prefix = resolvePath(rule.pathPrefix, ctx);
      const target = resolvePath(value, ctx);
      if (target !== prefix && !target.startsWith(prefix + sep)) {
        return fail(arg, `must be under ${rule.pathPrefix}`);
      }
    } catch {
      return fail(arg, 'could not be resolved');
    }
  }

  return { ok: true };
}

export function evaluateScope(
  _tool: string,
  args: unknown,
  scope: ToolScope,
  ctx: ScopeContext,
): ScopeResult {
  if (!isPlainObject(args)) return fail('<args>', 'arguments must be an object');

  for (const [arg, rule] of Object.entries(scope)) {
    const value = args[arg];
    const present = value !== undefined && value !== null;
    if (!present) {
      if (rule.required) return fail(arg, 'is required');
      continue;
    }
    const result = evaluateArg(arg, value, rule, ctx);
    if (!result.ok) return result;
  }

  return { ok: true };
}
