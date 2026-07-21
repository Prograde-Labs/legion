import type {
  JSONSchema,
  ToolResult,
  ParticipantConfig,
  WorkspaceConfig,
  StreamChunk,
  LLMChunk,
  ConversationOrigin,
  MiddlewareInstanceConfig,
  MiddlewareCheckpoint,
} from '@legion/types';
import type { Collective } from '../collective/Collective.js';
import type { CredentialStore } from '../credentials/CredentialStore.js';
import type { EventBus } from '../events/EventBus.js';
import type { Storage } from '../storage/Storage.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import type {
  AutomationCompactionSeed,
  PendingApproval,
  PendingApprovalRegistry,
} from '../auth/PendingApprovalRegistry.js';

export interface MessageRouterResult {
  conversationId: string;
  response?: string;
  status: 'success' | 'error' | 'dispatched' | 'pending_approval';
  error?: string;
  partial?: boolean;
  storedMessageId?: string;
  approvalId?: string;
  checkpointId?: string;
  pendingParticipantId?: string;
  approvalRequests?: PendingApproval[];
}

/** Minimal port so core tools can route messages without depending on @legion/runtime. */
export interface MessageRouterPort {
  send(opts: {
    senderId: string;
    recipientId: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
    origin?: ConversationOrigin;
    context: ToolContext;
  }): Promise<MessageRouterResult>;

  /**
   * Re-trigger a paused participant after approval decisions arrive.
   * Called by `approval_response` after resolving pending approvals.
   */
  resume(
    conversationId: string,
    participantId: string,
    context: ToolContext,
  ): Promise<MessageRouterResult>;

  /** Resume durable middleware approval continuation without replaying runtime input. */
  resumeApproval(approvalId: string, context: ToolContext): Promise<MessageRouterResult>;

  /**
   * Trigger a participant response from the current active branch without
   * appending a new user message. Used by edit re-run and regenerate flows.
   */
  generate(
    conversationId: string,
    participantId: string,
    context: ToolContext,
  ): Promise<MessageRouterResult>;

  sendStream(opts: {
    senderId: string;
    recipientId: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
    origin?: ConversationOrigin;
    context: ToolContext;
  }): AsyncGenerator<LLMChunk, MessageRouterResult>;
}

export interface MiddlewareConfigurationValidator {
  validate(instances: readonly MiddlewareInstanceConfig[]): Promise<void>;
}

/**
 * Context handed to every tool execution. `participant` is always the principal.
 * Runtime-only collaborators are optional here; @legion/runtime's RuntimeContext
 * satisfies this interface and provides them concretely (spec §4).
 */
export interface ToolContext {
  participant: ParticipantConfig;
  conversationId: string;
  collective: Collective;
  config: WorkspaceConfig;
  eventBus: EventBus;
  storage: Storage;
  workspaceRoot: string;
  communicationDepth: number;
  toolRegistry: ToolRegistryLike;
  callingParticipantId?: string;
  /** The LLM tool-call id currently being executed, for parent linking in delegation. */
  toolCallId?: string;
  /** Durable parent checkpoint while a middleware-owned tool executes. */
  middlewareCheckpoint?: MiddlewareCheckpoint;
  /** JSON-safe continuation seed consumed atomically when helper middleware requests approval. */
  approvalContinuationSeed?: AutomationCompactionSeed;
  /** Title helpers terminalize nested approvals before they can be observed or resumed. */
  titleApprovalRejectionMessage?: string;
  pendingApprovalRegistry?: PendingApprovalRegistry;
  credentialStore?: CredentialStore;
  conversation?: ConversationThread;
  messageRouter?: MessageRouterPort;
  conversationStore?: ConversationStore;
  middlewareValidator?: MiddlewareConfigurationValidator;
  /** AbortSignal set by transport when a streaming call is cancelled. */
  signal?: AbortSignal;
  /** Narrow cancellation capability — only for the cancel_stream tool. */
  cancelStream?: (streamId: string) => boolean;
  // Plans 5 & 7 attach: authEngine, pendingApprovalRegistry, serviceManager.
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(args: unknown, context: ToolContext): Promise<unknown>;
}

/** A tool that yields chunks instead of returning a single result. */
export interface StreamingTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  stream(args: unknown, context: ToolContext): AsyncGenerator<StreamChunk, ToolResult | void>;
}

/** Either a regular tool or a streaming tool. */
export type AnyTool = Tool | StreamingTool;

/** Type guard — use before accessing `.stream()` or `.execute()`. */
export function isStreamingTool(t: AnyTool): t is StreamingTool {
  return 'stream' in t && typeof (t as StreamingTool).stream === 'function';
}

export interface ToolRegistryLike {
  get(name: string): AnyTool | undefined;
  has(name: string): boolean;
  list(): AnyTool[];
  listAll(): string[];
  execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult>;
  stream(name: string, args: unknown, context: ToolContext): AsyncGenerator<StreamChunk>;
}
