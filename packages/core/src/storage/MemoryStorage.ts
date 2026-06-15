import type { Storage } from './Storage.js';

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
    const needle = `${base}/`;
    const children = new Set<string>();
    for (const fullKey of this.map.keys()) {
      if (!fullKey.startsWith(needle)) continue;
      const rest = fullKey.slice(needle.length);
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

  scope(prefix: string): Storage {
    return new MemoryStorage(this.map, this.full(prefix));
  }
}
