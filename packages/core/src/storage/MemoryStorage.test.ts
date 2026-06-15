import { MemoryStorage } from './MemoryStorage.js';

describe('MemoryStorage', () => {
  it('writes and reads raw strings', async () => {
    const s = new MemoryStorage();
    expect(await s.read('a.txt')).toBeNull();
    await s.write('a.txt', 'hello');
    expect(await s.read('a.txt')).toBe('hello');
    expect(await s.exists('a.txt')).toBe(true);
  });

  it('round-trips JSON', async () => {
    const s = new MemoryStorage();
    await s.writeJson('obj.json', { x: 1 });
    expect(await s.readJson<{ x: number }>('obj.json')).toEqual({ x: 1 });
  });

  it('deletes keys', async () => {
    const s = new MemoryStorage();
    await s.write('a', '1');
    await s.delete('a');
    expect(await s.exists('a')).toBe(false);
    await s.delete('a'); // no throw on missing
  });

  it('lists immediate children under a prefix', async () => {
    const s = new MemoryStorage();
    await s.write('dir/a.json', '1');
    await s.write('dir/b.json', '2');
    await s.write('dir/sub/c.json', '3');
    const listed = (await s.list('dir')).sort();
    expect(listed).toEqual(['a.json', 'b.json', 'sub']);
  });

  it('scopes under a prefix', async () => {
    const s = new MemoryStorage();
    const scoped = s.scope('services/svc-1');
    await scoped.write('state.json', 'x');
    expect(await s.read('services/svc-1/state.json')).toBe('x');
    expect(await scoped.read('state.json')).toBe('x');
  });
});
