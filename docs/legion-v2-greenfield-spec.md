# Legion v2 — Greenfield Specification

**Audience:** An agent starting from a blank slate with no prior knowledge of this project.

---

## What is Legion?

Legion is a **multi-agent collective framework**. It runs as a single always-on process that hosts a collection of participants — AI agents, automated services, and human users — who communicate with each other by sending messages. Any participant can talk to any other. A web user logged into a browser UI, an external integration (Teams, Slack), and an AI agent mid-task all participate through the same model.

The core insight: Legion is not a chat app you start and stop. It is a persistent process that external channels connect to simultaneously. Agents run autonomously, services react to events, and humans reach in through connectors (web browser, Teams, Slack, etc.) to direct, approve, or monitor.

---

## 1. Participants

The collective is a roster of participants. Every participant has an `id`, a `name`, a `type`, and an authorization profile (which tools it may run, and whose tool calls it may approve).

There are four types:

| Type      | Driver                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `agent`   | LLM agentic loop (calls tools, receives results, repeats until done)                                   |
| `service` | Code module (`LegionService` interface, §5)                                                            |
| `user`    | No internal driver — behaviour comes entirely from an external entity reached through a connector (§6) |
| `mock`    | Scripted deterministic responses (testing)                                                             |

`type` describes only the internal driver. **No routing, authorization, or delivery logic branches on type.**

### Base participant shape

```typescript
interface BaseParticipant {
  id: string;
  name: string;
  type: 'agent' | 'service' | 'user' | 'mock';
  tools: Record<string, ToolPolicy>; // what tools this participant may run
  approvalAuthority?: ApprovalAuthority; // whose tool calls this participant may approve
  status?: 'active' | 'retired';
  identities?: ConnectorIdentity[]; // external identities that map to this participant
  operator?: boolean; // broad administrative authority (by convention)
  protected?: boolean; // cannot be retired; last operator cannot be removed
}
```

### Per-type extensions

```typescript
interface AgentConfig extends BaseParticipant {
  type: 'agent';
  systemPrompt: string;
  model: ModelConfig;
  runtimeConfig?: Partial<RuntimeConfig>;
}

interface ServiceConfig extends BaseParticipant {
  type: 'service';
  module: string; // npm module name or relative path
  config?: Record<string, unknown>;
  canReceive?: boolean; // whether this service accepts incoming messages (default: true)
  autoStart?: boolean; // whether to start on process boot (default: true)
}

interface UserConfig extends BaseParticipant {
  type: 'user';
  // No internal driver. All behaviour arrives via connector(s) in `identities`.
}

interface MockConfig extends BaseParticipant {
  type: 'mock';
  responses: string[]; // scripted responses, cycling
}
```

### Connector binding is orthogonal to type

Any participant — not just `user` — may be bound to a boundary connector (e.g. an agent exposed to a Teams integration). A `user` is simply a participant that has no internal driver, so it is _only_ reachable via connector(s). Binding is declared in `identities`:

```typescript
interface ConnectorIdentity {
  connector: string; // connector name: "web" | "teams" | "slack" | ...
  externalId: string; // implementation-defined external id
}
```

### Participant configs on disk

Each participant is stored as a JSON file: `.legion/collective/participants/<id>.json`. The schema maps directly to the union type above.

### Bootstrap operator

On workspace init, Legion seeds a **default operator**: a `user`-type participant with `operator: true`, `protected: true`, broad `approvalAuthority`, and management tool access. This participant is reachable via the web connector with a bootstrapped password. It makes a fresh workspace immediately usable.

---

## 2. Conversations

### A conversation is a standalone thread

A conversation is a persistent, identified message history. It is not tied to a fixed pair of participants — any participant may send into any conversation. The full history is the shared context.

```typescript
interface ConversationData {
  id: string;
  schemaVersion: '2.0';
  createdAt: string;
  updatedAt: string;
  title?: string;
  activeBranchHead: string; // ID of the current leaf in the active chain
  messages: Record<string, MessageData>; // keyed map, not an array
}
```

Stored as JSON files: `.legion/conversations/<id>.json`. ID format: `conv-<timestamp>-<random5>`.

### Message model

Messages are stored as a **keyed map**, not an array. Order is recovered by traversing `parentId` links from `activeBranchHead` back to the root (`parentId: null`). This structure supports editing, pruning, and compaction without data loss.

```typescript
interface MessageData {
  id: string;
  parentId: string | null; // null for the root message
  conversationId: string;
  senderId: string; // participant who sent this
  recipientId: string; // participant this is addressed to
  replyTo?: string; // participantId — redirect recipient's response here (§3)
  role: 'user' | 'assistant'; // stored on the message; computed from senderId/recipientId
  content: string;
  type?: 'message' | 'summary'; // 'summary' for compaction nodes (default: 'message')
  status: 'active' | 'superseded' | 'pruned' | 'compacted';
  toolCalls?: ToolCallData[];
  toolResults?: ToolCallResult[];
  timestamp: string;

  // Edit tracking
  editOf?: string; // references the original message ID this node replaces
  supersededBy?: string; // set on the original when it has been edited

  // Compaction tracking
  compacts?: string[]; // set on summary nodes; IDs of messages this node replaces

  // Prune tracking
  prunedAt?: string;
  prunedBy?: string; // participantId of who performed the prune
}
```

### Reconstructing the active context

To build the ordered message list for LLM context injection:

```typescript
function getActiveChain(conversation: ConversationData): MessageData[] {
  const chain: MessageData[] = [];
  let current = conversation.messages[conversation.activeBranchHead];
  while (current) {
    chain.unshift(current);
    current = current.parentId ? conversation.messages[current.parentId] : undefined;
  }
  return chain;
}
```

Only `active` messages appear in the active chain. All other nodes (`superseded`, `pruned`, `compacted`) remain in the file and are fully recoverable.

### Context manipulation operations

**Edit + re-run:** Create a new node with the same `parentId` as the original, set `editOf` on the new node and `supersededBy` on the original, mark the original `superseded`. Update `activeBranchHead` to the new leaf after re-running.

**Manual prune:** Mark the target `pruned`, set `prunedAt`/`prunedBy`. If it was `activeBranchHead`, roll the head back to its `parentId`. Descendants are excluded from the active chain automatically (traversal cannot route through a pruned parent).

**Compaction:** Create a `summary` node spanning a range of messages. Set its `parentId` to the parent of the first compacted message and `compacts` to the list of compacted IDs. Mark all compacted messages `compacted`. Re-point the following message's `parentId` to the new summary node.

### Storage invariants

- Every message's `parentId` references an existing key in `messages`, or is `null`
- Exactly one message has `parentId: null` (the root)
- `activeBranchHead` references an existing key in `messages`
- The path from `activeBranchHead` to root contains no cycles
- A `compacted` message must appear in exactly one summary node's `compacts` array
- A `superseded` message must have a valid `supersededBy` reference

---

## 3. Communication

### The `communicate` tool

The primary way any participant sends a message to another is the `communicate` tool. Agents call it during their agentic loop; services call `ServiceContext.communicate()`; connectors call `MessageRouter.send()` directly.

```typescript
// Tool signature exposed to LLM
{
  name: 'communicate',
  parameters: {
    to: string,              // target participant ID
    message: string,
    conversationId?: string, // join existing thread (creates new if omitted)
    replyTo?: string,        // fire-and-forget: route response to this participant instead
  }
}
```

### Synchronous call (no `replyTo`)

Default behaviour. The sender blocks until the recipient responds.

```
Sender calls communicate(to="agent-b", message="...")
  → MessageRouter acquires conversation lock
  → appends message (persists)
  → dispatches to agent-b's runtime (awaits)
  → appends agent-b's response (persists)
  → releases lock
  → returns response as tool result
```

### Fire-and-forget (with `replyTo`)

When `replyTo` is set, the call returns immediately with a `conversationId`. The recipient processes asynchronously. When done, `MessageRouter` routes the response to the `replyTo` participant (not back to `senderId`).

```
Service calls communicate(to="analysis-agent", message="...", replyTo="ops-alice")
  → MessageRouter appends message (persists)
  → dispatches to analysis-agent's runtime (no await — returns conversationId immediately)
  → [service continues]

  [background]
  analysis-agent finishes its loop
  → MessageRouter routes response to "ops-alice"
  → ops-alice is connector-bound; the connector delivers to the external channel
```

`replyTo` always names a **participant**. Delivery to a connector-bound participant goes through its connector (§6.7).

### MessageRouter

The central dispatch class. Replaces any notion of a "session" as the communication hub.

```typescript
class MessageRouter {
  constructor(
    private store: ConversationStore,
    private registry: RuntimeRegistry,
    private collective: Collective,
    private eventBus: EventBus,
  ) {}

  async send(opts: {
    senderId: string;
    recipientId: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
    context: Omit<RuntimeContext, 'participant' | 'conversationId' | 'conversation'>;
  }): Promise<MessageRouterResult>;
}

interface MessageRouterResult {
  conversationId: string;
  response?: string;
  status: 'success' | 'error' | 'dispatched'; // 'dispatched' = fire-and-forget
  error?: string;
}
```

---

## 4. RuntimeContext

The object passed to every tool execution and runtime invocation:

```typescript
interface RuntimeContext {
  participant: ParticipantConfig; // the principal executing this action
  conversationId: string;
  conversation: ConversationThread;
  collective: Collective;
  communicationDepth: number;
  toolRegistry: ToolRegistry;
  config: Config;
  eventBus: EventBus;
  storage: Storage;
  workspaceRoot: string;
  authEngine: AuthEngine;
  callingParticipantId?: string; // immediate caller (first approver candidate — §7)
  pendingApprovalRegistry: PendingApprovalRegistry;
  messageRouter: MessageRouter;
  serviceManager?: ServiceManager;
}
```

---

## 5. Service SDK

Services are code-backed participants. Any npm module can be a service by exporting a `LegionService` object.

### `LegionService` interface

```typescript
export interface LegionService {
  start(context: ServiceContext): Promise<void>;
  stop(): Promise<void>;
  onMessage?(message: IncomingMessage, context: ServiceContext): Promise<string | void>;
}
```

`onMessage` is optional. If absent, the service cannot receive incoming messages from other participants (or set `canReceive: false` in config). `start` is called once at startup; `stop` is called on shutdown.

### `IncomingMessage`

```typescript
export interface IncomingMessage {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  replyTo?: string;
  content: string;
  timestamp: string;
}
```

### `ServiceContext`

```typescript
export interface ServiceContext {
  participantId: string;
  stopped: AbortSignal;
  storage: Storage; // scoped to .legion/services/<id>/
  eventBus: EventBus;

  communicate(
    to: string,
    message: string,
    opts?: { conversationId?: string; replyTo?: string },
  ): Promise<CommunicateResult>;

  callTool(toolName: string, args: unknown): Promise<ToolResult>;

  sleep(ms: number): Promise<void>;
}

export interface CommunicateResult {
  conversationId: string;
  response?: string;
  status: 'success' | 'error' | 'dispatched';
  error?: string;
}
```

---

## 6. Connectors

A **connector** is the channel through which a participant is contacted and through which its responses (and any approval requests) return. There are two kinds:

| Connector           | Boundary                                            | Role                       |
| ------------------- | --------------------------------------------------- | -------------------------- |
| `communicate` tool  | Internal (participant ↔ participant, in-collective) | Pure routing               |
| web / Teams / Slack | Boundary (participant ↔ external entity)            | Authentication + transport |

**A connector is not a participant.** It is a channel. Messages route between participants by `senderId`/`recipientId`; a connector is _how_ a participant is reached when it is connector-bound.

**Boundary connectors map external identities to participants.** A single web connector authenticates many external identities, each resolving to its own participant. Unknown identities are rejected (or optionally mapped to a configured low-privilege default participant, per-connector opt-in).

### Core-facing connector interface

```typescript
interface Connector {
  readonly name: string;
  start(ctx: ConnectorContext): Promise<void>;
  deliver(message: IncomingMessage): Promise<void>; // outbound to external entity
  stop(): Promise<void>;
}

interface ConnectorContext {
  // Inbound: external entity sends a message as a participant this connector fronts
  submit(msg: {
    senderId: string;
    recipientId: string;
    content: string;
    conversationId?: string;
    replyTo?: string;
  }): Promise<MessageRouterResult>;

  // Execute a tool as a participant this connector fronts
  callTool(participantId: string, toolName: string, args: unknown): Promise<ToolResult>;

  registry: ConnectorRegistry; // register/deregister participants this connector fronts
}
```

Core knows nothing about authentication. How a connector proves identity and maps it to a participant is entirely internal to the implementation.

### Authentication is connector-internal

- The **web connector** verifies a password via `CredentialStore`, establishes an `AuthSession` (cookie or JWT), and fronts the matching participant.
- Teams/Slack connectors trust the platform's verified user identity.

Authentication material is stored in a `CredentialStore`, separate from participant configs:

```typescript
interface CredentialStore {
  getCredential(participantId: string): Promise<StoredCredential | null>;
  setCredential(participantId: string, credential: StoredCredential): Promise<void>;
  removeCredential(participantId: string): Promise<void>;
  verify(participantId: string, secret: string): Promise<boolean>;
}
```

Default: `FileCredentialStore` (`.legion/credentials.json`, git-ignored). Passwords hashed at rest (argon2/bcrypt). A login session is called `AuthSession` — unrelated to conversations.

### Built-in connectors

- **Web connector** (`packages/runtime/src/server/`): Fastify HTTP server; password auth → `AuthSession`; SPA + tool-execution gateway (§8.3).

Third-party boundary connectors (Teams, Slack, etc.) implement the §6 `Connector` interface as external packages.

### Delivering to connector-bound participants

When `MessageRouter` routes a message to a connector-bound participant (normal delivery, fire-and-forget response, or bubbled approval), a **delivery runtime** resolves the participant's active connector(s) via `ConnectorRegistry` and calls `connector.deliver(message)`. If the participant has no active connection, the message is still persisted to the conversation and delivered when a connection is next established (per connector policy).

---

## 7. Authorization & Approval

### AuthEngine is a pure predicate

`AuthEngine` answers exactly two questions and orchestrates nothing:

```typescript
authorize(participantId, tool, args, participantPolicies?)
  // → { authorized: boolean, reason? }
  //   'auto'              → { authorized: true }
  //   'requires_approval' → { authorized: false } — must be approved by someone with authority
  //   absent from map     → { authorized: false, reason: 'hidden' } — not visible to LLM

hasAuthority(approverAuthority, requesterId, tool, args)
  // → boolean
```

Policy resolution: participant per-tool policy. Tools absent from the participant's `tools` map are hidden from the LLM and cannot be called.

The principal is always `context.participant`. An agent's LLM tool call, a service's `callTool`, and a participant acting through a boundary connector are all authorized identically — no special-casing by type or channel.

### Approval bubbles up emergently

When participant B (called by A through a connector) hits a `requires_approval` tool:

1. `AuthEngine` returns `requires_approval`.
2. B's runtime returns an **approval request to A through the connector B was called on** (the `communicate` tool for an internal call).
3. A receives it. Can A approve it (`hasAuthority(A, B, tool, args)`)?
   - **Yes** → A resolves it; the decision returns to B; B resumes.
   - **No** → A bubbles it up through A's own inbound connector.
4. Repeat. When the chain reaches a **boundary connector**, that connector posts the request to the external entity that made the call and returns the decision.
5. If the chain exhausts with no authority and no connector, it **fails closed** (deny).

No participant walks the chain — each hop performs the same local action. The resolution is tracked in `PendingApprovalRegistry`. `ApprovalLog.decidedByParticipantId` carries the real approver (not a hardcoded string).

### Management actions are ordinary authorized tool calls

`create_agent`, `retire_agent`, policy edits, credential management — these are **tools**, gated by the acting participant's `ToolPolicy` like any other tool. There is no separate management-permission layer.

### Protected participants

- Participants marked `protected` cannot be retired or removed.
- The collective must always retain at least one active `operator`; the last operator cannot be removed or stripped of operator authority.

---

## 8. Process Model

### Single unified process

Legion runs as one binary. The entry point is `packages/runtime/src/index.ts`.

**Startup sequence:**

1. Read workspace config from `.legion/config.json`
2. Load the collective from `.legion/collective/participants/` (seed the bootstrap operator if none exists)
3. Initialise `ConversationStore` and `CredentialStore` (file backends by default)
4. Register runtime factories: `agent` → `AgentRuntime`, `service` → `ServiceRuntime`, `mock` → `MockRuntime`, `user` → delivery runtime (routes to connector)
5. Create `MessageRouter`, `ToolRegistry`, `AuthEngine`, `EventBus`
6. Register global tools (file ops, `communicate`, `approval_response`, management tools)
7. Load MCP tool sources declared in workspace config; register tools into the global `ToolRegistry`
8. Create `ServiceManager`, load all service modules
9. Initialise enabled connectors; the web connector starts the HTTP server
10. Auto-start services with `autoStart: true`
11. Emit `process:ready`

### `LegionProcess`

```typescript
class LegionProcess {
  static async start(workspaceRoot: string): Promise<LegionProcess>;
  async stop(): Promise<void>;

  readonly router: MessageRouter;
  readonly collective: Collective;
  readonly store: ConversationStore;
  readonly credentials: CredentialStore;
  readonly services: ServiceManager;
  readonly connectors: ConnectorRegistry;
  readonly eventBus: EventBus;
}
```

### Management API — authenticated tool-execution gateway

The web connector exposes a minimal API. Every collective operation is a tool call; there are no bespoke CRUD endpoints.

| Route                   | Description                                               |
| ----------------------- | --------------------------------------------------------- |
| `POST /api/auth/login`  | Verify password, establish `AuthSession`                  |
| `POST /api/auth/logout` | Clear `AuthSession`                                       |
| `GET  /api/auth/me`     | Authenticated participant + authority summary             |
| `POST /api/execute`     | Execute a named tool **as the authenticated participant** |
| `GET  /ws`              | EventBus → WebSocket stream (authenticated)               |
| `GET  /api/health`      | Process liveness (unauthenticated)                        |
| `GET  /`                | Vue SPA (served from `packages/web/dist/`)                |

All authorization and audit come from `AuthEngine` + `ApprovalLog`. No per-endpoint permission logic.

The server binds `127.0.0.1` by default. Binding a non-loopback host emits a startup warning.

### Package structure

```
packages/
  core/      — engine: participants, conversations, tools, auth, LLM providers, events, storage
  runtime/   — single process entry point, web connector, CredentialStore
    src/
      index.ts             — LegionProcess
      server/              — Fastify: auth + execute gateway + WebSocket (web connector)
      credentials/         — FileCredentialStore
  web/       — Vue 3 + Vite + Tailwind SPA (workspace member; runtime serves its built dist/)
```

---

## 9. MCP Tool Sources

MCP servers are **tool sources**, not participants. They add tools to the global `ToolRegistry`, making them available to any participant that has the appropriate tool policies.

```typescript
export interface ToolSource {
  load(): Promise<Tool[]>;
  unload?(): Promise<void>;
}

export class MCPToolSource implements ToolSource {
  constructor(private config: MCPServerConfig) {}
  async load(): Promise<Tool[]> {
    /* connect to MCP server, list tools */
  }
}
```

MCP servers are declared in the **workspace config** (`.legion/config.json`), not in participant configs:

```json
{
  "version": "2",
  "mcpServers": [
    {
      "name": "brave-search",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "${BRAVE_API_KEY}" }
    },
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    }
  ]
}
```

Tools are namespaced `mcp__<serverName>__<toolName>` to avoid collisions. Access is controlled by each participant's `tools` policy like any other tool — declaring the MCP server makes the tools available to the registry; participants still need explicit policies (or a permissive default) to invoke them.

---

## 10. Storage Interfaces

### `ConversationStore`

```typescript
export interface ConversationStore {
  create(data: Omit<ConversationData, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConversationData>;
  load(conversationId: string): Promise<ConversationData | null>;
  save(data: ConversationData): Promise<void>;
  appendMessage(conversationId: string, message: MessageData): Promise<void>;
  updateMessage(
    conversationId: string,
    messageId: string,
    patch: Partial<MessageData>,
  ): Promise<void>;
  updateHead(conversationId: string, newHeadId: string): Promise<void>;
  list(filter?: ConversationFilter): Promise<ConversationMeta[]>;
  exists(conversationId: string): Promise<boolean>;
}
```

Default: `FileConversationStore` — one JSON file per conversation at `.legion/conversations/<id>.json`.

### `CredentialStore`

See §6. Default: `FileCredentialStore` at `.legion/credentials.json` (git-ignored).

---

## 11. Config Schema

### Workspace config (`.legion/config.json`)

```typescript
interface WorkspaceConfig {
  version: '2';
  workspaceRoot?: string;
  storage?: StorageConfig;
  server?: ServerConfig;
  connectors?: ConnectorConfig[];
  mcpServers?: MCPServerConfig[]; // tool sources available to all participants
  defaultModel?: ModelConfig;
  providers?: Record<string, ProviderConfig>;
  logging?: LoggingConfig;
}

interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ServerConfig {
  port?: number; // default: 3000
  host?: string; // default: '127.0.0.1'
}

interface ConnectorConfig {
  name: string; // 'web' | 'teams' | 'slack' | ...
  enabled?: boolean; // default: true
  defaultParticipantId?: string; // low-privilege fallback for unknown verified identities
  options?: Record<string, unknown>;
}
```

### Global config (`~/.config/legion/config.json`)

Stores API keys and user preferences. LLM provider API keys live here or in environment variables — never in workspace config.

---

## 12. Event Model

`EventBus` emits typed events. Key events:

| Event                  | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `process:ready`        | Process fully initialised                                  |
| `conversation:created` | New conversation thread created                            |
| `message:sent`         | Message appended to a conversation                         |
| `message:delivered`    | Message delivered to a connector-bound participant         |
| `tool:call`            | Tool invocation started                                    |
| `tool:result`          | Tool invocation completed                                  |
| `approval:requested`   | Tool call requires approval                                |
| `approval:resolved`    | Approval decision made (includes `decidedByParticipantId`) |
| `iteration`            | Agent completed one agentic loop iteration                 |
| `error`                | Runtime error                                              |

All events carry `conversationId` (not a session concept). Message-routing events use `senderId`/`recipientId`. WebSocket serialization converts `Error` to `{ name, message }` and `Date` to ISO strings.

---

## 13. Web Management SPA

`packages/web` is a Vue 3 + Vite + Tailwind app — the UI of the web connector.

**Primary purpose:** managing and monitoring the collective. A logged-in participant invokes management tools (`create_agent`, `list_participants`, `get_conversation`, etc.) via `POST /api/execute` and observes live state via the `/ws` event stream.

**Secondary:** conversation view and approval handling — fully supported via the same tool-execution and event-stream primitives.

The SPA needs only two backend capabilities — authentication and tool execution — so it contains no parallel permission logic. Everything it can do is a tool call, automatically authorized and audited by `AuthEngine`.

---

## 14. Tool Definition Pattern

```typescript
export const exampleTool: Tool = {
  name: 'example_action',
  description: 'What this tool does',
  parameters: { type: 'object', properties: { ... }, required: [...] } as JSONSchema,
  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const { param1 } = args as { param1: string };
    // validate early; return { status: 'error', error: '...' } on failure
    return { status: 'success', data: result };
  },
};
```

Tools return `{ status: 'error', error: '...' }` instead of throwing — the LLM receives the error and adapts.

---

## 15. Code Conventions

### Module system

- Pure ESM (`"type": "module"`). Always use `.js` extensions in imports: `import { Foo } from './Foo.js'`
- TypeScript strict mode: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. Prefix unused params with `_`.

### Naming

- Classes/types: PascalCase files (`MessageRouter.ts`, `AgentRuntime.ts`)
- Tools/utilities: kebab-case files (`file-read.ts`, `agent-tools.ts`)
- Tool objects: `const fooTool: Tool = { name: 'foo_name', ... }` — snake_case `name` field
- Zod schemas: `FooSchema` suffix, infer via `z.infer<typeof FooSchema>`
- Factory functions: `create` prefix (`createMessage`, `createDefaultParticipants`)

### Formatting (Prettier)

Single quotes, semicolons, trailing commas, 100 char print width, 2-space indent.

### Error handling

Custom error hierarchy: `LegionError` → `ParticipantNotFoundError`, `ToolNotFoundError`, `ProviderError`, `ConfigError`, etc.

### Testing

- Vitest with globals (`describe`/`it`/`expect` without imports)
- Colocated: `Foo.test.ts` next to `Foo.ts`
- Unit tests: `*.test.ts`; integration tests: `*.integration.test.ts`
- Use `MockRuntime` with `mock`-type participants for deterministic tests — no LLM calls
- Temp dirs: `mkdtemp(join(tmpdir(), 'legion-...-'))` with cleanup in `afterEach`

---

## 16. Workspace Layout

```
.legion/
  collective/
    participants/        — one JSON file per participant (git-tracked)
  conversations/         — conversation data (git-ignored)
  services/              — per-service storage namespaces (git-ignored)
  credentials.json       — hashed credentials (git-ignored)
  config.json            — workspace config (includes mcpServers)
packages/
  core/                  — engine
  runtime/               — process entry point, web connector, credential store
  web/                   — Vue SPA
```
