import type { Storage } from './Storage.js';
import { withKeyedLock } from './keyed-lock.js';

const backingLocks = new WeakMap<Map<string, string>, Map<string, Promise<void>>>();

function joinKey(prefix: string, key: string): string {
  if (!prefix) return key;
  return `${prefix.replace(/\/$/, '')}/${key}`;
}

export class MemoryStorage implements Storage {
  private map: Map<string, string>;
  private prefix: string;

  constructor(map: Map<string, string> = new Map(), prefix = '') {
    this.map = map;
    this.prefix = prefix;
  }

  private full(key: string): string {
    return joinKey(this.prefix, key);
  }

  async read(key: string): Promise<string | null> {
    return this.map.has(this.full(key)) ? this.map.get(this.full(key))! : null;
  }

  async write(key: string, value: string): Promise<void> {
    this.map.set(this.full(key), value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(this.full(key));
  }

  async exists(key: string): Promise<boolean> {
    return this.map.has(this.full(key));
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.full(prefix).replace(/\/$/, '');
    const needle = base ? `${base}/` : '';
    const children = new Set<string>();
    for (const fullKey of this.map.keys()) {
      if (needle && !fullKey.startsWith(needle)) continue;
      const rest = needle ? fullKey.slice(needle.length) : fullKey;
      const firstSegment = rest.split('/')[0];
      if (firstSegment) children.add(firstSegment);
    }
    return [...children];
  }

  async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.read(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.write(key, JSON.stringify(value, null, 2));
  }

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let locks = backingLocks.get(this.map);
    if (!locks) {
      locks = new Map();
      backingLocks.set(this.map, locks);
    }
    try {
      return await withKeyedLock(locks, this.full(key), operation);
    } finally {
      if (locks.size === 0) backingLocks.delete(this.map);
    }
  }

  scope(prefix: string): Storage {
    return new MemoryStorage(this.map, this.full(prefix));
  }
}
