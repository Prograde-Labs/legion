import type { MessageData, ParticipantConfig } from '@legion/types';
import type { ToolContext } from '../tools/Tool.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { PendingApprovalRegistry, PendingApproval } from '../auth/PendingApprovalRegistry.js';
import type { ApprovalLog } from '../auth/ApprovalLog.js';
import type { MessageRouterPort } from '../tools/Tool.js';

export type RuntimeResult =
  | { kind: 'response'; content: string }
  | { kind: 'pending_approval'; approvalRequests: PendingApproval[] }
  | { kind: 'void' };

/**
 * Full execution context (spec §4). Extends ToolContext, tightening the runtime-only
 * collaborators to required and concrete.
 */
export interface RuntimeContext extends ToolContext {
  conversation: ConversationThread;
  authEngine: AuthEngine;
  pendingApprovalRegistry: PendingApprovalRegistry;
  approvalLog?: ApprovalLog;
  messageRouter: MessageRouterPort;
  // TODO (Plan 008 Task 5): replace with `import('../service/ServiceManager.js').ServiceManager`
  serviceManager?: unknown;
}

/** A runtime handles an inbound message addressed to its participant. */
export interface Runtime {
  handle(incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult>;
}

/** Builds a Runtime instance bound to a specific participant. */
export type RuntimeFactory = (participantId: string) => Runtime;

export type { ParticipantConfig };
