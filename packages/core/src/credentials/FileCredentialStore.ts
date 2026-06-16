import { hash, verify } from '@node-rs/argon2';
import type { Storage } from '../storage/Storage.js';
import { nowIso } from '../util/ids.js';
import type { CredentialStore, StoredCredential } from './CredentialStore.js';

const CREDENTIALS_KEY = 'credentials.json';

type CredentialFile = Record<string, StoredCredential>;

export class FileCredentialStore implements CredentialStore {
  constructor(private storage: Storage) {}

  private async readAll(): Promise<CredentialFile> {
    return (await this.storage.readJson<CredentialFile>(CREDENTIALS_KEY)) ?? {};
  }

  private async writeAll(file: CredentialFile): Promise<void> {
    await this.storage.writeJson(CREDENTIALS_KEY, file);
  }

  async getCredential(participantId: string): Promise<StoredCredential | null> {
    const file = await this.readAll();
    return file[participantId] ?? null;
  }

  async setCredential(participantId: string, secret: string): Promise<void> {
    const hashed = await hash(secret);
    const file = await this.readAll();
    file[participantId] = { scheme: 'argon2id', hash: hashed, updatedAt: nowIso() };
    await this.writeAll(file);
  }

  async removeCredential(participantId: string): Promise<void> {
    const file = await this.readAll();
    delete file[participantId];
    await this.writeAll(file);
  }

  async verify(participantId: string, secret: string): Promise<boolean> {
    const cred = await this.getCredential(participantId);
    if (!cred) return false;
    try {
      return await verify(cred.hash, secret);
    } catch {
      return false;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const file = await this.readAll();
    file[key] = { scheme: 'raw', hash: value, updatedAt: nowIso() };
    await this.writeAll(file);
  }

  async list(): Promise<string[]> {
    const file = await this.readAll();
    return Object.keys(file);
  }
}
