import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileCredentialStore } from './FileCredentialStore.js';

describe('FileCredentialStore', () => {
  let dir: string;
  let store: FileCredentialStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-cred-'));
    store = new FileCredentialStore(new FileStorage(dir));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores a hashed credential (never plaintext)', async () => {
    await store.setCredential('op-1', 'hunter2');
    const cred = await store.getCredential('op-1');
    expect(cred).not.toBeNull();
    expect(cred!.scheme).toBe('argon2id');
    expect(cred!.hash).not.toContain('hunter2');
  });

  it('verifies a correct secret and rejects a wrong one', async () => {
    await store.setCredential('op-1', 'hunter2');
    expect(await store.verify('op-1', 'hunter2')).toBe(true);
    expect(await store.verify('op-1', 'wrong')).toBe(false);
  });

  it('returns false verifying an unknown participant', async () => {
    expect(await store.verify('ghost', 'x')).toBe(false);
  });

  it('removes a credential', async () => {
    await store.setCredential('op-1', 'hunter2');
    await store.removeCredential('op-1');
    expect(await store.getCredential('op-1')).toBeNull();
  });

  it('persists across store instances at credentials.json', async () => {
    await store.setCredential('op-1', 'hunter2');
    const fresh = new FileCredentialStore(new FileStorage(dir));
    expect(await fresh.verify('op-1', 'hunter2')).toBe(true);
  });
});
