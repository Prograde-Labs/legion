import { Ajv, type ValidateFunction } from 'ajv';
import type {
  FailureMode,
  JSONSchema,
  MiddlewareDefinition,
  MiddlewareDefinitionSummary,
  MiddlewareHooks,
  MiddlewareInstanceConfig,
} from '@legion/types';
import { LegionError } from '../errors/LegionError.js';
import type { MiddlewareConfigurationValidator } from '../tools/Tool.js';
import { cloneJsonSafe } from './json.js';

interface Registration {
  definition: MiddlewareDefinition;
  source: string;
  validator: ValidateFunction;
}

interface NormalizedDefinition {
  type: unknown;
  displayName: unknown;
  description: unknown;
  defaultFailureMode: unknown;
  configSchema: unknown;
  hooks: unknown;
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Middleware definition ${field} must be a non-empty string`);
  }
}

function requireFailureMode(value: unknown): asserts value is FailureMode {
  if (value !== 'open' && value !== 'closed') {
    throw new TypeError('Middleware definition defaultFailureMode must be open or closed');
  }
}

function normalizeDefinition(value: unknown): NormalizedDefinition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Middleware definition must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Middleware definition must be a plain object');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Middleware definition must not have symbol properties');
  }

  const allowed = new Set([
    'type',
    'displayName',
    'description',
    'defaultFailureMode',
    'configSchema',
    'hooks',
  ]);
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowed.has(name)) {
      throw new TypeError(`Middleware definition property ${name} is unsupported`);
    }
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError(`Middleware definition property ${name} must not be an accessor`);
    }
    normalized[name] = descriptor.value;
  }
  return normalized as unknown as NormalizedDefinition;
}

function normalizeHooks(value: unknown): MiddlewareHooks<unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Middleware definition hooks must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Middleware definition hooks must be a plain object');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Middleware definition hooks must not have symbol properties');
  }
  const allowed = new Set([
    'beforeSend',
    'beforeReceive',
    'afterReceive',
    'buildSystemPrompt',
    'afterSend',
  ]);
  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowed.has(name)) {
      throw new TypeError(`Middleware definition hook ${name} is unsupported`);
    }
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError(`Middleware definition hook ${name} must not be an accessor`);
    }
    const hook = descriptor.value;
    if (typeof hook !== 'function') {
      throw new TypeError(`Middleware definition hook ${name} must be a supported function`);
    }
    normalized[name] = hook;
  }
  return normalized as MiddlewareHooks<unknown>;
}

function detachedDefinition(registration: Registration): MiddlewareDefinition {
  const { definition } = registration;
  return {
    type: definition.type,
    displayName: definition.displayName,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    defaultFailureMode: definition.defaultFailureMode,
    configSchema: cloneJsonSafe(definition.configSchema),
    hooks: { ...definition.hooks },
  };
}

export class MiddlewareRegistry implements MiddlewareConfigurationValidator {
  private readonly registrations = new Map<string, Registration>();

  register(definition: MiddlewareDefinition, source: string): void {
    const normalized = normalizeDefinition(definition);
    requireNonEmptyString(normalized.type, 'type');
    requireNonEmptyString(normalized.displayName, 'displayName');
    requireNonEmptyString(source, 'source');
    if (normalized.description !== undefined && typeof normalized.description !== 'string') {
      throw new TypeError('Middleware definition description must be a string');
    }
    requireFailureMode(normalized.defaultFailureMode);
    const hooks = normalizeHooks(normalized.hooks);
    if (normalized.configSchema === null || typeof normalized.configSchema !== 'object') {
      throw new TypeError('Middleware definition configSchema type must be a non-empty string');
    }
    const configSchema = cloneJsonSafe(normalized.configSchema, '$.configSchema') as JSONSchema;
    const schemaType = Object.getOwnPropertyDescriptor(configSchema, 'type');
    if (!schemaType || 'get' in schemaType || 'set' in schemaType) {
      throw new TypeError('Middleware definition configSchema type must be a non-empty string');
    }
    const schemaTypeValue = schemaType.value;
    if (typeof schemaTypeValue !== 'string' || schemaTypeValue.trim() === '') {
      throw new TypeError('Middleware definition configSchema type must be a non-empty string');
    }
    if (normalized.type.startsWith('builtin:') && !source.startsWith('builtin:')) {
      throw new TypeError('Middleware types using builtin: prefix are reserved');
    }
    if (this.registrations.has(normalized.type)) {
      throw new LegionError(
        `Middleware already registered: ${normalized.type}`,
        'MIDDLEWARE_ALREADY_REGISTERED',
      );
    }

    const metadata = cloneJsonSafe({
      type: normalized.type,
      displayName: normalized.displayName,
      ...(normalized.description === undefined ? {} : { description: normalized.description }),
      defaultFailureMode: normalized.defaultFailureMode,
      configSchema,
      source,
    });
    const validator = new Ajv({ allErrors: true, strict: true }).compile(
      metadata.configSchema as JSONSchema,
    );
    if ((validator as ValidateFunction & { $async?: boolean }).$async === true) {
      throw new LegionError(
        `Async config schema is unsupported for middleware ${normalized.type}`,
        'MIDDLEWARE_CONFIG_INVALID',
      );
    }
    const storedDefinition: MiddlewareDefinition = {
      type: metadata.type,
      displayName: metadata.displayName,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      defaultFailureMode: metadata.defaultFailureMode,
      configSchema: metadata.configSchema as JSONSchema,
      hooks,
    };

    this.registrations.set(normalized.type, { definition: storedDefinition, source, validator });
  }

  get(type: string): MiddlewareDefinition | undefined {
    const registration = this.registrations.get(type);
    return registration ? detachedDefinition(registration) : undefined;
  }

  validateConfig(type: string, config: unknown): string[] {
    let configSnapshot: unknown;
    try {
      configSnapshot = cloneJsonSafe(config);
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }

    const registration = this.registrations.get(type);
    if (!registration) return [`Middleware type unavailable: ${type}`];
    if (registration.validator(configSnapshot)) return [];
    return (registration.validator.errors ?? []).map(
      (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    );
  }

  async validate(instances: readonly MiddlewareInstanceConfig[]): Promise<void> {
    for (const instance of instances) {
      if (instance.enabled === false) continue;
      const errors = this.validateConfig(instance.type, instance.config);
      if (errors.length > 0) {
        throw new LegionError(
          `Invalid middleware configuration for instance ${instance.id}: ${errors.join('; ')}`,
          'MIDDLEWARE_CONFIG_INVALID',
        );
      }
    }
  }

  list(): MiddlewareDefinitionSummary[] {
    return [...this.registrations.values()].map((registration) => {
      const definition = detachedDefinition(registration);
      return {
        type: definition.type,
        displayName: definition.displayName,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        defaultFailureMode: definition.defaultFailureMode,
        configSchema: definition.configSchema,
        source: registration.source,
      };
    });
  }
}
