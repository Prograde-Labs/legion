# Telegram Connector Design

## Goal

Let a human talk to a Legion collective from Telegram: inbound Telegram messages arrive as
messages from a mapped participant, replies and fire-and-forget messages from any agent are
delivered back to the chat, and tool-approval requests surface as inline buttons.

Two deliverables:

1. **Generic config-driven connector loading** in `packages/runtime` — the `ConnectorConfig`
   type already exists in `@legion/types` but `LegionProcess` hardcodes the web connector.
   This change makes `connectors[]` entries actually load, from built-in factories or from
   external modules.
2. **`@legion/connector-telegram`** — an external connector package implementing the spec §6
   `Connector` interface, consumed like any third-party connector.

## Non-goals

- Workspace setup for our own box (`.legion/` config, participants, skills seeding) — separate
  spec; this is framework work only.
- A plugin manager / package installer. The loader below is the minimal primitive; a future
  plugin system is "install package + write a `connectors[]` entry".
- Webhook mode. Long polling only (the host is LAN-side; no public HTTPS endpoint).
- Media, voice, photos, sticker handling. Text messages and inline keyboards only in v1.
- Per-token streaming into Telegram (Telegram edit rate limits make it ugly; v1 is buffered
  with a typing indicator). Revisit later if wanted.
- Multiple bot instances per process.

## Background

- Spec §6 defines `Connector` (`start(ctx)` / `deliver(msg)` / `stop()`) and
  `ConnectorContext` (`submit`, `callTool`, `streamTool`, `registry`). The web connector is the
  only implementation today, constructed directly in `LegionProcess.start()` step 9.
- Spec §Boundary: "Boundary connectors map external identities to participants… How a connector
  proves identity and maps it to a participant is entirely internal to the implementation."
  Unknown identities are rejected; an optional per-connector low-privilege
  `defaultParticipantId` fallback is opt-in.
- Participants of **any** type can carry
  `identities: [{ connector: string, externalId: string }]`;
  `Collective.findByIdentity(connector, externalId)` already exists.
- Precedent for loading external modules from a workspace: services. `ServiceConfig.module`
  (npm name or path) is resolved against `workspaceRoot` and dynamically imported
  (`ServiceManager`), requiring a named `service` export implementing `LegionService`.
  Connectors adopt the same convention.

## Design

### 1. Connector config and loading (`packages/runtime`)

`ConnectorConfig` (in `@legion/types`) gains one field:

```typescript
export interface ConnectorConfig {
  name: string;
  enabled?: boolean;               // default true
  module?: string;                 // npm package name OR absolute/workspace-relative path to built JS
  defaultParticipantId?: string;   // low-priv fallback for unknown verified identities (opt-in)
  options?: Record<string, unknown>; // passed verbatim to the connector factory
}
```

`LegionProcess.start()` step 9 becomes:

1. For each entry in `mergedConfig.connectors ?? [{ name: 'web' }]`:
   - Skip if `enabled === false`.
   - `name === 'web'` → built-in `WebConnector`, constructed exactly as today (its deps are
     runtime-internal: collective, credentials, eventBus, processManager, serverConfig, SPA
     paths). This preserves current behavior, including the default when `connectors` is
     absent.
   - Otherwise → external connector:
     1. Resolve `module`: absolute path used as-is; otherwise try (a) workspaceRoot-relative
        path, (b) bare specifier via standard Node resolution (npm package installed in the
        workspace). Mirror `ServiceManager`'s resolve-then-import, including its error style.
     2. `await import(resolved)` and require a **named `connector` export**:
        `(options: Record<string, unknown>, deps: ConnectorRuntimeDeps) => Connector`.
     3. Call the factory with the entry's `options` and the runtime deps (below).
     4. `connectorRegistry.register(connector)`; duplicate names throw (registry already does).
   - Wrap construction + registration per connector in try/catch: a broken external connector
     is logged and skipped; the process still boots. (The web connector keeps fail-fast
     behavior.)
2. Build the `ConnectorContext` once (unchanged shape) — after all connectors are registered,
   mirroring the current register → build-context → start sequence.
3. `start()` every registered connector with that context.

`ConnectorRuntimeDeps` (new, exported from `@legion/core`):

```typescript
export interface ConnectorRuntimeDeps {
  collective: Collective; // read access for identity mapping (findByIdentity)
  eventBus: EventBus;     // subscribe to approval:requested etc.
}
```

Rationale: the spec makes identity mapping internal to the connector, which requires reading
the collective; approval surfacing is event-driven. Everything else the connector needs
arrives through `ConnectorContext` at `start()`. This keeps `ConnectorContext` unchanged.

### 2. The `@legion/connector-telegram` package

Own repo/workspace dir (`/workspace/legion-connector-telegram`), pure ESM, Node ≥ 20,
TypeScript strict matching Legion's tsconfig style. Depends on
[grammY](https://grammy.dev) for the Bot API (long polling, `handleUpdate()` for tests).

Packaging rule — the connector must be loadable by any Legion workspace without that
workspace resolving `@legion/core` types at runtime: **type-only imports** for
`Connector`/`ConnectorRuntimeDeps` (erased at compile; verified with `tsc --declaration
--emitDeclarationOnly`), grammY as the only runtime dependency, Legion packages as
devDependencies for type conformance. The Legion root workspace installs the connector
package (never `packages/runtime` itself — the runtime must not depend on connectors).

Public API:

```typescript
export interface TelegramConnectorOptions {
  botToken?: string;        // inline token (discouraged)
  botTokenEnv?: string;     // default 'TELEGRAM_BOT_TOKEN'
  apiServer?: string;       // optional local Bot API server base URL (future)
}
export function connector(options: TelegramConnectorOptions, deps: ConnectorRuntimeDeps): Connector;
```

Token resolution: `options.botToken ?? process.env[options.botTokenEnv ?? 'TELEGRAM_BOT_TOKEN']`;
missing token → throw with a clear message at construction (connector loader catches, logs,
skips). Tokens never live in committed config — env only, same rule as provider keys.

### 3. Identity mapping (inbound)

- On a text message from chat `C` by user `U`: the external identity is
  `('telegram', String(C.chat.id))` — **chat id**, not user id, so a private chat and a group
  the bot shares with Chris are distinct identities; v1 assumes private chats.
- Resolve `deps.collective.findByIdentity('telegram', chatId)`:
  - Found → proceed as that participant.
  - Not found, connector entry has `defaultParticipantId` → proceed as that participant
    (spec's low-privilege fallback; the fallback participant's tool policy is the security
    boundary).
  - Neither → reply "unknown sender — register your Telegram identity with an operator" and
    drop. Never guess.
- On first successful mapping of a participant, `ctx.registry.setActive(participantId,
  'telegram')`. Long polling is always connected, so participants mapped this way are
  permanently deliverable while the process runs. `clearActive` on `stop()`.

### 4. Addressing and commands (inbound translation)

The connector is a protocol translator; authority stays with the mapped participant's tool
policy. Per message:

| Input | Action (as mapped participant) |
| --- | --- |
| `/start` | Welcome + command help (no tool calls) |
| `/agents` | `list_participants` via `ctx.callTool`, format as text |
| `/to <participantId> <text>` | `ctx.submit({ senderId, recipientId: <id>, content: <text>, conversationId })` |
| `/new` | Reset this chat's conversation mapping (next message starts a fresh thread) |
| anything else | `ctx.submit({ senderId, recipientId: defaultRecipient, content, conversationId })` |

`defaultRecipient` is a connector option (`defaultRecipientId`, default `'assistant'` if it
exists, else no default → text messages get a hint to use `/to`). Note this option is the
*recipient* default for plain chat — distinct from `defaultParticipantId`, which is the
*sender* fallback for unknown identities.

Conversation continuity: an in-memory `Map<chatId, conversationId>`. First message in a chat
omits `conversationId`; the router creates a thread and `MessageRouterResult.conversationId`
is stored. `/new` deletes the entry. State is not persisted: a process restart starts fresh
conversations (acceptable for v1; `/new` semantics anyway). Each chat maps to exactly one
Legion conversation.

Reply-thread learning: `deliver()` stores `message.conversationId` into the chat map for the
recipient's chat. When an agent initiates (fire-and-forget) and Chris then types a plain
message, it continues the agent's thread rather than opening the default one. Inbound
`/to <id>` submissions follow the chat's currently mapped conversation.

`ctx.submit` is synchronous (blocks until the recipient's response, per the communicate-hub
philosophy). The connector awaits it and sends `result.response` back to the chat. While
waiting it sends a `sendChatAction('typing')` indicator. `status: 'pending_approval'` /
`'dispatched'` results send the corresponding status text instead of a response body.

### 5. Outbound delivery (`deliver`)

`UserDeliveryRuntime` calls `connector.deliver(message)` for messages addressed to a
connector-active participant. The connector:

1. Reverse-maps `message.recipientId` → chat via the participant's `identities`
   (`externalId` where `connector === 'telegram'`). No identity → nothing to do (participant
   has no Telegram presence; e.g. operator without a mapped chat).
2. Sends `content` to that chat. Telegram's 4096-char limit: split on paragraph boundaries
   when possible, hard-split otherwise.
3. Delivery failures (network, blocked bot) are logged and swallowed — per
   `UserDeliveryRuntime`, delivery is non-fatal; the message is already persisted.

### 6. Approvals

The connector subscribes to `eventBus.on('approval:requested', { conversationId,
participantId, tool, approvalId })` and sends an approval card to **every chat currently
mapped** (v1 assumption: a single-human collective; on this box that's one chat): tool name,
requesting participant, short conversation id, and inline buttons ✅ Approve / ❌ Reject.

Button callback → `ctx.callTool(mappedParticipantId, 'approval_response', { decisions: [{
approvalId, decision }] })` → answer the callback query with the outcome, edit the message to
disable buttons and show the recorded decision. Authorization is enforced by `AuthEngine` at
the `approval_response` call — the connector adds no authority of its own; a chat without
authority gets the tool's error text.

Limitation (documented, acceptable for v1): approval cards go to all mapped chats rather than
being routed through `approvalAuthority` analysis. With multiple humans this could leak
approval prompts to unauthorized chats — the button press still fails authorization, but the
card is visible. Follow-up: route cards by querying approver authority.

### 7. Error handling

- **Polling:** grammY retries network errors with backoff; bot startup failure (bad token) →
  connector `start()` throws → loader logs and skips the connector.
- **Send failures:** logged, non-fatal.
- **Handler errors:** one bad update must not kill polling — wrap handler bodies; on error,
  send a short "internal error" reply when possible.
- **Shutdown:** `stop()` stops polling (`bot.stop()`), clears registry actives, unsubscribes
  event listeners.

### 8. Testing

- **Unit (vitest, in the connector package, no network):** grammY transformer API stubs
  `bot.api.*`. Cover: identity resolution (found / fallback / unknown), command parsing
  (`/to` with and without id, unknown command passthrough), conversation mapping across
  messages and `/new`, deliver + 4096 chunking, callback → `approval_response` args + button
  edit, token-missing error, delivery-failure tolerance.
- **Loader unit tests (packages/runtime):** config entries → factories; web preserved; module
  resolution paths; broken module → process continues; duplicate names.
- **Integration (env-gated `LEGION_TELEGRAM_INTEGRATION=1`):** real bot token, real temp
  workspace collective; script an `handleUpdate()` round trip and assert the reply text
  arrives via a stubbed send. Skipped by default like other integration suites.
- **Live E2E (manual, once):** Chris texts the bot; assistant replies; an approval card flow;
  `/to` to a second agent.

## Files

- `packages/types/src/config.ts` — add `module?` to `ConnectorConfig`.
- `packages/core/src/connectors/ConnectorRuntimeDeps.ts` (new) + export from index.
- `packages/runtime/src/LegionProcess.ts` — generic connector loading in step 9.
- `packages/runtime/src/LegionProcess.connector-loading.test.ts` (new).
- External repo `/workspace/legion-connector-telegram` — package source + tests + README
  (install/config example).
