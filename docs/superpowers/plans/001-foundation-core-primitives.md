# Foundation & Core Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the npm-workspaces monorepo and the core primitive types/utilities every later subsystem depends on (errors, events, storage, domain types).

**Architecture:** Three packages (`core`, `runtime`, `web`). This plan only fleshes out `packages/core` plus root tooling; `runtime` and `web` get minimal placeholder scaffolds so the workspace resolves. Pure ESM, TypeScript strict, Vitest for tests, Prettier for formatting. Core exposes a small, dependency-free foundation: a `LegionError` hierarchy, a typed `EventBus`, a `Storage` interface with an in-memory + file implementation, and the shared domain type declarations from the spec.

**Tech Stack:** Node 20+, npm workspaces, TypeScript 5.x (strict ESM, `NodeNext`), Vitest, Prettier.

---

## File Structure

```
legion-v2/
  package.json                         — root, workspaces + scripts (npm)
  tsconfig.base.json                   — shared compiler options
  tsconfig.json                        — solution file (references packages)
  .prettierrc.json                     — formatting rules
  .gitignore                           — .legion runtime dirs, dist, node_modules
  vitest.config.ts                     — root vitest config (workspace-aware)
  packages/
    types/                             — @legion-collective/types: zero-dependency, browser-safe shared models + wire DTOs
      package.json
      tsconfig.json
      src/
        index.ts                       — type barrel
        participant.ts                 — ParticipantConfig union + sub-shapes
        conversation.ts                — ConversationData, MessageData, ToolCall*
        tool.ts                        — ToolResult, ToolPolicy, JSONSchema, ApprovalAuthority
        config.ts                      — WorkspaceConfig, ModelConfig, etc.
        events.ts                      — LegionEventMap payload shapes (data only)
    core/
      package.json
      tsconfig.json
      src/
        index.ts                       — barrel re-exports (incl. re-export of @legion-collective/types)
        errors/
          LegionError.ts               — base + subclasses
          LegionError.test.ts
        events/
          EventBus.ts                  — typed pub/sub (class; imports map from @legion-collective/types)
          EventBus.test.ts
        storage/
          Storage.ts                   — interface
          MemoryStorage.ts             — in-memory impl
          MemoryStorage.test.ts
          FileStorage.ts               — fs-backed impl
          FileStorage.test.ts
    runtime/
      package.json
      tsconfig.json
      src/index.ts                     — placeholder export (filled in later plans)
    web/
      package.json                     — placeholder (filled in Plan 11)
```

> **Why a separate `@legion-collective/types` package?** The web frontend (Plan 11) must share the
> domain models and wire DTOs without pulling the engine — and crucially without dragging
> Node-only deps (`@node-rs/argon2`, `node:fs`, `node:crypto`) into the browser bundle.
> A zero-dependency types package makes that impossible by construction. **Scope rule:**
> only pure, browser-safe data shapes live here (domain models, `ToolResult`/`ToolCall*`,
> config, event payload map). Behavior/Node-coupled types (`Storage`, `EventBus` class,
> `Runtime`, `ToolContext`, `MessageRouterPort`, `AuthEngine`) stay in `@legion-collective/core`.
> `@legion-collective/core` re-exports `@legion-collective/types`, so importing domain types from `@legion-collective/core`
> keeps working everywhere.

---

## Task 1: Root workspace scaffolding

**Files:**

- Create: `package.json`
- Create: `.gitignore`
- Create: `.prettierrc.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Create the root `package.json`**

```json
{
  "name": "legion-v2",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "workspaces": ["packages/types", "packages/core", "packages/runtime", "packages/web"],
  "scripts": {
    "build": "tsc --build",
    "clean": "tsc --build --clean",
    "test": "vitest run",
    "test:watch": "vitest",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --build --force"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "prettier": "^3.3.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
node_modules/
dist/
*.tsbuildinfo

# Legion runtime data (git-ignored per spec §16)
.legion/conversations/
.legion/services/
.legion/credentials.json
```

- [ ] **Step 3: Create `.prettierrc.json`** (spec §15)

```json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 4: Create `tsconfig.base.json`** (spec §15 strict ESM)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 5: Create the solution `tsconfig.json`**

```json
{
  "files": [],
  "references": [
    { "path": "packages/types" },
    { "path": "packages/core" },
    { "path": "packages/runtime" }
  ]
}
```

- [ ] **Step 6: Install and verify the workspace resolves**

Run: `npm install`
Expected: completes without error, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore .prettierrc.json tsconfig.base.json tsconfig.json
git commit -m "chore: scaffold npm workspace root tooling"
```

---

## Task 2: types + core + runtime + web package skeletons

**Files:**

- Create: `packages/types/package.json`
- Create: `packages/types/tsconfig.json`
- Create: `packages/types/src/index.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/runtime/package.json`
- Create: `packages/runtime/tsconfig.json`
- Create: `packages/runtime/src/index.ts`
- Create: `packages/web/package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `packages/types/package.json`** (zero runtime dependencies)

```json
{
  "name": "@legion-collective/types",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc --build"
  }
}
```

- [ ] **Step 2: Create `packages/types/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/types/src/index.ts`** (temporary barrel; populated in Task 4)

```typescript
export const TYPES_PACKAGE = '@legion-collective/types';
```

- [ ] **Step 4: Create `packages/core/package.json`** (depends on `@legion-collective/types`)

```json
{
  "name": "@legion-collective/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc --build"
  },
  "dependencies": {
    "@legion-collective/types": "*"
  }
}
```

- [ ] **Step 5: Create `packages/core/tsconfig.json`** (references `../types`)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "references": [{ "path": "../types" }],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 6: Create `packages/core/src/index.ts`** (temporary barrel; grows per task)

```typescript
export const CORE_PACKAGE = '@legion-collective/core';
```

- [ ] **Step 7: Create `packages/runtime/package.json`**

```json
{
  "name": "@legion-collective/runtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc --build"
  },
  "dependencies": {
    "@legion-collective/core": "*"
  }
}
```

- [ ] **Step 8: Create `packages/runtime/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "references": [{ "path": "../core" }],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 9: Create `packages/runtime/src/index.ts`** (placeholder, filled in Plan 10)

```typescript
export const RUNTIME_PACKAGE = '@legion-collective/runtime';
```

- [ ] **Step 10: Create `packages/web/package.json`** (placeholder, filled in Plan 11)

```json
{
  "name": "@legion-collective/web",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 11: Create root `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/**/src/**/*.test.ts', 'packages/**/src/**/*.integration.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 12: Build and verify**

Run: `npm run build`
Expected: builds `@legion-collective/types`, `@legion-collective/core`, and `@legion-collective/runtime` with no errors, emits `dist/`.

- [ ] **Step 13: Commit**

```bash
git add packages vitest.config.ts package-lock.json
git commit -m "chore: scaffold types, core, runtime, web package skeletons"
```

---

## Task 3: LegionError hierarchy

**Files:**

- Create: `packages/core/src/errors/LegionError.ts`
- Test: `packages/core/src/errors/LegionError.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import {
  LegionError,
  ParticipantNotFoundError,
  ToolNotFoundError,
  ProviderError,
  ConfigError,
} from './LegionError.js';

describe('LegionError', () => {
  it('is an Error subclass carrying a stable code', () => {
    const err = new LegionError('boom', 'LEGION_ERROR');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LegionError');
    expect(err.code).toBe('LEGION_ERROR');
    expect(err.message).toBe('boom');
  });

  it('ParticipantNotFoundError includes the id and a specific code', () => {
    const err = new ParticipantNotFoundError('agent-7');
    expect(err).toBeInstanceOf(LegionError);
    expect(err.name).toBe('ParticipantNotFoundError');
    expect(err.code).toBe('PARTICIPANT_NOT_FOUND');
    expect(err.message).toContain('agent-7');
  });

  it('ToolNotFoundError includes the tool name', () => {
    const err = new ToolNotFoundError('communicate');
    expect(err.code).toBe('TOOL_NOT_FOUND');
    expect(err.message).toContain('communicate');
  });

  it('ProviderError and ConfigError carry their own codes', () => {
    expect(new ProviderError('rate limited').code).toBe('PROVIDER_ERROR');
    expect(new ConfigError('bad config').code).toBe('CONFIG_ERROR');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/errors/LegionError.test.ts`
Expected: FAIL — `Cannot find module './LegionError.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
export class LegionError extends Error {
  readonly code: string;

  constructor(message: string, code = 'LEGION_ERROR') {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ParticipantNotFoundError extends LegionError {
  constructor(participantId: string) {
    super(`Participant not found: ${participantId}`, 'PARTICIPANT_NOT_FOUND');
  }
}

export class ToolNotFoundError extends LegionError {
  constructor(toolName: string) {
    super(`Tool not found: ${toolName}`, 'TOOL_NOT_FOUND');
  }
}

export class ProviderError extends LegionError {
  constructor(message: string) {
    super(message, 'PROVIDER_ERROR');
  }
}

export class ConfigError extends LegionError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}

export class ConversationNotFoundError extends LegionError {
  constructor(conversationId: string) {
    super(`Conversation not found: ${conversationId}`, 'CONVERSATION_NOT_FOUND');
  }
}

export class AuthorizationError extends LegionError {
  constructor(message: string) {
    super(message, 'AUTHORIZATION_ERROR');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/errors/LegionError.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from the core barrel**

In `packages/core/src/index.ts` replace the temporary content with:

```typescript
export * from './errors/LegionError.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/errors packages/core/src/index.ts
git commit -m "feat(core): add LegionError hierarchy"
```

---

## Task 4: Domain types — `@legion-collective/types` (conversations, tools, participants, config)

**Files:**

- Create: `packages/types/src/tool.ts`
- Create: `packages/types/src/conversation.ts`
- Create: `packages/types/src/participant.ts`
- Create: `packages/types/src/config.ts`
- Modify: `packages/types/src/index.ts`
- Test: `packages/types/src/types.test.ts`

> These are declaration-only modules (no runtime logic, zero dependencies) living in the
> shared `@legion-collective/types` package so both `@legion-collective/core` and `@legion-collective/web` can consume them.
> The test exists to lock the shapes in and guard against accidental signature drift in
> later plans. It uses `satisfies` to assert the types compile with representative literals.

- [ ] **Step 1: Create `packages/types/src/tool.ts`** (spec §7, §14)

```typescript
export type JSONSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolResultStatus = 'success' | 'error';

export interface ToolResult {
  status: ToolResultStatus;
  data?: unknown;
  error?: string;
}

export interface ToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  result: ToolResult;
}

export type ToolPolicy = 'auto' | 'deny' | 'requires_approval';

export interface ApprovalAuthority {
  // Tools this participant may approve on behalf of others.
  // '*' means any tool. Specific entries override the wildcard.
  tools?: Record<string, boolean> | '*';
  // Participant ids this authority applies to ('*' = any requester).
  participants?: string[] | '*';
}
```

- [ ] **Step 2: Create `packages/types/src/conversation.ts`** (spec §2)

```typescript
import type { ToolCallData, ToolCallResult } from './tool.js';

export type MessageRole = 'user' | 'assistant';
export type MessageType = 'message' | 'summary';
export type MessageStatus = 'active' | 'superseded' | 'pruned' | 'compacted';

export interface MessageData {
  id: string;
  parentId: string | null;
  conversationId: string;
  senderId: string;
  recipientId: string;
  replyTo?: string;
  role: MessageRole;
  content: string;
  type?: MessageType;
  status: MessageStatus;
  toolCalls?: ToolCallData[];
  toolResults?: ToolCallResult[];
  timestamp: string;

  editOf?: string;
  supersededBy?: string;

  compacts?: string[];

  prunedAt?: string;
  prunedBy?: string;
}

export interface ConversationData {
  id: string;
  schemaVersion: '2.0';
  createdAt: string;
  updatedAt: string;
  title?: string;
  activeBranchHead: string;
  messages: Record<string, MessageData>;
}

export interface ConversationMeta {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationFilter {
  participantId?: string;
  since?: string;
}
```

- [ ] **Step 3: Create `packages/types/src/config.ts`** (spec §11)

```typescript
export interface ModelConfig {
  provider: string; // e.g. 'openai-compatible' | 'anthropic'
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string; // name of env var holding the key
  temperature?: number;
  maxTokens?: number;
}

export interface RuntimeConfig {
  maxIterations: number;
  communicationDepthLimit: number;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ServerConfig {
  port?: number;
  host?: string;
}

export interface ConnectorConfig {
  name: string;
  enabled?: boolean;
  defaultParticipantId?: string;
  options?: Record<string, unknown>;
}

export interface StorageConfig {
  backend?: 'file' | 'memory';
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface LoggingConfig {
  level?: 'debug' | 'info' | 'warn' | 'error';
}

export interface WorkspaceConfig {
  version: '2';
  workspaceRoot?: string;
  storage?: StorageConfig;
  server?: ServerConfig;
  connectors?: ConnectorConfig[];
  mcpServers?: MCPServerConfig[];
  defaultModel?: ModelConfig;
  providers?: Record<string, ProviderConfig>;
  logging?: LoggingConfig;
}
```

- [ ] **Step 4: Create `packages/types/src/participant.ts`** (spec §1)

```typescript
import type { ToolPolicy, ApprovalAuthority } from './tool.js';
import type { ModelConfig, RuntimeConfig } from './config.js';

export type ParticipantType = 'agent' | 'service' | 'user' | 'mock';
export type ParticipantStatus = 'active' | 'retired';

export interface ConnectorIdentity {
  connector: string;
  externalId: string;
}

export interface BaseParticipant {
  id: string;
  name: string;
  type: ParticipantType;
  tools: Record<string, ToolPolicy>;
  approvalAuthority?: ApprovalAuthority;
  status?: ParticipantStatus;
  identities?: ConnectorIdentity[];
  operator?: boolean;
  protected?: boolean;
}

export interface AgentConfig extends BaseParticipant {
  type: 'agent';
  systemPrompt: string;
  model: ModelConfig;
  runtimeConfig?: Partial<RuntimeConfig>;
}

export interface ServiceConfig extends BaseParticipant {
  type: 'service';
  module: string;
  config?: Record<string, unknown>;
  canReceive?: boolean;
  autoStart?: boolean;
}

export interface UserConfig extends BaseParticipant {
  type: 'user';
}

export interface MockConfig extends BaseParticipant {
  type: 'mock';
  responses: string[];
}

export type ParticipantConfig = AgentConfig | ServiceConfig | UserConfig | MockConfig;
```

- [ ] **Step 5: Replace `packages/types/src/index.ts`** (was the temporary placeholder)

```typescript
export * from './tool.js';
export * from './conversation.js';
export * from './config.js';
export * from './participant.js';
```

- [ ] **Step 6: Write the compile-guard test** at `packages/types/src/types.test.ts`

```typescript
import type {
  ParticipantConfig,
  ConversationData,
  MessageData,
  ToolResult,
  WorkspaceConfig,
} from './index.js';

describe('domain type shapes', () => {
  it('accepts a representative agent participant', () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      type: 'agent',
      tools: { communicate: 'auto' },
      systemPrompt: 'You are helpful.',
      model: { provider: 'openai-compatible', model: 'gpt-4o-mini' },
    } satisfies ParticipantConfig;
    expect(agent.type).toBe('agent');
  });

  it('accepts a representative conversation with a keyed message map', () => {
    const root: MessageData = {
      id: 'm1',
      parentId: null,
      conversationId: 'conv-1',
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const conv = {
      id: 'conv-1',
      schemaVersion: '2.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      activeBranchHead: 'm1',
      messages: { m1: root },
    } satisfies ConversationData;
    expect(conv.messages.m1.parentId).toBeNull();
  });

  it('accepts a tool result and workspace config', () => {
    const ok: ToolResult = { status: 'success', data: 42 };
    const cfg = { version: '2' } satisfies WorkspaceConfig;
    expect(ok.status).toBe('success');
    expect(cfg.version).toBe('2');
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run packages/types/src/types.test.ts`
Expected: PASS (3 tests). If it fails to compile, the type definitions are wrong — fix them, not the test.

- [ ] **Step 8: Re-export `@legion-collective/types` from the core barrel**

In `packages/core/src/index.ts` (so `import { MessageData } from '@legion-collective/core'` keeps working everywhere):

```typescript
export * from './errors/LegionError.js';
export * from '@legion-collective/types';
```

- [ ] **Step 9: Commit**

```bash
git add packages/types/src packages/core/src/index.ts
git commit -m "feat(types): add shared domain type declarations"
```

---

## Task 5: Typed EventBus

**Files:**

- Create: `packages/types/src/events.ts` (event payload map — browser-safe, shared with web)
- Modify: `packages/types/src/index.ts` (export the event map)
- Create: `packages/core/src/events/EventBus.ts` (the class — stays in core)
- Test: `packages/core/src/events/EventBus.test.ts`

> The `LegionEventMap` payload shapes live in `@legion-collective/types` so the web connector's
> `/ws` event stream (Plan 11) can type events without importing the engine. The `EventBus`
> _class_ stays in `@legion-collective/core`.

- [ ] **Step 1: Create the event map** (spec §12)

`packages/types/src/events.ts`:

```typescript
export interface LegionEventMap {
  'process:ready': { workspaceRoot: string };
  'conversation:created': { conversationId: string };
  'message:sent': {
    conversationId: string;
    senderId: string;
    recipientId: string;
    messageId: string;
  };
  'message:delivered': { conversationId: string; recipientId: string; messageId: string };
  'tool:call': { conversationId: string; participantId: string; tool: string; callId: string };
  'tool:result': {
    conversationId: string;
    participantId: string;
    tool: string;
    callId: string;
    status: 'success' | 'error';
  };
  'approval:requested': {
    conversationId: string;
    requesterId: string;
    tool: string;
    requestId: string;
  };
  'approval:resolved': {
    conversationId: string;
    requestId: string;
    approved: boolean;
    decidedByParticipantId: string;
  };
  iteration: { conversationId: string; participantId: string; iteration: number };
  error: { conversationId?: string; error: { name: string; message: string } };
}

export type LegionEventName = keyof LegionEventMap;
```

Then append to `packages/types/src/index.ts`:

```typescript
export * from './events.js';
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/events/EventBus.test.ts`:

```typescript
import { EventBus } from './EventBus.js';

describe('EventBus', () => {
  it('delivers a typed payload to a subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('message:sent', (p) => seen.push(p.messageId));
    bus.emit('message:sent', {
      conversationId: 'c1',
      senderId: 'a',
      recipientId: 'b',
      messageId: 'm1',
    });
    expect(seen).toEqual(['m1']);
  });

  it('supports multiple subscribers and unsubscribe', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('process:ready', () => (count += 1));
    bus.on('process:ready', () => (count += 1));
    bus.emit('process:ready', { workspaceRoot: '/w' });
    expect(count).toBe(2);
    off();
    bus.emit('process:ready', { workspaceRoot: '/w' });
    expect(count).toBe(3);
  });

  it('once fires a handler a single time', () => {
    const bus = new EventBus();
    let count = 0;
    bus.once('iteration', () => (count += 1));
    bus.emit('iteration', { conversationId: 'c', participantId: 'a', iteration: 1 });
    bus.emit('iteration', { conversationId: 'c', participantId: 'a', iteration: 2 });
    expect(count).toBe(1);
  });

  it('isolates subscriber errors so other handlers still run', () => {
    const bus = new EventBus();
    let reached = false;
    bus.on('process:ready', () => {
      throw new Error('boom');
    });
    bus.on('process:ready', () => (reached = true));
    expect(() => bus.emit('process:ready', { workspaceRoot: '/w' })).not.toThrow();
    expect(reached).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/events/EventBus.test.ts`
Expected: FAIL — `Cannot find module './EventBus.js'`.

- [ ] **Step 4: Write minimal implementation**

`packages/core/src/events/EventBus.ts`:

```typescript
import type { LegionEventMap, LegionEventName } from '@legion-collective/types';

type Handler<E extends LegionEventName> = (payload: LegionEventMap[E]) => void;

export class EventBus {
  private handlers = new Map<LegionEventName, Set<Handler<LegionEventName>>>();

  on<E extends LegionEventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<LegionEventName>);
    return () => this.off(event, handler);
  }

  once<E extends LegionEventName>(event: E, handler: Handler<E>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<E extends LegionEventName>(event: E, handler: Handler<E>): void {
    this.handlers.get(event)?.delete(handler as Handler<LegionEventName>);
  }

  emit<E extends LegionEventName>(event: E, payload: LegionEventMap[E]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {
        // Subscriber errors must not break emission for other handlers.
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/events/EventBus.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Export from the core barrel**

Append to `packages/core/src/index.ts` (the event map is already re-exported via `@legion-collective/types` in Task 4 Step 8):

```typescript
export * from './events/EventBus.js';
```

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/events.ts packages/types/src/index.ts packages/core/src/events packages/core/src/index.ts
git commit -m "feat(core): add typed EventBus over @legion-collective/types event map"
```

---

## Task 6: Storage interface + MemoryStorage

**Files:**

- Create: `packages/core/src/storage/Storage.ts`
- Create: `packages/core/src/storage/MemoryStorage.ts`
- Test: `packages/core/src/storage/MemoryStorage.test.ts`

> `Storage` is the low-level key/value-by-path abstraction used by the service SDK
> (spec §5 `storage` scoped per service) and the file stores. It is namespace-prefixed
> string storage with JSON helpers and listing.

- [ ] **Step 1: Create the interface**

`packages/core/src/storage/Storage.ts`:

```typescript
export interface Storage {
  /** Read raw string content at a key, or null if absent. */
  read(key: string): Promise<string | null>;
  /** Write raw string content at a key (creates parents as needed). */
  write(key: string, value: string): Promise<void>;
  /** Delete a key; no error if it does not exist. */
  delete(key: string): Promise<void>;
  /** True if the key exists. */
  exists(key: string): Promise<boolean>;
  /** List keys under a prefix (non-recursive directory-style listing). */
  list(prefix: string): Promise<string[]>;
  /** Read and JSON.parse, or null if absent. */
  readJson<T>(key: string): Promise<T | null>;
  /** JSON.stringify (pretty) and write. */
  writeJson(key: string, value: unknown): Promise<void>;
  /** Return a Storage scoped under the given prefix. */
  scope(prefix: string): Storage;
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/storage/MemoryStorage.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/storage/MemoryStorage.test.ts`
Expected: FAIL — `Cannot find module './MemoryStorage.js'`.

- [ ] **Step 4: Write minimal implementation**

`packages/core/src/storage/MemoryStorage.ts`:

```typescript
import type { Storage } from './Storage.js';

function joinKey(prefix: string, key: string): string {
  if (!prefix) return key;
  return `${prefix.replace(/\/$/, '')}/${key}`;
}

export class MemoryStorage implements Storage {
  private map: Map<string, string>;
  private prefix: string;

  constructor(map: Map<string, string> = new Map(), prefix = '') {
    this.map = map;
    this.prefix = prefix;
  }

  private full(key: string): string {
    return joinKey(this.prefix, key);
  }

  async read(key: string): Promise<string | null> {
    return this.map.has(this.full(key)) ? this.map.get(this.full(key))! : null;
  }

  async write(key: string, value: string): Promise<void> {
    this.map.set(this.full(key), value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(this.full(key));
  }

  async exists(key: string): Promise<boolean> {
    return this.map.has(this.full(key));
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.full(prefix).replace(/\/$/, '');
    const needle = `${base}/`;
    const children = new Set<string>();
    for (const fullKey of this.map.keys()) {
      if (!fullKey.startsWith(needle)) continue;
      const rest = fullKey.slice(needle.length);
      const firstSegment = rest.split('/')[0];
      if (firstSegment) children.add(firstSegment);
    }
    return [...children];
  }

  async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.read(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.write(key, JSON.stringify(value, null, 2));
  }

  scope(prefix: string): Storage {
    return new MemoryStorage(this.map, this.full(prefix));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/storage/MemoryStorage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/storage/Storage.ts packages/core/src/storage/MemoryStorage.ts packages/core/src/storage/MemoryStorage.test.ts
git commit -m "feat(core): add Storage interface and MemoryStorage"
```

---

## Task 7: FileStorage

**Files:**

- Create: `packages/core/src/storage/FileStorage.ts`
- Test: `packages/core/src/storage/FileStorage.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/storage/FileStorage.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from './FileStorage.js';

describe('FileStorage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-storage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes and reads through the filesystem', async () => {
    const s = new FileStorage(dir);
    expect(await s.read('a.txt')).toBeNull();
    await s.write('nested/a.txt', 'hello');
    expect(await s.read('nested/a.txt')).toBe('hello');
    expect(await s.exists('nested/a.txt')).toBe(true);
  });

  it('round-trips JSON', async () => {
    const s = new FileStorage(dir);
    await s.writeJson('obj.json', { x: 1 });
    expect(await s.readJson<{ x: number }>('obj.json')).toEqual({ x: 1 });
  });

  it('lists immediate children', async () => {
    const s = new FileStorage(dir);
    await s.write('d/a.json', '1');
    await s.write('d/b.json', '2');
    await s.write('d/sub/c.json', '3');
    expect((await s.list('d')).sort()).toEqual(['a.json', 'b.json', 'sub']);
  });

  it('returns empty list for a missing prefix', async () => {
    const s = new FileStorage(dir);
    expect(await s.list('missing')).toEqual([]);
  });

  it('scopes under a sub-path', async () => {
    const s = new FileStorage(dir).scope('services/svc-1');
    await s.write('state.json', 'x');
    expect(await new FileStorage(dir).read('services/svc-1/state.json')).toBe('x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/storage/FileStorage.test.ts`
Expected: FAIL — `Cannot find module './FileStorage.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/storage/FileStorage.ts`:

```typescript
import { mkdir, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Storage } from './Storage.js';

export class FileStorage implements Storage {
  constructor(private root: string) {}

  private path(key: string): string {
    return join(this.root, key);
  }

  async read(key: string): Promise<string | null> {
    try {
      return await readFile(this.path(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(key: string, value: string): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value, 'utf8');
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const entries = await readdir(this.path(prefix), { withFileTypes: true });
      return entries.map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.read(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.write(key, JSON.stringify(value, null, 2));
  }

  scope(prefix: string): Storage {
    return new FileStorage(join(this.root, prefix));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/storage/FileStorage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Export storage from the core barrel**

Append to `packages/core/src/index.ts`:

```typescript
export * from './storage/Storage.js';
export * from './storage/MemoryStorage.js';
export * from './storage/FileStorage.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/storage/FileStorage.ts packages/core/src/storage/FileStorage.test.ts packages/core/src/index.ts
git commit -m "feat(core): add FileStorage"
```

---

## Task 8: id + timestamp utilities

**Files:**

- Create: `packages/core/src/util/ids.ts`
- Test: `packages/core/src/util/ids.test.ts`

> Centralises id generation so every later plan uses the same formats
> (`conv-<timestamp>-<random5>` per spec §2; generic `<prefix>-<...>` for messages, etc.).

- [ ] **Step 1: Write the failing test**

`packages/core/src/util/ids.test.ts`:

```typescript
import { createId, createConversationId, nowIso } from './ids.js';

describe('id utilities', () => {
  it('createConversationId matches conv-<timestamp>-<random5>', () => {
    const id = createConversationId();
    expect(id).toMatch(/^conv-\d+-[a-z0-9]{5}$/);
  });

  it('createId prefixes and stays unique across calls', () => {
    const a = createId('msg');
    const b = createId('msg');
    expect(a).toMatch(/^msg-/);
    expect(a).not.toBe(b);
  });

  it('nowIso returns a parseable ISO timestamp', () => {
    const iso = nowIso();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/util/ids.test.ts`
Expected: FAIL — `Cannot find module './ids.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/util/ids.ts`:

```typescript
import { randomBytes, randomUUID } from 'node:crypto';

function random5(): string {
  return randomBytes(4).toString('hex').slice(0, 5);
}

export function createConversationId(): string {
  return `conv-${Date.now()}-${random5()}`;
}

export function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/util/ids.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Export from the core barrel**

Append to `packages/core/src/index.ts`:

```typescript
export * from './util/ids.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/util packages/core/src/index.ts
git commit -m "feat(core): add id and timestamp utilities"
```

---

## Task 9: Full build + test gate

**Files:**

- Modify: none (verification task)

> **Note on the type gate:** each package `tsconfig.json` excludes `src/**/*.test.ts`, so
> `npm run typecheck` (`tsc --build`) type-checks production sources only. Vitest transpiles
> tests with esbuild (no type checking), so **Vitest is the gate for test code** — test-only
> type mistakes surface as runtime failures, not `tsc` errors. This is intentional: tests use
> `as unknown as` casts to build partial contexts. Keep production sources strictly typed.

- [ ] **Step 1: Typecheck the whole workspace**

Run: `npm run typecheck`
Expected: PASS — no type errors in any package.

- [ ] **Step 2: Run the entire test suite**

Run: `npm test`
Expected: PASS — all tests from Tasks 3–8 green.

- [ ] **Step 3: Verify formatting**

Run: `npm run format:check`
Expected: PASS, or run `npm run format` then re-check.

- [ ] **Step 4: Commit any formatting fixes**

```bash
git add -A
git commit -m "chore: format foundation sources" || echo "nothing to format"
```

---

## Self-Review Checklist

- **Spec §8 (process/package structure):** `packages/types`, `packages/core`, `packages/runtime`, `packages/web` scaffolded — Tasks 1–2. ✅
- **Shared types package:** `@legion-collective/types` holds browser-safe domain models + event payload map (zero deps); `@legion-collective/core` re-exports it; web (Plan 11) consumes it without dragging Node deps — Tasks 2, 4, 5. ✅
- **Spec §10 (storage interfaces):** `Storage` low-level abstraction in place; `ConversationStore`/`CredentialStore` are Plans 2–3. ✅ (foundation only)
- **Spec §12 (events):** typed `EventBus` (core) over `LegionEventMap` (`@legion-collective/types`) — Task 5. ✅
- **Spec §15 (conventions):** ESM `.js` imports, strict TS, Prettier config, Vitest globals, colocated tests, `mkdtemp` temp dirs — Tasks 1, 7. ✅
- **Spec §16 (workspace layout):** `.gitignore` excludes `.legion/conversations`, `services`, `credentials.json` — Task 1. ✅
- **Domain types (§1, §2, §7, §11, §14):** declared in `@legion-collective/types` — Task 4. ✅
- **Placeholder scan:** every code step contains full code; no TODO/TBD. ✅
- **Type consistency:** `Storage`, `EventBus`, `LegionEventMap`, `ParticipantConfig`, `ConversationData`, `MessageData`, `ToolResult` names are reused verbatim by Plans 2–5 (imported from `@legion-collective/types` or re-exported via `@legion-collective/core`). ✅
