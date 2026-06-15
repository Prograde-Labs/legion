import { createId } from '../util/ids.js';
import { LegionError } from '../errors/LegionError.js';

export interface ApprovalDecision {
  approved: boolean;
  decidedByParticipantId: string;
}

export interface PendingApprovalInput {
  conversationId: string;
  requesterId: string;
  tool: string;
  args: unknown;
}

export interface PendingApproval extends PendingApprovalInput {
  requestId: string;
  createdAt: string;
}

interface PendingEntry extends PendingApproval {
  resolveFn: (decision: ApprovalDecision) => void;
}

export class PendingApprovalRegistry {
  private pending = new Map<string, PendingEntry>();

  create(input: PendingApprovalInput): { requestId: string; decision: Promise<ApprovalDecision> } {
    const requestId = createId('appr');
    let resolveFn!: (decision: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      resolveFn = resolve;
    });
    this.pending.set(requestId, {
      ...input,
      requestId,
      createdAt: new Date().toISOString(),
      resolveFn,
    });
    return { requestId, decision };
  }

  get(requestId: string): PendingApproval | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    const { resolveFn: _ignored, ...rest } = entry;
    return rest;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ resolveFn: _ignored, ...rest }) => rest);
  }

  resolve(requestId: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry)
      throw new LegionError(`Unknown approval request: ${requestId}`, 'APPROVAL_NOT_FOUND');
    this.pending.delete(requestId);
    entry.resolveFn(decision);
  }
}
