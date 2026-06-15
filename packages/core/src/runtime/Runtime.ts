import type { MessageData, ParticipantType } from '@legion/types';
import type { ToolContext } from '../tools/Tool.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { MessageRouterPort } from '../tools/Tool.js';

/**
 * Full execution context (spec §4). Extends ToolContext, tightening the runtime-only
 * collaborators to required and concrete.
 */
export interface RuntimeContext extends ToolContext {
  conversation: ConversationThread;
  authEngine: AuthEngine;
  pendingApprovalRegistry: PendingApprovalRegistry;
  messageRouter: MessageRouterPort;
  serviceManager?: unknown;
}

/** A runtime handles an inbound message addressed to its participant. */
export interface Runtime {
  /** Returns the response content, or void/undefined if the participant produces no reply. */
  handle(incoming: MessageData, context: RuntimeContext): Promise<string | void>;
}

/** Builds a Runtime instance bound to a specific participant. */
export type RuntimeFactory = (participantId: string) => Runtime;

export type { ParticipantType };
