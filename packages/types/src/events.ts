import type { ConversationEventMetadata } from './conversation.js';
import type { FailureMode, MiddlewarePhase } from './middleware.js';

export interface LegionEventMap {
  'process:ready': { workspaceRoot: string };
  'conversation:created': { conversation: ConversationEventMetadata };
  'conversation:updated': {
    conversationId: string;
    before: ConversationEventMetadata;
    after: ConversationEventMetadata;
  };
  'middleware:error': {
    conversationId: string;
    participantId: string;
    instanceId: string;
    middlewareType: string;
    phase: MiddlewarePhase;
    failureMode: FailureMode;
    error: { name: string; message: string };
  };
  'message:sent': {
    conversationId: string;
    senderId: string;
    recipientId: string;
    messageId: string;
  };
  'message:delivered': { conversationId: string; recipientId: string; messageId: string };
  'tool:call': { conversationId: string; participantId: string; tool: string; callId: string };
  'tool:result': {
    conversationId: string;
    participantId: string;
    tool: string;
    callId: string;
    status: 'success' | 'error' | 'pending_approval' | 'rejected';
  };
  'approval:requested': {
    conversationId: string;
    participantId: string;
    tool: string;
    approvalId: string;
    args?: Record<string, unknown>;
  };
  'approval:resolved': {
    conversationId: string;
    approvalId: string;
    approved: boolean;
    decidedByParticipantId: string;
  };
  'participant:active': { participantId: string };
  'participant:retired': { participantId: string };
  iteration: { conversationId: string; participantId: string; iteration: number };
  error: { conversationId?: string; error: { name: string; message: string } };
}

export type LegionEventName = keyof LegionEventMap;
