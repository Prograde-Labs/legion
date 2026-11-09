import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { ArgScope, ToolScope } from '@legion-collective/types';

export interface ScopeContext {
  workspaceRoot: string;
}

export type ScopeResult = { ok: true } | { ok: false; arg: string; reason: string };

const CONSTRAINT_KEYS = new Set([
  'required',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'min',
  'max',
  'pathPrefix',
]);

function fail(arg: string, reason: string): ScopeResult {
  return { ok: false, arg, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

/**
 * Validates a stored rule before using it. Loaded configs are not revalidated at
 * boot, so a malformed shape must fail closed here rather than throw or pass.
 */
function validateRule(arg: string, rule: unknown): ScopeResult | null {
  if (!isPlainObject(rule)) return fail(arg, 'rule must be an object');

  for (const key of Object.keys(rule)) {
    if (!CONSTRAINT_KEYS.has(key)) return fail(arg, `has an unknown constraint "${key}"`);
  }

  const { required, enum: enumValues, pattern, minLength, maxLength, min, max, pathPrefix } = rule;

  if (required !== undefined && typeof required !== 'boolean') {
    return fail(arg, 'required must be a boolean');
  }
  if (enumValues !== undefined) {
    if (
      !Array.isArray(enumValues) ||
      enumValues.length === 0 ||
      !enumValues.every((entry) => typeof entry === 'string' && entry.length > 0)
    ) {
      return fail(arg, 'enum must be a non-empty array of non-empty strings');
    }
  }
  if (pattern !== undefined) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      return fail(arg, 'pattern must be a non-empty string');
    }
    try {
      new RegExp(pattern);
    } catch {
      return fail(arg, 'has an invalid pattern');
    }
  }
  if (minLength !== undefined && !isNonNegativeInteger(minLength)) {
    return fail(arg, 'minLength must be a non-negative integer');
  }
  if (maxLength !== undefined && !isNonNegativeInteger(maxLength)) {
    return fail(arg, 'maxLength must be a non-negative integer');
  }
  if (min !== undefined && !isFiniteNumber(min)) {
    return fail(arg, 'min must be a finite number');
  }
  if (max !== undefined && !isFiniteNumber(max)) {
    return fail(arg, 'max must be a finite number');
  }
  if (pathPrefix !== undefined && (typeof pathPrefix !== 'string' || pathPrefix.length === 0)) {
    return fail(arg, 'pathPrefix must be a non-empty string');
  }

  return null;
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
    // `path.resolve` collapses `..` lexically, before the OS resolves symlinks.
    // Reject parent segments outright so `link/../file` cannot bypass containment.
    if (value.split(/[\\/]/).includes('..')) {
      return fail(arg, `must be under ${rule.pathPrefix}`);
    }
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
  if (!isPlainObject(scope)) return fail('<scope>', 'scope must be an object');
  if (!isPlainObject(args)) return fail('<args>', 'arguments must be an object');

  for (const [arg, rule] of Object.entries(scope)) {
    const invalid = validateRule(arg, rule);
    if (invalid) return invalid;

    const present = Object.hasOwn(args, arg) && args[arg] !== undefined && args[arg] !== null;
    if (!present) {
      if ((rule as ArgScope).required) return fail(arg, 'is required');
      continue;
    }
    const result = evaluateArg(arg, args[arg], rule as ArgScope, ctx);
    if (!result.ok) return result;
  }

  return { ok: true };
}
