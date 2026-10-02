import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  MiddlewareDefinition,
  MiddlewareDiagnostic,
  MiddlewareModuleConfig,
} from '@legion-collective/types';
import { LegionError } from '../errors/LegionError.js';
import { MiddlewareRegistry } from './MiddlewareRegistry.js';

interface StagedMiddleware {
  definition: MiddlewareDefinition;
  source: string;
}

export class MiddlewareLoadError extends LegionError {
  readonly diagnostics: MiddlewareDiagnostic[];
  readonly cause: unknown;

  constructor(message: string, diagnostics: readonly MiddlewareDiagnostic[], cause: unknown) {
    super(message, 'MIDDLEWARE_LOAD_FAILED');
    this.diagnostics = diagnostics.map(detachDiagnostic);
    this.cause = cause;
    Object.defineProperty(this, 'cause', { enumerable: false });
  }
}

export async function loadWorkspaceMiddleware(
  workspaceRoot: string,
  modules: readonly MiddlewareModuleConfig[],
  registry: MiddlewareRegistry,
): Promise<MiddlewareDiagnostic[]> {
  const validationRegistry = seedValidationRegistry(registry);
  const diagnostics: MiddlewareDiagnostic[] = [];
  const staged: StagedMiddleware[] = [];
  let canonicalRoot: string | undefined;

  for (const config of modules) {
    let id = '<invalid>';
    let modulePath = '<invalid>';
    let source = 'workspace:<invalid>';
    let publicError = 'Invalid middleware module configuration';

    try {
      id = ownNonEmptyString(config, 'id');
      modulePath = ownNonEmptyString(config, 'module');
      source = publicSource(modulePath);

      if (isAbsolute(modulePath)) {
        publicError = 'Middleware module path must be workspace-relative';
        throw new TypeError(publicError);
      }

      let unresolvedTarget: string;
      try {
        canonicalRoot ??= await realpath(workspaceRoot);
        unresolvedTarget = resolve(canonicalRoot, modulePath);
      } catch (error) {
        publicError = 'Middleware module could not be resolved';
        throw error;
      }

      publicError = 'Middleware module path must remain within workspace root';
      requireContainedPath(canonicalRoot, unresolvedTarget);

      let target: string;
      try {
        target = await realpath(unresolvedTarget);
      } catch (error) {
        publicError = 'Middleware module could not be resolved';
        throw error;
      }

      // Workspace modules are trusted startup configuration. These checks prevent accidental
      // traversal or symlink escape at resolution time; later workspace mutation is outside the
      // security boundary, and normal file URLs preserve module-relative imports.
      publicError = 'Middleware module path must remain within workspace root';
      requireContainedPath(canonicalRoot, target);

      let namespace: unknown;
      try {
        namespace = await import(pathToFileURL(target).href);
      } catch (error) {
        publicError = 'Middleware module import failed';
        throw error;
      }

      publicError = 'Middleware module must have a default object export';
      const namespaceDefault = ownDataProperty(namespace, 'default');
      if (
        namespaceDefault === undefined ||
        namespaceDefault === null ||
        typeof namespaceDefault !== 'object' ||
        Array.isArray(namespaceDefault)
      ) {
        throw new TypeError(publicError);
      }

      const exportedType = ownDataProperty(namespaceDefault, 'type');
      publicError = `Configured middleware id "${id}" does not match exported type "${displayValue(exportedType)}"`;
      if (exportedType !== id) throw new TypeError(publicError);

      try {
        validationRegistry.register(namespaceDefault as MiddlewareDefinition, source);
      } catch (error) {
        publicError = publicDefinitionError(error, id);
        throw error;
      }

      const definition = validationRegistry.get(id);
      if (!definition) {
        publicError = `Middleware definition validation failed for "${id}"`;
        throw new TypeError(publicError);
      }
      staged.push({ definition, source });
      diagnostics.push({
        type: id,
        source,
        status: 'loaded',
        configurationErrors: [],
      });
    } catch (error) {
      const diagnostic: MiddlewareDiagnostic = {
        type: id,
        source,
        status: 'error',
        error: publicError,
        configurationErrors: [],
      };
      throw new MiddlewareLoadError(
        `Failed to load middleware "${id}" from "${publicModulePath(modulePath)}": ${publicError}`,
        [...diagnostics, diagnostic],
        error,
      );
    }
  }

  try {
    registry.registerBatch(staged);
  } catch (error) {
    const publicError = 'Middleware destination changed during loading';
    const diagnostic: MiddlewareDiagnostic = {
      type: '<batch>',
      source: 'workspace:<batch>',
      status: 'error',
      error: publicError,
      configurationErrors: [],
    };
    throw new MiddlewareLoadError(
      `Failed to commit workspace middleware: ${publicError}`,
      [...diagnostics, diagnostic],
      error,
    );
  }
  return diagnostics.map(detachDiagnostic);
}

function seedValidationRegistry(registry: MiddlewareRegistry): MiddlewareRegistry {
  const validationRegistry = new MiddlewareRegistry();
  for (const summary of registry.list()) {
    const definition = registry.get(summary.type);
    if (!definition) {
      throw new LegionError(
        `Middleware registry snapshot missing definition: ${summary.type}`,
        'INVARIANT_VIOLATION',
      );
    }
    validationRegistry.register(definition, summary.source);
  }
  return validationRegistry;
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

function publicSource(modulePath: string): string {
  return isAbsolute(modulePath) ? 'workspace:<invalid>' : `workspace:${modulePath}`;
}

function publicModulePath(modulePath: string): string {
  return isAbsolute(modulePath) ? '<invalid>' : modulePath;
}

function publicDefinitionError(error: unknown, id: string): string {
  return error instanceof LegionError && error.code === 'MIDDLEWARE_ALREADY_REGISTERED'
    ? `Middleware type "${id}" is already registered`
    : `Middleware definition validation failed for "${id}"`;
}

function displayValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : typeof value;
}

function detachDiagnostic(diagnostic: MiddlewareDiagnostic): MiddlewareDiagnostic {
  return {
    type: diagnostic.type,
    source: diagnostic.source,
    status: diagnostic.status,
    ...(diagnostic.error === undefined ? {} : { error: diagnostic.error }),
    configurationErrors: diagnostic.configurationErrors.map((configurationError) => ({
      participantId: configurationError.participantId,
      instanceId: configurationError.instanceId,
      errors: [...configurationError.errors],
    })),
  };
}
