import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  MiddlewareDefinition,
  MiddlewareDiagnostic,
  MiddlewareModuleConfig,
} from '@legion/types';
import { LegionError } from '../errors/LegionError.js';
import type { MiddlewareRegistry } from './MiddlewareRegistry.js';

export async function loadWorkspaceMiddleware(
  workspaceRoot: string,
  modules: readonly MiddlewareModuleConfig[],
  registry: MiddlewareRegistry,
): Promise<MiddlewareDiagnostic[]> {
  const diagnostics: MiddlewareDiagnostic[] = [];
  let canonicalRoot: string | undefined;

  for (const config of modules) {
    let id = '<invalid>';
    let modulePath = '<invalid>';

    try {
      id = ownNonEmptyString(config, 'id');
      modulePath = ownNonEmptyString(config, 'module');
      const source = `workspace:${modulePath}`;

      if (isAbsolute(modulePath)) {
        throw new TypeError('Middleware module path must be workspace-relative');
      }

      canonicalRoot ??= await realpath(workspaceRoot);
      const unresolvedTarget = resolve(canonicalRoot, modulePath);
      requireContainedPath(canonicalRoot, unresolvedTarget);
      const target = await realpath(unresolvedTarget);
      requireContainedPath(canonicalRoot, target);

      const namespace: unknown = await import(pathToFileURL(target).href);
      const namespaceDefault = ownDataProperty(namespace, 'default');
      if (
        namespaceDefault === undefined ||
        namespaceDefault === null ||
        typeof namespaceDefault !== 'object' ||
        Array.isArray(namespaceDefault)
      ) {
        throw new TypeError('Middleware module must have a default object export');
      }

      const exportedType = ownDataProperty(namespaceDefault, 'type');
      if (exportedType !== id) {
        throw new TypeError(
          `Configured middleware id "${id}" does not match exported type "${displayValue(exportedType)}"`,
        );
      }

      registry.register(namespaceDefault as MiddlewareDefinition, source);
      diagnostics.push({
        type: id,
        source,
        status: 'loaded',
        configurationErrors: [],
      });
    } catch (error) {
      const source = `workspace:${modulePath}`;
      const diagnostic: MiddlewareDiagnostic = {
        type: id,
        source,
        status: 'error',
        error: safeErrorMessage(error),
        configurationErrors: [],
      };
      throw new LegionError(
        `Failed to load middleware "${id}" from "${modulePath}": ${diagnostic.error}`,
        'MIDDLEWARE_LOAD_FAILED',
      );
    }
  }

  return diagnostics;
}

function ownNonEmptyString(value: unknown, field: 'id' | 'module'): string {
  const candidate = ownDataProperty(value, field);
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new TypeError(`Middleware module ${field} must be an own non-empty string`);
  }
  return candidate;
}

function ownDataProperty(value: unknown, property: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (!descriptor || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function requireContainedPath(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new TypeError('Middleware module path must remain within workspace root');
  }
}

function displayValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : typeof value;
}

function safeErrorMessage(error: unknown): string {
  try {
    const message = ownDataProperty(error, 'message');
    return typeof message === 'string' && message !== ''
      ? message
      : 'Unknown middleware load error';
  } catch {
    return 'Unknown middleware load error';
  }
}
