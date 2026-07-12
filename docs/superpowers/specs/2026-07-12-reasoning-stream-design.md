# Reasoning Stream Design

**Date:** 2026-07-12
**Status:** Approved

## Objective

Stream provider-supplied reasoning text through Legion's existing LLM streaming pipeline, persist it per assistant turn, and render it as an inline disclosure in the conversation UI. Reasoning remains distinct from final answer text and is never sent back to the model.

This feature captures only text explicitly emitted by a provider. It does not claim access to hidden chain-of-thought. Providers that do not expose reasoning continue to behave exactly as they do today.

## Requirements

- Normalize provider-specific reasoning events into a Legion `reasoning_delta` chunk.
- Support common OpenAI-compatible delta fields initially: `reasoning_content` and `reasoning`.
- Keep provider-specific mapping inside provider adapters.
- Persist completed reasoning per assistant turn, including intermediate tool-call turns.
- Make persisted reasoning visible to everyone authorized to view its conversation message.
- Never include persisted reasoning in later provider requests.
- Render reasoning inside its assistant message using an inline disclosure.
- Expand disclosure while reasoning streams and collapse it when generation completes.
- Preserve existing behavior for providers and conversations without reasoning.
- Introduce explicit stream iteration boundaries to prevent live content from separate agent iterations from being concatenated.

## Non-Goals

- Exposing reasoning from providers that do not return it.
- Reconstructing or synthesizing hidden reasoning.
- Sending persisted reasoning back to providers.
- Preserving provider-specific reasoning signatures or encrypted blocks.
- Recording partial reasoning from failed or interrupted model turns.
- Adding reasoning duration metadata in the first version.
- Replacing message content with a generic content-parts schema.

## Architecture

Reasoning follows the existing Phase 2 streaming path:

```text
Provider SSE
  -> provider-specific parser
  -> ProviderStreamChunk.reasoning_delta
  -> AgentRuntime per-iteration accumulator
  -> LLMChunk.reasoning_delta
  -> MessageRouter / communicate StreamingTool
  -> ToolRegistry / WebSocket stream
  -> useConversation.streamingReasoning
  -> inline reasoning disclosure
```

Completed reasoning follows the existing persistence path:

```text
AgentRuntime turn result
  -> intermediate tool-call MessageData.reasoning
  -> or RuntimeResult.reasoning for final turn
  -> MessageRouter.persistResponse()
  -> final MessageData.reasoning
  -> get_conversation
  -> MessageBubble disclosure
```

No new transport mechanism is required. Reasoning and iteration chunks use the existing `StreamChunk` WebSocket and SSE routing.

## Canonical Stream Types

Add reasoning to provider-internal stream chunks:

```ts
export type ProviderStreamChunk =
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string }
  | { type: 'done'; stopReason: ProviderStopReason; usage?: ProviderUsage; cost?: number };
```

Add reasoning and iteration boundaries to public LLM chunks:

```ts
export type LLMChunk =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string };
```

`iteration_start` is emitted by `AgentRuntime`, not providers. The zero-based `iteration` value matches the runtime loop and existing `iteration` activity event.

## Provider Boundary

`OpenAICompatibleProvider` maps common compatible fields into canonical reasoning chunks:

```text
choice.delta.reasoning_content -> reasoning_delta
choice.delta.reasoning         -> reasoning_delta
```

Only non-empty string values produce chunks. Unknown or malformed fields are ignored without affecting text, tool-call, usage, or completion handling.

Future providers implement the same contract inside their adapters. For example, an `AnthropicProvider` can map `content_block_delta` events containing `thinking_delta` into `reasoning_delta`. Provider-specific signatures or continuity metadata remain private to that adapter unless a future feature explicitly requires them.

Everything above the provider boundary remains provider-agnostic.

## Runtime And Iterations

`AgentRuntime` emits `iteration_start` before each call to `provider.stream()`. It then accumulates answer text and reasoning in separate fields for that iteration:

```ts
interface TurnAccumulator {
  content: string;
  reasoning: string;
  // existing tool-call, usage, stop-reason, and cost fields
}
```

Provider `reasoning_delta` chunks update `acc.reasoning` and are yielded upstream as public `reasoning_delta` chunks. Provider `text_delta` chunks continue to update `acc.content` independently.

When an iteration ends in tool calls, `AgentRuntime` persists that iteration's `content`, `reasoning`, tool calls, tool results, and usage together on the intermediate assistant message. The next iteration starts with fresh content and reasoning accumulators.

When an iteration ends in a final response, `RuntimeResult` carries both values:

```ts
type RuntimeResult =
  | { kind: 'response'; content: string; reasoning?: string; usage?: MessageUsage }
  | { kind: 'pending_approval'; approvalRequests: PendingApproval[] }
  | { kind: 'void' };
```

Reasoning is omitted when empty.

`buildProviderMessages()` continues to use only `MessageData.content`, tool calls, and tool results. It never copies `MessageData.reasoning` into `ProviderMessage`.

## Persistence

Add one optional field to the existing message model:

```ts
export interface MessageData {
  // existing fields
  content: string;
  reasoning?: string;
}
```

`NewMessageInput`, `createMessage()`, and `MessageRouter.persistResponse()` propagate the field. Reasoning and answer content are stored atomically on the same assistant message.

No conversation schema-version bump or data migration is required. Existing JSON files without `reasoning` remain valid.

### Conversation Operations

- **Branching and switching:** reasoning stays with its message node and follows existing branch behavior.
- **Pruning:** reasoning is pruned with its message.
- **Manual editing:** edited messages do not copy original reasoning because it may no longer explain edited content.
- **Regeneration:** regenerated branches receive newly generated reasoning.
- **Compaction:** summaries do not copy source-message reasoning.
- **Conversation export/read:** authorized message readers receive `reasoning` with the rest of `MessageData`.

## Frontend State

`useConversation` adds `streamingReasoning` beside `streamingText`.

Chunk behavior:

- `iteration_start`: clear temporary reasoning and output for the new model iteration.
- `reasoning_delta`: append to `streamingReasoning`.
- `text_delta`: append to `streamingText`.
- `stream:done`: clear temporary state after persisted message delivery/reload takes over.
- `stream:error`: use existing error state and do not create persisted partial reasoning.

Explicit iteration boundaries fix a current ambiguity in multi-iteration streams: content emitted before a tool call cannot leak into the live bubble for the next model iteration.

New conversations use the same state. They do not depend on `watch_activity`, which is unavailable until a conversation ID exists.

## Conversation UI

Reasoning appears inside its assistant message, immediately before answer content.

### Streaming State

- First reasoning chunk opens disclosure automatically.
- Reasoning text streams inside disclosure.
- Final answer text can stream below it.
- Disclosure stays expanded until stream completion.
- Reasoning uses the existing sanitized Markdown renderer.

### Persisted State

- Messages with non-empty `reasoning` render a **Reasoning** disclosure.
- Disclosure starts collapsed after completion and after page reload.
- User may expand or collapse it independently per message.
- Messages without reasoning preserve current rendering exactly.
- First version does not show a generated duration such as "Thought for 8 seconds."

## Visibility And Security

Reasoning uses the same authorization boundary as its owning conversation message. Anyone authorized to retrieve the message can retrieve its reasoning. No separate endpoint, sidecar store, or permission model is introduced.

Reasoning is rendered through the existing sanitized Markdown path. It is never interpolated as raw HTML.

Because provider reasoning can contain sensitive intermediate material, UI defaults to collapsed after completion. Storage and conversation export treat reasoning as message data, not telemetry.

## Error Handling

- Unsupported providers emit no reasoning chunks.
- Missing reasoning fields are normal and silent.
- Non-string or empty provider reasoning fields are ignored.
- Reasoning parsing cannot suppress valid answer, tool-call, usage, or completion chunks.
- Failed or interrupted turns do not persist partial reasoning.
- Existing `stream:error` behavior remains authoritative in frontend.
- Existing conversations with no reasoning require no fallback logic.

## Iteration Boundary Compatibility

`iteration_start` expands the `LLMChunk` union, so every chunk consumer must be audited. Consumers should either handle it explicitly or ignore unknown non-terminal chunks without failing.

Required checks:

- `AgentRuntime.handle()` still drains all chunks and returns identical buffered results.
- `MessageRouter.sendStream()` forwards boundary chunks without altering persistence.
- `communicate` streams boundaries but preserves final `ToolResult` shape.
- `ToolRegistry.execute()` drains boundary chunks without exposing them in buffered results.
- WebSocket and SSE transports serialize boundaries using existing framing.
- `useToolStream` stores/routes boundaries like other chunks.
- Existing UI subscriptions that do not consume LLM chunks remain unchanged.
- Tests and mocks with exhaustive `LLMChunk` switches are updated.
- Single-iteration streams gain one harmless initial boundary and preserve text ordering.
- Multi-iteration streams reset only temporary frontend state; persisted messages remain untouched.

## Testing Strategy

### Provider Tests

- Parse `reasoning_content` deltas.
- Parse `reasoning` deltas.
- Preserve ordering for interleaved reasoning and text.
- Ignore malformed reasoning while continuing text and tool calls.
- Preserve usage and terminal `done` behavior.

### Runtime Tests

- Emit `iteration_start` before every provider invocation.
- Preserve existing single-iteration text and tool-call ordering.
- Accumulate reasoning separately from output.
- Persist reasoning on intermediate tool-call messages.
- Return final reasoning through `RuntimeResult`.
- Reset accumulators between iterations.
- Exclude persisted reasoning from later provider messages.
- Preserve buffered `handle()` behavior.

### Router And Conversation Tests

- Persist final response reasoning atomically with content.
- Load old conversation files without reasoning.
- Carry reasoning through branch switching and pruning.
- Drop reasoning when manually editing a message.
- Keep generated summaries free of copied reasoning.

### Web Tests

- Reset temporary text and reasoning on `iteration_start`.
- Accumulate reasoning and text independently.
- Auto-expand reasoning during streaming.
- Collapse persisted disclosure by default.
- Render persisted reasoning after reload.
- Hide disclosure for absent or whitespace-only reasoning.
- Preserve existing messages and stream errors.

### End-To-End Test

Mock provider emits:

```text
iteration 0: reasoning -> tool call
iteration 1: reasoning -> final text
```

Verify live state resets at second iteration, final output does not include first-turn content, and both persisted assistant turns retain their own reasoning disclosures.

## Acceptance Criteria

- OpenAI-compatible reasoning streams live without mixing into answer text.
- Completed reasoning survives reload and stays attached to correct assistant turn.
- Intermediate tool-call and final-answer reasoning remain separate.
- Reasoning never appears in subsequent provider request messages.
- Inline disclosure expands during streaming and collapses after completion.
- Providers without reasoning show no UI or behavioral regression.
- Buffered execution and existing streaming tools retain current results.
- Full formatting, typecheck, root tests, web tests, and reasoning E2E test pass.
