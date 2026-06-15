import type { JSONSchema, ToolResult, ParticipantConfig, WorkspaceConfig } from '@legion/types';
import type { Collective } from '../collective/Collective.js';
import type { CredentialStore } from '../credentials/CredentialStore.js';
import type { EventBus } from '../events/EventBus.js';
import type { Storage } from '../storage/Storage.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';

export interface MessageRouterResult {
  conversationId: string;
  response?: string;
  status: 'success' | 'error' | 'dispatched';
  error?: string;
}

/** Minimal port so core tools can route messages without depending on @legion/runtime. */
export interface MessageRouterPort {
  send(opts: {
    senderId: string;
    recipientId: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
    context: ToolContext;
  }): Promise<MessageRouterResult>;
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
  credentialStore?: CredentialStore;
  conversation?: ConversationThread;
  messageRouter?: MessageRouterPort;
  conversationStore?: ConversationStore;
  // Plans 5 & 7 attach: authEngine, pendingApprovalRegistry, serviceManager.
  [key: string]: unknown;
}

export interface ToolRegistryLike {
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  list(): Tool[];
  execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}
