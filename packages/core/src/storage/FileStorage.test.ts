import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FileStorage } from './FileStorage.js';

describe('FileStorage', () => {
  let dir: string;

  async function setupOutsideSymlink(): Promise<string> {
    const outside = await mkdtemp(join(tmpdir(), 'legion-storage-outside-'));
    await symlink(outside, join(dir, 'link'), 'dir');
    return outside;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-storage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes and reads through the filesystem', async () => {
    const s = new FileStorage(dir);
    expect(await s.read('a.txt')).toBeNull();
    await s.write('nested/a.txt', 'hello');
    expect(await s.read('nested/a.txt')).toBe('hello');
    expect(await s.exists('nested/a.txt')).toBe(true);
  });

  it('allows dot-prefixed keys under the root', async () => {
    const s = new FileStorage(dir);
    await s.write('..cache', 'ok');
    expect(await s.read('..cache')).toBe('ok');
  });

  it('round-trips JSON', async () => {
    const s = new FileStorage(dir);
    await s.writeJson('obj.json', { x: 1 });
    expect(await s.read('obj.json')).toBe('{\n  "x": 1\n}');
    expect(await s.readJson<{ x: number }>('obj.json')).toEqual({ x: 1 });
  });

  it('deletes keys', async () => {
    const s = new FileStorage(dir);
    await s.write('a', '1');
    await s.delete('a');
    expect(await s.exists('a')).toBe(false);
    await s.delete('a');
  });

  it('lists immediate children', async () => {
    const s = new FileStorage(dir);
    await s.write('d/a.json', '1');
    await s.write('d/b.json', '2');
    await s.write('d/sub/c.json', '3');
    expect((await s.list('d')).sort()).toEqual(['a.json', 'b.json', 'sub']);
  });

  it('lists immediate children at the root', async () => {
    const s = new FileStorage(dir);
    await s.write('a.json', '1');
    await s.write('dir/b.json', '2');
    expect((await s.list('')).sort()).toEqual(['a.json', 'dir']);
  });

  it('returns empty list for a missing prefix', async () => {
    const s = new FileStorage(dir);
    expect(await s.list('missing')).toEqual([]);
  });

  it('throws non-missing filesystem errors from exists', async () => {
    const s = new FileStorage(dir);
    await expect(s.exists('\0')).rejects.toThrow();
  });

  it('scopes under a sub-path', async () => {
    const s = new FileStorage(dir).scope('services/svc-1');
    await s.write('state.json', 'x');
    expect(await new FileStorage(dir).read('services/svc-1/state.json')).toBe('x');
  });

  it('coordinates locks by absolute path across instances and scopes', async () => {
    const first = new FileStorage(dir).scope('shared');
    const second = new FileStorage(join(dir, 'shared'));
    const events: string[] = [];
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const firstOperation = first.withLock('state.json', async () => {
      events.push('first:start');
      operationStarted();
      await gate;
      events.push('first:end');
    });
    await started;
    const secondOperation = second.withLock('state.json', async () => {
      events.push('second');
    });

    expect(events).toEqual(['first:start']);
    release();
    await Promise.all([firstOperation, secondOperation]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('releases a lock when an operation throws', async () => {
    const storage = new FileStorage(dir);

    await expect(
      storage.withLock('state.json', async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await expect(storage.withLock('state.json', async () => 'continued')).resolves.toBe(
      'continued',
    );
  });

  it('rejects keys and scopes outside the root', async () => {
    const s = new FileStorage(dir);
    const outsideKey = `../${basename(dir)}-outside`;
    const outsidePath = join(dir, outsideKey);

    try {
      await expect(s.write(outsideKey, 'x')).rejects.toThrow();
    } finally {
      await rm(outsidePath, { force: true });
    }

    await expect(s.read('../x')).rejects.toThrow();
    await expect(s.delete('../x')).rejects.toThrow();
    await expect(s.list('..')).rejects.toThrow();
    expect(() => s.scope('..')).toThrow();
  });

  it('rejects writes through symlinks outside the root', async () => {
    const s = new FileStorage(dir);
    const outside = await setupOutsideSymlink();
    try {
      await expect(s.write('link/file', 'x')).rejects.toThrow();
      await expect(readFile(join(outside, 'file'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects reads, lists, and deletes through symlinks outside the root', async () => {
    const s = new FileStorage(dir);
    const outside = await setupOutsideSymlink();
    try {
      await writeFile(join(outside, 'file'), 'x', 'utf8');
      await writeFile(join(outside, 'delete-me'), 'delete me', 'utf8');

      await expect(s.read('link/file')).rejects.toThrow();
      await expect(s.list('link')).rejects.toThrow();
      await expect(s.delete('link/delete-me')).rejects.toThrow();
      expect(await readFile(join(outside, 'delete-me'), 'utf8')).toBe('delete me');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects scoped writes through symlinks outside the root', async () => {
    const s = new FileStorage(dir);
    const outside = await setupOutsideSymlink();
    try {
      await expect(s.scope('link').write('file', 'x')).rejects.toThrow();
      await expect(readFile(join(outside, 'file'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
