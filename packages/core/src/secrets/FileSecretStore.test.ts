import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { FileStorage } from '../storage/FileStorage.js';
import { FileSecretStore } from './FileSecretStore.js';

function makeStore(): FileSecretStore {
  const dir = mkdtempSync(join(tmpdir(), 'legion-secrets-'));
  return new FileSecretStore(new FileStorage(dir), 'a'.repeat(32));
}

describe('FileSecretStore', () => {
  it('round-trips a secret as plaintext', async () => {
    const store = makeStore();
    await store.setSecret('worker', 'telegram-bot/my_bot', '123:ABC');
    await expect(store.getSecret('worker', 'telegram-bot/my_bot')).resolves.toBe('123:ABC');
  });

  it('returns null for missing participant or key', async () => {
    const store = makeStore();
    await store.setSecret('worker', 'telegram-bot/my_bot', '123:ABC');
    await expect(store.getSecret('nobody', 'telegram-bot/my_bot')).resolves.toBeNull();
    await expect(store.getSecret('worker', 'nope')).resolves.toBeNull();
  });

  it('encrypts at rest — raw file content does not contain the plaintext', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'legion-secrets-'));
    const store = new FileSecretStore(new FileStorage(dir), 'a'.repeat(32));
    await store.setSecret('worker', 'telegram-bot/my_bot', 'SUPER-PLAINTEXT-TOKEN');
    const raw = (await new FileStorage(dir).readJson<Record<string, unknown>>('secrets.json'))!;
    expect(JSON.stringify(raw)).not.toContain('SUPER-PLAINTEXT-TOKEN');
  });

  it('removeSecret deletes the entry and listKeys reports only that participant', async () => {
    const store = makeStore();
    await store.setSecret('a', 'k1', 'v1');
    await store.setSecret('b', 'k2', 'v2');
    await expect(store.listKeys('a')).resolves.toEqual(['k1']);
    await store.removeSecret('a', 'k1');
    await expect(store.getSecret('a', 'k1')).resolves.toBeNull();
    await expect(store.listKeys('a')).resolves.toEqual([]);
    await expect(store.getSecret('b', 'k2')).resolves.toBe('v2');
  });

  it('overwrites an existing key', async () => {
    const store = makeStore();
    await store.setSecret('a', 'k', 'old');
    await store.setSecret('a', 'k', 'new');
    await expect(store.getSecret('a', 'k')).resolves.toBe('new');
  });

  it('refuses a key material shorter than 32 chars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legion-secrets-'));
    expect(() => new FileSecretStore(new FileStorage(dir), 'short')).toThrow(/32/);
  });
});
