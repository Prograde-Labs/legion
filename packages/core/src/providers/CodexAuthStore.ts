import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ProviderError } from '../errors/LegionError.js';
import { withKeyedLock } from '../storage/keyed-lock.js';
import {
  extractClaims,
  getClientId,
  isRefreshTokenFailure,
  refreshTokens,
  revokeToken,
  tokenExpiry,
} from './codex-auth.js';
import type { TokenSet } from './codex-auth.js';

export interface CodexAuth {
  clientId: string;
  issuer: string;
  accountId?: string;
  email?: string;
  plan?: string;
  idToken?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  savedAt: string;
}

const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const REFRESH_MARGIN_SECONDS = 300;
const ISSUER = 'https://auth.openai.com';

export function buildAuth(tokens: TokenSet, clientId = getClientId()): CodexAuth {
  const claims = extractClaims(tokens.idToken);
  return {
    clientId,
    issuer: ISSUER,
    accountId: claims.accountId,
    email: claims.email,
    plan: claims.plan,
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    savedAt: new Date().toISOString(),
  };
}

export class CodexAuthStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  private path(name: string): string {
    if (!PROVIDER_NAME_PATTERN.test(name)) throw new ProviderError('Invalid provider name');
    return join(this.dir, `${name}.json`);
  }

  async read(name: string): Promise<CodexAuth | null> {
    try {
      return JSON.parse(await readFile(this.path(name), 'utf8')) as CodexAuth;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof SyntaxError) {
        throw new ProviderError(`Codex auth file for '${name}' is corrupt; sign in again`);
      }
      throw err;
    }
  }

  async save(name: string, auth: CodexAuth): Promise<void> {
    const target = this.path(name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await chmod(dirname(target), 0o700);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    await chmod(target, 0o600).catch(() => undefined);
  }

  async delete(name: string): Promise<void> {
    const target = this.path(name);
    await rm(target, { force: true });
    const files = await readdir(this.dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const prefix = `${basename(target)}.`;
    await Promise.all(
      files
        .filter((file) => file.startsWith(prefix) && file.endsWith('.tmp'))
        .map((file) => rm(join(this.dir, file), { force: true })),
    );
  }

  async saveIfActive(name: string, auth: CodexAuth, active: () => boolean): Promise<boolean> {
    return withKeyedLock(this.locks, this.path(name), async () => {
      if (!active()) return false;
      await this.save(name, auth);
      return true;
    });
  }

  async logout(name: string): Promise<{ signedOut: true; revoked: boolean }> {
    return withKeyedLock(this.locks, this.path(name), async () => {
      const auth = await this.read(name);
      const revoked = auth
        ? await revokeToken({ clientId: auth.clientId, token: auth.refreshToken }).catch(
            () => false,
          )
        : false;
      await this.delete(name);
      return { signedOut: true, revoked };
    });
  }

  async ensureFresh(name: string, force = false): Promise<CodexAuth> {
    return withKeyedLock(this.locks, this.path(name), async () => {
      const current = await this.read(name);
      if (!current) throw new ProviderError('Not signed in to ChatGPT');

      const now = Math.floor(Date.now() / 1000);
      if (!force && current.expiresAt - now >= REFRESH_MARGIN_SECONDS) return current;

      try {
        const tokens = await refreshTokens({
          clientId: current.clientId,
          refreshToken: current.refreshToken,
        });
        const claims = extractClaims(tokens.idToken ?? current.idToken);
        const next: CodexAuth = {
          ...current,
          idToken: tokens.idToken ?? current.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokenExpiry(tokens.accessToken) ?? tokens.expiresAt,
          accountId: claims.accountId ?? current.accountId,
          email: claims.email ?? current.email,
          plan: claims.plan ?? current.plan,
          savedAt: new Date().toISOString(),
        };
        await this.save(name, next);
        return next;
      } catch (err) {
        if (isRefreshTokenFailure(err)) {
          await this.delete(name).catch(() => undefined);
          throw new ProviderError('ChatGPT session expired; sign in again', 401);
        }
        throw err;
      }
    });
  }
}
