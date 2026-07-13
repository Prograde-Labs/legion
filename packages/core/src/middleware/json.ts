function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function fail(path: string, reason: string): never {
  throw new TypeError(`Value at ${path} is not JSON-safe: ${reason}`);
}

export function assertJsonSafe(
  value: unknown,
  path = '$',
  ancestors: Set<object> = new Set(),
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'number must be finite');
    return;
  }
  if (typeof value !== 'object') fail(path, `${typeof value} values are unsupported`);
  if (ancestors.has(value)) fail(path, `cycle detected at ${path}`);

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    fail(path, 'only plain objects are supported');
  }

  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) fail(path, `symbol key ${String(symbols[0])} is unsupported`);

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      for (const key of Object.keys(descriptors)) {
        if (key === 'length') continue;
        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          String(index) !== key ||
          index >= value.length
        ) {
          fail(childPath(path, key), `custom array property ${key} is unsupported`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = `${path}[${index}]`;
        const descriptor = descriptors[String(index)];
        if (!descriptor) fail(itemPath, 'sparse array entries are unsupported');
        if ('get' in descriptor || 'set' in descriptor) {
          fail(itemPath, 'accessor properties are unsupported');
        }
        assertJsonSafe(descriptor.value, itemPath, ancestors);
      }
      return;
    }

    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key]!;
      const propertyPath = childPath(path, key);
      if ('get' in descriptor || 'set' in descriptor) {
        fail(propertyPath, 'accessor properties are unsupported');
      }
      if (descriptor.enumerable) assertJsonSafe(descriptor.value, propertyPath, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}
