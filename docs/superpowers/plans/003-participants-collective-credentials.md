# Participants, Collective & Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the participant roster (`Collective`) backed by per-participant JSON files, the bootstrap-operator seed, and the `CredentialStore` with an argon2-hashed file backend.

**Architecture:** Participants live as JSON files under `.legion/collective/participants/<id>.json` (git-tracked). `Collective` loads, caches, queries, and mutates the roster (add/retire/update), enforcing the protected/last-operator invariants from spec §7. `CredentialStore` is separate from participant configs (spec §6) and stores argon2 hashes in `.legion/credentials.json` (git-ignored). Depends on Plan 1 (`@legion-collective/core` types, `Storage`, errors, ids).

**Tech Stack:** `@legion-collective/core`, `@node-rs/argon2` (native argon2 binding), Vitest.

---

## File Structure

```
packages/core/src/collective/
  Collective.ts                — roster load/query/mutate + invariants
  Collective.test.ts
  default-participants.ts      — createDefaultParticipants (bootstrap operator)
  default-participants.test.ts
packages/core/src/credentials/
  CredentialStore.ts           — interface + StoredCredential type
  FileCredentialStore.ts       — argon2-hashed file backend
  FileCredentialStore.test.ts
```

All exported from `packages/core/src/index.ts`.

---

## Task 1: Collective — load + query

**Files:**

- Create: `packages/core/src/collective/Collective.ts`
- Test: `packages/core/src/collective/Collective.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from './Collective.js';
import type { AgentConfig, UserConfig } from '@legion-collective/types';

function seedStorage() {
  const storage = new MemoryStorage();
  const operator: UserConfig = {
    id: 'op-1',
    name: 'Operator',
    type: 'user',
    tools: {},
    operator: true,
    protected: true,
    status: 'active',
  };
  const agent: AgentConfig = {
    id: 'agent-1',
    name: 'Researcher',
    type: 'agent',
    tools: { communicate: 'auto' },
    systemPrompt: 'You help.',
    model: { provider: 'openai-compatible', model: 'gpt-4o-mini' },
    status: 'active',
  };
  return { storage, operator, agent };
}

describe('Collective: load and query', () => {
  it('loads participants from storage', async () => {
    const { storage, operator, agent } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    await storage.writeJson('collective/participants/agent-1.json', agent);

    const collective = await Collective.load(storage);
    expect(collective.get('agent-1')?.name).toBe('Researcher');
    expect(collective.list().length).toBe(2);
  });

  it('getOrThrow raises ParticipantNotFoundError for unknown ids', async () => {
    const { storage } = seedStorage();
    const collective = await Collective.load(storage);
    expect(() => collective.getOrThrow('ghost')).toThrow(/ghost/);
  });

  it('lists only active participants via listActive', async () => {
    const { storage, operator, agent } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    await storage.writeJson('collective/participants/agent-1.json', {
      ...agent,
      status: 'retired',
    });
    const collective = await Collective.load(storage);
    expect(collective.listActive().map((p) => p.id)).toEqual(['op-1']);
  });

  it('finds a participant by connector identity', async () => {
    const { storage, operator } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', {
      ...operator,
      identities: [{ connector: 'web', externalId: 'op-1' }],
    });
    const collective = await Collective.load(storage);
    expect(collective.findByIdentity('web', 'op-1')?.id).toBe('op-1');
    expect(collective.findByIdentity('web', 'nobody')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/collective/Collective.test.ts`
Expected: FAIL — `Cannot find module './Collective.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/collective/Collective.ts`:

```typescript
import type { Storage } from '../storage/Storage.js';
import type { ParticipantConfig } from '@legion-collective/types';
import { ParticipantNotFoundError } from '../errors/LegionError.js';

const PARTICIPANTS_PREFIX = 'collective/participants';

export class Collective {
  private participants = new Map<string, ParticipantConfig>();

  private constructor(
    private storage: Storage,
    participants: ParticipantConfig[],
  ) {
    for (const p of participants) this.participants.set(p.id, p);
  }

  static async load(storage: Storage): Promise<Collective> {
    const files = await storage.list(PARTICIPANTS_PREFIX);
    const participants: ParticipantConfig[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      const config = await storage.readJson<ParticipantConfig>(`${PARTICIPANTS_PREFIX}/${id}.json`);
      if (config) participants.push(config);
    }
    return new Collective(storage, participants);
  }

  get(id: string): ParticipantConfig | undefined {
    return this.participants.get(id);
  }

  getOrThrow(id: string): ParticipantConfig {
    const p = this.participants.get(id);
    if (!p) throw new ParticipantNotFoundError(id);
    return p;
  }

  list(): ParticipantConfig[] {
    return [...this.participants.values()];
  }

  listActive(): ParticipantConfig[] {
    return this.list().filter((p) => (p.status ?? 'active') === 'active');
  }

  findByIdentity(connector: string, externalId: string): ParticipantConfig | undefined {
    return this.list().find((p) =>
      p.identities?.some((i) => i.connector === connector && i.externalId === externalId),
    );
  }

  operators(): ParticipantConfig[] {
    return this.listActive().filter((p) => p.operator === true);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/collective/Collective.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/collective/Collective.ts packages/core/src/collective/Collective.test.ts
git commit -m "feat(core): add Collective roster load and query"
```

---

## Task 2: Collective — add / update / retire with invariants

**Files:**

- Modify: `packages/core/src/collective/Collective.ts`
- Test: `packages/core/src/collective/Collective.test.ts` (add cases)

> Enforces spec §7: protected participants cannot be retired/removed; the collective must
> always retain at least one active operator; the last operator cannot be removed or stripped.

- [ ] **Step 1: Add the failing test**

```typescript
import { LegionError } from '../errors/LegionError.js';

describe('Collective: mutation and invariants', () => {
  async function withOperatorAndAgent() {
    const { storage, operator, agent } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    await storage.writeJson('collective/participants/agent-1.json', agent);
    return Collective.load(storage);
  }

  it('adds a participant and persists it', async () => {
    const collective = await withOperatorAndAgent();
    await collective.add({
      id: 'mock-1',
      name: 'Mock',
      type: 'mock',
      tools: {},
      responses: ['ok'],
      status: 'active',
    });
    expect(collective.get('mock-1')?.name).toBe('Mock');
    const reloaded = await Collective.load(
      (collective as unknown as { storage: MemoryStorage }).storage,
    );
    expect(reloaded.get('mock-1')).toBeDefined();
  });

  it('rejects adding a duplicate id', async () => {
    const collective = await withOperatorAndAgent();
    await expect(
      collective.add({ id: 'agent-1', name: 'Dup', type: 'mock', tools: {}, responses: [] }),
    ).rejects.toThrow(LegionError);
  });

  it('retires a non-protected participant', async () => {
    const collective = await withOperatorAndAgent();
    await collective.retire('agent-1');
    expect(collective.get('agent-1')?.status).toBe('retired');
  });

  it('refuses to retire a protected participant', async () => {
    const collective = await withOperatorAndAgent();
    await expect(collective.retire('op-1')).rejects.toThrow(/protected/i);
  });

  it('refuses to retire the last active operator', async () => {
    const { storage } = seedStorage();
    // operator that is NOT protected, but is the only operator
    await storage.writeJson('collective/participants/op-1.json', {
      id: 'op-1',
      name: 'Op',
      type: 'user',
      tools: {},
      operator: true,
      status: 'active',
    });
    const collective = await Collective.load(storage);
    await expect(collective.retire('op-1')).rejects.toThrow(/operator/i);
  });

  it('updates a participant via patch', async () => {
    const collective = await withOperatorAndAgent();
    await collective.update('agent-1', { name: 'Renamed' });
    expect(collective.get('agent-1')?.name).toBe('Renamed');
  });

  it('refuses to strip operator authority from the last operator', async () => {
    const { storage } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', {
      id: 'op-1',
      name: 'Op',
      type: 'user',
      tools: {},
      operator: true,
      status: 'active',
    });
    const collective = await Collective.load(storage);
    await expect(collective.update('op-1', { operator: false })).rejects.toThrow(/operator/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/collective/Collective.test.ts -t "mutation"`
Expected: FAIL — `add`/`retire`/`update` not defined.

- [ ] **Step 3: Implement mutations**

Add to `Collective.ts` (and add a `ConflictError` to the error hierarchy first):

In `packages/core/src/errors/LegionError.ts`, add:

```typescript
export class ConflictError extends LegionError {
  constructor(message: string) {
    super(message, 'CONFLICT');
  }
}

export class InvariantError extends LegionError {
  constructor(message: string) {
    super(message, 'INVARIANT_VIOLATION');
  }
}
```

Then in `Collective.ts`:

```typescript
import { ConflictError, InvariantError, ParticipantNotFoundError } from '../errors/LegionError.js';

// inside the class:

  private async persist(config: ParticipantConfig): Promise<void> {
    await this.storage.writeJson(`${PARTICIPANTS_PREFIX}/${config.id}.json`, config);
  }

  async add(config: ParticipantConfig): Promise<void> {
    if (this.participants.has(config.id)) {
      throw new ConflictError(`Participant already exists: ${config.id}`);
    }
    const withStatus: ParticipantConfig = { status: 'active', ...config };
    this.participants.set(withStatus.id, withStatus);
    await this.persist(withStatus);
  }

  async update(id: string, patch: Partial<ParticipantConfig>): Promise<void> {
    const existing = this.getOrThrow(id);
    const updated = { ...existing, ...patch } as ParticipantConfig;
    // Last-operator protection: cannot strip operator authority from the final operator.
    if (existing.operator === true && updated.operator === false) {
      const otherOperators = this.operators().filter((p) => p.id !== id);
      if (otherOperators.length === 0) {
        throw new InvariantError('Cannot strip operator authority from the last operator');
      }
    }
    this.participants.set(id, updated);
    await this.persist(updated);
  }

  async retire(id: string): Promise<void> {
    const existing = this.getOrThrow(id);
    if (existing.protected) {
      throw new InvariantError(`Cannot retire protected participant: ${id}`);
    }
    if (existing.operator === true) {
      const otherActiveOperators = this.operators().filter((p) => p.id !== id);
      if (otherActiveOperators.length === 0) {
        throw new InvariantError('Cannot retire the last active operator');
      }
    }
    const updated = { ...existing, status: 'retired' as const };
    this.participants.set(id, updated);
    await this.persist(updated);
  }
```

> The test reaches into `collective.storage`; mark the field accessible by leaving it
> `private` (the test casts through `unknown`). No production code relies on that access.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/collective/Collective.test.ts -t "mutation"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/collective/Collective.ts packages/core/src/collective/Collective.test.ts packages/core/src/errors/LegionError.ts
git commit -m "feat(core): add Collective mutations with protected/operator invariants"
```

---

## Task 3: Default participants (bootstrap operator)

**Files:**

- Create: `packages/core/src/collective/default-participants.ts`
- Test: `packages/core/src/collective/default-participants.test.ts`

> Spec §1 bootstrap: a `user`-type participant with `operator: true`, `protected: true`,
> broad `approvalAuthority`, management tool access, reachable via the web connector.

- [ ] **Step 1: Write the failing test**

```typescript
import { createDefaultParticipants, BOOTSTRAP_OPERATOR_ID } from './default-participants.js';

describe('createDefaultParticipants', () => {
  it('produces a protected operator user with broad authority', () => {
    const [operator] = createDefaultParticipants();
    expect(operator.id).toBe(BOOTSTRAP_OPERATOR_ID);
    expect(operator.type).toBe('user');
    expect(operator.operator).toBe(true);
    expect(operator.protected).toBe(true);
    expect(operator.approvalAuthority?.tools).toBe('*');
    expect(operator.approvalAuthority?.participants).toBe('*');
  });

  it('grants the operator the web connector identity and management tools', () => {
    const [operator] = createDefaultParticipants();
    expect(operator.identities).toEqual([{ connector: 'web', externalId: BOOTSTRAP_OPERATOR_ID }]);
    expect(operator.tools['create_agent']).toBe('auto');
    expect(operator.tools['communicate']).toBe('auto');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/collective/default-participants.test.ts`
Expected: FAIL — `Cannot find module './default-participants.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/collective/default-participants.ts`:

```typescript
import type { ParticipantConfig, UserConfig, ToolPolicy } from '@legion-collective/types';

export const BOOTSTRAP_OPERATOR_ID = 'operator';

const MANAGEMENT_TOOLS = [
  'communicate',
  'create_agent',
  'retire_agent',
  'list_participants',
  'get_conversation',
  'set_tool_policy',
  'set_credential',
] as const;

export function createDefaultParticipants(): ParticipantConfig[] {
  const tools: Record<string, ToolPolicy> = {};
  for (const tool of MANAGEMENT_TOOLS) tools[tool] = 'auto';

  const operator: UserConfig = {
    id: BOOTSTRAP_OPERATOR_ID,
    name: 'Operator',
    type: 'user',
    tools,
    operator: true,
    protected: true,
    status: 'active',
    approvalAuthority: { tools: '*', participants: '*' },
    identities: [{ connector: 'web', externalId: BOOTSTRAP_OPERATOR_ID }],
  };

  return [operator];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/collective/default-participants.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add a `seedDefaults` helper to `Collective`**

In `Collective.ts`, add:

```typescript
import { createDefaultParticipants } from './default-participants.js';

// inside the class:

  /** Seed bootstrap participants if the roster is empty. Returns the ids seeded. */
  async seedDefaultsIfEmpty(): Promise<string[]> {
    if (this.participants.size > 0) return [];
    const defaults = createDefaultParticipants();
    for (const config of defaults) {
      this.participants.set(config.id, config);
      await this.persist(config);
    }
    return defaults.map((p) => p.id);
  }
```

- [ ] **Step 6: Add a Collective test for seeding**

Append to `Collective.test.ts`:

```typescript
describe('Collective: seedDefaultsIfEmpty', () => {
  it('seeds the bootstrap operator into an empty collective', async () => {
    const storage = new MemoryStorage();
    const collective = await Collective.load(storage);
    const seeded = await collective.seedDefaultsIfEmpty();
    expect(seeded).toContain('operator');
    expect(collective.operators().length).toBe(1);
  });

  it('does nothing when participants already exist', async () => {
    const { storage, operator } = seedStorage();
    await storage.writeJson('collective/participants/op-1.json', operator);
    const collective = await Collective.load(storage);
    expect(await collective.seedDefaultsIfEmpty()).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the Collective + defaults tests**

Run: `npx vitest run packages/core/src/collective/`
Expected: PASS — all Collective + default-participants tests green.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/collective/default-participants.ts packages/core/src/collective/default-participants.test.ts packages/core/src/collective/Collective.ts packages/core/src/collective/Collective.test.ts
git commit -m "feat(core): add bootstrap operator seeding"
```

---

## Task 4: CredentialStore interface

**Files:**

- Create: `packages/core/src/credentials/CredentialStore.ts`

- [ ] **Step 1: Create the interface** (spec §6)

`packages/core/src/credentials/CredentialStore.ts`:

```typescript
export interface StoredCredential {
  /** Hashing scheme identifier, e.g. 'argon2id'. */
  scheme: string;
  /** The hash string (self-describing for argon2). */
  hash: string;
  updatedAt: string;
}

export interface CredentialStore {
  getCredential(participantId: string): Promise<StoredCredential | null>;
  setCredential(participantId: string, secret: string): Promise<void>;
  removeCredential(participantId: string): Promise<void>;
  verify(participantId: string, secret: string): Promise<boolean>;
}
```

> Note: the spec's `setCredential` takes a `StoredCredential`, but hashing belongs inside
> the store (callers should never hash). We take the plaintext `secret` and hash internally.
> This keeps the one-responsibility boundary clean and is the signature Plan 10 will call.

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/credentials/CredentialStore.ts
git commit -m "feat(core): add CredentialStore interface"
```

---

## Task 5: FileCredentialStore (argon2)

**Files:**

- Modify: `packages/core/package.json` (add `@node-rs/argon2`)
- Create: `packages/core/src/credentials/FileCredentialStore.ts`
- Test: `packages/core/src/credentials/FileCredentialStore.test.ts`

- [ ] **Step 1: Add the argon2 dependency**

In `packages/core/package.json`, add a `dependencies` block:

```json
  "dependencies": {
    "@node-rs/argon2": "^2.0.0"
  }
```

Run: `npm install`
Expected: installs `@node-rs/argon2`.

- [ ] **Step 2: Write the failing test**

`packages/core/src/credentials/FileCredentialStore.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/credentials/FileCredentialStore.test.ts`
Expected: FAIL — `Cannot find module './FileCredentialStore.js'`.

- [ ] **Step 4: Write minimal implementation**

`packages/core/src/credentials/FileCredentialStore.ts`:

```typescript
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
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/credentials/FileCredentialStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Export collective + credentials from the core barrel**

Append to `packages/core/src/index.ts`:

```typescript
export * from './collective/Collective.js';
export * from './collective/default-participants.js';
export * from './credentials/CredentialStore.js';
export * from './credentials/FileCredentialStore.js';
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/credentials packages/core/src/index.ts packages/core/package.json package-lock.json
git commit -m "feat(core): add FileCredentialStore with argon2 hashing"
```

---

## Task 6: Full build + test gate

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Run full suite**

Run: `npm test`
Expected: PASS — Plans 1–3 green.

- [ ] **Step 3: Format + commit fixes**

```bash
npm run format
git add -A
git commit -m "chore: format collective/credentials sources" || echo "nothing to format"
```

---

## Self-Review Checklist

- **Spec §1 participant roster (id/name/type/tools/authority/status/identities/operator/protected):** consumed via `ParticipantConfig` from Plan 1; `Collective` loads/queries — Task 1. ✅
- **Spec §1 participant configs on disk at `collective/participants/<id>.json`:** Tasks 1–2. ✅
- **Spec §1 bootstrap operator (user, operator, protected, broad authority, web identity, management tools):** Task 3. ✅
- **Spec §7 protected participants cannot be retired; last operator cannot be removed/stripped:** Task 2. ✅
- **Spec §6 CredentialStore interface + FileCredentialStore at `credentials.json`, hashed at rest:** Tasks 4–5. ✅
- **Spec §16 credentials.json git-ignored:** handled by Plan 1 `.gitignore`. ✅
- **Deviation noted:** `setCredential(participantId, secret)` takes plaintext and hashes internally instead of spec's `StoredCredential` arg — documented in Task 4. ✅
- **Placeholder scan:** all steps contain full code/commands. ✅
- **Type consistency:** `Collective`, `createDefaultParticipants`, `BOOTSTRAP_OPERATOR_ID`, `CredentialStore`, `FileCredentialStore` are reused by Plans 4, 5, 10 verbatim. ✅
