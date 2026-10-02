import type { MiddlewareDefinition, MiddlewareInstanceConfig } from '@legion-collective/types';
import { LegionError } from '../errors/LegionError.js';
import { MiddlewareRegistry } from './MiddlewareRegistry.js';

function definition(overrides: Partial<MiddlewareDefinition> = {}): MiddlewareDefinition {
  return {
    type: 'labeler',
    displayName: 'Labeler',
    defaultFailureMode: 'closed',
    configSchema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
      additionalProperties: false,
    },
    hooks: { beforeSend: () => ({ kind: 'continue' }) },
    ...overrides,
  };
}

describe('MiddlewareRegistry', () => {
  it('registers metadata, validates config, and lists source and type', () => {
    const registry = new MiddlewareRegistry();
    registry.register(definition(), 'builtin:core');

    expect(registry.validateConfig('labeler', { label: 'safe' })).toEqual([]);
    expect(registry.validateConfig('labeler', { label: 42 })).toContain('/label must be string');
    expect(registry.list()).toEqual([
      expect.objectContaining({ type: 'labeler', source: 'builtin:core' }),
    ]);
    expect(registry.get('labeler')?.hooks.beforeSend).toBeTypeOf('function');
  });

  it('rejects duplicate types', () => {
    const registry = new MiddlewareRegistry();
    registry.register(definition(), 'builtin:core');

    expect(() => registry.register(definition(), 'builtin:other')).toThrow(/already registered/i);
  });

  it('does not publish a valid first batch entry when the second is invalid', () => {
    const registry = new MiddlewareRegistry();

    expect(() =>
      registry.registerBatch([
        { definition: definition({ type: 'first' }), source: 'builtin:first' },
        {
          definition: definition({ type: 'second', hooks: undefined }) as MiddlewareDefinition,
          source: 'builtin:second',
        },
      ]),
    ).toThrow(/hooks/i);
    expect(registry.list()).toEqual([]);
  });

  it('does not publish a batch containing duplicate types', () => {
    const registry = new MiddlewareRegistry();

    expect(() =>
      registry.registerBatch([
        { definition: definition({ type: 'duplicate' }), source: 'builtin:first' },
        { definition: definition({ type: 'duplicate' }), source: 'builtin:second' },
      ]),
    ).toThrow(/already registered/i);
    expect(registry.list()).toEqual([]);
  });

  it('does not publish earlier batch entries when a later type already exists', () => {
    const registry = new MiddlewareRegistry();
    registry.register(definition({ type: 'existing' }), 'builtin:existing');
    const before = registry.list();

    expect(() =>
      registry.registerBatch([
        { definition: definition({ type: 'new' }), source: 'builtin:new' },
        { definition: definition({ type: 'existing' }), source: 'builtin:duplicate' },
      ]),
    ).toThrow(/already registered/i);
    expect(registry.list()).toEqual(before);
    expect(registry.get('new')).toBeUndefined();
  });

  it('does not overwrite a registration inserted reentrantly during batch preparation', () => {
    const registry = new MiddlewareRegistry();
    let reentered = false;
    const trigger = new Proxy(definition({ type: 'other' }), {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          registry.register(
            definition({ type: 'claimed', displayName: 'Reentrant' }),
            'builtin:reentrant',
          );
        }
        return Reflect.ownKeys(target);
      },
    });

    expect(() =>
      registry.registerBatch([
        {
          definition: definition({ type: 'claimed', displayName: 'Outer' }),
          source: 'builtin:outer',
        },
        { definition: trigger, source: 'builtin:trigger' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(registry.list()).toEqual([
      expect.objectContaining({
        type: 'claimed',
        displayName: 'Reentrant',
        source: 'builtin:reentrant',
      }),
    ]);
    expect(registry.get('other')).toBeUndefined();
  });

  it.each([
    ['omitted', {}],
    ['undefined', { description: undefined }],
  ])('accepts an %s optional description', (_name, overrides) => {
    const registry = new MiddlewareRegistry();
    registry.register(definition(overrides), 'builtin:core');

    expect(registry.list()[0]).not.toHaveProperty('description');
  });

  it.each([
    ['function', { value: () => undefined }],
    ['undefined', { value: undefined }],
    ['Date', { value: new Date() }],
    ['class instance', { value: new (class Example {})() }],
    ['nonfinite number', { value: Infinity }],
    ['bigint', { value: 1n }],
    ['symbol', { value: Symbol('value') }],
  ])('rejects %s configuration values', (_name, config) => {
    const registry = new MiddlewareRegistry();
    registry.register(definition(), 'builtin:core');

    expect(registry.validateConfig('labeler', config)).toEqual([
      expect.stringMatching(/not JSON-safe/),
    ]);
  });

  it('rejects cycles without overflowing', () => {
    const registry = new MiddlewareRegistry();
    registry.register(definition(), 'builtin:core');
    const config: Record<string, unknown> = {};
    config.self = config;

    expect(registry.validateConfig('labeler', config)).toEqual([
      expect.stringMatching(/cycle.*\$\.self/i),
    ]);
  });

  it.each([
    ['missing type', { type: undefined }],
    ['empty type', { type: '' }],
    ['missing displayName', { displayName: undefined }],
    ['empty displayName', { displayName: '' }],
    ['missing hooks', { hooks: undefined }],
    ['missing schema', { configSchema: undefined }],
    ['empty schema', { configSchema: {} }],
    ['missing failure mode', { defaultFailureMode: undefined }],
    ['invalid failure mode', { defaultFailureMode: 'sometimes' }],
  ])('rejects malformed definition with %s', (_name, overrides) => {
    const registry = new MiddlewareRegistry();

    expect(() =>
      registry.register(definition(overrides as Partial<MiddlewareDefinition>), 'builtin:core'),
    ).toThrow();
  });

  it('accepts an empty hooks object', () => {
    const registry = new MiddlewareRegistry();

    expect(() => registry.register(definition({ hooks: {} }), 'builtin:core')).not.toThrow();
    expect(registry.get('labeler')?.hooks).toEqual({});
  });

  it('accepts a null-prototype definition object', () => {
    const candidate = Object.assign(Object.create(null), definition()) as MiddlewareDefinition;

    expect(() => new MiddlewareRegistry().register(candidate, 'builtin:core')).not.toThrow();
  });

  it('rejects non-plain definitions, symbol keys, inherited fields, and unknown keys', () => {
    class CustomDefinition {}
    const custom = Object.assign(new CustomDefinition(), definition());
    const symbolKey = Object.assign(definition(), { [Symbol('extra')]: true });
    const { type: _type, ...withoutType } = definition();
    const inheritedType = Object.assign(Object.create({ type: 'labeler' }), withoutType);
    const unknownKey = Object.assign(definition(), { extra: true });

    for (const candidate of [custom, symbolKey, inheritedType, unknownKey]) {
      expect(() =>
        new MiddlewareRegistry().register(candidate as MiddlewareDefinition, 'builtin:core'),
      ).toThrow();
    }
  });

  it.each(['type', 'hooks', 'configSchema'] as const)(
    'rejects a stateful %s getter without invoking it or registering',
    (field) => {
      const registry = new MiddlewareRegistry();
      const candidate = definition() as unknown as Record<string, unknown>;
      let invocations = 0;
      Object.defineProperty(candidate, field, {
        enumerable: true,
        get() {
          invocations += 1;
          return field === 'type' ? 'labeler' : field === 'hooks' ? {} : { type: 'object' };
        },
      });

      expect(() =>
        registry.register(candidate as unknown as MiddlewareDefinition, 'builtin:core'),
      ).toThrow(/accessor/i);
      expect(invocations).toBe(0);
      expect(registry.list()).toEqual([]);
    },
  );

  it('rejects unsafe hook containers without invoking accessors', () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, 'beforeSend', {
      enumerable: true,
      get() {
        invoked = true;
        return () => ({ kind: 'continue' });
      },
    });
    const inherited = Object.create({ beforeSend: () => ({ kind: 'continue' }) }) as Record<
      string,
      unknown
    >;

    expect(() => registryWithHooks(accessor as MiddlewareDefinition['hooks'])).toThrow(/accessor/i);
    expect(invoked).toBe(false);
    expect(() => registryWithHooks(inherited as MiddlewareDefinition['hooks'])).toThrow(
      /plain object/i,
    );
  });

  it('reserves builtin types for trusted builtin sources', () => {
    const registry = new MiddlewareRegistry();

    for (const source of ['workspace:local', 'module:third-party', 'arbitrary']) {
      expect(() => registry.register(definition({ type: `builtin:${source}` }), source)).toThrow(
        /reserved/i,
      );
    }
    expect(() =>
      registry.register(definition({ type: 'builtin:trusted' }), 'builtin:core'),
    ).not.toThrow();
    expect(() => registry.register(definition({ type: 'ordinary' }), 'arbitrary')).not.toThrow();
  });

  it('returns errors for unavailable types', () => {
    expect(new MiddlewareRegistry().validateConfig('missing', {})).toEqual([
      expect.stringMatching(/unavailable.*missing/i),
    ]);
  });

  it('validates enabled instances and reports the first invalid instance', async () => {
    const registry = new MiddlewareRegistry();
    registry.register(definition(), 'builtin:core');
    const instances: MiddlewareInstanceConfig[] = [
      { id: 'off', type: 'missing', enabled: false, config: {} },
      { id: 'bad', type: 'labeler', config: { label: 1 } },
      { id: 'later', type: 'missing', config: {} },
    ];

    await expect(registry.validate(instances)).rejects.toMatchObject<Partial<LegionError>>({
      code: 'MIDDLEWARE_CONFIG_INVALID',
      message: expect.stringMatching(/bad.*\/label must be string/),
    });
  });

  it('rejects strict schema errors without partially registering', () => {
    const registry = new MiddlewareRegistry();
    const invalid = definition({ configSchema: { type: 'unknown' } });

    expect(() => registry.register(invalid, 'builtin:core')).toThrow();
    expect(registry.get('labeler')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('allows corrected registration after failed compilation with the same schema ID', () => {
    const registry = new MiddlewareRegistry();
    const schemaId = 'urn:legion:test:labeler';

    expect(() =>
      registry.register(
        definition({ configSchema: { $id: schemaId, type: 'object', unknownKeyword: true } }),
        'builtin:core',
      ),
    ).toThrow();
    expect(() =>
      registry.register(
        definition({ configSchema: { $id: schemaId, type: 'object' } }),
        'builtin:core',
      ),
    ).not.toThrow();
  });

  it('rejects async schemas without registering or causing an unhandled rejection', async () => {
    const registry = new MiddlewareRegistry();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      expect(() =>
        registry.register(
          definition({ configSchema: { $async: true, type: 'object' } }),
          'builtin:core',
        ),
      ).toThrow(expect.objectContaining({ code: 'MIDDLEWARE_CONFIG_INVALID' }));
      expect(registry.get('labeler')).toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('validates a stable config snapshot without invoking Proxy gets', () => {
    const registry = new MiddlewareRegistry();
    registry.register(definition(), 'builtin:core');
    let gets = 0;
    const config = new Proxy(
      { label: 'safe' },
      {
        get() {
          gets += 1;
          throw new Error('get trap must not run');
        },
      },
    );

    expect(registry.validateConfig('labeler', config)).toEqual([]);
    expect(gets).toBe(0);
  });

  it('snapshots a Proxy schema without invoking property gets', () => {
    let gets = 0;
    const configSchema = new Proxy(
      { type: 'object' },
      {
        get() {
          gets += 1;
          throw new Error('get trap must not run');
        },
      },
    );

    expect(() =>
      new MiddlewareRegistry().register(definition({ configSchema }), 'builtin:core'),
    ).not.toThrow();
    expect(gets).toBe(0);
  });

  it('handles Proxy schema descriptor failures without partial registration', () => {
    const registry = new MiddlewareRegistry();
    const configSchema = new Proxy(
      { type: 'object' },
      {
        ownKeys() {
          throw new Error('descriptor trap');
        },
      },
    );

    expect(() => registry.register(definition({ configSchema }), 'builtin:core')).toThrow(
      /not JSON-safe.*inspect/i,
    );
    expect(registry.list()).toEqual([]);
  });

  it.each([
    ['absent', { properties: {} }],
    ['empty', { type: '' }],
  ])('rejects config schemas with %s own type', (_name, configSchema) => {
    expect(() =>
      new MiddlewareRegistry().register(
        definition({ configSchema: configSchema as MiddlewareDefinition['configSchema'] }),
        'builtin:core',
      ),
    ).toThrow(/configSchema type/i);
  });

  it('rejects inherited and accessor schema types without invoking getters', () => {
    let invoked = false;
    const inherited = Object.assign(Object.create({ type: 'object' }), { properties: {} });
    const accessor = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        invoked = true;
        return 'object';
      },
    });

    expect(() =>
      new MiddlewareRegistry().register(definition({ configSchema: inherited }), 'builtin:core'),
    ).toThrow(/configSchema|JSON-safe/i);
    expect(() =>
      new MiddlewareRegistry().register(definition({ configSchema: accessor }), 'builtin:core'),
    ).toThrow(/configSchema|JSON-safe/i);
    expect(invoked).toBe(false);
  });

  it('snapshots schema metadata while preserving registered hook references', () => {
    const registry = new MiddlewareRegistry();
    const original = definition();
    const hook = original.hooks.beforeSend;
    registry.register(original, 'builtin:core');

    original.displayName = 'Mutated';
    original.configSchema.type = 'string';
    const first = registry.list()[0]!;
    first.displayName = 'Also mutated';
    first.configSchema.type = 'number';

    expect(registry.list()[0]).toMatchObject({
      displayName: 'Labeler',
      configSchema: { type: 'object' },
    });
    expect(registry.get('labeler')?.hooks.beforeSend).toBe(hook);
    expect(registry.validateConfig('labeler', { label: 'safe' })).toEqual([]);
  });

  it('does not invoke inherited toJSON while snapshotting registration metadata', () => {
    let invoked = false;
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value(this: object) {
        invoked = true;
        return this;
      },
    });

    try {
      expect(() => new MiddlewareRegistry().register(definition(), 'builtin:core')).not.toThrow();
      expect(invoked).toBe(false);
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
  });
});

function registryWithHooks(hooks: MiddlewareDefinition['hooks']): MiddlewareRegistry {
  const registry = new MiddlewareRegistry();
  registry.register(definition({ hooks }), 'builtin:core');
  return registry;
}
