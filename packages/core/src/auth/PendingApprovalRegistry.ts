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

function exactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Value at ${path} must be a plain object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`Value at ${path} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) {
    throw new TypeError(`Value at ${path} has unsupported symbol fields`);
  }
  const allowed = new Set([...required, ...optional]);
  const normalized: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) throw new TypeError(`Value at ${path}.${key} is unsupported`);
    if (!descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
      throw new TypeError(`Value at ${path}.${key} must be an enumerable data property`);
    }
    if (descriptor.value === undefined && optional.includes(key)) continue;
    normalized[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(normalized, key)) throw new TypeError(`Value at ${path} requires ${key}`);
  }
  return normalized;
}

function requiredInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`Value at ${path} must be a non-negative integer`);
  }
  return value as number;
}

function requiredIsoString(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (Number.isNaN(Date.parse(result)))
    throw new TypeError(`Value at ${path} must be an ISO timestamp`);
  return result;
}

function assertNoAliases(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Value at ${path} must be finite`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`Value at ${path} is not JSON-safe`);
  if (seen.has(value)) throw new TypeError(`Value at ${path} may not contain aliases or cycles`);
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) {
    throw new TypeError(`Value at ${path} has unsupported symbol fields`);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
        throw new TypeError(`Value at ${path}[${index}] is not JSON-safe`);
      }
      assertNoAliases(descriptor.value, `${path}[${index}]`, seen);
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`Value at ${path} must be a plain object`);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
      throw new TypeError(`Value at ${path}.${key} is not JSON-safe`);
    }
    assertNoAliases(descriptor.value, `${path}.${key}`, seen);
  }
}

function validateDraft(value: unknown, path: string): void {
  const draft = exactObject(
    value,
    path,
    ['senderId', 'recipientId', 'role', 'content'],
    ['replyTo', 'reasoning'],
  );
  requiredString(draft.senderId, `${path}.senderId`);
  requiredString(draft.recipientId, `${path}.recipientId`);
  if (draft.role !== 'user' && draft.role !== 'assistant') {
    throw new TypeError(`Value at ${path}.role must be user or assistant`);
  }
  requiredString(draft.content, `${path}.content`);
  for (const field of ['replyTo', 'reasoning']) {
    if (draft[field] !== undefined) requiredString(draft[field], `${path}.${field}`);
  }
}

function validateJsonObject(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Value at ${path} must be a non-array object`);
  }
  assertNoAliases(value, path);
}

function validateStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new TypeError(`Value at ${path} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    requiredString(value[index], `${path}[${index}]`);
  }
  assertNoAliases(value, path);
}

function validateUsage(value: unknown, path: string): void {
  const usage = exactObject(value, path, [
    'input',
    'output',
    'reasoning',
    'cache',
    'cost',
    'modelId',
    'providerId',
  ]);
  for (const field of ['input', 'output', 'reasoning', 'cost']) {
    if (typeof usage[field] !== 'number' || !Number.isFinite(usage[field])) {
      throw new TypeError(`Value at ${path}.${field} must be a finite number`);
    }
  }
  const cache = exactObject(usage.cache, `${path}.cache`, ['read', 'write']);
  for (const field of ['read', 'write']) {
    if (typeof cache[field] !== 'number' || !Number.isFinite(cache[field])) {
      throw new TypeError(`Value at ${path}.cache.${field} must be a finite number`);
    }
  }
  requiredString(usage.modelId, `${path}.modelId`);
  requiredString(usage.providerId, `${path}.providerId`);
}

function validateMessage(
  value: unknown,
  path: string,
  conversationId: string,
): Record<string, unknown> {
  const message = exactObject(
    value,
    path,
    [
      'id',
      'parentId',
      'conversationId',
      'senderId',
      'recipientId',
      'role',
      'content',
      'status',
      'timestamp',
    ],
    [
      'replyTo',
      'reasoning',
      'type',
      'toolCalls',
      'toolResults',
      'usage',
      'editOf',
      'supersededBy',
      'compacts',
      'prunedAt',
      'prunedBy',
    ],
  );
  for (const field of ['id', 'conversationId', 'senderId', 'recipientId']) {
    requiredString(message[field], `${path}.${field}`);
  }
  if (message.conversationId !== conversationId) {
    throw new TypeError(`Value at ${path}.conversationId must match checkpoint conversationId`);
  }
  if (typeof message.content !== 'string')
    throw new TypeError(`Value at ${path}.content must be a string`);
  requiredIsoString(message.timestamp, `${path}.timestamp`);
  if (message.parentId !== null && typeof message.parentId !== 'string') {
    throw new TypeError(`Value at ${path}.parentId must be string or null`);
  }
  if (typeof message.parentId === 'string') requiredString(message.parentId, `${path}.parentId`);
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw new TypeError(`Value at ${path}.role is invalid`);
  }
  if (!['active', 'superseded', 'pruned', 'compacted'].includes(message.status as string)) {
    throw new TypeError(`Value at ${path}.status is invalid`);
  }
  if (message.replyTo !== undefined) requiredString(message.replyTo, `${path}.replyTo`);
  if (message.reasoning !== undefined && typeof message.reasoning !== 'string') {
    throw new TypeError(`Value at ${path}.reasoning must be a string`);
  }
  if (message.type !== undefined && message.type !== 'message' && message.type !== 'summary') {
    throw new TypeError(`Value at ${path}.type is invalid`);
  }
  if (message.toolCalls !== undefined) {
    if (!Array.isArray(message.toolCalls))
      throw new TypeError(`Value at ${path}.toolCalls must be an array`);
    for (let index = 0; index < message.toolCalls.length; index += 1) {
      const call = exactObject(message.toolCalls[index], `${path}.toolCalls[${index}]`, [
        'id',
        'name',
        'arguments',
      ]);
      requiredString(call.id, `${path}.toolCalls[${index}].id`);
      requiredString(call.name, `${path}.toolCalls[${index}].name`);
      validateJsonObject(call.arguments, `${path}.toolCalls[${index}].arguments`);
    }
  }
  if (message.toolResults !== undefined) {
    if (!Array.isArray(message.toolResults)) {
      throw new TypeError(`Value at ${path}.toolResults must be an array`);
    }
    for (let index = 0; index < message.toolResults.length; index += 1) {
      const result = exactObject(message.toolResults[index], `${path}.toolResults[${index}]`, [
        'id',
        'name',
        'result',
      ]);
      requiredString(result.id, `${path}.toolResults[${index}].id`);
      requiredString(result.name, `${path}.toolResults[${index}].name`);
      validateToolResult(result.result, `${path}.toolResults[${index}].result`);
    }
  }
  if (message.usage !== undefined) validateUsage(message.usage, `${path}.usage`);
  for (const field of ['editOf', 'supersededBy', 'prunedBy']) {
    if (message[field] !== undefined) requiredString(message[field], `${path}.${field}`);
  }
  if (message.compacts !== undefined) validateStringArray(message.compacts, `${path}.compacts`);
  if (message.prunedAt !== undefined) requiredIsoString(message.prunedAt, `${path}.prunedAt`);
  assertNoAliases(message, path);
  return message;
}

function validateToolResult(value: unknown, path: string): void {
  const result = exactObject(value, path, ['status'], ['data', 'error', 'approvalId', 'message']);
  if (!['success', 'error', 'pending_approval', 'rejected'].includes(result.status as string)) {
    throw new TypeError(`Value at ${path}.status is invalid`);
  }
  if (result.data !== undefined) assertNoAliases(result.data, `${path}.data`);
  for (const field of ['error', 'approvalId', 'message']) {
    if (result[field] !== undefined && typeof result[field] !== 'string') {
      throw new TypeError(`Value at ${path}.${field} must be a string`);
    }
  }
  assertNoAliases(result, path);
}

function validateActions(value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new TypeError(`Value at ${path} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    const action = exactObject(
      value[index],
      `${path}[${index}]`,
      ['requestId', 'participantId', 'instanceId', 'tool', 'status'],
      ['result'],
    );
    for (const field of ['requestId', 'participantId', 'instanceId', 'tool']) {
      requiredString(action[field], `${path}[${index}].${field}`);
    }
    if (!['success', 'error', 'rejected'].includes(action.status as string)) {
      throw new TypeError(`Value at ${path}[${index}].status is invalid`);
    }
    if (action.result !== undefined) validateToolResult(action.result, `${path}[${index}].result`);
  }
  assertNoAliases(value, path);
}

function validateRuntimeResume(
  value: unknown,
  checkpoint: Record<string, unknown>,
  path: string,
): void {
  const resume = exactObject(value, path, [
    'kind',
    'participantId',
    'incomingMessageId',
    'iteration',
    'preparedPrompt',
    'actionCursor',
    'actions',
  ]);
  if (resume.kind !== 'agent_provider') throw new TypeError(`Value at ${path}.kind is invalid`);
  requiredString(resume.participantId, `${path}.participantId`);
  if (resume.participantId !== checkpoint.participantId) {
    throw new TypeError(`Value at ${path}.participantId must match checkpoint participantId`);
  }
  requiredString(resume.incomingMessageId, `${path}.incomingMessageId`);
  if (resume.incomingMessageId !== checkpoint.persistedMessageId) {
    throw new TypeError(
      `Value at ${path}.incomingMessageId must match checkpoint persistedMessageId`,
    );
  }
  requiredInteger(resume.iteration, `${path}.iteration`);
  requiredString(resume.preparedPrompt, `${path}.preparedPrompt`);
  if (requiredInteger(resume.actionCursor, `${path}.actionCursor`) !== checkpoint.actionCursor) {
    throw new TypeError(`Value at ${path}.actionCursor must match checkpoint actionCursor`);
  }
  validateActions(resume.actions, `${path}.actions`);
  if (!isDeepStrictEqual(resume.actions, checkpoint.actions)) {
    throw new TypeError(`Value at ${path}.actions must match checkpoint actions`);
  }
}

function validateCheckpoint(value: unknown): void {
  const checkpoint = exactObject(
    value,
    '$.continuation.checkpoint',
    [
      'checkpointId',
      'operationId',
      'conversationId',
      'phase',
      'participantId',
      'instanceId',
      'middlewareType',
      'middlewareRevision',
      'nextHookIndex',
      'actionCursor',
      'request',
      'actions',
      'observedHead',
      'createdAt',
    ],
    [
      'draft',
      'prompt',
      'message',
      'mode',
      'final',
      'iteration',
      'persistedMessageId',
      'runtimeResume',
    ],
  );
  for (const field of [
    'checkpointId',
    'operationId',
    'conversationId',
    'participantId',
    'instanceId',
    'middlewareType',
  ]) {
    requiredString(checkpoint[field], `$.continuation.checkpoint.${field}`);
  }
  if (typeof checkpoint.observedHead !== 'string') {
    throw new TypeError('Value at $.continuation.checkpoint.observedHead must be a string');
  }
  if (
    !['beforeSend', 'beforeReceive', 'afterReceive', 'buildSystemPrompt', 'afterSend'].includes(
      checkpoint.phase as string,
    )
  ) {
    throw new TypeError('Value at $.continuation.checkpoint.phase is invalid');
  }
  for (const field of ['middlewareRevision', 'nextHookIndex', 'actionCursor']) {
    requiredInteger(checkpoint[field], `$.continuation.checkpoint.${field}`);
  }
  requiredIsoString(checkpoint.createdAt, '$.continuation.checkpoint.createdAt');
  const request = exactObject(
    checkpoint.request,
    '$.continuation.checkpoint.request',
    ['requestId', 'tool', 'arguments'],
    ['stateOnSuccess'],
  );
  requiredString(request.requestId, '$.continuation.checkpoint.request.requestId');
  requiredString(request.tool, '$.continuation.checkpoint.request.tool');
  if (
    request.arguments === null ||
    typeof request.arguments !== 'object' ||
    Array.isArray(request.arguments)
  ) {
    throw new TypeError(
      'Value at $.continuation.checkpoint.request.arguments must be a non-array object',
    );
  }
  assertNoAliases(request.arguments, '$.continuation.checkpoint.request.arguments');
  if (request.stateOnSuccess !== undefined) {
    assertNoAliases(request.stateOnSuccess, '$.continuation.checkpoint.request.stateOnSuccess');
  }
  validateActions(checkpoint.actions, '$.continuation.checkpoint.actions');

  if (checkpoint.phase === 'beforeSend' || checkpoint.phase === 'beforeReceive') {
    for (const field of ['prompt', 'message', 'mode', 'persistedMessageId', 'runtimeResume']) {
      if (checkpoint[field] !== undefined) {
        throw new TypeError(
          `Value at $.continuation.checkpoint.${field} is invalid for message phase`,
        );
      }
    }
    validateDraft(checkpoint.draft, '$.continuation.checkpoint.draft');
    if (typeof checkpoint.final !== 'boolean') {
      throw new TypeError('Value at $.continuation.checkpoint.final must be boolean');
    }
    if (checkpoint.iteration !== undefined) {
      requiredInteger(checkpoint.iteration, '$.continuation.checkpoint.iteration');
    }
  } else if (checkpoint.phase === 'afterReceive') {
    for (const field of ['draft', 'prompt', 'final', 'iteration', 'runtimeResume']) {
      if (checkpoint[field] !== undefined) {
        throw new TypeError(
          `Value at $.continuation.checkpoint.${field} is invalid for afterReceive`,
        );
      }
    }
    const message = validateMessage(
      checkpoint.message,
      '$.continuation.checkpoint.message',
      checkpoint.conversationId as string,
    );
    if (checkpoint.mode !== 'pre_runtime' && checkpoint.mode !== 'post_response') {
      throw new TypeError('Value at $.continuation.checkpoint.mode is invalid');
    }
    if (
      checkpoint.persistedMessageId !== undefined &&
      checkpoint.persistedMessageId !== message.id
    ) {
      throw new TypeError(
        'Value at $.continuation.checkpoint.persistedMessageId must match message.id',
      );
    }
  } else if (checkpoint.phase === 'buildSystemPrompt') {
    for (const field of ['draft', 'message', 'mode', 'final', 'iteration']) {
      if (checkpoint[field] !== undefined) {
        throw new TypeError(
          `Value at $.continuation.checkpoint.${field} is invalid for buildSystemPrompt`,
        );
      }
    }
    requiredString(checkpoint.prompt, '$.continuation.checkpoint.prompt');
    requiredString(checkpoint.persistedMessageId, '$.continuation.checkpoint.persistedMessageId');
    if (checkpoint.runtimeResume !== undefined) {
      validateRuntimeResume(
        checkpoint.runtimeResume,
        checkpoint,
        '$.continuation.checkpoint.runtimeResume',
      );
    }
  } else {
    for (const field of ['draft', 'prompt', 'mode', 'final', 'iteration', 'runtimeResume']) {
      if (checkpoint[field] !== undefined) {
        throw new TypeError(`Value at $.continuation.checkpoint.${field} is invalid for afterSend`);
      }
    }
    const message = validateMessage(
      checkpoint.message,
      '$.continuation.checkpoint.message',
      checkpoint.conversationId as string,
    );
    if (checkpoint.persistedMessageId !== message.id) {
      throw new TypeError(
        'Value at $.continuation.checkpoint.persistedMessageId must match message.id',
      );
    }
  }
  assertNoAliases(checkpoint, '$.continuation.checkpoint');
}

function snapshotContinuation(
  value: ApprovalContinuation | undefined,
): ApprovalContinuation | undefined {
  if (value === undefined) return undefined;
  const continuation = exactObject(value, '$.continuation', ['kind', 'checkpoint']);
  if (continuation.kind !== 'middleware') {
    throw new TypeError('Approval continuation must be a middleware checkpoint');
  }
  validateCheckpoint(continuation.checkpoint);
  const cloned = cloneJsonSafe(continuation, '$.continuation') as ApprovalContinuation;
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
      record.lifecycle = 'decided';
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
    const stored = await storage.readJson<unknown>(STORAGE_KEY);
    if (stored !== null) registry.data = normalizeData(stored);
    if (recovery(registry.data)) await storage.writeJson(STORAGE_KEY, registry.data);
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
        if (record.resumeResult !== undefined) return { status: 'ready', record };
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
      record.lifecycle = 'decided';
      return undefined;
    });
  }

  async acknowledge(approvalId: string): Promise<void> {
    await this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      if (record.lifecycle === 'acknowledged') return undefined;
      if (record.lifecycle !== 'decided' || record.resumeResult === undefined) {
        throw new LegionError(
          `Approval request has no terminal resume result: ${approvalId}`,
          'APPROVAL_CONFLICT',
        );
      }
      record.lifecycle = 'acknowledged';
      delete record.continuation;
      return undefined;
    });
  }
}
