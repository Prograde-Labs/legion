export interface ApprovalLogEntry {
  requestId: string;
  conversationId: string;
  requesterId: string;
  tool: string;
  args: unknown;
  approved: boolean;
  decidedByParticipantId: string;
  decidedAt: string;
}

export interface ApprovalLogFilter {
  conversationId?: string;
  requesterId?: string;
}

export class ApprovalLog {
  private entries: ApprovalLogEntry[] = [];

  record(entry: ApprovalLogEntry): void {
    this.entries.push(entry);
  }

  list(filter?: ApprovalLogFilter): ApprovalLogEntry[] {
    return this.entries.filter((e) => {
      if (filter?.conversationId && e.conversationId !== filter.conversationId) return false;
      if (filter?.requesterId && e.requesterId !== filter.requesterId) return false;
      return true;
    });
  }
}
