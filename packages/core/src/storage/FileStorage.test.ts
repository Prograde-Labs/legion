import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from './FileStorage.js';

describe('FileStorage', () => {
  let dir: string;

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

  it('round-trips JSON', async () => {
    const s = new FileStorage(dir);
    await s.writeJson('obj.json', { x: 1 });
    expect(await s.readJson<{ x: number }>('obj.json')).toEqual({ x: 1 });
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

  it('scopes under a sub-path', async () => {
    const s = new FileStorage(dir).scope('services/svc-1');
    await s.write('state.json', 'x');
    expect(await new FileStorage(dir).read('services/svc-1/state.json')).toBe('x');
  });
});
