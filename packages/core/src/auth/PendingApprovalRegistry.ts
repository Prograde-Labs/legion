import { createId } from '../util/ids.js';
import { LegionError } from '../errors/LegionError.js';
import type { Storage } from '../storage/Storage.js';

export interface ApprovalDecision {
  approved: boolean;
  decidedByParticipantId: string;
  message?: string;
  decidedAt: string;
}

export interface PendingApprovalInput {
  conversationId: string;
  requesterId: string;
  tool: string;
  args: unknown;
}

export interface PendingApproval extends PendingApprovalInput {
  approvalId: string;
  createdAt: string;
}

interface RegistryData {
  pending: Record<string, PendingApproval>;
  decisions: Record<string, ApprovalDecision>;
}

const STORAGE_KEY = 'pending-approvals/registry.json';

export class PendingApprovalRegistry {
  private data: RegistryData = { pending: {}, decisions: {} };

  constructor(private storage?: Storage) {}

  /**
   * Load a durable registry from storage. If the file does not exist yet, returns a
   * fresh empty registry backed by the provided storage.
   */
  static async load(storage: Storage): Promise<PendingApprovalRegistry> {
    const reg = new PendingApprovalRegistry(storage);
    try {
      const data = await storage.readJson<RegistryData>(STORAGE_KEY);
      if (data) reg.data = data;
    } catch {
      // No file yet — start fresh.
    }
    return reg;
  }

  private async persist(): Promise<void> {
    if (this.storage) {
      await this.storage.writeJson(STORAGE_KEY, this.data);
    }
  }

  async create(input: PendingApprovalInput): Promise<{ approvalId: string }> {
    const approvalId = createId('appr');
    const pending: PendingApproval = {
      ...input,
      approvalId,
      createdAt: new Date().toISOString(),
    };
    this.data.pending[approvalId] = pending;
    await this.persist();
    return { approvalId };
  }

  /** Returns the pending approval if it has not yet been resolved. */
  get(approvalId: string): PendingApproval | undefined {
    return this.data.pending[approvalId];
  }

  /** Returns the decision if this approval has been resolved; undefined if still pending. */
  getDecision(approvalId: string): ApprovalDecision | undefined {
    return this.data.decisions[approvalId];
  }

  /**
   * Lists all still-pending approvals, optionally filtered to a specific conversation.
   */
  listPending(conversationId?: string): PendingApproval[] {
    const all = Object.values(this.data.pending);
    if (!conversationId) return all;
    return all.filter((p) => p.conversationId === conversationId);
  }

  async resolve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.data.pending[approvalId]) {
      throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
    }
    this.data.decisions[approvalId] = decision;
    delete this.data.pending[approvalId];
    await this.persist();
  }
}
