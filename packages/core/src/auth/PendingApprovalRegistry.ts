import { isDeepStrictEqual } from 'node:util';
import type {
  ConversationData,
  JSONValue,
  MessageData,
  MiddlewareActionResult,
  MiddlewareCheckpoint,
  ToolResult,
} from '@legion-collective/types';
import { LegionError } from '../errors/LegionError.js';
import { cloneJsonSafe } from '../middleware/json.js';
import type { Storage } from '../storage/Storage.js';
import { createId } from '../util/ids.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import { ConversationNotFoundError } from '../errors/LegionError.js';

export interface ApprovalDecision {
  approved: boolean;
  decidedByParticipantId: string;
  message?: string;
  decidedAt: string;
}

export type MiddlewareApprovalContinuation = {
  kind: 'middleware';
  checkpoint: MiddlewareCheckpoint;
};

export interface AutomationCompactionContinuation {
  kind: 'automation_compaction';
  parentConversationId: string;
  helperConversationId: string;
  participantId: string;
  middlewareInstanceId: string;
  middlewareRevision: number;
  middlewareType: string;
  middlewareConfig: JSONValue;
  observedParentHead: string;
  selectedMessages: MessageData[];
  parentMessageId: string;
  helperContinuation: MiddlewareApprovalContinuation;
  parentCheckpoint: MiddlewareCheckpoint;
}

export type AutomationCompactionSeed = Omit<
  AutomationCompactionContinuation,
  'kind' | 'helperContinuation'
>;

export type ApprovalContinuation =
  | MiddlewareApprovalContinuation
  | AutomationCompactionContinuation;

export interface AutomationCompactionState {
  lifecycle: 'waiting' | 'summary_ready' | 'parent_committed' | 'completed' | 'unknown';
  summary?: string;
  summaryMessageId?: string;
  parentHead?: string;
  parentExecution?: 'executing' | 'completed' | 'unknown';
}

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
  routerResult?: ApprovalRouterResult;
  successorApprovalId?: string;
  successorApprovalIds?: string[];
  providerExecution?: 'pending' | 'executing' | 'completed' | 'unknown';
  automationCompaction?: AutomationCompactionState;
}

export interface ApprovalRouterResult {
  conversationId: string;
  status: 'success' | 'error';
  response?: string;
  error?: string;
  partial?: boolean;
  storedMessageId?: string;
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

export interface MiddlewareActionInput {
  operationId: string;
  conversationId: string;
  participantId: string;
  instanceId: string;
  requestId: string;
  tool: string;
  args: unknown;
}

export interface MiddlewareActionRecord extends MiddlewareActionInput {
  lifecycle: 'executing' | 'suspended' | 'completed';
  result?: MiddlewareActionResult;
  createdAt: string;
}

export type MiddlewareActionClaim =
  | { kind: 'claimed' }
  | { kind: 'completed'; result: MiddlewareActionResult }
  | { kind: 'in_progress' };

interface RegistryData {
  records: Record<string, ApprovalRecord>;
  middlewareActions: Record<string, MiddlewareActionRecord>;
  genericResumes: Record<string, 'executing' | 'completed'>;
}

interface LegacyRegistryData {
  pending?: Record<string, PendingApproval>;
  decisions?: Record<string, ApprovalDecision>;
}

const STORAGE_KEY = 'pending-approvals/registry.json';
const INTERRUPTION_ERROR =
  'Interrupted middleware tool execution; outcome unknown and tool was not retried';
const ACTION_INTERRUPTION_ERROR = 'Middleware tool outcome unknown and tool was not retried';

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
  validateToolResult(value, '$.resumeResult');
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
  validateToolResult(cloned, '$.resumeResult');
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

/** Validate and detach middleware action ledgers crossing runtime boundaries. */
export function snapshotMiddlewareActions(
  value: unknown,
  path = '$.middlewareActions',
): MiddlewareActionResult[] {
  validateActions(value, path);
  return cloneJsonSafe(value, path) as MiddlewareActionResult[];
}

function snapshotMiddlewareActionInput(value: MiddlewareActionInput): MiddlewareActionInput {
  const input = exactObject(value, '$.middlewareAction', [
    'operationId',
    'conversationId',
    'participantId',
    'instanceId',
    'requestId',
    'tool',
    'args',
  ]);
  for (const field of [
    'operationId',
    'conversationId',
    'participantId',
    'instanceId',
    'requestId',
    'tool',
  ]) {
    requiredString(input[field], `$.middlewareAction.${field}`);
  }
  assertNoAliases(input.args, '$.middlewareAction.args');
  return cloneJsonSafe(input, '$.middlewareAction') as unknown as MiddlewareActionInput;
}

function middlewareActionKey(input: MiddlewareActionInput): string {
  return JSON.stringify([
    input.operationId,
    input.conversationId,
    input.participantId,
    input.instanceId,
    input.requestId,
  ]);
}

function genericResumeKey(conversationId: string, requesterId: string): string {
  requiredString(conversationId, 'genericResume.conversationId');
  requiredString(requesterId, 'genericResume.requesterId');
  return JSON.stringify([conversationId, requesterId]);
}

function unknownMiddlewareActionResult(input: MiddlewareActionInput): MiddlewareActionResult {
  return {
    requestId: input.requestId,
    participantId: input.participantId,
    instanceId: input.instanceId,
    tool: input.tool,
    status: 'error',
    result: { status: 'error', error: ACTION_INTERRUPTION_ERROR },
  };
}

function snapshotMiddlewareActionResult(value: MiddlewareActionResult): MiddlewareActionResult {
  validateActions([value], '$.middlewareAction.result');
  return cloneJsonSafe(value, '$.middlewareAction.result') as MiddlewareActionResult;
}

function validateActionResultForClaim(
  claim: MiddlewareActionInput,
  result: MiddlewareActionResult,
): void {
  if (
    result.requestId !== claim.requestId ||
    result.participantId !== claim.participantId ||
    result.instanceId !== claim.instanceId ||
    result.tool !== claim.tool
  ) {
    throw new TypeError('Middleware action terminal result must match claim identity');
  }
  if (result.result === undefined) {
    throw new TypeError('Middleware action terminal result requires ToolResult');
  }
  if (result.status === 'success' && result.result.status !== 'success') {
    throw new TypeError('Successful middleware action requires successful ToolResult');
  }
  if (result.status === 'error' && result.result.status !== 'error') {
    throw new TypeError('Errored middleware action requires error ToolResult');
  }
  if (result.status === 'rejected' && result.result.status !== 'rejected') {
    throw new TypeError('Rejected middleware action requires rejected ToolResult');
  }
}

function snapshotMiddlewareActionRecord(value: MiddlewareActionRecord): MiddlewareActionRecord {
  const record = exactObject(
    value,
    '$.middlewareActionRecord',
    [
      'operationId',
      'conversationId',
      'participantId',
      'instanceId',
      'requestId',
      'tool',
      'args',
      'lifecycle',
      'createdAt',
    ],
    ['result'],
  );
  const input = snapshotMiddlewareActionInput({
    operationId: record.operationId as string,
    conversationId: record.conversationId as string,
    participantId: record.participantId as string,
    instanceId: record.instanceId as string,
    requestId: record.requestId as string,
    tool: record.tool as string,
    args: record.args,
  });
  if (
    record.lifecycle !== 'executing' &&
    record.lifecycle !== 'suspended' &&
    record.lifecycle !== 'completed'
  ) {
    throw new TypeError('Middleware action lifecycle is invalid');
  }
  requiredIsoString(record.createdAt, '$.middlewareActionRecord.createdAt');
  if (record.lifecycle === 'completed' && record.result === undefined) {
    throw new TypeError('Completed middleware action requires result');
  }
  if (record.lifecycle !== 'completed' && record.result !== undefined) {
    throw new TypeError('Non-terminal middleware action may not have result');
  }
  const result =
    record.result === undefined
      ? undefined
      : snapshotMiddlewareActionResult(record.result as MiddlewareActionResult);
  if (record.lifecycle === 'completed') validateActionResultForClaim(input, result!);
  return {
    ...input,
    lifecycle: record.lifecycle,
    createdAt: record.createdAt as string,
    ...(result === undefined ? {} : { result }),
  };
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
      'middlewareConfig',
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
  if (checkpoint.middlewareConfig !== undefined) {
    cloneJsonSafe(checkpoint.middlewareConfig, '$.continuation.checkpoint.middlewareConfig');
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
  const actions = checkpoint.actions as MiddlewareActionResult[];
  if (checkpoint.actionCursor !== actions.length) {
    throw new TypeError(
      'Value at $.continuation.checkpoint.actionCursor must equal actions.length',
    );
  }
  const actionRequestIds = new Set<string>();
  for (const action of actions) {
    if (actionRequestIds.has(action.requestId)) {
      throw new TypeError('Value at $.continuation.checkpoint.actions has duplicate requestId');
    }
    actionRequestIds.add(action.requestId);
  }
  if (actions.some((action) => action.requestId === request.requestId)) {
    throw new TypeError(
      'Value at $.continuation.checkpoint.request.requestId must not collide with actions',
    );
  }

  if (checkpoint.phase === 'beforeSend' || checkpoint.phase === 'beforeReceive') {
    for (const field of ['prompt', 'message', 'persistedMessageId', 'runtimeResume']) {
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
    if (
      checkpoint.mode !== undefined &&
      checkpoint.mode !== 'pre_runtime' &&
      checkpoint.mode !== 'post_response'
    ) {
      throw new TypeError('Value at $.continuation.checkpoint.mode is invalid');
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
    for (const field of ['draft', 'prompt', 'final', 'iteration', 'runtimeResume']) {
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
    if (
      checkpoint.mode !== undefined &&
      checkpoint.mode !== 'pre_runtime' &&
      checkpoint.mode !== 'post_response'
    ) {
      throw new TypeError('Value at $.continuation.checkpoint.mode is invalid');
    }
  }
  assertNoAliases(checkpoint, '$.continuation.checkpoint');
}

function snapshotContinuation(
  value: ApprovalContinuation | undefined,
): ApprovalContinuation | undefined {
  if (value === undefined) return undefined;
  if (value.kind === 'middleware') {
    const continuation = exactObject(value, '$.continuation', ['kind', 'checkpoint']);
    validateCheckpoint(continuation.checkpoint);
    const cloned = cloneJsonSafe(continuation, '$.continuation') as MiddlewareApprovalContinuation;
    requiredString(cloned.checkpoint.checkpointId, 'continuation.checkpoint.checkpointId');
    requiredString(cloned.checkpoint.conversationId, 'continuation.checkpoint.conversationId');
    return cloned;
  }
  const continuation = exactObject(value, '$.continuation', [
    'kind',
    'parentConversationId',
    'helperConversationId',
    'participantId',
    'middlewareInstanceId',
    'middlewareRevision',
    'middlewareType',
    'middlewareConfig',
    'observedParentHead',
    'selectedMessages',
    'parentMessageId',
    'helperContinuation',
    'parentCheckpoint',
  ]);
  if (continuation.kind !== 'automation_compaction') {
    throw new TypeError('Approval continuation kind is invalid');
  }
  for (const field of [
    'parentConversationId',
    'helperConversationId',
    'participantId',
    'middlewareInstanceId',
    'middlewareType',
    'observedParentHead',
    'parentMessageId',
  ]) {
    requiredString(continuation[field], `$.continuation.${field}`);
  }
  requiredInteger(continuation.middlewareRevision, '$.continuation.middlewareRevision');
  cloneJsonSafe(continuation.middlewareConfig, '$.continuation.middlewareConfig');
  if (!Array.isArray(continuation.selectedMessages) || continuation.selectedMessages.length === 0) {
    throw new TypeError('Automation compaction selectedMessages must be a non-empty array');
  }
  const selected = continuation.selectedMessages.map((message, index) =>
    validateMessage(
      message,
      `$.continuation.selectedMessages[${index}]`,
      continuation.parentConversationId as string,
    ),
  );
  if (selected.at(-1)?.id !== continuation.parentMessageId) {
    throw new TypeError('Automation compaction parentMessageId must match selected prefix');
  }
  const helper = snapshotContinuation(
    continuation.helperContinuation as MiddlewareApprovalContinuation,
  );
  if (helper?.kind !== 'middleware') {
    throw new TypeError('Automation compaction helper continuation must be middleware');
  }
  validateCheckpoint(continuation.parentCheckpoint);
  const parentCheckpoint = continuation.parentCheckpoint as MiddlewareCheckpoint;
  if (
    parentCheckpoint.conversationId !== continuation.parentConversationId ||
    parentCheckpoint.participantId !== continuation.participantId ||
    parentCheckpoint.instanceId !== continuation.middlewareInstanceId ||
    parentCheckpoint.middlewareRevision !== continuation.middlewareRevision ||
    parentCheckpoint.middlewareType !== continuation.middlewareType ||
    !isDeepStrictEqual(parentCheckpoint.middlewareConfig, continuation.middlewareConfig)
  ) {
    throw new TypeError('Automation compaction parent checkpoint does not match snapshot');
  }
  return cloneJsonSafe(
    continuation,
    '$.continuation',
  ) as unknown as AutomationCompactionContinuation;
}

function validateContinuationBinding(
  input: PendingApprovalInput,
  continuation: ApprovalContinuation,
): void {
  if (continuation.kind === 'automation_compaction') {
    const helper = continuation.helperContinuation.checkpoint;
    if (
      helper.conversationId !== input.conversationId ||
      helper.participantId !== input.requesterId ||
      helper.request.tool !== input.tool ||
      !isDeepStrictEqual(helper.request.arguments, input.args) ||
      continuation.helperConversationId !== input.conversationId
    ) {
      throw new TypeError('Automation helper continuation must match approval');
    }
    return;
  }
  const checkpoint = continuation.checkpoint;
  if (checkpoint.conversationId !== input.conversationId) {
    throw new TypeError('Middleware checkpoint conversationId must match approval conversationId');
  }
  if (checkpoint.participantId !== input.requesterId) {
    throw new TypeError('Middleware checkpoint participantId must match approval requesterId');
  }
  if (checkpoint.request.tool !== input.tool) {
    throw new TypeError('Middleware checkpoint request tool must match approval tool');
  }
  if (!isDeepStrictEqual(checkpoint.request.arguments, input.args)) {
    throw new TypeError('Middleware checkpoint request arguments must match approval args');
  }
}

function snapshotInput(input: PendingApprovalInput): PendingApprovalInput {
  const cloned = snapshotOptionalFields(
    input,
    '$.input',
    new Set(['continuation']),
  ) as PendingApprovalInput;
  const snapshot = {
    conversationId: requiredString(cloned.conversationId, 'conversationId'),
    requesterId: requiredString(cloned.requesterId, 'requesterId'),
    tool: requiredString(cloned.tool, 'tool'),
    args: cloneJsonSafe(cloned.args, '$.input.args'),
    ...(cloned.continuation === undefined
      ? {}
      : { continuation: snapshotContinuation(cloned.continuation) }),
  };
  if (snapshot.continuation) validateContinuationBinding(snapshot, snapshot.continuation);
  return snapshot;
}

function snapshotRecord(value: ApprovalRecord): ApprovalRecord {
  const cloned = cloneJsonSafe(value, '$.record') as ApprovalRecord;
  if (!['pending', 'decided', 'resuming', 'acknowledged'].includes(cloned.lifecycle)) {
    throw new TypeError('Pending approval lifecycle is invalid');
  }
  const record = {
    ...snapshotInput(cloned),
    approvalId: requiredString(cloned.approvalId, 'approvalId'),
    createdAt: requiredString(cloned.createdAt, 'createdAt'),
    lifecycle: cloned.lifecycle,
    ...(cloned.decision === undefined ? {} : { decision: snapshotDecision(cloned.decision) }),
    ...(cloned.resumeResult === undefined
      ? {}
      : { resumeResult: snapshotResult(cloned.resumeResult) }),
    ...(cloned.routerResult === undefined
      ? {}
      : { routerResult: snapshotRouterResult(cloned.routerResult) }),
    ...(cloned.successorApprovalId === undefined
      ? {}
      : { successorApprovalId: requiredString(cloned.successorApprovalId, 'successorApprovalId') }),
    ...(cloned.successorApprovalIds === undefined
      ? {}
      : {
          successorApprovalIds: (() => {
            if (!Array.isArray(cloned.successorApprovalIds)) {
              throw new TypeError('Approval successorApprovalIds must be an array');
            }
            const ids = cloned.successorApprovalIds.map((id, index) =>
              requiredString(id, `successorApprovalIds[${index}]`),
            );
            if (new Set(ids).size !== ids.length) {
              throw new TypeError('Approval successorApprovalIds must be unique');
            }
            return ids;
          })(),
        }),
    ...(cloned.providerExecution === undefined
      ? {}
      : { providerExecution: cloned.providerExecution }),
    ...(cloned.automationCompaction === undefined
      ? {}
      : { automationCompaction: snapshotAutomationState(cloned.automationCompaction) }),
  };
  if (
    record.providerExecution !== undefined &&
    !['pending', 'executing', 'completed', 'unknown'].includes(record.providerExecution)
  ) {
    throw new TypeError('Approval provider execution lifecycle is invalid');
  }
  if (
    record.lifecycle === 'pending' &&
    (record.decision !== undefined || record.resumeResult !== undefined)
  ) {
    throw new TypeError('Pending approval record may not have decision or resumeResult');
  }
  if (record.lifecycle === 'decided' && record.decision === undefined) {
    throw new TypeError('Decided approval record requires decision');
  }
  if (record.lifecycle === 'resuming') {
    if (
      record.decision === undefined ||
      record.resumeResult !== undefined ||
      !record.continuation
    ) {
      throw new TypeError(
        'Resuming approval record requires decision and continuation without resumeResult',
      );
    }
  }
  if (record.lifecycle === 'acknowledged') {
    if (record.decision === undefined || record.resumeResult === undefined || record.continuation) {
      throw new TypeError(
        'Acknowledged approval record requires terminal result without continuation',
      );
    }
  }
  if (
    record.resumeResult !== undefined &&
    !record.continuation &&
    record.lifecycle !== 'acknowledged'
  ) {
    throw new TypeError('Approval resumeResult requires middleware continuation');
  }
  const automationContinuation = record.continuation?.kind === 'automation_compaction';
  if (
    record.lifecycle !== 'acknowledged' &&
    automationContinuation !== !!record.automationCompaction
  ) {
    throw new TypeError('Automation compaction continuation and state must coexist');
  }
  if (
    record.lifecycle === 'pending' &&
    record.automationCompaction?.lifecycle !== undefined &&
    record.automationCompaction.lifecycle !== 'waiting'
  ) {
    throw new TypeError('Pending automation compaction must be waiting');
  }
  if (
    record.automationCompaction?.lifecycle === 'completed' &&
    record.routerResult === undefined &&
    record.successorApprovalId === undefined &&
    record.successorApprovalIds === undefined
  ) {
    throw new TypeError('Completed automation compaction requires terminal routing data');
  }
  if (
    record.automationCompaction?.lifecycle === 'unknown' &&
    (record.routerResult?.status !== 'error' || record.lifecycle === 'pending')
  ) {
    throw new TypeError('Unknown automation compaction requires terminal router error');
  }
  if (record.automationCompaction && record.routerResult && record.resumeResult === undefined) {
    throw new TypeError('Automation compaction router result requires terminal resume result');
  }
  if (
    record.lifecycle === 'acknowledged' &&
    record.automationCompaction?.lifecycle === 'parent_committed'
  ) {
    throw new TypeError('Acknowledged automation compaction must be terminal');
  }
  if (
    record.automationCompaction &&
    (record.successorApprovalIds?.length === 0 ||
      (record.successorApprovalId !== undefined &&
        record.successorApprovalIds !== undefined &&
        record.successorApprovalIds[0] !== record.successorApprovalId))
  ) {
    throw new TypeError('Automation compaction successor linkage is invalid');
  }
  return record;
}

function snapshotAutomationState(value: AutomationCompactionState): AutomationCompactionState {
  const state = exactObject(
    value,
    '$.automationCompaction',
    ['lifecycle'],
    ['summary', 'summaryMessageId', 'parentHead', 'parentExecution'],
  );
  if (
    !['waiting', 'summary_ready', 'parent_committed', 'completed', 'unknown'].includes(
      state.lifecycle as string,
    )
  ) {
    throw new TypeError('Automation compaction lifecycle is invalid');
  }
  if (state.summary !== undefined) requiredString(state.summary, '$.automationCompaction.summary');
  if (state.summaryMessageId !== undefined) {
    requiredString(state.summaryMessageId, '$.automationCompaction.summaryMessageId');
  }
  if (state.parentHead !== undefined) {
    requiredString(state.parentHead, '$.automationCompaction.parentHead');
  }
  if (
    state.parentExecution !== undefined &&
    !['executing', 'completed', 'unknown'].includes(state.parentExecution as string)
  ) {
    throw new TypeError('Automation parent execution lifecycle is invalid');
  }
  const hasSummary = state.summary !== undefined;
  const hasCommit = state.summaryMessageId !== undefined && state.parentHead !== undefined;
  const hasPartialCommit = state.summaryMessageId !== undefined || state.parentHead !== undefined;
  const valid =
    (state.lifecycle === 'waiting' &&
      !hasSummary &&
      !hasPartialCommit &&
      state.parentExecution === undefined) ||
    (state.lifecycle === 'summary_ready' &&
      hasSummary &&
      !hasPartialCommit &&
      state.parentExecution === undefined) ||
    (state.lifecycle === 'parent_committed' &&
      hasSummary &&
      hasCommit &&
      state.parentExecution !== 'unknown') ||
    (state.lifecycle === 'completed' &&
      hasSummary &&
      hasCommit &&
      state.parentExecution === 'completed') ||
    (state.lifecycle === 'unknown' &&
      ((!hasSummary && !hasPartialCommit && state.parentExecution === undefined) ||
        (hasSummary && hasCommit && state.parentExecution === 'unknown')));
  if (!valid) {
    throw new TypeError('Automation compaction lifecycle fields are inconsistent');
  }
  return cloneJsonSafe(state, '$.automationCompaction') as unknown as AutomationCompactionState;
}

function snapshotRouterResult(value: ApprovalRouterResult): ApprovalRouterResult {
  const result = exactObject(
    value,
    '$.routerResult',
    ['conversationId', 'status'],
    ['response', 'error', 'partial', 'storedMessageId'],
  );
  requiredString(result.conversationId, '$.routerResult.conversationId');
  if (result.status !== 'success' && result.status !== 'error') {
    throw new TypeError('Approval router result status is invalid');
  }
  if (result.response !== undefined && typeof result.response !== 'string') {
    throw new TypeError('Approval router result response must be a string');
  }
  if (result.error !== undefined) requiredString(result.error, '$.routerResult.error');
  if (result.partial !== undefined && typeof result.partial !== 'boolean') {
    throw new TypeError('Approval router result partial is invalid');
  }
  if (result.storedMessageId !== undefined) {
    requiredString(result.storedMessageId, '$.routerResult.storedMessageId');
  }
  return cloneJsonSafe(result, '$.routerResult') as unknown as ApprovalRouterResult;
}

function normalizeData(value: unknown): RegistryData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Pending approval registry must be an object');
  }
  const data = cloneJsonSafe(value, '$.registry') as RegistryData & LegacyRegistryData;
  if (Object.hasOwn(data, 'records')) {
    const canonical = exactObject(
      data,
      '$.registry',
      ['records'],
      ['middlewareActions', 'genericResumes'],
    );
    if (
      data.records === null ||
      typeof data.records !== 'object' ||
      Array.isArray(data.records) ||
      (Object.getPrototypeOf(data.records) !== Object.prototype &&
        Object.getPrototypeOf(data.records) !== null)
    ) {
      throw new TypeError('Pending approval registry records must be a plain object');
    }
    const middlewareActions = canonical.middlewareActions ?? {};
    if (
      middlewareActions === null ||
      typeof middlewareActions !== 'object' ||
      Array.isArray(middlewareActions) ||
      (Object.getPrototypeOf(middlewareActions) !== Object.prototype &&
        Object.getPrototypeOf(middlewareActions) !== null)
    ) {
      throw new TypeError('Pending approval registry middlewareActions must be a plain object');
    }
    const genericResumes = canonical.genericResumes ?? {};
    if (
      genericResumes === null ||
      typeof genericResumes !== 'object' ||
      Array.isArray(genericResumes) ||
      (Object.getPrototypeOf(genericResumes) !== Object.prototype &&
        Object.getPrototypeOf(genericResumes) !== null) ||
      Object.values(genericResumes).some((state) => state !== 'executing' && state !== 'completed')
    ) {
      throw new TypeError('Pending approval registry genericResumes must be a valid plain object');
    }
    const records = Object.fromEntries(
      Object.entries(data.records).map(([approvalId, record]) => [
        approvalId,
        snapshotRecord(record),
      ]),
    );
    for (const record of Object.values(records)) {
      if (!record.automationCompaction) continue;
      const successors =
        record.successorApprovalIds ??
        (record.successorApprovalId === undefined ? [] : [record.successorApprovalId]);
      if (successors.some((approvalId) => records[approvalId] === undefined)) {
        throw new TypeError('Automation compaction successor linkage is invalid');
      }
    }
    return {
      records,
      middlewareActions: Object.fromEntries(
        Object.entries(middlewareActions).map(([key, action]) => [
          key,
          snapshotMiddlewareActionRecord(action),
        ]),
      ),
      genericResumes: cloneJsonSafe(genericResumes, '$.registry.genericResumes') as Record<
        string,
        'executing' | 'completed'
      >,
    };
  }
  const legacy = exactObject(data, '$.registry', ['pending', 'decisions']);
  if (
    legacy.pending === null ||
    typeof legacy.pending !== 'object' ||
    Array.isArray(legacy.pending) ||
    legacy.decisions === null ||
    typeof legacy.decisions !== 'object' ||
    Array.isArray(legacy.decisions)
  ) {
    throw new TypeError('Legacy pending approval registry maps must be plain objects');
  }
  const records: Record<string, ApprovalRecord> = {};
  for (const [approvalId, pending] of Object.entries(legacy.pending)) {
    const decision = (legacy.decisions as Record<string, ApprovalDecision>)[approvalId];
    records[approvalId] = snapshotRecord({
      ...pending,
      approvalId,
      lifecycle: decision ? 'decided' : 'pending',
      ...(decision ? { decision } : {}),
    });
  }
  return { records, middlewareActions: {}, genericResumes: {} };
}

function recovery(data: RegistryData): boolean {
  let changed = false;
  for (const record of Object.values(data.records)) {
    if (
      record.lifecycle === 'resuming' &&
      record.continuation?.kind === 'automation_compaction' &&
      record.automationCompaction?.lifecycle === 'waiting' &&
      record.providerExecution !== 'executing'
    ) {
      record.lifecycle = 'decided';
      changed = true;
    }
    if (
      record.lifecycle === 'resuming' &&
      record.continuation?.kind === 'middleware' &&
      record.resumeResult === undefined
    ) {
      record.resumeResult = { status: 'error', error: INTERRUPTION_ERROR };
      record.lifecycle = 'decided';
      changed = true;
    }
    if (record.providerExecution === 'executing') {
      record.providerExecution = 'unknown';
      if (record.automationCompaction) record.automationCompaction.lifecycle = 'unknown';
      record.routerResult = {
        conversationId:
          record.continuation?.kind === 'automation_compaction'
            ? record.continuation.parentConversationId
            : record.conversationId,
        status: 'error',
        error:
          record.continuation?.kind === 'automation_compaction'
            ? 'Automation summary provider outcome unknown and was not retried'
            : 'Middleware provider outcome unknown and was not retried',
      };
      changed = true;
    }
    if (record.automationCompaction?.parentExecution === 'executing') {
      record.automationCompaction.parentExecution = 'unknown';
      record.automationCompaction.lifecycle = 'unknown';
      record.routerResult = {
        conversationId:
          record.continuation?.kind === 'automation_compaction'
            ? record.continuation.parentConversationId
            : record.conversationId,
        status: 'error',
        error: 'Automation parent provider outcome unknown and was not retried',
      };
      changed = true;
    }
  }
  for (const action of Object.values(data.middlewareActions)) {
    if (action.lifecycle === 'executing') {
      action.lifecycle = 'completed';
      action.result = unknownMiddlewareActionResult(action);
      changed = true;
    }
  }
  for (const approvalId of Object.keys(data.genericResumes)) {
    if (data.genericResumes[approvalId] === 'executing') {
      data.genericResumes[approvalId] = 'completed';
      changed = true;
    }
  }
  return changed;
}

function matchesAutomationHelper(
  helper: ConversationData,
  continuation: AutomationCompactionContinuation,
): boolean {
  return (
    helper.origin?.kind === 'middleware' &&
    helper.origin.participantId === continuation.participantId &&
    helper.origin.middlewareInstanceId === continuation.middlewareInstanceId &&
    helper.origin.parentConversationId === continuation.parentConversationId &&
    helper.origin.parentMessageId === continuation.parentMessageId
  );
}

export async function archiveAutomationHelper(
  conversationStore: ConversationStore,
  continuation: AutomationCompactionContinuation,
): Promise<boolean> {
  let archived = false;
  try {
    await conversationStore.mutate(continuation.helperConversationId, (helper) => {
      if (!matchesAutomationHelper(helper, continuation)) return helper;
      archived = true;
      return helper.status === 'archived' ? helper : { ...helper, status: 'archived' };
    });
  } catch (error) {
    if (!(error instanceof ConversationNotFoundError)) throw error;
  }
  return archived;
}

export class PendingApprovalRegistry {
  private data: RegistryData = { records: {}, middlewareActions: {}, genericResumes: {} };
  private mutations: Promise<void> = Promise.resolve();

  constructor(private readonly storage?: Storage) {}

  static async load(storage: Storage): Promise<PendingApprovalRegistry> {
    const registry = new PendingApprovalRegistry(storage);
    const stored = await storage.readJson<unknown>(STORAGE_KEY);
    const upgradeRecordsOnly =
      stored !== null &&
      typeof stored === 'object' &&
      !Array.isArray(stored) &&
      Object.hasOwn(stored, 'records') &&
      !Object.hasOwn(stored, 'middlewareActions');
    if (stored !== null) registry.data = normalizeData(stored);
    if (upgradeRecordsOnly || recovery(registry.data))
      await storage.writeJson(STORAGE_KEY, registry.data);
    return registry;
  }

  async reconcileAutomationHelpers(conversationStore: ConversationStore): Promise<void> {
    const continuations = Object.values(this.data.records)
      .filter(
        (record) =>
          record.automationCompaction?.lifecycle === 'unknown' &&
          record.continuation?.kind === 'automation_compaction',
      )
      .map((record) => record.continuation as AutomationCompactionContinuation);
    for (const continuation of continuations) {
      await archiveAutomationHelper(conversationStore, continuation);
    }
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

  async withAutomationCompactionLock<T>(
    approvalId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.storage) return operation();
    return this.storage.withLock(`${STORAGE_KEY}:${approvalId}:automation`, async () => {
      await this.mutate(() => undefined);
      return operation();
    });
  }

  async create(
    input: PendingApprovalInput,
    automationCompactionSeed?: AutomationCompactionSeed,
  ): Promise<{ approvalId: string }> {
    const snapshot = snapshotInput(input);
    if (automationCompactionSeed !== undefined) {
      if (snapshot.continuation?.kind !== 'middleware') {
        throw new TypeError('Automation compaction seed requires middleware continuation');
      }
      const continuation = snapshotContinuation({
        ...automationCompactionSeed,
        kind: 'automation_compaction',
        helperContinuation: snapshot.continuation,
      });
      if (continuation?.kind !== 'automation_compaction') {
        throw new TypeError('Automation compaction continuation is required');
      }
      validateContinuationBinding(snapshot, continuation);
      snapshot.continuation = continuation;
    }
    return this.mutate((data) => {
      const approvalId = createId('appr');
      data.records[approvalId] = {
        ...snapshot,
        approvalId,
        createdAt: new Date().toISOString(),
        lifecycle: 'pending',
        ...(snapshot.continuation?.kind === 'automation_compaction'
          ? { automationCompaction: { lifecycle: 'waiting' as const } }
          : {}),
      };
      if (snapshot.continuation?.kind === 'automation_compaction') {
        const checkpoint = snapshot.continuation.parentCheckpoint;
        const action =
          data.middlewareActions[
            middlewareActionKey({
              operationId: checkpoint.operationId,
              conversationId: checkpoint.conversationId,
              participantId: checkpoint.participantId,
              instanceId: checkpoint.instanceId,
              requestId: checkpoint.request.requestId,
              tool: checkpoint.request.tool,
              args: checkpoint.request.arguments,
            })
          ];
        if (action?.lifecycle === 'completed') {
          throw new LegionError('Automation parent action already completed', 'APPROVAL_CONFLICT');
        }
        if (action) action.lifecycle = 'suspended';
      }
      return { approvalId };
    });
  }

  async transferAutomationCompaction(
    approvalId: string,
    successorApprovalIds: string[],
  ): Promise<void> {
    if (successorApprovalIds.length === 0) return;
    await this.mutate((data) => {
      const source = data.records[approvalId];
      if (source?.continuation?.kind !== 'automation_compaction') {
        throw new LegionError(
          'Automation compaction continuation unavailable',
          'APPROVAL_CONFLICT',
        );
      }
      for (const successorApprovalId of successorApprovalIds) {
        const successor = data.records[successorApprovalId];
        if (!successor || successor.lifecycle !== 'pending' || !successor.continuation) {
          throw new LegionError('Automation compaction successor is invalid', 'APPROVAL_CONFLICT');
        }
        if (successor.continuation.kind === 'automation_compaction') {
          const { helperContinuation: _sourceHelper, ...sourceSeed } = source.continuation;
          const { helperContinuation: _successorHelper, ...successorSeed } = successor.continuation;
          if (
            !isDeepStrictEqual(sourceSeed, successorSeed) ||
            successor.automationCompaction?.lifecycle !== 'waiting'
          ) {
            throw new LegionError(
              'Automation compaction successor is invalid',
              'APPROVAL_CONFLICT',
            );
          }
          continue;
        }
        const continuation = snapshotContinuation({
          ...source.continuation,
          helperContinuation: successor.continuation,
        });
        if (continuation?.kind !== 'automation_compaction') {
          throw new LegionError('Automation compaction successor is invalid', 'APPROVAL_CONFLICT');
        }
        validateContinuationBinding(successor, continuation);
        successor.continuation = continuation;
        successor.automationCompaction = { lifecycle: 'waiting' };
      }
      const existing =
        source.successorApprovalIds ??
        (source.successorApprovalId === undefined ? [] : [source.successorApprovalId]);
      const merged = [...existing, ...successorApprovalIds.filter((id) => !existing.includes(id))];
      source.successorApprovalIds = merged;
      source.successorApprovalId = merged[0];
      if (source.providerExecution === 'executing') source.providerExecution = 'completed';
      if (source.lifecycle === 'resuming') {
        source.resumeResult = { status: 'success', data: { successorApprovalIds: merged } };
        source.lifecycle = 'decided';
      }
      return undefined;
    });
  }

  async recordAutomationSummary(approvalId: string, summary: string): Promise<void> {
    const snapshot = requiredString(summary, 'automation summary');
    await this.mutate((data) => {
      const record = data.records[approvalId];
      const state = record?.automationCompaction;
      if (!record || record.continuation?.kind !== 'automation_compaction' || !state) {
        throw new LegionError(
          'Automation compaction continuation unavailable',
          'APPROVAL_CONFLICT',
        );
      }
      if (state.summary !== undefined && state.summary !== snapshot) {
        throw new LegionError('Conflicting automation compaction summary', 'APPROVAL_CONFLICT');
      }
      state.summary = snapshot;
      if (record.providerExecution === 'executing') record.providerExecution = 'completed';
      if (state.lifecycle === 'waiting') state.lifecycle = 'summary_ready';
      return undefined;
    });
  }

  async recordAutomationParentCommitted(
    approvalId: string,
    summaryMessageId: string,
    parentHead: string,
  ): Promise<void> {
    const snapshot = requiredString(summaryMessageId, 'automation summaryMessageId');
    const headSnapshot = requiredString(parentHead, 'automation parentHead');
    await this.mutate((data) => {
      const state = data.records[approvalId]?.automationCompaction;
      if (!state || state.summary === undefined) {
        throw new LegionError('Automation compaction summary is unavailable', 'APPROVAL_CONFLICT');
      }
      if (state.summaryMessageId !== undefined && state.summaryMessageId !== snapshot) {
        throw new LegionError('Conflicting automation compaction commit', 'APPROVAL_CONFLICT');
      }
      if (state.parentHead !== undefined && state.parentHead !== headSnapshot) {
        throw new LegionError('Conflicting automation compaction parent head', 'APPROVAL_CONFLICT');
      }
      state.summaryMessageId = snapshot;
      state.parentHead = headSnapshot;
      if (state.lifecycle !== 'completed') state.lifecycle = 'parent_committed';
      return undefined;
    });
  }

  async completeAutomationCompaction(approvalId: string): Promise<void> {
    await this.mutate((data) => {
      const state = data.records[approvalId]?.automationCompaction;
      if (
        !state ||
        state.lifecycle !== 'parent_committed' ||
        !state.summaryMessageId ||
        state.parentExecution !== 'completed'
      ) {
        throw new LegionError('Automation compaction parent is not committed', 'APPROVAL_CONFLICT');
      }
      state.lifecycle = 'completed';
      return undefined;
    });
  }

  async terminalizeAutomationSuccess(
    approvalId: string,
    options: {
      routerResult?: ApprovalRouterResult;
      successorApprovalIds?: string[];
    },
  ): Promise<void> {
    const routerResult =
      options.routerResult === undefined ? undefined : snapshotRouterResult(options.routerResult);
    const successorApprovalIds = options.successorApprovalIds?.map((id, index) =>
      requiredString(id, `successorApprovalIds[${index}]`),
    );
    if (successorApprovalIds && successorApprovalIds.length === 0) {
      throw new LegionError('Automation terminal successors are empty', 'APPROVAL_CONFLICT');
    }
    await this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      if (record.lifecycle === 'acknowledged') return undefined;
      const state = record.automationCompaction;
      if (
        record.lifecycle !== 'decided' ||
        record.resumeResult === undefined ||
        record.continuation?.kind !== 'automation_compaction' ||
        !state ||
        (state.lifecycle !== 'parent_committed' && state.lifecycle !== 'completed')
      ) {
        throw new LegionError('Automation success cannot be terminalized', 'APPROVAL_CONFLICT');
      }
      if (routerResult !== undefined) {
        if (record.routerResult && !isDeepStrictEqual(record.routerResult, routerResult)) {
          throw new LegionError('Conflicting approval router result', 'APPROVAL_CONFLICT');
        }
        record.routerResult = routerResult;
      }
      if (successorApprovalIds !== undefined) {
        if (new Set(successorApprovalIds).size !== successorApprovalIds.length) {
          throw new LegionError('Duplicate approval successors', 'APPROVAL_CONFLICT');
        }
        for (const successorApprovalId of successorApprovalIds) {
          if (!data.records[successorApprovalId]) {
            throw new LegionError(
              `Unknown approval request: ${successorApprovalId}`,
              'APPROVAL_NOT_FOUND',
            );
          }
        }
        record.successorApprovalIds = successorApprovalIds;
        record.successorApprovalId = successorApprovalIds[0];
      }
      const linkedSuccessors =
        record.successorApprovalIds ??
        (record.successorApprovalId === undefined ? [] : [record.successorApprovalId]);
      if (record.routerResult === undefined && linkedSuccessors.length === 0) {
        throw new LegionError(
          'Automation terminal routing data is unavailable',
          'APPROVAL_CONFLICT',
        );
      }
      if (state.parentExecution !== 'completed' && state.parentExecution !== 'executing') {
        throw new LegionError('Automation parent execution is not terminal', 'APPROVAL_CONFLICT');
      }
      state.parentExecution = 'completed';
      state.lifecycle = 'completed';
      record.lifecycle = 'acknowledged';
      delete record.continuation;
      return undefined;
    });
  }

  async claimAutomationParentExecution(
    approvalId: string,
  ): Promise<'claimed' | 'completed' | 'unknown'> {
    return this.mutate((data) => {
      const record = data.records[approvalId];
      const state = record?.automationCompaction;
      if (!state || state.lifecycle !== 'parent_committed') {
        throw new LegionError('Automation parent continuation unavailable', 'APPROVAL_CONFLICT');
      }
      if (state.parentExecution === 'completed' || record.routerResult) return 'completed';
      if (state.parentExecution === 'unknown') return 'unknown';
      if (state.parentExecution === 'executing') {
        state.parentExecution = 'unknown';
        return 'unknown';
      }
      state.parentExecution = 'executing';
      return 'claimed';
    });
  }

  async markAutomationParentExecutionUnknown(approvalId: string): Promise<ApprovalRouterResult> {
    return this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record?.automationCompaction) {
        throw new LegionError('Automation parent continuation unavailable', 'APPROVAL_CONFLICT');
      }
      const result: ApprovalRouterResult = {
        conversationId:
          record.continuation?.kind === 'automation_compaction'
            ? record.continuation.parentConversationId
            : record.conversationId,
        status: 'error',
        error: 'Automation parent provider outcome unknown and was not retried',
      };
      record.automationCompaction.parentExecution = 'unknown';
      record.automationCompaction.lifecycle = 'unknown';
      record.routerResult = result;
      return result;
    });
  }

  async terminalizeAutomationFailure(
    approvalId: string,
    error: string,
  ): Promise<ApprovalRouterResult> {
    const errorSnapshot = requiredString(error, 'automation failure');
    return this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      if (record.routerResult?.status === 'error') {
        return record.routerResult;
      }
      if (
        (record.lifecycle !== 'decided' && record.lifecycle !== 'resuming') ||
        record.continuation?.kind !== 'automation_compaction' ||
        !record.automationCompaction
      ) {
        throw new LegionError('Automation failure cannot be terminalized', 'APPROVAL_CONFLICT');
      }
      const result: ApprovalRouterResult = {
        conversationId: record.continuation.parentConversationId,
        status: 'error',
        error: errorSnapshot,
      };
      record.resumeResult ??= { status: 'error', error: errorSnapshot };
      record.routerResult = result;
      if (record.providerExecution === 'executing') record.providerExecution = 'completed';
      record.automationCompaction = { lifecycle: 'unknown' };
      record.lifecycle = 'decided';
      return result;
    });
  }

  async claimMiddlewareAction(input: MiddlewareActionInput): Promise<MiddlewareActionClaim> {
    const snapshot = snapshotMiddlewareActionInput(input);
    const key = middlewareActionKey(snapshot);
    return this.mutate((data) => {
      const existing = data.middlewareActions[key];
      if (!existing) {
        data.middlewareActions[key] = {
          ...snapshot,
          lifecycle: 'executing',
          createdAt: new Date().toISOString(),
        };
        return { kind: 'claimed' };
      }
      if (
        !isDeepStrictEqual(
          snapshotMiddlewareActionInput({
            operationId: existing.operationId,
            conversationId: existing.conversationId,
            participantId: existing.participantId,
            instanceId: existing.instanceId,
            requestId: existing.requestId,
            tool: existing.tool,
            args: existing.args,
          }),
          snapshot,
        )
      ) {
        throw new LegionError('Conflicting middleware action claim', 'APPROVAL_CONFLICT');
      }
      if (existing.lifecycle === 'executing' || existing.lifecycle === 'suspended') {
        return { kind: 'in_progress' };
      }
      return { kind: 'completed', result: existing.result! };
    });
  }

  async recordMiddlewareActionResult(
    input: MiddlewareActionInput,
    result: MiddlewareActionResult,
  ): Promise<void> {
    const snapshot = snapshotMiddlewareActionInput(input);
    const actionResult = snapshotMiddlewareActionResult(result);
    validateActionResultForClaim(snapshot, actionResult);
    const key = middlewareActionKey(snapshot);
    await this.mutate((data) => {
      const existing = data.middlewareActions[key];
      if (!existing) throw new LegionError('Unknown middleware action claim', 'APPROVAL_NOT_FOUND');
      if (
        !isDeepStrictEqual(
          snapshotMiddlewareActionInput({
            operationId: existing.operationId,
            conversationId: existing.conversationId,
            participantId: existing.participantId,
            instanceId: existing.instanceId,
            requestId: existing.requestId,
            tool: existing.tool,
            args: existing.args,
          }),
          snapshot,
        )
      ) {
        throw new LegionError('Conflicting middleware action result', 'APPROVAL_CONFLICT');
      }
      if (existing.lifecycle === 'completed') {
        if (isDeepStrictEqual(existing.result, actionResult)) return undefined;
        throw new LegionError(
          'Conflicting completed middleware action result',
          'APPROVAL_CONFLICT',
        );
      }
      existing.lifecycle = 'completed';
      existing.result = actionResult;
      return undefined;
    });
  }

  async suspendMiddlewareAction(input: MiddlewareActionInput): Promise<void> {
    const snapshot = snapshotMiddlewareActionInput(input);
    const key = middlewareActionKey(snapshot);
    await this.mutate((data) => {
      const existing = data.middlewareActions[key];
      if (!existing) throw new LegionError('Unknown middleware action claim', 'APPROVAL_NOT_FOUND');
      if (existing.lifecycle === 'completed') {
        throw new LegionError('Completed middleware action cannot suspend', 'APPROVAL_CONFLICT');
      }
      existing.lifecycle = 'suspended';
      return undefined;
    });
  }

  getRecord(approvalId: string): ApprovalRecord | undefined {
    const record = this.data.records[approvalId];
    return record === undefined ? undefined : snapshotRecord(record);
  }

  async getAuthoritativeRecord(approvalId: string): Promise<ApprovalRecord | undefined> {
    return this.mutate((data) => data.records[approvalId]);
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

  async discardUnpersisted(approvalIds: readonly string[]): Promise<void> {
    const ids = [...new Set(approvalIds)];
    await this.mutate((data) => {
      for (const approvalId of ids) delete data.records[approvalId];
    });
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
        if (
          record.decision.approved === snapshot.approved &&
          record.decision.message === snapshot.message
        ) {
          return undefined;
        }
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

  async claimGenericResume(
    conversationId: string,
    requesterId: string,
  ): Promise<'claimed' | 'completed'> {
    const key = genericResumeKey(conversationId, requesterId);
    return this.mutate((data) => {
      if (data.genericResumes[key] !== undefined) return 'completed';
      data.genericResumes[key] = 'executing';
      return 'claimed';
    });
  }

  async completeGenericResume(conversationId: string, requesterId: string): Promise<void> {
    const key = genericResumeKey(conversationId, requesterId);
    await this.mutate((data) => {
      if (data.genericResumes[key] === undefined) {
        throw new LegionError(
          `Generic approval resume was not claimed: ${key}`,
          'APPROVAL_CONFLICT',
        );
      }
      data.genericResumes[key] = 'completed';
      return undefined;
    });
  }

  async releaseGenericResume(conversationId: string, requesterId: string): Promise<void> {
    const key = genericResumeKey(conversationId, requesterId);
    await this.mutate((data) => {
      if (data.genericResumes[key] === 'executing') delete data.genericResumes[key];
      return undefined;
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

  async recordRouterResult(approvalId: string, result: ApprovalRouterResult): Promise<void> {
    const snapshot = snapshotRouterResult(result);
    await this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      if (
        record.lifecycle !== 'decided' ||
        record.resumeResult === undefined ||
        !record.continuation
      ) {
        throw new LegionError('Approval request cannot record router result', 'APPROVAL_CONFLICT');
      }
      if (record.routerResult !== undefined && !isDeepStrictEqual(record.routerResult, snapshot)) {
        throw new LegionError('Conflicting approval router result', 'APPROVAL_CONFLICT');
      }
      record.routerResult = snapshot;
      if (record.providerExecution === 'executing') record.providerExecution = 'completed';
      if (record.automationCompaction?.parentExecution === 'executing') {
        record.automationCompaction.parentExecution = 'completed';
      }
      return undefined;
    });
  }

  async claimProviderExecution(approvalId: string): Promise<'claimed' | 'completed' | 'unknown'> {
    return this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      if (record.providerExecution === 'completed' || record.routerResult !== undefined)
        return 'completed';
      if (record.providerExecution === 'unknown') return 'unknown';
      if (record.providerExecution === 'executing') {
        record.providerExecution = 'unknown';
        record.routerResult = {
          conversationId: record.conversationId,
          status: 'error',
          error: 'Middleware provider outcome unknown and was not retried',
        };
        return 'unknown';
      }
      record.providerExecution = 'executing';
      return 'claimed';
    });
  }

  async markProviderExecutionUnknown(approvalId: string): Promise<ApprovalRouterResult> {
    return this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      const result: ApprovalRouterResult = {
        conversationId: record.conversationId,
        status: 'error',
        error: 'Middleware provider outcome unknown and was not retried',
      };
      record.providerExecution = 'unknown';
      record.routerResult = result;
      return result;
    });
  }

  async recordSuccessor(approvalId: string, successorApprovalId: string): Promise<void> {
    await this.recordSuccessors(approvalId, [successorApprovalId]);
  }

  async recordSuccessors(approvalId: string, successorApprovalIds: string[]): Promise<void> {
    if (successorApprovalIds.length === 0) return;
    const successorIds = successorApprovalIds.map((id, index) =>
      requiredString(id, `successorApprovalIds[${index}]`),
    );
    if (new Set(successorIds).size !== successorIds.length) {
      throw new LegionError('Duplicate approval successors', 'APPROVAL_CONFLICT');
    }
    await this.mutate((data) => {
      const record = data.records[approvalId];
      if (!record)
        throw new LegionError(`Unknown approval request: ${approvalId}`, 'APPROVAL_NOT_FOUND');
      for (const successorApprovalId of successorIds) {
        if (!data.records[successorApprovalId]) {
          throw new LegionError(
            `Unknown approval request: ${successorApprovalId}`,
            'APPROVAL_NOT_FOUND',
          );
        }
      }
      const existing =
        record.successorApprovalIds ??
        (record.successorApprovalId === undefined ? [] : [record.successorApprovalId]);
      const merged = [...existing, ...successorIds.filter((id) => !existing.includes(id))];
      record.successorApprovalIds = merged;
      record.successorApprovalId = merged[0];
      if (record.providerExecution === 'executing') record.providerExecution = 'completed';
      if (record.automationCompaction?.parentExecution === 'executing') {
        record.automationCompaction.parentExecution = 'completed';
      }
      if (record.lifecycle === 'resuming') {
        record.resumeResult = { status: 'success', data: { successorApprovalIds: merged } };
        record.lifecycle = 'decided';
      }
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
