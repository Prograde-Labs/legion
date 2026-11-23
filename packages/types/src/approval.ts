/** Structured approval request delivered to a participant or connector. */
export interface ApprovalRequestView {
  approvalId: string;
  conversationId: string;
  requesterId: string;
  tool: string;
  args: unknown;
  createdAt: string;
}
