import { Ajv, type ValidateFunction } from 'ajv';
import type {
  JSONSchema,
  MiddlewareDefinition,
  MiddlewareDefinitionSummary,
  MiddlewareHooks,
  MiddlewareInstanceConfig,
} from '@legion/types';
import { LegionError } from '../errors/LegionError.js';
import type { MiddlewareConfigurationValidator } from '../tools/Tool.js';
import { assertJsonSafe } from './json.js';

interface Registration {
  definition: MiddlewareDefinition;
  source: string;
  validator: ValidateFunction;
}

function cloneJson<T>(value: T): T {
  assertJsonSafe(value);
  return cloneJsonValue(value) as T;
}

function cloneJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) =>
      cloneJsonValue(descriptors[String(index)]!.value),
    );
  }

  const clone = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneJsonValue(descriptor.value),
      writable: true,
    });
  }
  return clone;
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Middleware definition ${field} must be a non-empty string`);
  }
}

function validateHooks(value: unknown): asserts value is MiddlewareHooks<unknown> {
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
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowed.has(name)) {
      throw new TypeError(`Middleware definition hook ${name} is unsupported`);
    }
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError(`Middleware definition hook ${name} must not be an accessor`);
    }
    if (!descriptor.enumerable || typeof descriptor.value !== 'function') {
      throw new TypeError(`Middleware definition hook ${name} must be a supported function`);
    }
  }
}

function detachedDefinition(registration: Registration): MiddlewareDefinition {
  const { definition } = registration;
  return {
    type: definition.type,
    displayName: definition.displayName,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    defaultFailureMode: definition.defaultFailureMode,
    configSchema: cloneJson(definition.configSchema),
    hooks: { ...definition.hooks },
  };
}

export class MiddlewareRegistry implements MiddlewareConfigurationValidator {
  private readonly registrations = new Map<string, Registration>();

  register(definition: MiddlewareDefinition, source: string): void {
    requireNonEmptyString(definition?.type, 'type');
    requireNonEmptyString(definition.displayName, 'displayName');
    requireNonEmptyString(source, 'source');
    if (definition.description !== undefined && typeof definition.description !== 'string') {
      throw new TypeError('Middleware definition description must be a string');
    }
    if (definition.defaultFailureMode !== 'open' && definition.defaultFailureMode !== 'closed') {
      throw new TypeError('Middleware definition defaultFailureMode must be open or closed');
    }
    validateHooks(definition.hooks);
    if (definition.configSchema === null || typeof definition.configSchema !== 'object') {
      throw new TypeError('Middleware definition configSchema type must be a non-empty string');
    }
    const schemaType = Object.getOwnPropertyDescriptor(definition.configSchema, 'type');
    if (
      !schemaType ||
      'get' in schemaType ||
      'set' in schemaType ||
      typeof schemaType.value !== 'string' ||
      schemaType.value.trim() === ''
    ) {
      throw new TypeError('Middleware definition configSchema type must be a non-empty string');
    }
    if (definition.type.startsWith('builtin:') && !source.startsWith('builtin:')) {
      throw new TypeError('Middleware types using builtin: prefix are reserved');
    }
    if (this.registrations.has(definition.type)) {
      throw new LegionError(
        `Middleware already registered: ${definition.type}`,
        'MIDDLEWARE_ALREADY_REGISTERED',
      );
    }

    const metadata = cloneJson({
      type: definition.type,
      displayName: definition.displayName,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      defaultFailureMode: definition.defaultFailureMode,
      configSchema: definition.configSchema,
      source,
    });
    const validator = new Ajv({ allErrors: true, strict: true }).compile(
      metadata.configSchema as JSONSchema,
    );
    const storedDefinition: MiddlewareDefinition = {
      type: metadata.type,
      displayName: metadata.displayName,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      defaultFailureMode: metadata.defaultFailureMode,
      configSchema: metadata.configSchema as JSONSchema,
      hooks: { ...definition.hooks },
    };

    this.registrations.set(definition.type, { definition: storedDefinition, source, validator });
  }

  get(type: string): MiddlewareDefinition | undefined {
    const registration = this.registrations.get(type);
    return registration ? detachedDefinition(registration) : undefined;
  }

  validateConfig(type: string, config: unknown): string[] {
    try {
      assertJsonSafe(config);
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }

    const registration = this.registrations.get(type);
    if (!registration) return [`Middleware type unavailable: ${type}`];
    if (registration.validator(config)) return [];
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
