function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function fail(path: string, reason: string): never {
  throw new TypeError(`Value at ${path} is not JSON-safe: ${reason}`);
}

interface InspectedObject {
  isArray: boolean;
  prototype: object | null;
  descriptors: PropertyDescriptorMap;
}

function inspectObject(value: object, path: string): InspectedObject {
  try {
    return {
      isArray: Array.isArray(value),
      prototype: Object.getPrototypeOf(value) as object | null,
      descriptors: Object.getOwnPropertyDescriptors(value),
    };
  } catch {
    fail(path, 'unable to inspect object properties');
  }
}

function cloneJsonSafeValue(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'number must be finite');
    return value;
  }
  if (typeof value !== 'object') fail(path, `${typeof value} values are unsupported`);
  if (ancestors.has(value)) fail(path, `cycle detected at ${path}`);

  const { isArray, prototype, descriptors } = inspectObject(value, path);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    fail(path, 'only plain objects are supported');
  }

  const keys = Reflect.ownKeys(descriptors);
  const symbol = keys.find((key): key is symbol => typeof key === 'symbol');
  if (symbol) fail(path, `symbol key ${String(symbol)} is unsupported`);

  ancestors.add(value);
  try {
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor ||
        'get' in lengthDescriptor ||
        'set' in lengthDescriptor ||
        typeof lengthDescriptor.value !== 'number' ||
        !Number.isInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        fail(path, 'array length descriptor is invalid');
      }
      const length = lengthDescriptor.value;
      for (const key of keys) {
        if (typeof key !== 'string' || key === 'length') continue;
        const descriptor = descriptors[key]!;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= length) {
          fail(childPath(path, key), `custom array property ${key} is unsupported`);
        }
        if (!descriptor.enumerable) {
          fail(`${path}[${index}]`, 'non-enumerable properties are unsupported');
        }
      }

      const clone = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const itemPath = `${path}[${index}]`;
        const descriptor = descriptors[String(index)];
        if (!descriptor) fail(itemPath, 'sparse array entries are unsupported');
        if ('get' in descriptor || 'set' in descriptor) {
          fail(itemPath, 'accessor properties are unsupported');
        }
        clone[index] = cloneJsonSafeValue(descriptor.value, itemPath, ancestors);
      }
      return clone;
    }

    const clone = Object.create(prototype) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const descriptor = descriptors[key]!;
      const propertyPath = childPath(path, key);
      if (!descriptor.enumerable) {
        fail(propertyPath, 'non-enumerable properties are unsupported');
      }
      if ('get' in descriptor || 'set' in descriptor) {
        fail(propertyPath, 'accessor properties are unsupported');
      }
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonSafeValue(descriptor.value, propertyPath, ancestors),
        writable: true,
      });
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

export function cloneJsonSafe<T>(value: T, path = '$'): T {
  return cloneJsonSafeValue(value, path, new Set()) as T;
}

export function assertJsonSafe(value: unknown, path = '$'): void {
  void cloneJsonSafe(value, path);
}
