import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Storage } from '../storage/Storage.js';
import type { SecretStore } from './SecretStore.js';
import { nowIso } from '../util/ids.js';

const SECRETS_FILE = 'secrets.json';

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
}

type SecretFile = Record<string, Record<string, EncryptedEntry>>;

export class FileSecretStore implements SecretStore {
  private readonly aesKey: Buffer;

  constructor(
    private storage: Storage,
    keyMaterial: string,
  ) {
    if (keyMaterial.length < 32) {
      throw new Error('FileSecretStore requires LEGION_SECRETS_KEY of at least 32 characters');
    }
    this.aesKey = scryptSync(keyMaterial, 'legion-secrets-v1', 32);
  }

  private encrypt(plaintext: string): EncryptedEntry {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.aesKey, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      updatedAt: nowIso(),
    };
  }

  private decrypt(entry: EncryptedEntry): string | null {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.aesKey,
        Buffer.from(entry.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null; // wrong key material or corrupted entry
    }
  }

  private async readAll(): Promise<SecretFile> {
    return (await this.storage.readJson<SecretFile>(SECRETS_FILE)) ?? {};
  }

  private async writeAll(file: SecretFile): Promise<void> {
    await this.storage.writeJson(SECRETS_FILE, file);
  }

  async getSecret(participantId: string, key: string): Promise<string | null> {
    const file = await this.readAll();
    const entry = file[participantId]?.[key];
    return entry ? this.decrypt(entry) : null;
  }

  async setSecret(participantId: string, key: string, secret: string): Promise<void> {
    const file = await this.readAll();
    file[participantId] = { ...file[participantId], [key]: this.encrypt(secret) };
    await this.writeAll(file);
  }

  async removeSecret(participantId: string, key: string): Promise<void> {
    const file = await this.readAll();
    if (file[participantId]) {
      delete file[participantId][key];
      if (Object.keys(file[participantId]).length === 0) delete file[participantId];
    }
    await this.writeAll(file);
  }

  async listKeys(participantId: string): Promise<string[]> {
    const file = await this.readAll();
    return Object.keys(file[participantId] ?? {});
  }
}
