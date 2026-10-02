import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { readMeta, writeMeta, listProcessIds } from './process-storage.js';
import type { ProcessMeta } from '@legion-collective/types';

const BASE_META: ProcessMeta = {
  id: 'proc-test-1',
  command: 'echo',
  args: ['hello'],
  cwd: '/tmp',
  tty: false,
  shell: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  startedByParticipantId: 'user-1',
  pid: 12345,
  status: 'running',
  exitCode: null,
  exitedAt: null,
};

describe('process-storage', () => {
  let dir: string;
  let storage: FileStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-proc-'));
    storage = new FileStorage(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writeMeta and readMeta round-trip', async () => {
    await writeMeta(storage, BASE_META);
    const result = await readMeta(storage, 'proc-test-1');
    expect(result).toEqual(BASE_META);
  });

  it('readMeta returns null for missing entry', async () => {
    const result = await readMeta(storage, 'proc-does-not-exist');
    expect(result).toBeNull();
  });

  it('readMeta returns null for corrupted JSON', async () => {
    // Write bad JSON directly
    await storage.write('proc-bad/meta.json', '{not valid json}');
    const result = await readMeta(storage, 'proc-bad');
    expect(result).toBeNull();
  });

  it('writeMeta persists all nullable fields correctly', async () => {
    const meta: ProcessMeta = {
      ...BASE_META,
      exitCode: 0,
      exitedAt: '2026-01-01T00:01:00.000Z',
      status: 'exited',
    };
    await writeMeta(storage, meta);
    const result = await readMeta(storage, 'proc-test-1');
    expect(result?.exitCode).toBe(0);
    expect(result?.exitedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(result?.status).toBe('exited');
  });

  it('listProcessIds returns ids of stored processes', async () => {
    await writeMeta(storage, BASE_META);
    await writeMeta(storage, { ...BASE_META, id: 'proc-test-2' });
    const ids = await listProcessIds(storage);
    expect(ids.sort()).toEqual(['proc-test-1', 'proc-test-2']);
  });

  it('listProcessIds returns empty array when none stored', async () => {
    const ids = await listProcessIds(storage);
    expect(ids).toEqual([]);
  });
});
