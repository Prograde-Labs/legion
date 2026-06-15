import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Storage } from './Storage.js';

export class FileStorage implements Storage {
  constructor(private root: string) {}

  private path(key: string): string {
    return join(this.root, key);
  }

  async read(key: string): Promise<string | null> {
    try {
      return await readFile(this.path(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(key: string, value: string): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value, 'utf8');
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const entries = await readdir(this.path(prefix), { withFileTypes: true });
      return entries.map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.read(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.write(key, JSON.stringify(value, null, 2));
  }

  scope(prefix: string): Storage {
    return new FileStorage(join(this.root, prefix));
  }
}
