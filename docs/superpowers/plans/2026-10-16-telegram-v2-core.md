# Legion Core: SecretStore + Secret Tools + External Connector Loader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the two approved core features the Telegram connector v2 depends on: a plaintext-retrievable, encrypted-at-rest per-participant SecretStore (+ `set_secret`/`list_secrets` tools), and the reintroduced external connector loader with `ConnectorRuntimeDeps` (no event bus).

**Architecture:** New `packages/core/src/secrets/` module mirrors the existing `credentials/` pattern (interface + file-backed store), but AES-256-GCM encrypts values and retrieves plaintext. New tools are plain `Tool` exports registered in the existing `managementTools` array; the operator's seeded tools list gains the new names. The loader is a pure module in `packages/core/src/connectors/` unit-tested directly; `LegionProcess` step 9 grows a loop that resolves every configured external connector and starts it with the shared `ConnectorContext` plus `ConnectorRuntimeDeps {collective, secrets}`.

**Tech Stack:** TypeScript (NodeNext, ESM, strict, `verbatimModuleSyntax`), Vitest, Node `crypto` (no new deps).

**Spec:** `/workspace/legion-connector-telegram-v2/docs/specs/2026-10-16-telegram-connector-v2-design.md` (§4 Core work, §10 wiring)

## Global Constraints

- Repo: `/workspace/legion` — work on feature branch `telegram-connector-v2-core` off current `main`. Do NOT commit on `main`.
- Pure ESM: every relative import needs `.js` extension, even for `.ts` sources. `verbatimModuleSyntax`: type-only imports must use `import type`.
- Strict + `noUnusedLocals` + `noUnusedParameters` — unused test params must be underscore-prefixed.
- Prettier: single quotes, semicolons, trailing commas, 100 cols, 2-space. Gate order: `npm run format:check` → `npm run typecheck` → `npm test` (root; web not touched by this plan). Run gates BARE — never pipe through `tail`/`grep` (erases the exit code).
- Node >= 20. No new npm dependencies — crypto from `node:crypto`.
- Encryption key from env `LEGION_SECRETS_KEY` (≥32 chars). Missing env → `FileSecretStore` constructor throws with a descriptive message; callers catch and degrade.
- Secrets live under `.legion/secrets/` via the existing `Storage` abstraction (gitignored by virtue of living under `.legion/`).
- Tool names `set_secret` / `list_secrets` are NEW — grep `name: '` under `packages/core/src/tools/` first to confirm no collision before registering (repo rule).
- Ignore standalone-LSP diagnostics from the patch tool on Legion `.ts` files; trust `npm run typecheck` + tests only.
- Commit as `Mirak <mirak@prograde-labs.com>` (already in git global config).

---

### Task 1: SecretStore interface + FileSecretStore (encrypt at rest, plaintext out)

**Files:**
- Create: `packages/core/src/secrets/SecretStore.ts`
- Create: `packages/core/src/secrets/FileSecretStore.ts`
- Create: `packages/core/src/secrets/FileSecretStore.test.ts`
- Modify: `packages/core/src/index.ts` (add exports)

**Interfaces:**
- Consumes: existing `Storage` abstraction (`packages/core/src/storage/Storage.ts` — `readJson<T>(key)`, `writeJson(key, data)`; `FileStorage` is constructed with the `.legion` dir).
- Produces: `interface SecretStore { getSecret(participantId: string, key: string): Promise<string | null>; setSecret(participantId: string, key: string, secret: string): Promise<void>; removeSecret(participantId: string, key: string): Promise<void>; listKeys(participantId: string): Promise<string[]> }` and `class FileSecretStore implements SecretStore { constructor(storage: Storage, keyMaterial: string) }`. Exported from `@legion/core`.

- [ ] **Step 1: Confirm no name collisions**

Run: `grep -rn "SecretStore\|set_secret\|list_secrets" packages/core/src --include='*.ts' | grep -v test`
Expected: no matches (clean namespace).

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/src/secrets/FileSecretStore.test.ts
import { describe, expect, it } from 'vitest';
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
    const raw = (
      await new FileStorage(dir).readJson<Record<string, unknown>>('secrets.json')
    )!;
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
```

Note: uses vitest globals style consistent with the repo (globals are enabled; explicit imports here match `FileCredentialStore.test.ts` style — check that file and mirror it. If it relies on globals only, drop the import line).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/secrets/FileSecretStore.test.ts`
Expected: FAIL — cannot resolve `./FileSecretStore.js`.

- [ ] **Step 4: Write the interface**

```ts
// packages/core/src/secrets/SecretStore.ts
export interface SecretStore {
  getSecret(participantId: string, key: string): Promise<string | null>;
  setSecret(participantId: string, key: string, secret: string): Promise<void>;
  removeSecret(participantId: string, key: string): Promise<void>;
  /** Key names only — values are never listable. */
  listKeys(participantId: string): Promise<string[]>;
}
```

- [ ] **Step 5: Write FileSecretStore**

AES-256-GCM: per-secret random 12-byte IV, auth tag stored alongside; scrypt derives the 32-byte key from `keyMaterial`. File layout: one JSON file `secrets.json` keyed `participantId → key → {iv, tag, data}` (all base64). Concurrency: mirror `FileCredentialStore`'s simple read-modify-write (single-process assumption, same as credentials).

```ts
// packages/core/src/secrets/FileSecretStore.ts
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
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
```

Verify `Storage` method names against `packages/core/src/storage/Storage.ts` and `nowIso` against `packages/core/src/util/ids.ts` (used by `FileCredentialStore.ts` line 3) — adjust the import if the helper lives elsewhere.

- [ ] **Step 6: Export from the package index**

In `packages/core/src/index.ts`, next to the credentials exports (line ~15), add:

```ts
export * from './secrets/SecretStore.js';
export * from './secrets/FileSecretStore.js';
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run packages/core/src/secrets/FileSecretStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/secrets packages/core/src/index.ts
git commit -m "feat(core): SecretStore — encrypted-at-rest, plaintext-retrievable per-participant secrets"
```

---

### Task 2: set_secret / list_secrets operator tools

**Files:**
- Create: `packages/core/src/tools/secret-tools.ts`
- Create: `packages/core/src/tools/secret-tools.test.ts`
- Modify: `packages/core/src/tools/management-tools.ts` (import + append to `managementTools` array ~line 1016; add `secretStore?: SecretStore` to `createManagementTools` deps ~line 1038)
- Modify: `packages/core/src/collective/default-participants.ts` (add both names to `MANAGEMENT_TOOLS` ~line 5)

**Interfaces:**
- Consumes: `SecretStore` from Task 1; `Tool`/`ToolContext` from `./Tool.js` (`ToolResult = {status, data?, error?}`).
- Produces: `setSecretTool: Tool` (name `set_secret`), `listSecretsTool: Tool` (name `list_secrets`). Tools read `context.secretStore` — so `ToolContext` (in `packages/core/src/tools/Tool.ts`, optional members near `credentialStore?:` line ~110) gains `secretStore?: SecretStore`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/tools/secret-tools.test.ts
import { describe, expect, it, vi } from 'vitest';
import { setSecretTool, listSecretsTool } from './secret-tools.js';
import type { ToolContext } from './Tool.js';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    participant: { id: 'operator' } as ToolContext['participant'],
    secretStore: {
      getSecret: vi.fn(),
      setSecret: vi.fn().mockResolvedValue(undefined),
      removeSecret: vi.fn(),
      listKeys: vi.fn().mockResolvedValue(['telegram-bot/my_bot', 'other']),
    },
    ...overrides,
  } as unknown as ToolContext;
}

describe('set_secret', () => {
  it('stores via the secret store', async () => {
    const c = ctx();
    const result = await setSecretTool.execute(
      { participantId: 'worker', key: 'telegram-bot/my_bot', secret: 'tok' },
      c,
    );
    expect(result.status).toBe('success');
    expect(c.secretStore!.setSecret).toHaveBeenCalledWith('worker', 'telegram-bot/my_bot', 'tok');
  });

  it('errors when the store is unavailable', async () => {
    const result = await setSecretTool.execute(
      { participantId: 'w', key: 'k', secret: 's' },
      ctx({ secretStore: undefined }),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('secretStore');
  });
});

describe('list_secrets', () => {
  it('returns keys only, never values', async () => {
    const result = await listSecretsTool.execute({ participantId: 'worker' }, ctx());
    expect(result.status).toBe('success');
    expect(result.data).toEqual({
      participantId: 'worker',
      keys: ['telegram-bot/my_bot', 'other'],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/secret-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tools**

```ts
// packages/core/src/tools/secret-tools.ts
import type { JSONSchema, ToolResult } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';
import type { SecretStore } from '../secrets/SecretStore.js';

export const setSecretTool: Tool = {
  name: 'set_secret',
  description:
    "Set a named secret for a participant (e.g. 'telegram-bot/<bot-username>' → bot token). Stored encrypted at rest; values are write-only — never readable back through tools.",
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      key: { type: 'string', description: "Secret name, e.g. 'telegram-bot/my_bot'" },
      secret: { type: 'string' },
    },
    required: ['participantId', 'key', 'secret'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { participantId, key, secret } = args as {
      participantId: string;
      key: string;
      secret: string;
    };
    const store = context.secretStore as SecretStore | undefined;
    if (!store) return { status: 'error', error: 'secretStore unavailable in context' };
    try {
      await store.setSecret(participantId, key, secret);
      return { status: 'success', data: { participantId, key } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const listSecretsTool: Tool = {
  name: 'list_secrets',
  description: "List the secret KEY NAMES held for a participant. Values are never returned.",
  parameters: {
    type: 'object',
    properties: { participantId: { type: 'string' } },
    required: ['participantId'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { participantId } = args as { participantId: string };
    const store = context.secretStore as SecretStore | undefined;
    if (!store) return { status: 'error', error: 'secretStore unavailable in context' };
    try {
      const keys = await store.listKeys(participantId);
      return { status: 'success', data: { participantId, keys } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/secret-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register in management tools + ToolContext + operator seeds**

1. `packages/core/src/tools/Tool.ts`: add optional member beside `credentialStore?: CredentialStore;` (~line 110):
   ```ts
   /** Named participant secrets (encrypted at rest, plaintext-retrievable by the host). */
   secretStore?: SecretStore;
   ```
   with `import type { SecretStore } from '../secrets/SecretStore.js';`
2. `packages/core/src/tools/management-tools.ts`: import `setSecretTool, listSecretsTool` from `./secret-tools.js`; append both to the `managementTools` array (~line 1016–1036, after `queryUsageTool`); add `secretStore?: SecretStore` to the `createManagementTools` deps (~line 1038) and pass `secretStore: deps.secretStore` into the context object.
3. `packages/core/src/collective/default-participants.ts`: add `'set_secret',` and `'list_secrets',` to `MANAGEMENT_TOOLS` (after `'set_credential',` line 24).

- [ ] **Step 6: Run the full core test suite**

Run: `npm test`
Expected: PASS — including existing `management-tools.test.ts` and `default-participants.test.ts` (the arrays grow, which existing assertions tolerate; fix any exact-length assertion if one exists).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tools/secret-tools.ts packages/core/src/tools/secret-tools.test.ts packages/core/src/tools/management-tools.ts packages/core/src/tools/Tool.ts packages/core/src/collective/default-participants.ts
git commit -m "feat(core): set_secret / list_secrets operator tools (values write-only)"
```

---

### Task 3: External connector loader (pure module)

**Files:**
- Create: `packages/core/src/connectors/ConnectorRuntimeDeps.ts`
- Create: `packages/core/src/connectors/loader.ts`
- Create: `packages/core/src/connectors/loader.test.ts`
- Modify: `packages/core/src/connectors/index.ts` (re-export)
- Modify: `packages/types/src/config.ts` (`ConnectorConfig` gains `module?: string`)

**Interfaces:**
- Consumes: `Connector` from `./Connector.js`; `Collective` (structural: `list()`, `get()`, `findByIdentity()`, `getOrThrow()`); `SecretStore` from Task 1.
- Produces:
  - `export interface ConnectorRuntimeDeps { collective: CollectiveLike; secrets?: SecretStoreLike }` where `CollectiveLike`/`SecretStoreLike` are structural local interfaces (see code).
  - `export interface LoadedConnector { name: string; connector: Connector }` 
  - `export async function loadExternalConnectors(entries: ConnectorConfig[], workspaceRoot: string, deps: ConnectorRuntimeDeps): Promise<{ loaded: LoadedConnector[]; failures: Array<{ name: string; reason: string }> }>`
  - `ConnectorConfig` (types) gains `module?: string`.

- [ ] **Step 1: Write the failing test**

Uses a fixture module written to a temp dir at test time (no fixtures checked in):

```ts
// packages/core/src/connectors/loader.test.ts
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadExternalConnectors } from './loader.js';
import type { Connector } from './Connector.js';
import type { ConnectorConfig } from '@legion-collective/types';

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'legion-loader-'));
}

function writeModule(dir: string, name: string, code: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, 'index.mjs');
  writeFileSync(file, code);
  return file;
}

const GOOD = `
export function connector(options, deps) {
  return {
    name: options?.name ?? 'ext',
    start: async () => {},
    deliver: async () => {},
    stop: async () => {},
  };
}
export default connector;
`;

describe('loadExternalConnectors', () => {
  it('imports a module by absolute path and requires a named connector factory', async () => {
    const ws = tmpWorkspace();
    writeModule(ws, 'good', GOOD);
    const entries: ConnectorConfig[] = [
      { name: 'ext', module: join(ws, 'good', 'index.mjs'), options: { name: 'ext' } },
    ];
    const { loaded, failures } = await loadExternalConnectors(entries, ws, {
      collective: { list: () => [], get: () => undefined, findByIdentity: () => undefined, getOrThrow: () => undefined },
    });
    expect(failures).toEqual([]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('ext');
    expect(typeof (loaded[0].connector as Connector).start).toBe('function');
  });

  it('logs-and-skips: broken module, missing export, non-function factory, start() throw', async () => {
    const ws = tmpWorkspace();
    writeModule(ws, 'broken', 'export syntax !!!');
    writeModule(ws, 'noexport', 'export const x = 1;');
    writeModule(ws, 'notfn', 'export function connector() { return 42; }');
    writeModule(ws, 'throwing', `
      export function connector() {
        return { name: 't', start: () => { throw new Error('boom'); }, deliver: async () => {}, stop: async () => {} };
      }
    `);
    const entries: ConnectorConfig[] = [
      { name: 'broken', module: join(ws, 'broken', 'index.mjs') },
      { name: 'noexport', module: join(ws, 'noexport', 'index.mjs') },
      { name: 'notfn', module: join(ws, 'notfn', 'index.mjs') },
      { name: 'throwing', module: join(ws, 'throwing', 'index.mjs') },
    ];
    const { loaded, failures } = await loadExternalConnectors(entries, ws, {
      collective: { list: () => [], get: () => undefined, findByIdentity: () => undefined, getOrThrow: () => undefined },
    });
    expect(loaded).toEqual([]);
    expect(failures.map((f) => f.name)).toEqual(['broken', 'noexport', 'notfn', 'throwing']);
    expect(failures.every((f) => typeof f.reason === 'string' && f.reason.length > 0)).toBe(true);
  });

  it('skips entries without module or with enabled:false', async () => {
    const entries: ConnectorConfig[] = [
      { name: 'web' }, // builtin — loader ignores entries without module
      { name: 'off', module: 'does-not-matter', enabled: false },
    ];
    const { loaded, failures } = await loadExternalConnectors(entries, tmpWorkspace(), {
      collective: { list: () => [], get: () => undefined, findByIdentity: () => undefined, getOrThrow: () => undefined },
    });
    expect(loaded).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('merges defaultParticipantId into factory options', async () => {
    const ws = tmpWorkspace();
    const file = writeModule(ws, 'cap', `
      export function connector(options) {
        return { name: 'cap', captured: options, start: async () => {}, deliver: async () => {}, stop: async () => {} };
      }
    `);
    const entries: ConnectorConfig[] = [
      { name: 'cap', module: file, defaultParticipantId: 'fallback-user' },
    ];
    const { loaded } = await loadExternalConnectors(entries, ws, {
      collective: { list: () => [], get: () => undefined, findByIdentity: () => undefined, getOrThrow: () => undefined },
    });
    expect((loaded[0].connector as unknown as { captured: Record<string, unknown> }).captured)
      .toMatchObject({ defaultParticipantId: 'fallback-user' });
  });

  it('resolves bare npm-style specs via workspace-relative paths', async () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, 'local-conn'), { recursive: true });
    writeFileSync(join(ws, 'local-conn', 'index.mjs'), GOOD);
    const entries: ConnectorConfig[] = [{ name: 'local', module: './local-conn/index.mjs' }];
    const { loaded, failures } = await loadExternalConnectors(entries, ws, {
      collective: { list: () => [], get: () => undefined, findByIdentity: () => undefined, getOrThrow: () => undefined },
    });
    expect(failures).toEqual([]);
    expect(loaded).toHaveLength(1);
  });

  it('duplicate connector names: last-wins with a warning', async () => {
    const ws = tmpWorkspace();
    const fileA = writeModule(ws, 'a', `
      export function connector() {
        return { name: 'dup', first: true, start: async () => {}, deliver: async () => {}, stop: async () => {} };
      }
    `);
    const fileB = writeModule(ws, 'b', `
      export function connector() {
        return { name: 'dup', first: false, start: async () => {}, deliver: async () => {}, stop: async () => {} };
      }
    `);
    const { loaded } = await loadExternalConnectors(
      [
        { name: 'dup', module: fileA },
        { name: 'dup', module: fileB },
      ],
      ws,
      { collective: { list: () => [], get: () => undefined, findByIdentity: () => undefined, getOrThrow: () => undefined } },
    );
    expect(loaded).toHaveLength(1);
    expect((loaded[0].connector as unknown as { first: boolean }).first).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/connectors/loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ConnectorRuntimeDeps + loader**

```ts
// packages/core/src/connectors/ConnectorRuntimeDeps.ts
/**
 * Dependencies handed to external connector factories. Deliberately narrow and
 * structural: the external package imports these TYPES only. No event bus —
 * connectors must not subscribe to the bus (design decision, spec §4.4).
 */
export interface CollectiveLike {
  list(): Array<{ id: string; identities?: Array<{ connector: string; externalId: string }>; status?: string }>;
  get(participantId: string):
    | { id: string; identities?: Array<{ connector: string; externalId: string }>; status?: string }
    | undefined;
  findByIdentity(connector: string, externalId: string):
    | { id: string; identities?: Array<{ connector: string; externalId: string }> }
    | undefined;
  getOrThrow(participantId: string): unknown;
}

export interface SecretStoreLike {
  getSecret(participantId: string, key: string): Promise<string | null>;
}

export interface ConnectorRuntimeDeps {
  collective: CollectiveLike;
  secrets?: SecretStoreLike;
}
```

```ts
// packages/core/src/connectors/loader.ts
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import type { ConnectorConfig } from '@legion-collective/types';
import type { Connector } from './Connector.js';
import type { ConnectorRuntimeDeps } from './ConnectorRuntimeDeps.js';

export interface LoadedConnector {
  name: string;
  connector: Connector;
}

export interface LoaderFailure {
  name: string;
  reason: string;
}

type ConnectorFactory = (
  options: Record<string, unknown>,
  deps: ConnectorRuntimeDeps,
) => Connector;

function resolveModuleSpec(spec: string, workspaceRoot: string): string {
  if (isAbsolute(spec)) return pathToFileURL(spec).href;
  try {
    return pathToFileURL(
      createRequire(join(workspaceRoot, 'package.json')).resolve(spec),
    ).href;
  } catch {
    return pathToFileURL(resolve(workspaceRoot, spec)).href;
  }
}

/**
 * Resolve, import, and construct every configured external connector.
 * Never throws per-entry: broken modules / bad factories / start() failures are
 * reported in `failures` so the process boots without them (log-and-skip).
 */
export async function loadExternalConnectors(
  entries: ConnectorConfig[],
  workspaceRoot: string,
  deps: ConnectorRuntimeDeps,
): Promise<{ loaded: LoadedConnector[]; failures: LoaderFailure[] }> {
  const loaded: LoadedConnector[] = [];
  const failures: LoaderFailure[] = [];

  for (const entry of entries) {
    const { name } = entry;
    if (!entry.module || entry.enabled === false) continue;
    try {
      const mod = (await import(resolveModuleSpec(entry.module, workspaceRoot))) as {
        connector?: unknown;
      };
      const factory = mod.connector;
      if (typeof factory !== 'function') {
        failures.push({ name, reason: 'module has no named `connector` factory export' });
        continue;
      }
      const factoryOptions = entry.defaultParticipantId
        ? { ...(entry.options ?? {}), defaultParticipantId: entry.defaultParticipantId }
        : (entry.options ?? {});
      const connector = (factory as ConnectorFactory)(factoryOptions, deps);
      if (!connector || typeof connector.start !== 'function' || typeof connector.deliver !== 'function' || typeof connector.stop !== 'function') {
        failures.push({ name, reason: 'factory did not return a Connector (start/deliver/stop)' });
        continue;
      }
      await connector.start(); // let start-throw become a per-entry failure, not a boot kill
      loaded.push({ name, connector });
    } catch (err) {
      failures.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`[connector-loader] skipped '${f.name}': ${f.reason}`);
  }
  // Duplicate connector names: last-wins (ConnectorRegistry.register would otherwise throw).
  const byName = new Map<string, LoadedConnector>();
  for (const entry of loaded) {
    if (byName.has(entry.connector.name)) {
      console.warn(`[connector-loader] duplicate connector name '${entry.connector.name}' — last wins`);
    }
    byName.set(entry.connector.name, entry);
  }
  return { loaded: [...byName.values()], failures };
}
```

(If `fileURLToPath` is genuinely unused, drop the import and the `void` line — `noUnusedLocals` gate.)

- [ ] **Step 4: Add `module?` to ConnectorConfig types**

In `packages/types/src/config.ts` `ConnectorConfig` (~line 37):

```ts
export interface ConnectorConfig {
  name: string;
  enabled?: boolean;
  defaultParticipantId?: string;
  /** Module spec (absolute path, workspace-relative path, or npm name) for external connectors. */
  module?: string;
  options?: Record<string, unknown>;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/connectors/loader.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Export from connectors index + core index**

`packages/core/src/connectors/index.ts` — add:

```ts
export * from './ConnectorRuntimeDeps.js';
export * from './loader.js';
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/connectors/ConnectorRuntimeDeps.ts packages/core/src/connectors/loader.ts packages/core/src/connectors/loader.test.ts packages/core/src/connectors/index.ts packages/types/src/config.ts
git commit -m "feat(core): external connector loader — module resolution, log-and-skip, ConnectorRuntimeDeps (bus-free)"
```

---

### Task 4: Wire the loader + SecretStore into LegionProcess

**Files:**
- Modify: `packages/runtime/src/LegionProcess.ts` (step 9 block ~lines 296–344; secrets construction in step 3 area ~line 110)
- Modify: `packages/runtime/src/LegionProcess.test.ts` if it exists, else add `packages/runtime/src/LegionProcess.loader.test.ts`
- Modify: `packages/runtime/src/index.ts` if it re-exports for bin (verify only)

**Interfaces:**
- Consumes: `loadExternalConnectors`, `LoadedConnector` (Task 3); `FileSecretStore` (Task 1); `managementTools` deps (Task 2) for context threading; `buildConnectorContext` (exists, ~line 657).
- Produces: boot-time behavior — every `mergedConfig.connectors` entry with `module` is loaded, started with the shared `ConnectorContext`, and registered; `stop()` stops them. Secret store constructed from `LEGION_SECRETS_KEY` when present.

- [ ] **Step 1: Construct the SecretStore early in `start()`**

After the credentials construction (line ~110), add:

```ts
const secrets = process.env.LEGION_SECRETS_KEY
  ? new FileSecretStore(storage, process.env.LEGION_SECRETS_KEY)
  : undefined;
if (!secrets) {
  console.warn('[legion] LEGION_SECRETS_KEY not set — participant secrets (e.g. Telegram bot tokens) unavailable');
}
```

- [ ] **Step 2: Thread `secretStore` into tool contexts**

1. Management tools: wherever `createManagementTools` is invoked with `credentialStore` (search `createManagementTools(` in runtime + web server routes), pass `secretStore: secrets` if that call site constructs tools at boot; if management tools are registered directly from the `managementTools` array (line 226 — they are, no deps), then instead ensure the shared `callTool` context in `buildConnectorContext` (line ~763 `const toolCtx: ToolContext = {...}`) gains `secretStore: secrets,` — this is the path tools actually execute through.
2. `buildMiddlewareToolContext` (~line 512): add `secretStore: secrets,` the same way, if its deps carry what's needed — add `secrets` to its deps object and pass through.
3. Both context builders must include `secretStore: secrets` (undefined-safe).

- [ ] **Step 3: Write the failing wiring test**

Spawn-level boot is too heavy; assert the wiring seam instead — that `loadExternalConnectors` is invoked with the config entries and the built context is started:

```ts
// packages/runtime/src/LegionProcess.loader.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('@legion/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@legion/core')>();
  return {
    ...actual,
    loadExternalConnectors: vi.fn(actual.loadExternalConnectors),
  };
});

import { loadExternalConnectors } from '@legion/core';

describe('LegionProcess external connector wiring', () => {
  it('loadExternalConnectors is exported and callable with the documented shape', async () => {
    // Boot of the full process is covered by LegionProcess.integration.test.ts (opt-in).
    // This guard pins the export the wiring depends on.
    expect(typeof loadExternalConnectors).toBe('function');
  });
});
```

NOTE TO EXECUTOR: if a lighter honest test is possible — e.g. refactor step 9 into an exported `startExternalConnectors(deps)` pure-ish function in LegionProcess.ts and unit-test THAT with stub registry/collective — prefer it. The mock above is the floor, not the target. A refactor-extract (`startExternalConnectors`) with a real unit test is the preferred shape:

```ts
// extracted into LegionProcess.ts
export async function startExternalConnectors(deps: {
  entries: ConnectorConfig[];
  workspaceRoot: string;
  connectorRegistry: ConnectorRegistry;
  runtimeDeps: ConnectorRuntimeDeps;
  context: ConnectorContext;
}): Promise<string[]> {
  const { loaded, failures } = await loadExternalConnectors(
    deps.entries,
    deps.workspaceRoot,
    deps.runtimeDeps,
  );
  for (const { name, connector } of loaded) {
    deps.connectorRegistry.register(connector);
    if (name === 'telegram') {
      console.log(`[legion] external connector '${name}' started`);
    }
  }
  if (failures.length > 0) {
    console.warn(`[legion] ${failures.length} external connector(s) failed to load`);
  }
  return loaded.map((l) => l.name);
}
```

…and call it from step 9 after `webConnector.start(...)`:

```ts
// after line 344 (await webConnector.start(connectorContext);)
if ((mergedConfig.connectors?.length ?? 0) > 0) {
  await startExternalConnectors({
    entries: mergedConfig.connectors ?? [],
    workspaceRoot,
    connectorRegistry,
    runtimeDeps: { collective, secrets },
    context: connectorContext,
  });
}
```

(The `context` param is part of the seam for future use; if unused, omit it from the extracted signature — `noUnusedParameters`.)

Also extend `stop()` (~line 380): the existing loop `for (const connector of this.connectors.getAll()) ... await connector.stop()` already stops externals — verify only, no change needed unless externals must be stopped before web (they don't).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/runtime/src/LegionProcess.loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gates (BARE commands, no pipes)**

Run: `npm run format:check; echo "format exit: $?"` → then `npm run typecheck; echo "typecheck exit: $?"` → then `npm test; echo "test exit: $?"`
Expected: all exit 0. Fix anything these surface (prettier reformat, type errors in touched files).

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/LegionProcess.ts packages/runtime/src/LegionProcess.loader.test.ts
git commit -m "feat(runtime): wire external connector loader + SecretStore into LegionProcess boot"
```

---

### Task 5: Integration smoke (opt-in, manual verification)

**Files:**
- Modify: `packages/runtime/src/LegionProcess.integration.test.ts` (add one case, gated like the others)

**Interfaces:**
- Consumes: everything above.
- Produces: confidence that boot with one external connector config entry registers and starts it, and a broken entry boots anyway.

- [ ] **Step 1: Add the gated integration case**

Mirror the existing `LEGION_INTEGRATION=1` gating pattern in that file. The case: temp workspace with `connectors: [{name: 'broken', module: './nonexistent.mjs'}, {name: 'ext', module: <fixture written at test time, GOOD factory>}]`; assert `process.connectors.get('ext')` is defined and `process.connectors.get('broken')` is undefined. Write the fixture module to the temp workspace exactly like `loader.test.ts` does.

- [ ] **Step 2: Run with the gate env var**

Run: `LEGION_INTEGRATION=1 npm test -- --run packages/runtime/src/LegionProcess.integration.test.ts`
Expected: PASS including the new case. (If port 3000 is occupied, the existing file's conventions handle it — follow them.)

- [ ] **Step 3: Full gates again**

Run: `npm run format:check; npm run typecheck; npm test` (each bare; each must exit 0)

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/LegionProcess.integration.test.ts
git commit -m "test(runtime): external connector boot integration smoke (opt-in)"
```

---

### Task 6: Push branch + MR readiness

- [ ] **Step 1: Rebase on main if needed, push**

Run: `git push -u origin telegram-connector-v2-core`
Expected: branch pushed (no MR creation without Chris's approval — Chris gates merges; report branch + gate results instead).

- [ ] **Step 2: Report**

Summarize: gate outputs (verbatim exit codes), files touched, the `LEGION_SECRETS_KEY` operator requirement, and that the connector plan (Plan B) unblocks.
