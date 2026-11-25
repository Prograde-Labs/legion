# Connector-Provided Tools — Design

**Date:** 2026-11-24
**Status:** Approved for planning
**Repos:** `legion` (core seam, `communicate` data), `legion-connector-teams` (Teams tools)
**Packages:** `@legion-collective/core`, `@legion-collective/runtime`,
`@legion-collective/connector-teams`

## 1. Context

Connectors are boundary channels, not participants. A connector receives a
`ConnectorContext` with `submit`, `callTool`, `streamTool`, and the participant
presence registry. It can route inbound traffic and push outbound messages, but it
cannot add anything to the global `ToolRegistry`. That registry is populated at boot
from builtins, runtime tools, and MCP sources.

This spec gives connectors a declarative tool surface: a connector can expose tools
that core registers after the connector starts and unregisters when it stops. The Teams
connector uses this to provide tools that act on Teams beyond plain text delivery:
Adaptive Cards, emoji reactions, and conversation discovery.

The tools are ordinary Legion tools. They are authorized by the same `AuthEngine` and
are visible to an LLM only when the participant's `tools` map grants them. Connectors
remain channels; no participant type or special auth path is introduced.

### Goals

- Let any connector (builtin or external) contribute tools to the global
  `ToolRegistry` through an optional, backward-compatible `Connector.tools()` method.
- Give core a leak-proof registration lifecycle: register after `start()`, unregister
  before/with `stop()`, and clean up partial failures.
- Add three Teams tools: `teams__send_card`, `teams__post_reaction`, and
  `teams__list_conversations`.
- Track enough message identity to let a tool react to a message by Legion message ID
  or raw Teams activity ID.
- Keep authorization fail-closed: no automatic policy grants.

### Non-goals (first version)

- Runtime tool registration after startup (e.g. after a bot directory rebuild).
- A generic connector RPC surface; tools are the extension point.
- Message editing/deletion, mentions, quoted replies, file attachments, or Graph
  access.
- A new participant type or a connector-specific approval path.
- Changing the Teams connector's existing inbound, outbound, approval, or pairing
  behavior.

## 2. Decisions

| Decision            | Choice                                                                     | Rationale                                             |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Core seam           | Optional `Connector.tools(): AnyTool[]`                                    | Declarative, backward-compatible; core owns lifecycle |
| Registration point  | After successful `start()`, before services auto-start                     | Tools exist before any participant can call them      |
| Naming              | `<connectorName>__<tool>`; core enforces the prefix                        | Avoids collisions with builtins and `mcp__*`          |
| Cleanup             | Core tracks names per connector; unregister on stop and on partial failure | No leaked tools from failed or stopped connectors     |
| Visibility          | Participant `tools` map only                                               | Fail-closed, identical to builtins and MCP            |
| Message identity    | Record inbound/outbound Teams activity IDs and Legion message IDs          | Enables reactions by either ID form                   |
| Message ID exposure | `communicate` adds `storedMessageId` to result `data`                      | Connector needs the inbound Legion message ID         |
| Acting bot          | Caller's own live `teams-bot` identity                                     | Mirrors `deliverMessage` ownership check              |
| Tool set            | Cards, reactions, read-only list                                           | Smallest set that delivers dynamic interaction        |
| State version       | v3 with `messages` and `legionMessages`                                    | Additive migration from v2                            |

## 3. Architecture

```
LegionProcess.start()
  ├── register builtins + MCP tools
  ├── build ConnectorContext
  ├── WebConnector.start(); registerConnectorTools(web, toolRegistry)
  └── startExternalConnectors()
        ├── loadExternalConnectors(): import, construct, start()
        ├── ConnectorRegistry.register(connector)
        └── registerConnectorTools(connector, toolRegistry)
              └── connector.tools?.() → ToolRegistry.register()

Participant (agent/service/user)
  └── tool call `teams__send_card`
        └── TeamsConnector tool closure
              ├── resolve caller's live teams-bot
              ├── resolve conversation from connector state
              └── app.send(...) / app.api.reactions.add(...)
```

The Teams connector builds its tools in `tools()`, after `start()` has loaded state and
started the `BotPool`. Tool closures read `this.pool`, `this.state`, and `this.store`
at execution time, so they follow directory rebuilds and state updates.

## 4. Core seam

### 4.1 `Connector` interface

In `packages/core/src/connectors/Connector.ts`:

```ts
import type { AnyTool } from '../tools/Tool.js';

export interface Connector {
  readonly name: string;
  canDeliver?(participantId: string): boolean;
  start(ctx: ConnectorContext): Promise<void>;
  deliver(message: {...}): Promise<DeliveryOutcome>;
  stop(): Promise<void>;

  /**
   * Tools this connector contributes to the global registry.
   * Called by core after a successful `start()`; unregistered on `stop()`.
   * Every tool name must start with `<connector.name>__`.
   */
  tools?(): AnyTool[];
}
```

`AnyTool` is already exported from the core index
(`packages/core/src/tools/Tool.ts`), so external connectors need no new type export.

### 4.2 Registration helper

Add a helper in `packages/runtime/src/LegionProcess.ts`:

```ts
export interface ConnectorToolRegistration {
  connector: string;
  tools: string[];
}

export function registerConnectorTools(connector: Connector, toolRegistry: ToolRegistry): string[];
```

Behavior:

1. If `connector.tools` is absent, return `[]`.
2. Call `connector.tools()` once. Reject a non-array result.
3. Reject duplicate names inside the returned array.
4. Require every `tool.name` to start with `` `${connector.name}__` ``. A mismatch is
   an error, not a warning.
5. Register each tool in order. If any `register` throws (e.g. `ConflictError` from a
   builtin or MCP collision), unregister the names already registered by this call and
   rethrow.
6. Return the registered names.

A matching `unregisterConnectorTools(toolRegistry, names)` removes them in reverse
order, tolerating missing names.

### 4.3 Boot wiring

`StartExternalConnectorsDeps` gains `toolRegistry: ToolRegistry`. The return type
becomes:

```ts
export interface StartExternalConnectorsResult {
  connectors: string[];
  toolsByConnector: Map<string, string[]>;
}
```

`startExternalConnectors`:

1. Load and start connectors as today (`loadExternalConnectors`).
2. For each loaded connector, `connectorRegistry.register(connector)`.
3. `registerConnectorTools(connector, toolRegistry)`.
4. On tool failure: unregister the partial set, `connector.stop()`,
   `connectorRegistry.deregister(connector.name)`, log the reason, and continue. The
   process still boots (spec §4.3 log-and-skip).
5. Record `toolsByConnector.set(connector.name, names)`.

In `LegionProcess.start()`, after `webConnector.start(connectorContext)`, call
`registerConnectorTools(webConnector, toolRegistry)` and record it in the same map. A
failure here is logged; the web connector keeps running without tools.

`LegionProcess` stores `private connectorTools = new Map<string, string[]>()`.

`LegionProcess.stop()`:

1. For each connector, `unregisterConnectorTools(toolRegistry, names)` **before**
   `connector.stop()`. New calls fail fast; in-flight executions keep their tool
   reference.
2. Then stop the connector as today.
3. Clear the map entry.

The order matters: a stopped connector's tools must not remain callable.

### 4.4 `communicate` result data

In `packages/core/src/tools/communicate-tool.ts`, add `storedMessageId` to `data`
whenever `MessageRouterResult.storedMessageId` is defined:

- `error` path: `data: { conversationId, storedMessageId? }`
- `pending_approval` path: `data: { conversationId, approvalRequests, storedMessageId? }`
- `timeout` path: `data: { conversationId, response, partial: true, storedMessageId? }`
- success path: `data: { conversationId, response, status, storedMessageId? }`

This is additive and lets any connector map an inbound Legion message to a platform
message. No other core behavior changes.

## 5. Teams tools

### 5.1 Module layout

New modules in `legion-connector-teams`:

```
src/tools.ts        buildTeamsTools(...) → AnyTool[]
src/tool-targets.ts conversation/message resolution shared by the tools
src/tool-state.ts   message-record helpers (record, lookup, prune)
```

`TeamsConnector.tools()` returns the subset selected by options. `tools()` is called
after `start()`, so `this.pool`, `this.state`, and `this.store` are available.

`src/bot-pool.ts` extends `TeamsAppLike` with the SDK surface the tools need:

```ts
export interface TeamsAppLike {
  // existing…
  send(conversationId: string, activity: unknown): Promise<{ id?: string }>;
  api: {
    conversations: {
      create(params: Record<string, unknown>): Promise<{ id: string }>;
    };
    reactions: {
      add(conversationId: string, activityId: string, type: string): Promise<void>;
      delete(conversationId: string, activityId: string, type: string): Promise<void>;
    };
  };
}
```

`src/inbound.ts` adds `id?: string` to `TeamsActivity`. `runCommunicate` returns
`{ result, conversationId, storedMessageId?, outboundActivityId? }`, populated from
`final.data.storedMessageId` and the ID returned by `TeamsStreamer.close()`. `runTurn`
records the inbound mapping after each turn.

### 5.2 Common rules

- The caller is `context.participant`. Resolve its `teams-bot` identity and require:
  - `pool.ownerOf(appId) === context.participant.id`
  - `pool.getByAppId(appId)` is defined
    Otherwise return `{ status: 'error', error: "caller '<id>' has no live Teams bot" }`.
- All tools return `ToolResult`. SDK failures become `{ status: 'error', error }`; no
  throws and no secrets in messages.
- A missing or unstarted connector state returns an error, never a crash.
- Tools do not mutate participant policies.

### 5.3 `teams__send_card`

Parameters:

```json
{
  "type": "object",
  "properties": {
    "participantId": {
      "type": "string",
      "description": "Legion user or group participant to send to"
    },
    "conversationId": {
      "type": "string",
      "description": "Raw Teams conversation id; must belong to the caller's bot"
    },
    "card": {
      "type": "object",
      "description": "Adaptive Card JSON (schema version 1.4 or later)"
    },
    "fallbackText": { "type": "string" },
    "aiLabel": { "type": "boolean" }
  },
  "required": ["card"]
}
```

Exactly one of `participantId` or `conversationId` is required.

Behavior:

1. Validate the caller's bot (5.2).
2. Resolve the target:
   - `conversationId`: find a `state.conversations` entry whose key starts with
     `${appId}:` and whose `conversationId` matches. If none, error.
   - `participantId`: mirror `deliverMessage`'s resolution:
     - `teams` identity → key `${appId}:${participantId}`; create the personal
       conversation via `app.api.conversations.create` when absent, and persist.
     - `teams-group` identity → key `${appId}:${participantId}:${externalId}`; use
       the record, or the identity's `externalId` as the conversation ID.
     - no Teams identity → error.
3. Serialize `card`; if `JSON.stringify(card).length > maxCardBytes`, return an error.
4. Build `MessageActivityInput().addCard('adaptive', card)`. When `fallbackText` is
   provided, pass it as the `summary` constructor field
   (`new MessageActivityInput('', { summary: fallbackText })`). Add `addAiGenerated()`
   when `aiLabel` is true (default: `options.aiLabel`).
5. `await app.send(conversationId, activity)`.
6. Capture `SentActivity.id`. Record an outbound message (section 6) and save state.
7. Return `{ status: 'success', data: { conversationId, activityId } }`.

The card is passed through as-is; validation is limited to JSON-serializability and
size. This keeps the tool flexible for LLM-authored cards and for
`@microsoft/teams.cards` output.

### 5.4 `teams__post_reaction`

Parameters:

```json
{
  "type": "object",
  "properties": {
    "messageId": {
      "type": "string",
      "description": "Legion message id or Teams activity id"
    },
    "reaction": {
      "type": "string",
      "description": "Emoji reaction type, e.g. like, heart, 1f440_eyes, launch"
    },
    "conversationId": {
      "type": "string",
      "description": "Teams conversation id; required when messageId is a raw activity id that is not recorded"
    },
    "remove": { "type": "boolean", "description": "Remove instead of add" }
  },
  "required": ["messageId", "reaction"]
}
```

Behavior:

1. Validate the caller's bot (5.2).
2. Resolve the target message in this order:
   - `legionMessages[messageId]` → `messages[key]`.
   - Scan `messages` for `activityId === messageId` and `appId === callerAppId`
     (optionally filtered by `conversationId`).
   - If `conversationId` is provided, treat `messageId` as a raw activity ID and
     validate that the conversation belongs to the caller's bot.
   - Otherwise return `{ status: 'error', error: 'message not found' }`.
3. Require `record.appId === callerAppId`; otherwise error.
4. Call `app.api.reactions.add(record.conversationId, record.activityId, reaction)`,
   or `app.api.reactions.delete(...)` when `remove` is true.
5. Return `{ status: 'success', data: { conversationId, activityId, reaction, removed } }`.

Reaction types are passed through as strings. The SDK accepts the documented set
(`like`, `heart`, `1f440_eyes`, `2705_whiteheavycheckmark`, `launch`,
`1f4cc_pushpin`) plus custom strings.

### 5.5 `teams__list_conversations`

Parameters:

```json
{
  "type": "object",
  "properties": {
    "conversationType": { "type": "string", "enum": ["personal", "groupChat"] },
    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
  }
}
```

Behavior:

1. Validate the caller's bot (5.2).
2. Take `state.conversations` entries whose key starts with `${appId}:`.
3. Filter by `conversationType` when provided.
4. Sort by `updatedAt` descending; default `limit` 50, cap at 200.
5. Return:
   ```json
   {
     "status": "success",
     "data": {
       "conversations": [
         {
           "key": "<appId>:<participantId>",
           "conversationId": "…",
           "conversationType": "personal",
           "externalId": "…",
           "name": "…",
           "displayName": "…",
           "updatedAt": "…"
         }
       ]
     }
   }
   ```
   Optional fields are omitted when absent. No secrets are present in state.

## 6. Message identity tracking

### 6.1 State v3

`src/state.ts` gains:

```ts
export interface MessageRecord {
  appId: string;
  conversationId: string;
  activityId: string;
  direction: 'inbound' | 'outbound';
  legionMessageId?: string;
  legionConversationId?: string;
  createdAt: string;
}

export interface TeamsState {
  version: 3;
  conversations: Record<string, ConversationRecord>;
  pendingPairs: Record<string, PendingPair>;
  legionConversations: Record<string, string>;
  legionConversationTargets: Record<string, string>;
  messages: Record<string, MessageRecord>; // key `${appId}:${activityId}`
  legionMessages: Record<string, string>; // legionMessageId → messages key
}
```

- `isV3` validates the existing maps plus the two new objects.
- `migrateV2` copies v2 maps and adds `messages: {}` and `legionMessages: {}`.
- `migrateV1` produces a v3 state (v1 → v2 shape → empty v3 maps).
- `emptyState()` returns v3.
- `StateStore.load` checks `isV3` first, then v2, then v1; unknown shapes are
  backed up and replaced with an empty v3 state. Migration is one-way and atomic,
  like the existing v1→v2 migration.

### 6.2 Recording

- **Inbound user message**: in `runCommunicate`, after `stream:done`, read
  `final.data.storedMessageId`. If it is a string, record:
  - `appId` = the bot's app ID
  - `conversationId` = the resolved Teams conversation
  - `activityId` = `context.activity.id` (add `id?: string` to `TeamsActivity`)
  - `direction: 'inbound'`
  - `legionMessageId` = the stored ID
  - `legionConversationId` = the Legion conversation returned by `communicate`
    Save state after the turn.
- **Outbound `deliver()`**: `app.send` returns `SentActivity { id }`. Record
  `direction: 'outbound'`, `legionMessageId = message.id`,
  `legionConversationId = message.conversationId`.
- **Streamed replies**: capture the ID from `TeamsStreamer.close()` (best effort; the
  SDK returns `{ id? }`). Record as outbound with no Legion message ID.
- **Tool-sent cards**: record the `SentActivity.id` as outbound with no Legion
  message ID.
- Every record also updates `legionMessages[legionMessageId] = key` when a Legion ID
  is present.

### 6.3 Lookup and pruning

- Lookup by Legion ID: `legionMessages[id]` → `messages[key]`.
- Lookup by Teams activity ID: scan `messages` (bounded) for `activityId`.
- Pruning: after a record is added, if `Object.keys(messages).length >
options.maxMessageRecords`, delete the oldest records by `createdAt` until at or
  below the limit, and remove their `legionMessages` entries.
- Pruning is best-effort and happens under the existing serialized state save.

## 7. Identity and authorization

- **Acting bot**: the caller's own `teams-bot` identity, verified live and owned via
  `BotPool.ownerOf`. This mirrors `deliverMessage` and prevents one participant from
  posting through another's bot.
- **Target ownership**: conversations and message records must belong to the caller's
  bot app ID. Raw `conversationId` values are validated against connector state.
- **Visibility**: tools are registered globally but hidden from an LLM unless the
  participant's `tools` map contains them. `AuthEngine` returns `hidden` otherwise.
  No auto-grants; operators use existing policy tools or config.
- **Approvals**: policy is per participant. Recommended defaults:
  - `teams__send_card`: `requires_approval` for agents that post to humans.
  - `teams__post_reaction`: `auto` or `requires_approval`, deployment choice.
  - `teams__list_conversations`: `auto`.
    These are recommendations, not enforced by the connector.

## 8. Configuration

`TeamsConnectorOptions` additions:

```ts
export type TeamsToolName = 'cards' | 'reactions' | 'list';

export interface TeamsConnectorOptions {
  // existing fields…
  tools?: TeamsToolName[] | false; // default all three
  maxMessageRecords?: number; // default 2000
  maxCardBytes?: number; // default 28000
}
```

`ResolvedOptions` resolves `tools` to a `Set<TeamsToolName>` (or empty when
`false`), `maxMessageRecords` to a positive integer, and `maxCardBytes` to a
positive integer.

`tools()` returns only the enabled tools. A disabled tool is absent from the registry
and therefore invisible even if a participant's policy references it.

## 9. Error handling

- All tool failures are `ToolResult` errors, never exceptions escaping `execute`.
- Error strings identify the missing thing (caller, bot, conversation, message) but
  contain no secrets or raw SDK payloads.
- SDK errors go through the connector's existing `describeError` helper.
- `tools()` itself may throw on invalid options; core treats that as a connector
  registration failure and skips the connector.
- Partial tool registration is rolled back (section 4.2).

## 10. Testing

### Core (`legion`)

- `registerConnectorTools`:
  - no `tools()` → empty
  - valid tools registered
  - prefix mismatch rejected
  - duplicate names rejected
  - collision with a builtin rolls back and rethrows
  - partial failure leaves no registered tools
- `startExternalConnectors`:
  - tools registered after `start()`
  - connector with a failing `tools()` is deregistered and stopped
  - returned `toolsByConnector` matches
- `LegionProcess.stop()` unregisters tools before stopping connectors.
- `communicate-tool` exposes `storedMessageId` in `data` on success, pending,
  timeout, and error paths.
- Builtin parity: a `WebConnector` implementing `tools()` is registered through the
  same helper.

### Teams (`legion-connector-teams`)

- State:
  - v1→v2 and v2→v3 migrations
  - unknown/invalid v3 shapes normalize safely
  - record, lookup by Legion ID, lookup by activity ID
  - pruning at `maxMessageRecords`
- Tools, with a fake `TeamsAppLike`:
  - `teams__send_card`: participant target, raw conversation target, missing bot,
    unknown recipient, oversized card, SDK failure, returned activity ID recorded
  - `teams__post_reaction`: add/remove by Legion ID, add by raw activity ID,
    missing message, wrong-bot record, SDK failure
  - `teams__list_conversations`: scoping to caller's bot, type filter, limit cap,
    empty state
  - disabled tools absent from `tools()`
- Existing connector tests continue to pass.

### Commands

- `legion`: `npm run format:check` → `npm run typecheck` → `npm test`
- `legion-connector-teams`: `npm run typecheck` → `npm run test`

Build order: `legion` core/types first (`npm run build`), then the connector, because
the connector's dev dependency is a `file:` link to `../legion/packages/core`.

## 11. Rollout

1. Core seam and `communicate` data change land first.
2. Teams tools land next, against the rebuilt core types.
3. Existing deployments are unaffected until a participant is granted a `teams__*`
   tool. The connector registers tools by default, but visibility stays policy-gated.
4. No config migration is required; state migrates automatically on load.

## 12. Risks

- **SDK surface stability.** Reactions and card sends are current APIs in
  `@microsoft/teams.apps` 2.2.1. Message update/delete are marked deprecated and are
  intentionally out of scope.
- **State growth.** Bounded by `maxMessageRecords`; pruning keeps the JSON file
  small.
- **Multi-bot ownership.** Every tool verifies the caller's bot; a participant with
  multiple bot identities uses the first `teams-bot` identity, matching
  `deliverMessage`.
- **Card validation.** Only serializability and size are checked; malformed cards are
  rejected by Teams and surface as tool errors.
- **Tool-name collisions.** The enforced `<connector>__` prefix makes collisions
  between connectors impossible; builtin/MCP collisions are rolled back cleanly.
