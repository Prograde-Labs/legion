# Middleware System Design

**Date:** 2026-07-12
**Status:** Proposed

## Goal

Add ordered, per-participant middleware pipelines to Legion. Middleware can intercept message
delivery, contribute to agent system prompts, invoke authorized tools, maintain isolated durable
state, short-circuit participant runtimes, and perform arbitrary trusted side effects.

The first release includes skills, automatic compaction, and conversation naming middleware. It
also adds conversation archive, tag, provenance, and participant-specific title capabilities needed
by those middleware.

## Principles

- Middleware attaches to participants, not participant types or message roles.
- Both sides of an exchange own boundary behavior: sender hooks run for sends and recipient hooks
  run for receives.
- Hook order is explicit and deterministic.
- Message transformations happen before persistence; persisted history is never silently rewritten
  by post-persistence hooks.
- Middleware-triggered tools use the attached participant's normal tool policy.
- Workspace middleware is trusted code, but core mutations still go through guarded APIs.
- Existing `EventBus` events remain observational and separate from awaited interception.

## Non-Goals

- Global or process-wide middleware chains
- Shared middleware state across participants
- Branch-local middleware state
- Workspace-provided Vue components
- Middleware module hot reload
- Message moderation built-in
- Provider-tool construction hooks such as `buildTools`
- Tool-call middleware phases
- Automatic keyword-based skill activation
- Serializable arbitrary JavaScript continuations
- Closing conversations or making archived conversations read-only

## Architecture

### Middleware Registry

`MiddlewareRegistry` owns available middleware definitions. Legion registers built-ins directly and
loads workspace definitions from explicit workspace configuration during startup:

```ts
interface MiddlewareModuleConfig {
  id: string;
  module: string;
}

interface WorkspaceConfig {
  middlewareModules?: MiddlewareModuleConfig[];
}
```

Module paths resolve from the workspace root. Each module exports one `MiddlewareDefinition`; its
`type` must match the configured module ID. Built-in types use the `builtin:` prefix. Duplicate type
registration, import failure, invalid exports, or an ID mismatch stops startup. Code changes require
a process restart.

```ts
type FailureMode = 'open' | 'closed';

interface MiddlewareDefinition<TConfig = unknown> {
  type: string;
  displayName: string;
  description?: string;
  defaultFailureMode: FailureMode;
  configSchema: JSONSchema;
  hooks: MiddlewareHooks<TConfig>;
}
```

Definitions expose schemas and metadata through a `list_middleware` management tool. Diagnostics
include source, load status, and configuration errors.

### Participant Configuration

Middleware configuration belongs to `BaseParticipant`, making it available to agents, services,
users, and mocks:

```ts
type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

interface MiddlewareInstanceConfig {
  id: string;
  type: string;
  enabled?: boolean;
  failureMode?: FailureMode;
  config: Record<string, JSONValue>;
}

interface BaseParticipant {
  middleware?: MiddlewareInstanceConfig[];
  middlewareRevision?: number;
}
```

An omitted `enabled` value means enabled. Instance IDs must be unique within one participant. A
middleware type may appear more than once. Array order is execution order.

Effective failure mode is:

```ts
instance.failureMode ?? definition.defaultFailureMode;
```

Participant create tools accept optional middleware configuration. A
`set_participant_middleware` management tool replaces one participant's ordered instance list after
validating unique IDs plus definition availability and configuration schemas for enabled instances.
Successful replacement increments `middlewareRevision`; an absent revision means zero. This
revision provides durable stale-checking for suspended middleware pipelines.

Definition availability and schema validation are required for enabled instances. Disabled
instances with unavailable definitions may be preserved or added as raw JSON configuration, but
cannot be enabled until their definition loads and validates them.

Disabled instances whose definitions are unavailable remain preserved so a removed module can be
restored. An enabled instance with an unavailable definition stops startup rather than silently
removing behavior.

### Middleware Runner

`MiddlewareRunner` resolves enabled definitions and executes one participant's instances in order.
Each hook receives:

- Attached participant and middleware instance identity
- Conversation identity and a read-only active chain
- Phase-specific message or system-prompt draft
- Validated instance configuration
- Namespaced state access
- Tool-action results completed earlier in the same routing operation
- Event bus, abort signal, and logger

Trusted middleware can use normal Node APIs for workspace-defined side effects. Conversation,
routing, title, tag, archive, and middleware-state changes use runner context APIs so locks, events,
and storage invariants remain intact.

### Hook Phases

Middleware definitions may implement any subset of:

```ts
interface MiddlewareHooks<TConfig> {
  beforeSend?: MessageDraftHook<TConfig>;
  beforeReceive?: MessageDraftHook<TConfig>;
  afterReceive?: AfterReceiveHook<TConfig>;
  buildSystemPrompt?: SystemPromptHook<TConfig>;
  afterSend?: PostMessageHook<TConfig>;
}

interface MessageDraft {
  readonly senderId: string;
  readonly recipientId: string;
  readonly role: MessageRole;
  readonly replyTo?: string;
  content: string;
  reasoning?: string;
}

interface MiddlewareActionResult {
  requestId: string;
  participantId: string;
  instanceId: string;
  tool: string;
  status: 'success' | 'error' | 'rejected';
  result?: ToolResult;
}

interface MiddlewareHookContext<TConfig> {
  operationId: string;
  participant: ParticipantConfig;
  instance: MiddlewareInstanceConfig;
  config: TConfig;
  conversationId: string;
  activeChain: readonly MessageData[];
  actions: readonly MiddlewareActionResult[];
  getState(): JSONValue | undefined;
  setState(value: JSONValue): Promise<void>;
  signal: AbortSignal;
  eventBus: EventBus;
  logger: Logger;
}

interface MessageDraftContext<TConfig> extends MiddlewareHookContext<TConfig> {
  message: Readonly<MessageDraft>;
  chunk?: LLMChunk;
  final: boolean;
  iteration?: number;
}

interface AfterReceiveContext<TConfig> extends MiddlewareHookContext<TConfig> {
  message: Readonly<MessageData>;
  mode: 'pre_runtime' | 'post_response';
}

interface SystemPromptContext<TConfig> extends MiddlewareHookContext<TConfig> {
  prompt: string;
}

interface PostMessageContext<TConfig> extends MiddlewareHookContext<TConfig> {
  message: Readonly<MessageData>;
}

type MessageDraftHook<TConfig> = (
  context: MessageDraftContext<TConfig>,
) => MessageDraftResult | Promise<MessageDraftResult>;

type AfterReceiveHook<TConfig> = (
  context: AfterReceiveContext<TConfig>,
) => AfterReceiveResult | Promise<AfterReceiveResult>;

type SystemPromptHook<TConfig> = (
  context: SystemPromptContext<TConfig>,
) => SystemPromptResult | Promise<SystemPromptResult>;

type PostMessageHook<TConfig> = (
  context: PostMessageContext<TConfig>,
) => PostMessageResult | Promise<PostMessageResult>;
```

`MessageDraft` lives in `@legion-collective/types`. Existing core `NewMessageInput` extends this draft with
optional storage inputs such as `id`, `parentId`, tool calls, tool results, and usage. Middleware can
change content and reasoning but cannot reroute a message, change its role, or assign tree identity.

Hooks return discriminated, phase-specific outcomes:

```ts
interface ContinueMessage {
  kind: 'continue';
  message?: MessageDraft;
}

interface ContinuePrompt {
  kind: 'continue';
  change?: {
    operation: 'append' | 'prepend' | 'replace';
    content: string;
  };
}

interface Continue {
  kind: 'continue';
}

interface Reject {
  kind: 'reject';
  error: string;
}

interface Complete {
  kind: 'complete';
}

interface Respond {
  kind: 'respond';
  message: MessageDraft;
}

interface Abort {
  kind: 'abort';
  error: string;
}

interface RequestTool {
  kind: 'tool';
  requestId: string;
  tool: string;
  arguments: Record<string, JSONValue>;
  stateOnSuccess?: JSONValue;
}

type MessageDraftResult = ContinueMessage | Reject | RequestTool;
type AfterReceiveResult = Continue | Complete | Respond | Abort | RequestTool;
type SystemPromptResult = ContinuePrompt | Abort | RequestTool;
type PostMessageResult = Continue | Abort | RequestTool;
```

`requestId` must be unique within one routing operation. Completed actions are exposed to later
hooks as operation-local records containing request ID, requesting participant and instance, tool,
status, and result. They never include actions from earlier sends.

`stateOnSuccess`, when present, atomically replaces the requesting instance's complete namespaced
state after a successful tool result. Middleware preserving existing fields must include them in the
replacement value it returns. Instance config, state, action records, and checkpoint data must all
be JSON-serializable; registration and context APIs reject unsupported values.

These outcomes prevent impossible operations:

- `beforeSend` and `beforeReceive` can continue, replace the message draft, reject delivery, or
  request a tool. Reject stops the operation immediately: no message is persisted, no later hooks
  run, and the caller receives a rejected result.
- `afterReceive` can continue, complete without invoking the participant runtime, supply a response,
  abort, or request a tool. Complete and respond are terminal for that phase and skip its remaining
  hooks. A supplied response skips the participant runtime and enters the normal response pipeline.
  In `post_response` mode, complete stops remaining follow-up hooks successfully; respond is invalid
  and becomes a middleware failure.
- `buildSystemPrompt` can append, prepend, replace, abort, or request a tool. Abort skips remaining
  prompt hooks and provider invocation. This phase runs only for agents.
- `afterSend` can continue, abort, or request a tool. It cannot rewrite the persisted message.
- Abort always terminates the complete routing operation and skips every later lifecycle phase. It
  returns an error before persistence or a partial failure identifying the stored message after
  persistence. An abort after inbound persistence prevents participant runtime invocation; an abort
  during response post-hooks leaves the response persisted but skips remaining follow-up hooks.
- Responses supplied by middleware still traverse the full outbound and inbound response path.

A middleware tool request is terminal for the current hook. The runner authorizes and executes it,
records its result, reloads the conversation to observe tool mutations, applies `stateOnSuccess`
only for a successful result, then advances to the next configured hook. Tool-dependent follow-up
reads the operation-local action result in a later hook or belongs in the tool itself. This
restriction permits durable approval resumption without serializing arbitrary JavaScript
continuations.

## Message Lifecycle

For participant A sending a message to participant B:

1. Run A's ordered `beforeSend` hooks.
2. Run B's ordered `beforeReceive` hooks.
3. Persist one inbound message containing the final transformed draft.
4. Run A's ordered `afterSend` hooks.
5. Run B's ordered `afterReceive` hooks.
6. For an agent, build the base provider messages and run B's ordered `buildSystemPrompt` hooks.
7. Invoke B's participant runtime unless middleware completed or supplied a response.

For B's response to A:

1. Run B's ordered `beforeSend` hooks.
2. Run A's ordered `beforeReceive` hooks.
3. Persist one response containing the final transformed draft.
4. Run B's ordered `afterSend` hooks.
5. Run A's ordered `afterReceive` hooks in post-response mode; this mode performs follow-up actions
   but does not invoke A's runtime.

Participant identity selects each chain. Passing an existing conversation ID to a different
participant changes the applicable chain for that message; assistant and user roles do not select
middleware.

The same lifecycle applies to buffered, streaming, synchronous, and fire-and-forget sends. Router
paths use common guarded append and state-update operations so streaming does not bypass middleware
serialization rules.

### Streaming Expansion

Streaming reuses existing `LLMChunk` values rather than introducing a parallel middleware chunk
hierarchy. For each `text_delta` or `reasoning_delta`, the runner accumulates a `MessageDraft` and
invokes sender `beforeSend` followed by recipient `beforeReceive` with:

```ts
{
  message, // cumulative content and reasoning for the current iteration
  chunk, // original LLMChunk
  final: false,
  iteration,
}
```

`iteration_start`, `tool_call_start`, and `tool_call_args_delta` pass through unchanged. An
iteration start resets text and reasoning accumulation. Tool-call chunks are runtime control data;
intercepting actual assembled calls requires future dedicated tool-call phases inside
`AgentRuntime`.

Middleware results are cumulative message snapshots. When transformed content remains an append of
the previously emitted snapshot, the runner emits an ordinary existing `text_delta` or
`reasoning_delta`. A rewrite of earlier content, channel removal, or retraction emits one new
authoritative chunk:

```ts
type LLMChunk =
  ExistingLLMChunk | { type: 'message_snapshot'; content: string; reasoning?: string };
```

When the runtime returns its completed response, the runner invokes both pre-persistence chains one
last time with the full draft, no `chunk`, and `final: true`. It emits a final snapshot when needed,
persists that final draft, then runs `afterSend` and `afterReceive` once. Non-streaming delivery uses
this same final call without any preceding chunk calls.

A reject during provisional streaming aborts provider generation, emits an empty authoritative
snapshot to retract provisional output, persists no response, and returns a rejected result. Tool
requests are valid only when `final` is true; returning one for a provisional chunk is a middleware
failure handled by the instance failure mode. Trusted middleware may still perform ordinary awaited
I/O, such as a moderation API call, while processing a provisional chunk.

## Middleware State

Conversation data stores durable middleware state by participant and instance:

```ts
interface ConversationData {
  middlewareState?: Record<
    string, // participantId
    Record<string, JSONValue> // instanceId
  >;
}
```

`getState` and `setState` expose only the attached participant and instance namespace. One
participant cannot access another participant's middleware state through middleware APIs. Shared
conversation-wide middleware state is not supported in v1.

State is conversation-wide rather than branch-local. Middleware that stores a message ID, such as
a compaction watermark, must verify that the message still belongs to the active chain before using
it. State updates use guarded conversation mutations.

## Tool Authorization And Approval

Middleware requests tools as its attached participant. `AuthEngine` evaluates that participant's
current tool policy exactly as it does for agent-generated calls:

- Hidden tools fail the middleware action.
- `auto` tools execute through `ToolRegistry` immediately.
- `requires_approval` tools create a standard durable pending approval and suspend the pipeline.

For suspension, the runner records a durable checkpoint containing:

- Conversation and routing operation identity
- Pipeline phase
- Attached participant and middleware instance
- Middleware type and participant middleware revision
- Completed hook cursor
- Current message or prompt draft
- Request ID, tool, arguments, and optional `stateOnSuccess`
- Completed operation-local action records
- Conversation head observed at suspension

After approval, the runner verifies that conversation head, participant ID, middleware type,
instance ID, and `middlewareRevision` still match. A mismatch fails closed instead of replaying
stale behavior. An approved tool runs through `ToolRegistry`; a rejected tool becomes a structured
middleware failure. The runner records the action result, reloads conversation data, conditionally
applies `stateOnSuccess`, and then advances to the next hook. Checkpoints are removed after
completion or terminal failure.

Middleware does not receive a resumable JavaScript continuation. This avoids replaying arbitrary
side effects that happened before an approval request.

## Failure Semantics

Runtime errors, hidden tools, `ToolResult` values whose status is not `success`, and rejected
approvals follow the effective instance failure mode:

- `open` emits `middleware:error`, records diagnostics, and continues with the current draft.
- `closed` before persistence aborts without storing the message.
- `closed` after persistence never rolls history back; it stops later phases and returns a partial
  failure that identifies the stored message.
- `closed` during system-prompt construction prevents provider invocation.

Security and correctness middleware should default closed. Best-effort automation such as naming
can default open.

## Conversation Lifecycle Additions

Middleware helper conversations need durable provenance and a way to stay out of normal lists.
These capabilities are general conversation features rather than middleware-private fields.

```ts
type ConversationStatus = 'active' | 'archived';

interface ConversationOrigin {
  kind: 'middleware' | 'tool' | 'participant';
  participantId?: string;
  middlewareInstanceId?: string;
  parentConversationId?: string;
  parentMessageId?: string;
  parentToolCallId?: string;
}

interface ConversationData {
  title?: string; // shared fallback
  titles?: Record<string, string>; // participantId -> title
  status?: ConversationStatus;
  tags?: string[];
  origin?: ConversationOrigin;
}
```

An absent status means active, preserving existing persisted conversations. `origin` is immutable.
Tags are editable, unique, case-sensitive strings. Existing `parentConversationId` and
`parentToolCallId` fields remain and are populated alongside origin fields for normal tree
navigation.

### Titles

Conversations retain the existing shared `title` as fallback and add participant-specific titles.
Display title resolves as:

```ts
conversation.titles?.[viewerParticipantId] ?? conversation.title;
```

Title writes can target shared or participant scope. First-write-wins operations are atomic within
their selected scope.

`get_conversation` and `list_conversations` return the title resolved for the calling participant.
Management responses also expose `sharedTitle` and the raw `titles` map where full visibility is
required.

### Archive And Tags

Archived means hidden from default listings, not closed or read-only. Any routed inbound message
sent through `MessageRouter` to an existing archived conversation atomically reactivates it before
delivery and emits `conversation:updated`. Storage-only maintenance operations do not reactivate a
conversation.

A `modify_conversation` management tool supports:

- Shared or participant-scoped title assignment
- `active` or `archived` status
- Atomic `addTags` and `removeTags`

`list_conversations` defaults to active conversations and adds:

- `status: 'active' | 'archived' | 'all'`
- `tags: string[]`, matching conversations containing every supplied tag

`watch_conversations` accepts the same lifecycle and tag filters and streams both
`conversation:created` and `conversation:updated`. Explicit archived/all filters make helper
conversations observable. Each update evaluates filters against metadata before and after the
change. A conversation entering or remaining in the filter emits `conversation:updated`; one
leaving the filter emits a watch-stream `conversation:removed` event with reason `filter_exit` so
clients can remove stale rows. A created conversation emits only when its initial metadata matches.

## Built-In Middleware

### Skills

`SkillRegistry` discovers Agent Skills from:

1. `<workspace>/.agents/skills`
2. `~/.agents/skills`

Project scope overrides user scope when names collide. Discovery follows the Agent Skills client
guidance: find directories containing `SKILL.md`, parse required `name` and `description`
frontmatter, retain absolute location and base directory, skip unusable files, and record lenient
validation diagnostics.

A `list_skills` management tool exposes effective skills, scope, location, and diagnostics for the
configuration UI.

Skills middleware configuration contains selected skill names. During `buildSystemPrompt`, it adds
concise activation instructions and an XML catalog containing only selected names and descriptions.
No selected skills means no catalog injection.

`load_skills` is a normal globally registered tool. Participant tool policy alone determines whether
the model sees it. At execution, the tool intersects requested names with enabled skills middleware
instances attached to the participant. Unselected skills remain inaccessible even if discovered.

The tool accepts one or more names and returns frontmatter-stripped instructions wrapped with skill
identity, base directory, and a bounded resource listing. Resources are listed but not eagerly read.
Repeated activations deduplicate. Activated names are stored in the first ordered skills middleware
instance that selected each name.

Within the current agent loop, tool results carry loaded instructions. On later invocations, skills
middleware restores active instructions during system-prompt construction. This keeps activated
skills effective after conversation compaction.

The built-in Vue editor provides searchable multi-select configuration from `list_skills` results.

### Automatic Compaction

Auto-compaction runs in recipient `afterReceive` before system-prompt construction. It estimates
active provider-context tokens and compares them with a configured percentage of the selected
model's context window. An absolute token threshold provides fallback when model metadata lacks a
context window.

Configuration includes:

- Trigger percentage
- Target percentage after compaction
- Absolute fallback token threshold
- Summarizer participant ID
- Minimum recent context to retain
- Optional excluded tags in addition to built-in helper tags

When triggered, middleware selects the oldest contiguous eligible active-chain prefix while
retaining configured recent context. It requests authorized `compact_conversation`. The compaction
tool creates its summarization conversation with middleware origin, parent conversation and message
links, and a `compaction` tag before dispatch. The helper archives after success or terminal failure.

After successful compaction, the original thread reloads before prompt construction. Namespaced
state records the compacted head to prevent repeated attempts and validates that watermark against
the active branch. The tool-request outcome supplies this watermark through `stateOnSuccess`; the
runner reloads the compacted conversation and stores the watermark before continuing later hooks.
Built-in automation ignores `compaction` and `conversation-title` helper conversations by default
to prevent recursive automation.

### Conversation Naming

Naming runs after the first successful response has been persisted. It can run from attached
participant `afterSend` or post-response `afterReceive`, allowing each side to own a title.

Configuration includes:

- Naming participant ID
- Maximum title length and generation guidance
- `scope: 'participant' | 'shared'`
- Optional excluded tags in addition to built-in helper tags

Participant scope writes `titles[attachedParticipantId]`; shared scope writes `title`. Middleware
does nothing when its selected scope already has a title.

Middleware requests authorized `generate_conversation_title`. The tool creates a helper conversation
with middleware origin, parent links, and a `conversation-title` tag before asking the configured
naming participant. It archives the helper after success or terminal failure, validates the result,
and performs an atomic first-write-wins assignment. Naming defaults to failure-open so title
generation cannot break message delivery.

## Configuration UI

Participant editing adds an ordered middleware section with enable/disable, reorder, inherited
failure mode, override, validation, and removal controls.

Built-in middleware may map their type to dedicated Vue components. V1 provides dedicated editors
where useful, including the skills catalog selector. Workspace middleware uses schema-generated
forms from its definition's configuration schema. Runtime-loaded workspace Vue components are
deferred until Legion has a browser plugin-loading design.

Unknown disabled middleware remains visible with preserved raw configuration and diagnostics but
cannot be enabled until its definition becomes available.

Secrets are represented by credential references rather than literal participant configuration
values.

## Events And Observability

Add `middleware:error` with conversation, participant, instance, type, phase, failure mode, and safe
error details. Add `conversation:updated` carrying metadata needed by filtered conversation watches.

Existing `message:sent` and `message:delivered` events fire only after corresponding final drafts
are persisted. Rejected pre-persistence messages do not emit either event.

Logs include module registration, hook duration, tool requests, approval checkpoint IDs, skipped
instances, and failure-mode decisions without logging secret config values.

## Testing

### Core Unit Tests

- Registry loading, duplicate types, module failures, defaults, and schema validation
- Ordered hooks, transformations, short-circuit responses, and failure modes
- Sender/recipient chain selection when participant roles change in one conversation
- Namespaced state isolation across participants and duplicate middleware instances
- Approval persistence, rejection, resumption, stale config, and stale conversation head
- Streaming, buffered, synchronous, and fire-and-forget routing parity
- Archive reactivation, tags, title resolution, list filters, and watch events

### Built-In Tests

- Skill precedence, parsing diagnostics, selection enforcement, loading, deduplication, and
  post-compaction restoration
- Compaction estimates, thresholds, range selection, authorization, provenance, archive state, and
  retry prevention
- Shared and participant naming, first-write-wins behavior, helper lifecycle, and concurrent naming
  attempts

### Web Tests

- Built-in editors and schema-generated workspace forms
- Middleware ordering and enablement
- Inherited and overridden failure mode
- Validation diagnostics and unavailable definitions
- Skill selection and archived conversation filtering

### End-To-End Tests

- Activate one configured skill through `load_skills`
- Trigger one automatic compaction
- Generate shared and participant title examples
- Hide and explicitly list archived helper conversations
- Pause and resume one middleware-triggered approved tool

## Compatibility And Migration

All new participant and conversation fields are optional. Existing participants have empty
middleware chains. Existing conversations with no status are active, retain their shared title, and
have no tags, origin, participant titles, or middleware state.

No bulk migration is required. Files acquire new fields only when corresponding features are used.
