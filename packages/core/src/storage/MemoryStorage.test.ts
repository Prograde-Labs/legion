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
    expect(await s.read('obj.json')).toBe('{\n  "x": 1\n}');
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

  it('lists immediate children at the root', async () => {
    const s = new MemoryStorage();
    await s.write('a.json', '1');
    await s.write('dir/b.json', '2');
    const listed = (await s.list('')).sort();
    expect(listed).toEqual(['a.json', 'dir']);
  });

  it('scopes under a prefix', async () => {
    const s = new MemoryStorage();
    const scoped = s.scope('services/svc-1');
    await scoped.write('state.json', 'x');
    expect(await s.read('services/svc-1/state.json')).toBe('x');
    expect(await scoped.read('state.json')).toBe('x');
  });

  it('coordinates locks for the same full key across scopes', async () => {
    const storage = new MemoryStorage();
    const first = storage.scope('shared');
    const second = storage.scope('shared');
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const firstOperation = first.withLock('state.json', async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
    });
    const secondOperation = second.withLock('state.json', async () => {
      events.push('second');
    });
    await Promise.resolve();

    expect(events).toEqual(['first:start']);
    release();
    await Promise.all([firstOperation, secondOperation]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('releases a lock when an operation throws', async () => {
    const storage = new MemoryStorage();

    await expect(
      storage.withLock('state.json', async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await expect(storage.withLock('state.json', async () => 'continued')).resolves.toBe(
      'continued',
    );
  });
});
