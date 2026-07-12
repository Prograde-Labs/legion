import type { MessageData, MessageDraft } from './conversation.js';
import type { LegionEventMap, LegionEventName } from './events.js';
import type { BaseParticipant } from './participant.js';
import type { LLMChunk } from './streaming.js';
import type { JSONSchema, ToolResult } from './tool.js';

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type FailureMode = 'open' | 'closed';
export type MiddlewarePhase =
  | 'beforeSend'
  | 'beforeReceive'
  | 'afterReceive'
  | 'buildSystemPrompt'
  | 'afterSend';

export interface MiddlewareInstanceConfig {
  id: string;
  type: string;
  enabled?: boolean;
  failureMode?: FailureMode;
  config: Record<string, JSONValue>;
}

export interface MiddlewareModuleConfig {
  id: string;
  module: string;
}

export interface MiddlewareActionResult {
  requestId: string;
  participantId: string;
  instanceId: string;
  tool: string;
  status: 'success' | 'error' | 'rejected';
  result?: ToolResult;
}

export interface MiddlewareEventBus {
  emit<TEvent extends LegionEventName>(event: TEvent, data: LegionEventMap[TEvent]): void;
}

export interface MiddlewareLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface MiddlewareHookContext<TConfig> {
  operationId: string;
  participant: BaseParticipant;
  instance: MiddlewareInstanceConfig;
  config: TConfig;
  conversationId: string;
  readonly activeChain: readonly MessageData[];
  readonly actions: readonly MiddlewareActionResult[];
  getState(): JSONValue | undefined;
  setState(value: JSONValue): Promise<void>;
  signal: AbortSignal;
  eventBus: MiddlewareEventBus;
  logger: MiddlewareLogger;
}

export interface MessageDraftContext<TConfig = unknown> extends MiddlewareHookContext<TConfig> {
  readonly message: MessageDraft;
  chunk?: LLMChunk;
  final: boolean;
  iteration?: number;
}

export interface AfterReceiveContext<TConfig = unknown> extends MiddlewareHookContext<TConfig> {
  readonly message: MessageData;
  mode: 'pre_runtime' | 'post_response';
}

export interface SystemPromptContext<TConfig = unknown> extends MiddlewareHookContext<TConfig> {
  prompt: string;
}

export interface PostMessageContext<TConfig = unknown> extends MiddlewareHookContext<TConfig> {
  readonly message: MessageData;
}

export interface ContinueMessage {
  action: 'continue';
  message: MessageDraft;
}

export interface ContinuePrompt {
  action: 'continue';
  prompt: string;
  mode: 'append' | 'prepend' | 'replace';
}

export interface Continue {
  action: 'continue';
}

export interface Reject {
  action: 'reject';
  reason: string;
}

export interface Complete {
  action: 'complete';
  content?: string;
  reasoning?: string;
}

export interface Respond {
  action: 'respond';
  content: string;
  reasoning?: string;
}

export interface Abort {
  action: 'abort';
  reason: string;
}

export interface RequestTool {
  action: 'request_tool';
  tool: string;
  arguments: Record<string, JSONValue>;
}

export type MessageDraftResult =
  | ContinueMessage
  | Reject
  | Complete
  | Respond
  | Abort
  | RequestTool;
export type AfterReceiveResult = Continue | Respond | Abort | RequestTool;
export type SystemPromptResult = ContinuePrompt | Abort;
export type PostMessageResult = Continue | Abort;

type Hook<TContext, TResult> = (context: TContext) => TResult | Promise<TResult>;

export interface MiddlewareHooks<TConfig> {
  beforeSend?: Hook<MessageDraftContext<TConfig>, MessageDraftResult>;
  beforeReceive?: Hook<MessageDraftContext<TConfig>, MessageDraftResult>;
  afterReceive?: Hook<AfterReceiveContext<TConfig>, AfterReceiveResult>;
  buildSystemPrompt?: Hook<SystemPromptContext<TConfig>, SystemPromptResult>;
  afterSend?: Hook<PostMessageContext<TConfig>, PostMessageResult>;
}

export interface MiddlewareDefinition<TConfig = unknown> {
  type: string;
  displayName: string;
  description?: string;
  defaultFailureMode: FailureMode;
  configSchema: JSONSchema;
  hooks: MiddlewareHooks<TConfig>;
}
