// packages/types/src/streaming.ts
import type { ToolResult } from './tool.js';
import type { LegionEventMap, LegionEventName } from './events.js';

// LLM output — from communicate and any LLM-backed streaming tools
export type LLMChunk =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string };

// Lifecycle — emitted by ToolRegistry, never by tool authors
export type LifecycleChunk =
  | { type: 'stream:done'; result: ToolResult }
  | { type: 'stream:error'; error: string };

// Event — from subscription tools; reuses LegionEventMap shapes
export type EventChunk = {
  [K in LegionEventName]: { type: K; data: LegionEventMap[K] };
}[LegionEventName];

// Process — from watch_process; source is ProcessManager, not EventBus
export type ProcessChunk =
  | { type: 'process:output'; processId: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'process:exited'; processId: string; exitCode: number | null }
  | { type: 'process:error'; processId: string; error: string };

export type ConversationWatchChunk = {
  type: 'conversation:removed';
  data: { conversationId: string; reason: 'filter_exit' };
};

export type StreamChunk =
  | LLMChunk
  | EventChunk
  | LifecycleChunk
  | ProcessChunk
  | ConversationWatchChunk;
