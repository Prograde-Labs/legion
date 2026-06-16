export interface LegionEventMap {
  'process:ready': { workspaceRoot: string };
  'conversation:created': { conversationId: string };
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
