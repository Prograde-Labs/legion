import { isDeepStrictEqual } from 'node:util';
import type { MiddlewareCheckpoint, ToolResult } from '@legion/types';
import { LegionError } from '../errors/LegionError.js';
import { cloneJsonSafe } from '../middleware/json.js';
import type { Storage } from '../storage/Storage.js';
import { createId } from '../util/ids.js';

export interface ApprovalDecision {
  approved: boolean;
  decidedByParticipantId: string;
  message?: string;
  decidedAt: string;
}

export type ApprovalContinuation = {
  kind: 'middleware';
  checkpoint: MiddlewareCheckpoint;
};

export interface PendingApprovalInput {
  conversationId: string;
  requesterId: string;
  tool: string;
  args: unknown;
  continuation?: ApprovalContinuation;
}

export type ApprovalLifecycle = 'pending' | 'decided' | 'resuming' | 'acknowledged';

export interface ApprovalRecord extends PendingApprovalInput {
  approvalId: string;
  createdAt: string;
  lifecycle: ApprovalLifecycle;
  decision?: ApprovalDecision;
  resumeResult?: ToolResult;
}

/** Legacy pending-only view retained for approval-response callers. */
export interface PendingApproval extends PendingApprovalInput {
  approvalId: string;
  createdAt: string;
}

export type ResumeClaim =
  | { status: 'ready'; record: ApprovalRecord }
  | { status: 'in_progress'; record: ApprovalRecord }
  | { status: 'acknowledged'; record: ApprovalRecord };

interface RegistryData {
  records: Record<string, ApprovalRecord>;
}

interface LegacyRegistryData {
  pending?: Record<string, PendingApproval>;
  decisions?: Record<string, ApprovalDecision>;
}

const STORAGE_KEY = 'pending-approvals/registry.json';
const INTERRUPTION_ERROR =
  'Interrupted middleware tool execution; outcome unknown and tool was not retried';

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Pending approval ${name} must be a non-empty string`);
  }
  return value;
}

function snapshotOptionalFields<T>(value: T, path: string, optional: ReadonlySet<string>): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return cloneJsonSafe(value, path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) {
    throw new TypeError(`Value at ${path} is not JSON-safe: symbol keys are unsupported`);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError(`Value at ${path}.${key} is not JSON-safe: accessors are unsupported`);
    }
    if (descriptor.value === undefined && optional.has(key)) continue;
    normalized[key] = descriptor.value;
  }
  return cloneJsonSafe(normalized, path) as T;
}

function snapshotDecision(value: ApprovalDecision): ApprovalDecision {
  const cloned = snapshotOptionalFields(
    value,
    '$.decision',
    new Set(['message']),
  ) as ApprovalDecision;
  if (typeof cloned.approved !== 'boolean')
    throw new TypeError('Approval decision approved must be boolean');
  requiredString(cloned.decidedByParticipantId, 'decision.decidedByParticipantId');
  requiredString(cloned.decidedAt, 'decision.decidedAt');
  if (cloned.message !== undefined && typeof cloned.message !== 'string') {
    throw new TypeError('Approval decision message must be a string');
  }
  return cloned;
}

function snapshotResult(value: ToolResult): ToolResult {
  const cloned = snapshotOptionalFields(
    value,
    '$.resumeResult',
    new Set(['data', 'error', 'approvalId', 'message']),
  ) as ToolResult;
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new TypeError('Approval resume result must be an object');
  }
  if (!['success', 'error', 'pending_approval', 'rejected'].includes(cloned.status)) {
    throw new TypeError('Approval resume result has an invalid status');
  }
  return cloned;
}

function snapshotContinuation(
  value: ApprovalContinuation | undefined,
): ApprovalContinuation | undefined {
  if (value === undefined) return undefined;
  const cloned = cloneJsonSafe(value, '$.continuation') as ApprovalContinuation;
  if (cloned.kind !== 'middleware' || !cloned.checkpoint || typeof cloned.checkpoint !== 'object') {
    throw new TypeError('Approval continuation must be a middleware checkpoint');
  }
  requiredString(cloned.checkpoint.checkpointId, 'continuation.checkpoint.checkpointId');
  requiredString(cloned.checkpoint.conversationId, 'continuation.checkpoint.conversationId');
  return cloned;
}

function snapshotInput(input: PendingApprovalInput): PendingApprovalInput {
  const cloned = snapshotOptionalFields(
    input,
    '$.input',
    new Set(['continuation']),
  ) as PendingApprovalInput;
  return {
    conversationId: requiredString(cloned.conversationId, 'conversationId'),
    requesterId: requiredString(cloned.requesterId, 'requesterId'),
    tool: requiredString(cloned.tool, 'tool'),
    args: cloneJsonSafe(cloned.args, '$.input.args'),
    ...(cloned.continuation === undefined
      ? {}
      : { continuation: snapshotContinuation(cloned.continuation) }),
  };
}

function snapshotRecord(value: ApprovalRecord): ApprovalRecord {
  const cloned = cloneJsonSafe(value, '$.record') as ApprovalRecord;
  if (!['pending', 'decided', 'resuming', 'acknowledged'].includes(cloned.lifecycle)) {
    throw new TypeError('Pending approval lifecycle is invalid');
  }
  return {
    ...snapshotInput(cloned),
    approvalId: requiredString(cloned.approvalId, 'approvalId'),
    createdAt: requiredString(cloned.createdAt, 'createdAt'),
    lifecycle: cloned.lifecycle,
    ...(cloned.decision === undefined ? {} : { decision: snapshotDecision(cloned.decision) }),
    ...(cloned.resumeResult === undefined
      ? {}
      : { resumeResult: snapshotResult(cloned.resumeResult) }),
  };
}

function normalizeData(value: unknown): RegistryData {
  const data = cloneJsonSafe(value, '$.registry') as RegistryData & LegacyRegistryData;
  if (data.records && typeof data.records === 'object' && !Array.isArray(data.records)) {
    return {
      records: Object.fromEntries(
        Object.entries(data.records).map(([approvalId, record]) => [
          approvalId,
          snapshotRecord(record),
        ]),
      ),
    };
  }
  const records: Record<string, ApprovalRecord> = {};
  for (const [approvalId, pending] of Object.entries(data.pending ?? {})) {
    const decision = data.decisions?.[approvalId];
    records[approvalId] = snapshotRecord({
      ...pending,
      approvalId,
      lifecycle: decision ? 'decided' : 'pending',
      ...(decision ? { decision } : {}),
    });
  }
  return { records };
}

function recovery(data: RegistryData): boolean {
  let changed = false;
  for (const record of Object.values(data.records)) {
    if (
      record.lifecycle === 'resuming' &&
      record.continuation?.kind === 'middleware' &&
      record.resumeResult === undefined
    ) {
      record.resumeResult = { status: 'error', error: INTERRUPTION_ERROR };
      changed = true;
    }
  }
  return changed;
}

export class PendingApprovalRegistry {
  private data: RegistryData = { records: {} };
  private mutations: Promise<void> = Promise.resolve();

  constructor(private readonly storage?: Storage) {}

  static async load(storage: Storage): Promise<PendingApprovalRegistry> {
    const registry = new PendingApprovalRegistry(storage);
    try {
      const stored = await storage.readJson<unknown>(STORAGE_KEY);
      if (stored !== null) registry.data = normalizeData(stored);
      if (recovery(registry.data)) await storage.writeJson(STORAGE_KEY, registry.data);
    } catch {
      // Missing registry starts empty. Invalid or unavailable persisted data is never published.
    }
    return registry;
  }

  private async mutate<T>(operation: (data: RegistryData) => T | Promise<T>): Promise<T> {
    const task = this.mutations.then(async () => {
      const commit = async (): Promise<T> => {
        let current = this.data;
        if (this.storage) {
          const stored = await this.storage.readJson<unknown>(STORAGE_KEY);
          if (stored !== null) current = normalizeData(stored);
        }
        const candidate = cloneJsonSafe(current, '$.registry') as RegistryData;
        const result = await operation(candidate);
        const durable = normalizeData(candidate);
        if (this.storage) await this.storage.writeJson(STORAGE_KEY, durable);
        this.data = durable;
        return result === undefined ? result : cloneJsonSafe(result, '$.mutationResult');
      };
      return this.storage ? this.storage.withLock(STORAGE_KEY, commit) : commit();
    });
    this.mutations = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async create(input: PendingApprovalInput): Promise<{ approvalId: string }> {
    const snapshot = snapshotInput(input);
    return this.mutate((data) => {
      const approvalId = createId('appr');
      data.records[approvalId] = {
        ...snapshot,
        approvalId,
        createdAt: new Date().toISOString(),
        lifecycle: 'pending',
      };
      return { approvalId };
    });
  }

  getRecord(approvalId: string): ApprovalRecord | undefined {
    const record = this.data.records[approvalId];
    return record === undefined ? undefined : snapshotRecord(record);
  }

  /** Returns only records still awaiting an approval decision. */
  get(approvalId: string): PendingApproval | undefined {
    const record = this.data.records[approvalId];
    if (!record || record.lifecycle !== 'pending') return undefined;
    const {
      lifecycle: _lifecycle,
      decision: _decision,
      resumeResult: _resumeResult,
      ...pending
    } = record;
    return cloneJsonSafe(pending, '$.pending') as PendingApproval;
  }

  getDecision(approvalId: string): ApprovalDecision | undefined {
    const decision = this.data.records[approvalId]?.decision;
    return decision === undefined ? undefined : snapshotDecision(decision);
  }

  listPending(conversationId?: string): PendingApproval[] {
    return Object.values(this.data.records)
      .filter((record) => record.lifecycle === 'pending')
      .filter((record) => conversationId === undefined || record.conversationId === conversationId)
      .map((record) => this.get(record.approvalId)!)
      .map((record) => cloneJsonSafe(record, '$.pending'));
  }

  async resolve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.data.records[approvalId]) {
      throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
    }
    const snapshot = snapshotDecision(decision);
    await this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      if (record.decision !== undefined) {
        if (isDeepStrictEqual(record.decision, snapshot)) return undefined;
        throw new LegionError(`Conflicting approval decision: ${approvalId}`, 'APPROVAL_CONFLICT');
      }
      if (record.lifecycle !== 'pending') {
        throw new LegionError(
          `Approval request is not pending: ${approvalId}`,
          'APPROVAL_CONFLICT',
        );
      }
      record.decision = snapshot;
      record.lifecycle = 'decided';
      return undefined;
    });
  }

  async beginResume(approvalId: string): Promise<ResumeClaim> {
    return this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      if (record.lifecycle === 'acknowledged') return { status: 'acknowledged', record };
      if (record.lifecycle === 'pending') {
        throw new LegionError(
          `Approval request is not decided: ${approvalId}`,
          'APPROVAL_NOT_DECIDED',
        );
      }
      if (record.lifecycle === 'decided') {
        record.lifecycle = 'resuming';
        return { status: 'ready', record };
      }
      return { status: record.resumeResult === undefined ? 'in_progress' : 'ready', record };
    });
  }

  async recordResumeResult(approvalId: string, result: ToolResult): Promise<void> {
    const snapshot = snapshotResult(result);
    await this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      if (record.lifecycle !== 'resuming') {
        throw new LegionError(
          `Approval request is not resuming: ${approvalId}`,
          'APPROVAL_CONFLICT',
        );
      }
      if (record.resumeResult !== undefined && !isDeepStrictEqual(record.resumeResult, snapshot)) {
        throw new LegionError(
          `Conflicting approval resume result: ${approvalId}`,
          'APPROVAL_CONFLICT',
        );
      }
      record.resumeResult = snapshot;
      return undefined;
    });
  }

  async acknowledge(approvalId: string): Promise<void> {
    await this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      if (record.lifecycle === 'acknowledged') return undefined;
      record.lifecycle = 'acknowledged';
      delete record.continuation;
      return undefined;
    });
  }
}
