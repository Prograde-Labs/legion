import type { ArgScope, ToolPolicy, ToolScope } from '@legion-collective/types';
import type { AnyTool, ToolRegistryLike } from '../tools/Tool.js';

const CONSTRAINT_KEYS = [
  'required',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'min',
  'max',
  'pathPrefix',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArgScope(arg: string, value: unknown): string | null {
  if (!isPlainObject(value)) return `scope.${arg} must be an object`;

  for (const key of Object.keys(value)) {
    if (!(CONSTRAINT_KEYS as readonly string[]).includes(key)) {
      return `unknown constraint "${key}" for ${arg}`;
    }
  }

  const required = value['required'];
  if (required !== undefined && typeof required !== 'boolean') {
    return `scope.${arg}.required must be a boolean`;
  }

  const enumValues = value['enum'];
  if (enumValues !== undefined) {
    if (
      !Array.isArray(enumValues) ||
      enumValues.length === 0 ||
      enumValues.some((entry) => typeof entry !== 'string' || entry === '')
    ) {
      return `scope.${arg}.enum must be a non-empty array of strings`;
    }
  }

  const pattern = value['pattern'];
  if (pattern !== undefined) {
    if (typeof pattern !== 'string' || pattern === '') {
      return `scope.${arg}.pattern must be a non-empty string`;
    }
    try {
      new RegExp(pattern);
    } catch {
      return `scope.${arg}.pattern is not a valid regular expression`;
    }
  }

  for (const key of ['minLength', 'maxLength'] as const) {
    const bound = value[key];
    if (
      bound !== undefined &&
      (typeof bound !== 'number' ||
        !Number.isFinite(bound) ||
        !Number.isInteger(bound) ||
        bound < 0)
    ) {
      return `scope.${arg}.${key} must be a non-negative integer`;
    }
  }

  if (
    typeof value['minLength'] === 'number' &&
    typeof value['maxLength'] === 'number' &&
    value['minLength'] > value['maxLength']
  ) {
    return `scope.${arg}.minLength must not exceed maxLength`;
  }

  for (const key of ['min', 'max'] as const) {
    const bound = value[key];
    if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) {
      return `scope.${arg}.${key} must be a finite number`;
    }
  }

  if (
    typeof value['min'] === 'number' &&
    typeof value['max'] === 'number' &&
    value['min'] > value['max']
  ) {
    return `scope.${arg}.min must not exceed max`;
  }

  const pathPrefix = value['pathPrefix'];
  if (pathPrefix !== undefined && (typeof pathPrefix !== 'string' || pathPrefix === '')) {
    return `scope.${arg}.pathPrefix must be a non-empty string`;
  }

  return null;
}

export function validateToolPolicy(
  tool: AnyTool | undefined,
  value: unknown,
): { ok: true; policy: ToolPolicy } | { ok: false; error: string } {
  if (value === 'auto' || value === 'requires_approval') {
    return { ok: true, policy: value };
  }

  if (!isPlainObject(value)) {
    return { ok: false, error: 'policy must be "auto", "requires_approval", or an object' };
  }

  const policy = value['policy'];
  if (policy !== 'auto' && policy !== 'requires_approval') {
    return { ok: false, error: 'policy.policy must be "auto" or "requires_approval"' };
  }

  const scope = value['scope'];
  if (scope !== undefined) {
    if (!isPlainObject(scope)) {
      return { ok: false, error: 'policy.scope must be an object' };
    }

    const properties = tool?.parameters?.properties;
    const declared = isPlainObject(properties) ? new Set(Object.keys(properties)) : undefined;

    for (const [arg, rule] of Object.entries(scope)) {
      if (arg === '') {
        return { ok: false, error: 'scope argument names must be non-empty' };
      }
      if (declared && !declared.has(arg)) {
        return {
          ok: false,
          error: `unknown argument "${arg}" for tool ${tool?.name ?? '<unknown>'}`,
        };
      }
      const error = validateArgScope(arg, rule);
      if (error) return { ok: false, error };
    }
  }

  return { ok: true, policy: value as ToolPolicy };
}

export function validateToolsMap(
  registry: Pick<ToolRegistryLike, 'get'> | undefined,
  tools: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  for (const [name, value] of Object.entries(tools)) {
    const result = validateToolPolicy(registry?.get(name), value);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export type { ArgScope, ToolScope };
