import type { MessageData, MessageDraft } from './conversation.js';
import type { LegionEventMap, LegionEventName } from './events.js';
import type { ParticipantConfig } from './participant.js';
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
  participant: ParticipantConfig;
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
  readonly message: Readonly<MessageDraft>;
  chunk?: LLMChunk;
  final: boolean;
  iteration?: number;
}

export interface AfterReceiveContext<TConfig = unknown> extends MiddlewareHookContext<TConfig> {
  readonly message: Readonly<MessageData>;
  mode: 'pre_runtime' | 'post_response';
}

export interface SystemPromptContext<TConfig = unknown> extends MiddlewareHookContext<TConfig> {
  prompt: string;
}

export interface PostMessageContext<TConfig = unknown> extends MiddlewareHookContext<TConfig> {
  readonly message: Readonly<MessageData>;
}

export interface ContinueMessage {
  kind: 'continue';
  message?: MessageDraft;
}

export interface ContinuePrompt {
  kind: 'continue';
  change?: {
    operation: 'append' | 'prepend' | 'replace';
    content: string;
  };
}

export interface Continue {
  kind: 'continue';
}

export interface Reject {
  kind: 'reject';
  error: string;
}

export interface Complete {
  kind: 'complete';
}

export interface Respond {
  kind: 'respond';
  message: MessageDraft;
}

export interface Abort {
  kind: 'abort';
  error: string;
}

export interface RequestTool {
  kind: 'tool';
  requestId: string;
  tool: string;
  arguments: Record<string, JSONValue>;
  stateOnSuccess?: JSONValue;
}

export interface MiddlewareDiagnostic {
  type: string;
  source: string;
  status: 'loaded' | 'error';
  error?: string;
  configurationErrors: Array<{
    participantId: string;
    instanceId: string;
    errors: string[];
  }>;
}

export interface MiddlewareCheckpoint {
  checkpointId: string;
  operationId: string;
  conversationId: string;
  phase: MiddlewarePhase;
  participantId: string;
  instanceId: string;
  middlewareType: string;
  middlewareRevision: number;
  middlewareConfig?: JSONValue;
  nextHookIndex: number;
  actionCursor: number;
  draft?: MessageDraft;
  prompt?: string;
  message?: MessageData;
  mode?: 'pre_runtime' | 'post_response';
  final?: boolean;
  iteration?: number;
  request: Omit<RequestTool, 'kind'>;
  actions: MiddlewareActionResult[];
  observedHead: string;
  persistedMessageId?: string;
  runtimeResume?: {
    kind: 'agent_provider';
    participantId: string;
    incomingMessageId: string;
    iteration: number;
    preparedPrompt: string;
    actionCursor: number;
    actions: MiddlewareActionResult[];
  };
  createdAt: string;
}

export type MessageDraftResult = ContinueMessage | Reject | RequestTool;
export type AfterReceiveResult = Continue | Complete | Respond | Abort | RequestTool;
export type SystemPromptResult = ContinuePrompt | Abort | RequestTool;
export type PostMessageResult = Continue | Abort | RequestTool;

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

export interface MiddlewareDefinitionSummary {
  type: string;
  displayName: string;
  description?: string;
  defaultFailureMode: FailureMode;
  configSchema: JSONSchema;
  source: string;
}
