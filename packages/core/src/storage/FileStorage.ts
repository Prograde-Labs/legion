import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Storage } from './Storage.js';
import { withKeyedLock } from './keyed-lock.js';

const fileLocks = new Map<string, Promise<void>>();

export class FileStorage implements Storage {
  constructor(
    private root: string,
    private boundaryRoot = root,
  ) {
    this.root = resolve(root);
    this.boundaryRoot = resolve(boundaryRoot);
  }

  private path(key: string): string {
    const target = resolve(this.root, key);
    const rel = relative(this.root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Invalid storage key outside root: ${key}`);
    }
    return target;
  }

  private async checkedPath(key: string): Promise<string> {
    const target = this.path(key);
    await this.rejectSymlinkComponents(target);
    return target;
  }

  private async rejectSymlinkComponents(target: string): Promise<void> {
    const rel = relative(this.boundaryRoot, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Invalid storage key outside root: ${target}`);
    }

    let current = this.boundaryRoot;
    for (const part of rel.split(sep)) {
      if (!part) continue;
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) {
          throw new Error(`Invalid storage key through symlink: ${target}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
    }
  }

  async read(key: string): Promise<string | null> {
    const target = await this.checkedPath(key);
    try {
      return await readFile(target, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(key: string, value: string): Promise<void> {
    const target = await this.checkedPath(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value, 'utf8');
  }

  async delete(key: string): Promise<void> {
    await rm(await this.checkedPath(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const target = await this.checkedPath(key);
    try {
      await access(target);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const target = await this.checkedPath(prefix);
    try {
      const entries = await readdir(target, { withFileTypes: true });
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

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return withKeyedLock(fileLocks, await this.checkedPath(key), operation);
  }

  scope(prefix: string): Storage {
    return new FileStorage(this.path(prefix), this.boundaryRoot);
  }
}
