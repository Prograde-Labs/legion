import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AgentConfig,
  FailureMode,
  JSONValue,
  MessageData,
  MessageDraft,
  MessageDraftContext,
  MiddlewareActionResult,
  MiddlewareDefinition,
  MiddlewareHookContext,
  MiddlewareInstanceConfig,
  MiddlewareEventBus,
  MiddlewareLogger,
  MiddlewarePhase,
  MiddlewareCheckpoint,
  ParticipantConfig,
  ToolResult,
} from '@legion/types';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type {
  AutomationCompactionContinuation,
  AutomationCompactionSeed,
  PendingApprovalRegistry,
} from '../auth/PendingApprovalRegistry.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import type { Collective } from '../collective/Collective.js';
import type { EventBus } from '../events/EventBus.js';
import type { ToolContext } from '../tools/Tool.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import { createId } from '../util/ids.js';
import { cloneJsonSafe } from './json.js';
import type { MiddlewareRegistry } from './MiddlewareRegistry.js';

export type MiddlewarePhaseResult<T> =
  | { kind: 'continue'; value: T; actions: MiddlewareActionResult[] }
  | { kind: 'complete'; actions: MiddlewareActionResult[] }
  | { kind: 'respond'; draft: MessageDraft; actions: MiddlewareActionResult[] }
  | { kind: 'reject'; error: string }
  | { kind: 'abort'; error: string; persisted: boolean; storedMessageId?: string }
  | {
      kind: 'pending_approval';
      approvalId: string;
      checkpointId: string;
      participantId: string;
    }
  | { kind: 'resume_pending'; approvalId: string; checkpointId: string };

export type MessagePhaseResult = Extract<
  MiddlewarePhaseResult<MessageDraft>,
  { kind: 'continue' | 'reject' | 'abort' | 'pending_approval' }
>;

export type AfterReceivePhaseResult = Extract<
  MiddlewarePhaseResult<MessageData>,
  { kind: 'continue' | 'complete' | 'respond' | 'abort' | 'pending_approval' }
>;

export type SystemPromptPhaseResult = Extract<
  MiddlewarePhaseResult<string>,
  { kind: 'continue' | 'abort' | 'pending_approval' }
>;

export type AfterSendPhaseResult = Extract<
  MiddlewarePhaseResult<MessageData>,
  { kind: 'continue' | 'abort' | 'pending_approval' }
>;

export interface MessagePhaseInput {
  operationId: string;
  phase: 'beforeSend' | 'beforeReceive';
  participant: ParticipantConfig;
  thread: ConversationThread;
  draft: MessageDraft;
  actions: MiddlewareActionResult[];
  final: boolean;
  iteration?: number;
  chunk?: MessageDraftContext['chunk'];
  signal?: AbortSignal;
  startIndex?: number;
  runtimeResume?: MiddlewareCheckpoint['runtimeResume'];
  mode?: 'pre_runtime' | 'post_response';
  approvalContinuationSeed?: AutomationCompactionSeed;
}

export interface AfterReceiveInput {
  operationId: string;
  participant: ParticipantConfig;
  thread: ConversationThread;
  message: MessageData;
  mode: 'pre_runtime' | 'post_response';
  actions: MiddlewareActionResult[];
  persistedMessageId?: string;
  signal?: AbortSignal;
  startIndex?: number;
  runtimeResume?: MiddlewareCheckpoint['runtimeResume'];
  approvalContinuationSeed?: AutomationCompactionSeed;
}

export interface SystemPromptInput {
  operationId: string;
  participant: AgentConfig;
  thread: ConversationThread;
  prompt: string;
  actions: MiddlewareActionResult[];
  /** Incoming message ID supplied by E7 runtime wiring. */
  persistedMessageId: string;
  signal?: AbortSignal;
  startIndex?: number;
  runtimeResume?: MiddlewareCheckpoint['runtimeResume'];
  approvalContinuationSeed?: AutomationCompactionSeed;
}

export interface AfterSendInput {
  operationId: string;
  participant: ParticipantConfig;
  thread: ConversationThread;
  message: MessageData;
  actions: MiddlewareActionResult[];
  persistedMessageId?: string;
  mode?: 'pre_runtime' | 'post_response';
  signal?: AbortSignal;
  startIndex?: number;
  runtimeResume?: MiddlewareCheckpoint['runtimeResume'];
  approvalContinuationSeed?: AutomationCompactionSeed;
}

export interface MiddlewareRunnerDependencies {
  registry: MiddlewareRegistry;
  authEngine: AuthEngine;
  toolRegistry: ToolRegistry;
  pendingApprovals: PendingApprovalRegistry;
  eventBus: EventBus;
  logger: MiddlewareLogger;
  conversationStore: ConversationStore;
  /** Authoritative participant lookup used while resuming durable checkpoints. */
  collective?: Collective;
  buildToolContext: (
    participant: ParticipantConfig,
    thread: ConversationThread,
    signal: AbortSignal,
  ) => ToolContext;
}

interface CommonInput {
  operationId: string;
  participant: ParticipantConfig;
  thread: ConversationThread;
  actions: MiddlewareActionResult[];
  signal?: AbortSignal;
}

interface HookSuccess {
  status: 'success';
  result: unknown;
  duration: number;
  failureMode: FailureMode;
}

interface HookFailure {
  status: 'failure';
  failureMode: FailureMode;
  error: string;
}

interface HookSkipped {
  status: 'skipped';
}

interface HookCancelled {
  status: 'cancelled';
}

type HookExecution = HookSuccess | HookFailure | HookSkipped | HookCancelled;

interface ToolRequest {
  kind: 'tool';
  requestId: string;
  tool: string;
  arguments: Record<string, JSONValue>;
  stateOnSuccess?: JSONValue;
}

type ToolPhaseInput = MessagePhaseInput | AfterReceiveInput | SystemPromptInput | AfterSendInput;

type ToolRequestOutcome =
  | { kind: 'continue'; snapshots: PhaseSnapshots }
  | { kind: 'failure'; snapshots: PhaseSnapshots; failure: HookFailure }
  | { kind: 'cancelled'; snapshots: PhaseSnapshots }
  | { kind: 'pending_approval'; approvalId: string; checkpointId: string; participantId: string };

interface PhaseSnapshots {
  participant: ParticipantConfig;
  activeChain: MessageData[];
  actions: MiddlewareActionResult[];
  eventBus: MiddlewareEventBus;
  logger: MiddlewareLogger;
}

interface ExecutionOwner {
  store: ConversationStore;
  conversationId: string;
  active: boolean;
}

interface HookLifecycle {
  accepting: boolean;
  cancelled: boolean;
  pending: Set<Promise<void>>;
}

const executionQueues = new WeakMap<ConversationStore, Map<string, Promise<void>>>();
const executionOwner = new AsyncLocalStorage<ExecutionOwner>();
const CANCELLATION_ERROR = 'Middleware operation cancelled';

class QueueCancelledError extends Error {}

class ReentrantExecutionError extends Error {}

async function serializeConversation<T>(
  store: ConversationStore,
  conversationId: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = executionOwner.getStore();
  if (owner?.active && owner.store === store && owner.conversationId === conversationId) {
    throw new ReentrantExecutionError('Nested middleware execution for the same conversation');
  }
  let queues = executionQueues.get(store);
  if (!queues) {
    queues = new Map();
    executionQueues.set(store, queues);
  }
  const previous = queues.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  queues.set(conversationId, tail);
  const waitSignal = signal ?? new AbortController().signal;
  const wait = await raceAbort(
    previous.catch(() => undefined),
    waitSignal,
  );
  if (wait.cancelled) {
    release();
    void tail.then(() => {
      if (queues?.get(conversationId) === tail) queues.delete(conversationId);
      if (queues?.size === 0) executionQueues.delete(store);
    });
    throw new QueueCancelledError(CANCELLATION_ERROR);
  }
  const ownership: ExecutionOwner = { store, conversationId, active: true };
  try {
    return await executionOwner.run(ownership, operation);
  } finally {
    ownership.active = false;
    release();
    if (queues.get(conversationId) === tail) queues.delete(conversationId);
    if (queues.size === 0) executionQueues.delete(store);
  }
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
  if (signal.aborted) return { cancelled: true };
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      resolve({ cancelled: true });
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve({ cancelled: false, value });
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`Middleware result ${field} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (result.trim() === '') throw new TypeError(`Middleware result ${field} must be non-empty`);
  return result;
}

function cloneWithOptionalFields<T extends object>(
  value: T,
  optionalFields: ReadonlySet<string>,
  path: string,
): T {
  if (!isPlainRecord(value)) throw new TypeError(`Value at ${path} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) {
    throw new TypeError(`Value at ${path} is not JSON-safe: symbol keys are unsupported`);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) {
      throw new TypeError(`Value at ${path}.${key} is not JSON-safe: field must be enumerable`);
    }
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError(`Value at ${path}.${key} is not JSON-safe: accessors are unsupported`);
    }
    if (descriptor.value === undefined && optionalFields.has(key)) continue;
    normalized[key] = descriptor.value;
  }
  return cloneJsonSafe(normalized, path) as T;
}

const DRAFT_OPTIONAL_FIELDS = new Set(['replyTo', 'reasoning']);
const MESSAGE_OPTIONAL_FIELDS = new Set([
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
]);

function cloneDraft(value: MessageDraft, path: string): MessageDraft {
  return cloneWithOptionalFields(value, DRAFT_OPTIONAL_FIELDS, path);
}

function cloneMessage(value: MessageData, path: string): MessageData {
  return cloneWithOptionalFields(value, MESSAGE_OPTIONAL_FIELDS, path);
}

type AbortPhaseResult = Extract<MiddlewarePhaseResult<never>, { kind: 'abort' }>;

function abortResult(error: string, persistedMessageId?: string): AbortPhaseResult {
  return {
    kind: 'abort',
    error,
    persisted: persistedMessageId !== undefined,
    ...(persistedMessageId === undefined ? {} : { storedMessageId: persistedMessageId }),
  };
}

function validateStartIndex(startIndex: number | undefined, instanceCount: number): number {
  const resolved = startIndex ?? 0;
  if (
    !Number.isFinite(resolved) ||
    !Number.isInteger(resolved) ||
    resolved < 0 ||
    resolved > instanceCount
  ) {
    throw new TypeError(
      `Middleware startIndex must be a finite integer between 0 and ${instanceCount} inclusive`,
    );
  }
  return resolved;
}

function persistedMessage(
  thread: ConversationThread,
  message: MessageData,
  suppliedId?: string,
): { id: string; message: MessageData } {
  const detached = cloneMessage(message, '$.message');
  if (typeof detached.id !== 'string' || detached.id.trim() === '') {
    throw new TypeError('Middleware message.id must be a non-empty string');
  }
  if (suppliedId !== undefined && suppliedId !== detached.id) {
    throw new TypeError('Middleware persistedMessageId must match message.id');
  }
  const stored = thread.data.messages[detached.id];
  if (!stored) {
    throw new TypeError('Middleware message must exist in the current thread stored messages');
  }
  const detachedStored = cloneMessage(stored, '$.storedMessage');
  if (
    detachedStored.id !== detached.id ||
    detachedStored.conversationId !== thread.id ||
    !isDeepStrictEqual(detached, detachedStored)
  ) {
    throw new TypeError('Middleware message must match the current thread stored message');
  }
  return { id: detached.id, message: detached };
}

function validatePersistedMessageId(thread: ConversationThread, value: string | undefined): string {
  if (value === undefined) {
    throw new TypeError('Middleware persistedMessageId is required');
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('Middleware persistedMessageId must be a non-empty string');
  }
  const stored = thread.data.messages[value];
  if (!stored || stored.id !== value || stored.conversationId !== thread.id) {
    throw new TypeError(
      'Middleware persistedMessageId must identify a current thread stored message',
    );
  }
  return value;
}

function validateDraft(value: unknown, original?: MessageDraft): MessageDraft {
  if (!isPlainRecord(value))
    throw new TypeError('Middleware result message must be a plain object');
  const allowed = new Set(['senderId', 'recipientId', 'role', 'replyTo', 'content', 'reasoning']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Middleware result message may not change ${key}`);
  }
  const candidate: MessageDraft = {
    senderId: requireString(value.senderId, 'message.senderId'),
    recipientId: requireString(value.recipientId, 'message.recipientId'),
    role:
      value.role === 'user' || value.role === 'assistant'
        ? value.role
        : (() => {
            throw new TypeError('Middleware result message.role must be user or assistant');
          })(),
    content: requireString(value.content, 'message.content'),
    ...(value.replyTo === undefined
      ? {}
      : { replyTo: requireString(value.replyTo, 'message.replyTo') }),
    ...(value.reasoning === undefined
      ? {}
      : { reasoning: requireString(value.reasoning, 'message.reasoning') }),
  };
  if (original) {
    for (const field of ['senderId', 'recipientId', 'role', 'replyTo'] as const) {
      if (candidate[field] !== original[field]) {
        throw new TypeError(`Middleware result message may not change ${field}`);
      }
    }
  }
  return candidate;
}

interface OutcomeSchema {
  required: readonly string[];
  optional?: readonly string[];
}

function inspectOutcome(
  value: unknown,
  schemas: Readonly<Record<string, OutcomeSchema>>,
): { kind: string; values: Record<string, unknown> } {
  if (!isPlainRecord(value)) throw new TypeError('Middleware result must be a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) {
    throw new TypeError('Middleware result symbol fields are unsupported');
  }
  const kindDescriptor = descriptors.kind;
  if (!kindDescriptor || 'get' in kindDescriptor || 'set' in kindDescriptor) {
    throw new TypeError('Middleware result kind must be a data property');
  }
  if (!kindDescriptor.enumerable) throw new TypeError('Middleware result kind must be enumerable');
  const kind = requireString(kindDescriptor.value, 'kind');
  const schema = schemas[kind];
  if (!schema) throw new TypeError(`Unsupported middleware outcome: ${kind}`);
  const allowed = new Set(['kind', ...schema.required, ...(schema.optional ?? [])]);
  const values: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key))
      throw new TypeError(`Middleware ${kind} result field ${key} is unsupported`);
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError(`Middleware result field ${key} must not be an accessor`);
    }
    if (!descriptor.enumerable) {
      throw new TypeError(`Middleware result field ${key} must be enumerable`);
    }
    if (key === 'kind') continue;
    if (descriptor.value === undefined && schema.optional?.includes(key)) continue;
    values[key] = descriptor.value;
  }
  for (const required of schema.required) {
    if (!Object.hasOwn(values, required)) {
      throw new TypeError(`Middleware ${kind} result requires ${required}`);
    }
  }
  return { kind, values };
}

function parseToolOutcome(values: Record<string, unknown>): Record<string, unknown> {
  if (
    values.arguments === null ||
    typeof values.arguments !== 'object' ||
    Array.isArray(values.arguments)
  ) {
    throw new TypeError('Middleware tool result arguments must be a plain object');
  }
  const args = cloneJsonSafe(values.arguments, '$.result.arguments');
  if (!isPlainRecord(args)) throw new TypeError('Middleware tool result arguments must be plain');
  return {
    kind: 'tool',
    requestId: requireString(values.requestId, 'requestId'),
    tool: requireString(values.tool, 'tool'),
    arguments: args,
    ...(values.stateOnSuccess === undefined
      ? {}
      : { stateOnSuccess: cloneJsonSafe(values.stateOnSuccess, '$.result.stateOnSuccess') }),
  };
}

function parseMessageOutcome(value: unknown): Record<string, unknown> {
  const outcome = inspectOutcome(value, {
    continue: { required: [], optional: ['message'] },
    reject: { required: ['error'] },
    tool: { required: ['requestId', 'tool', 'arguments'], optional: ['stateOnSuccess'] },
  });
  if (outcome.kind === 'continue') {
    return {
      kind: 'continue',
      ...(outcome.values.message === undefined
        ? {}
        : { message: cloneDraft(outcome.values.message as MessageDraft, '$.result.message') }),
    };
  }
  if (outcome.kind === 'reject') {
    return { kind: 'reject', error: requireString(outcome.values.error, 'error') };
  }
  return parseToolOutcome(outcome.values);
}

function parseAfterReceiveOutcome(value: unknown): Record<string, unknown> {
  const outcome = inspectOutcome(value, {
    continue: { required: [] },
    complete: { required: [] },
    respond: { required: ['message'] },
    abort: { required: ['error'] },
    tool: { required: ['requestId', 'tool', 'arguments'], optional: ['stateOnSuccess'] },
  });
  if (outcome.kind === 'respond') {
    return {
      kind: 'respond',
      message: cloneDraft(outcome.values.message as MessageDraft, '$.result.message'),
    };
  }
  if (outcome.kind === 'abort') {
    return { kind: 'abort', error: requireString(outcome.values.error, 'error') };
  }
  if (outcome.kind === 'tool') return parseToolOutcome(outcome.values);
  return { kind: outcome.kind };
}

function parsePromptChange(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) throw new TypeError('Middleware prompt change must be a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) {
    throw new TypeError('Middleware prompt change symbol fields are unsupported');
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key !== 'operation' && key !== 'content') {
      throw new TypeError(`Middleware prompt change field ${key} is unsupported`);
    }
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError(`Middleware prompt change field ${key} must not be an accessor`);
    }
    if (!descriptor.enumerable) {
      throw new TypeError(`Middleware prompt change field ${key} must be enumerable`);
    }
  }
  const operationDescriptor = descriptors.operation;
  const contentDescriptor = descriptors.content;
  if (!operationDescriptor || !('value' in operationDescriptor)) {
    throw new TypeError('Middleware prompt change requires operation');
  }
  if (!contentDescriptor || !('value' in contentDescriptor)) {
    throw new TypeError('Middleware prompt change requires content');
  }
  const operation = requireString(operationDescriptor.value, 'change.operation');
  if (operation !== 'append' && operation !== 'prepend' && operation !== 'replace') {
    throw new TypeError(`Unsupported prompt change operation: ${operation}`);
  }
  return { operation, content: requireString(contentDescriptor.value, 'change.content') };
}

function parseSystemPromptOutcome(value: unknown): Record<string, unknown> {
  const outcome = inspectOutcome(value, {
    continue: { required: [], optional: ['change'] },
    abort: { required: ['error'] },
    tool: { required: ['requestId', 'tool', 'arguments'], optional: ['stateOnSuccess'] },
  });
  if (outcome.kind === 'continue') {
    return {
      kind: 'continue',
      ...(outcome.values.change === undefined
        ? {}
        : { change: parsePromptChange(outcome.values.change) }),
    };
  }
  if (outcome.kind === 'abort') {
    return { kind: 'abort', error: requireString(outcome.values.error, 'error') };
  }
  return parseToolOutcome(outcome.values);
}

function parseAfterSendOutcome(value: unknown): Record<string, unknown> {
  const outcome = inspectOutcome(value, {
    continue: { required: [] },
    abort: { required: ['error'] },
    tool: { required: ['requestId', 'tool', 'arguments'], optional: ['stateOnSuccess'] },
  });
  if (outcome.kind === 'abort') {
    return { kind: 'abort', error: requireString(outcome.values.error, 'error') };
  }
  if (outcome.kind === 'tool') return parseToolOutcome(outcome.values);
  return { kind: 'continue' };
}

export class MiddlewareRunner {
  constructor(private readonly dependencies: MiddlewareRunnerDependencies) {}

  runMessagePhase(input: MessagePhaseInput): Promise<MessagePhaseResult> {
    return this.runSerialized(
      input,
      async () => {
        await this.refreshThread(input.thread);
        return this.runMessagePhaseUnlocked(input);
      },
      () => abortResult(CANCELLATION_ERROR),
    );
  }

  runAfterReceive(input: AfterReceiveInput): Promise<AfterReceivePhaseResult> {
    return this.runSerialized(
      input,
      async () => {
        await this.refreshThread(input.thread);
        return this.runAfterReceiveUnlocked(input);
      },
      async () => {
        const authoritative = await this.loadAuthoritativeThread(input.thread.id);
        const persisted = persistedMessage(authoritative, input.message, input.persistedMessageId);
        return abortResult(CANCELLATION_ERROR, persisted.id);
      },
    );
  }

  runSystemPrompt(input: SystemPromptInput): Promise<SystemPromptPhaseResult> {
    return this.runSerialized(
      input,
      async () => {
        await this.refreshThread(input.thread);
        return this.runSystemPromptUnlocked(input);
      },
      async () => {
        if (input.participant.type !== 'agent') {
          throw new TypeError('Middleware system prompt requires an agent participant');
        }
        const authoritative = await this.loadAuthoritativeThread(input.thread.id);
        const id = validatePersistedMessageId(authoritative, input.persistedMessageId);
        return abortResult(CANCELLATION_ERROR, id);
      },
    );
  }

  runAfterSend(input: AfterSendInput): Promise<AfterSendPhaseResult> {
    return this.runSerialized(
      input,
      async () => {
        await this.refreshThread(input.thread);
        return this.runAfterSendUnlocked(input);
      },
      async () => {
        const authoritative = await this.loadAuthoritativeThread(input.thread.id);
        const persisted = persistedMessage(authoritative, input.message, input.persistedMessageId);
        return abortResult(CANCELLATION_ERROR, persisted.id);
      },
    );
  }

  /** Resume exactly one durable middleware checkpoint after its approval decision. */
  async resumeApproval(
    approvalId: string,
    thread: ConversationThread,
  ): Promise<MiddlewarePhaseResult<MessageDraft | MessageData | string>> {
    const claim = await this.dependencies.pendingApprovals.beginResume(approvalId);
    if (claim.status === 'acknowledged') {
      return { kind: 'resume_pending', approvalId, checkpointId: '' };
    }
    if (claim.status === 'in_progress') {
      const continuation = claim.record.continuation;
      const checkpointId =
        continuation?.kind === 'middleware'
          ? continuation.checkpoint.checkpointId
          : (continuation?.helperContinuation.checkpoint.checkpointId ?? '');
      return { kind: 'resume_pending', approvalId, checkpointId };
    }
    const continuation = claim.record.continuation;
    const decision = claim.record.decision;
    if (!continuation || !decision) {
      return abortResult('Middleware approval checkpoint is unavailable');
    }
    const checkpoint =
      continuation.kind === 'middleware'
        ? continuation.checkpoint
        : continuation.helperContinuation.checkpoint;
    return serializeConversation(
      this.dependencies.conversationStore,
      checkpoint.conversationId,
      undefined,
      async () => {
        const authoritative = await this.loadAuthoritativeThread(checkpoint.conversationId);
        const participant = this.dependencies.collective?.get(checkpoint.participantId);
        const instance = participant?.middleware?.[checkpoint.nextHookIndex - 1];
        if (!this.checkpointCurrent(checkpoint, thread, authoritative, participant, instance)) {
          if (claim.record.resumeResult === undefined) {
            await this.dependencies.pendingApprovals.recordResumeResult(approvalId, {
              status: 'error',
              error: 'Middleware approval checkpoint is stale',
            });
          }
          return abortResult(
            'Middleware approval checkpoint is stale',
            checkpoint.persistedMessageId,
          );
        }
        if (!participant || !instance)
          return abortResult('Middleware approval checkpoint is stale');
        const action = await this.resumeAction(
          approvalId,
          checkpoint,
          participant,
          instance,
          authoritative,
          decision.approved,
          claim.record.resumeResult !== undefined,
        );
        if (!('status' in action)) return action;
        const actions = [...checkpoint.actions.slice(0, checkpoint.actionCursor), action];
        if (action.status !== 'success') {
          const failure = this.recordFailure(
            instance,
            checkpoint.phase,
            { operationId: checkpoint.operationId, participant, thread: authoritative, actions },
            new Error('Middleware approval action did not succeed'),
            0,
          );
          if (failure.failureMode === 'closed') {
            return abortResult(failure.error, checkpoint.persistedMessageId);
          }
        }
        const resumedCheckpoint =
          checkpoint.runtimeResume === undefined
            ? checkpoint
            : {
                ...checkpoint,
                runtimeResume: {
                  ...checkpoint.runtimeResume,
                  actions: cloneJsonSafe(actions, '$.runtimeResume.actions'),
                  actionCursor: actions.length,
                },
              };
        return this.resumePhase(
          resumedCheckpoint,
          participant,
          authoritative,
          actions,
          continuation.kind === 'automation_compaction' ? continuation : undefined,
        );
      },
    );
  }

  async resumeAutomationParent(
    continuation: AutomationCompactionContinuation,
    thread: ConversationThread,
    action: MiddlewareActionResult,
    expectedParentHead: string,
  ): Promise<MiddlewarePhaseResult<MessageDraft | MessageData | string>> {
    const checkpoint = continuation.parentCheckpoint;
    if (thread.id !== checkpoint.conversationId) {
      return abortResult('Automation compaction parent checkpoint is stale');
    }
    return serializeConversation(
      this.dependencies.conversationStore,
      checkpoint.conversationId,
      undefined,
      async () => {
        const authoritative = await this.loadAuthoritativeThread(checkpoint.conversationId);
        const participant = this.dependencies.collective?.get(checkpoint.participantId);
        const instance = participant?.middleware?.[checkpoint.nextHookIndex - 1];
        if (
          !participant ||
          (participant.status ?? 'active') !== 'active' ||
          !instance ||
          (participant.middlewareRevision ?? 0) !== continuation.middlewareRevision ||
          instance.id !== continuation.middlewareInstanceId ||
          instance.type !== continuation.middlewareType ||
          !isDeepStrictEqual(instance.config, continuation.middlewareConfig)
        ) {
          return abortResult('Automation compaction parent checkpoint is stale');
        }
        if (authoritative.data.activeBranchHead !== expectedParentHead) {
          return abortResult('Automation compaction parent checkpoint is stale');
        }
        const actions = [...checkpoint.actions.slice(0, checkpoint.actionCursor), action];
        const resumedCheckpoint =
          checkpoint.message && checkpoint.persistedMessageId
            ? {
                ...checkpoint,
                observedHead: authoritative.data.activeBranchHead,
                message: authoritative.data.messages[checkpoint.persistedMessageId],
              }
            : checkpoint;
        if (checkpoint.message && !resumedCheckpoint.message) {
          return abortResult('Automation compaction parent checkpoint is stale');
        }
        return this.resumePhase(resumedCheckpoint, participant, authoritative, actions);
      },
    );
  }

  private checkpointCurrent(
    checkpoint: MiddlewareCheckpoint,
    suppliedThread: ConversationThread,
    thread: ConversationThread,
    participant: ParticipantConfig | undefined,
    instance: MiddlewareInstanceConfig | undefined,
  ): boolean {
    if (suppliedThread.id !== checkpoint.conversationId) return false;
    if (thread.data.activeBranchHead !== checkpoint.observedHead) return false;
    if (!participant || (participant.status ?? 'active') !== 'active') return false;
    if ((participant.middlewareRevision ?? 0) !== checkpoint.middlewareRevision) return false;
    if (
      !instance ||
      instance.id !== checkpoint.instanceId ||
      instance.type !== checkpoint.middlewareType
    ) {
      return false;
    }
    if (
      checkpoint.middlewareConfig === undefined ||
      !isDeepStrictEqual(checkpoint.middlewareConfig, instance.config)
    ) {
      return false;
    }
    if (instance.enabled === false || checkpoint.nextHookIndex < 1) return false;
    if (checkpoint.nextHookIndex > (participant.middleware?.length ?? 0)) return false;
    if (checkpoint.actionCursor < 0 || checkpoint.actionCursor !== checkpoint.actions.length)
      return false;
    if (checkpoint.phase === 'afterReceive' || checkpoint.phase === 'afterSend') {
      if (!checkpoint.message || !checkpoint.persistedMessageId) return false;
      const stored = thread.data.messages[checkpoint.persistedMessageId];
      if (!stored || !isDeepStrictEqual(stored, checkpoint.message)) return false;
    }
    if (checkpoint.phase === 'buildSystemPrompt') {
      if (!checkpoint.persistedMessageId || !thread.data.messages[checkpoint.persistedMessageId])
        return false;
    }
    return true;
  }

  private async resumeAction(
    approvalId: string,
    checkpoint: MiddlewareCheckpoint,
    participant: ParticipantConfig,
    instance: MiddlewareInstanceConfig,
    thread: ConversationThread,
    approved: boolean,
    resumeRecorded: boolean,
  ): Promise<
    | MiddlewareActionResult
    | Extract<MiddlewarePhaseResult<never>, { kind: 'resume_pending' | 'pending_approval' }>
  > {
    const request: ToolRequest = { kind: 'tool', ...checkpoint.request };
    const actionInput = {
      operationId: checkpoint.operationId,
      conversationId: checkpoint.conversationId,
      participantId: participant.id,
      instanceId: instance.id,
      requestId: request.requestId,
      tool: request.tool,
      args: cloneJsonSafe(request.arguments, '$.request.arguments'),
    };
    let action: MiddlewareActionResult;
    if (!approved) {
      const result: ToolResult = {
        status: 'rejected',
        message: 'Middleware approval was rejected',
      };
      action = {
        requestId: request.requestId,
        participantId: participant.id,
        instanceId: instance.id,
        tool: request.tool,
        status: 'rejected',
        result,
      };
      if (!resumeRecorded)
        await this.dependencies.pendingApprovals.recordResumeResult(approvalId, result);
      return action;
    }
    const claimed = await this.dependencies.pendingApprovals.claimMiddlewareAction(actionInput);
    if (claimed.kind === 'in_progress') {
      return { kind: 'resume_pending', approvalId, checkpointId: checkpoint.checkpointId };
    }
    if (claimed.kind === 'completed') {
      action = claimed.result;
    } else {
      let result: ToolResult;
      try {
        result = this.safeToolResult(
          await this.dependencies.toolRegistry.execute(request.tool, actionInput.args, {
            ...this.dependencies.buildToolContext(
              participant,
              thread,
              new AbortController().signal,
            ),
            middlewareCheckpoint: checkpoint,
          }),
        );
      } catch {
        result = this.safeToolFailure('error');
      }
      if (result.status === 'pending_approval') {
        await this.dependencies.pendingApprovals.suspendMiddlewareAction(actionInput);
        const data = result.data as { checkpointId: string; pendingParticipantId: string };
        return {
          kind: 'pending_approval',
          approvalId: result.approvalId!,
          checkpointId: data.checkpointId,
          participantId: data.pendingParticipantId,
        };
      }
      const status: MiddlewareActionResult['status'] =
        result.status === 'success'
          ? 'success'
          : result.status === 'rejected'
            ? 'rejected'
            : 'error';
      action = {
        requestId: request.requestId,
        participantId: participant.id,
        instanceId: instance.id,
        tool: request.tool,
        status,
        result,
      };
      await this.dependencies.pendingApprovals.recordMiddlewareActionResult(actionInput, action);
    }
    if (!resumeRecorded) {
      await this.dependencies.pendingApprovals.recordResumeResult(
        approvalId,
        action.result ?? { status: action.status === 'rejected' ? 'rejected' : 'error' },
      );
    }
    if (action.status === 'success' && request.stateOnSuccess !== undefined) {
      await this.applyToolState(
        instance,
        {
          operationId: checkpoint.operationId,
          participant,
          thread,
          actions: [],
        } as unknown as ToolPhaseInput,
        request.stateOnSuccess,
        new AbortController().signal,
      );
    }
    return action;
  }

  private resumePhase(
    checkpoint: MiddlewareCheckpoint,
    participant: ParticipantConfig,
    thread: ConversationThread,
    actions: MiddlewareActionResult[],
    automationContinuation?: AutomationCompactionContinuation,
  ): Promise<MiddlewarePhaseResult<MessageDraft | MessageData | string>> {
    const common = {
      operationId: checkpoint.operationId,
      participant,
      thread,
      actions,
      startIndex: checkpoint.nextHookIndex,
      runtimeResume: checkpoint.runtimeResume,
      ...(automationContinuation === undefined
        ? {}
        : {
            approvalContinuationSeed: {
              parentConversationId: automationContinuation.parentConversationId,
              helperConversationId: automationContinuation.helperConversationId,
              participantId: automationContinuation.participantId,
              middlewareInstanceId: automationContinuation.middlewareInstanceId,
              middlewareRevision: automationContinuation.middlewareRevision,
              middlewareType: automationContinuation.middlewareType,
              middlewareConfig: automationContinuation.middlewareConfig,
              observedParentHead: automationContinuation.observedParentHead,
              selectedMessages: automationContinuation.selectedMessages,
              parentMessageId: automationContinuation.parentMessageId,
              parentCheckpoint: automationContinuation.parentCheckpoint,
            },
          }),
    };
    if (checkpoint.phase === 'beforeSend' || checkpoint.phase === 'beforeReceive') {
      return this.runMessagePhaseUnlocked({
        ...common,
        phase: checkpoint.phase,
        draft: checkpoint.draft!,
        final: checkpoint.final!,
        ...(checkpoint.iteration === undefined ? {} : { iteration: checkpoint.iteration }),
        ...(checkpoint.mode === undefined ? {} : { mode: checkpoint.mode }),
      });
    }
    if (checkpoint.phase === 'afterReceive') {
      return this.runAfterReceiveUnlocked({
        ...common,
        message: checkpoint.message!,
        mode: checkpoint.mode!,
        persistedMessageId: checkpoint.persistedMessageId,
      });
    }
    if (checkpoint.phase === 'buildSystemPrompt') {
      if (participant.type !== 'agent')
        return Promise.resolve(
          abortResult('Middleware approval checkpoint is stale', checkpoint.persistedMessageId),
        );
      return this.runSystemPromptUnlocked({
        ...common,
        participant,
        prompt: checkpoint.prompt!,
        persistedMessageId: checkpoint.persistedMessageId!,
      });
    }
    return this.runAfterSendUnlocked({
      ...common,
      message: checkpoint.message!,
      persistedMessageId: checkpoint.persistedMessageId,
    });
  }

  private async runMessagePhaseUnlocked(input: MessagePhaseInput): Promise<MessagePhaseResult> {
    if (input.signal?.aborted) return abortResult(CANCELLATION_ERROR);
    let current = cloneDraft(input.draft, '$.draft');
    const instances = input.participant.middleware ?? [];
    const startIndex = validateStartIndex(input.startIndex, instances.length);
    let snapshots = this.buildPhaseSnapshots(input);
    for (let index = startIndex; index < instances.length; index += 1) {
      const instance = instances[index];
      if (!this.enabled(instance, input, input.phase)) continue;
      const execution = await this.invoke(instance, input.phase, input, snapshots, (base) => ({
        ...base,
        message: cloneJsonSafe(current, '$.message'),
        final: input.final,
        ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
        ...(input.chunk === undefined ? {} : { chunk: cloneJsonSafe(input.chunk, '$.chunk') }),
      }));
      if (execution.status === 'skipped') continue;
      if (execution.status === 'cancelled') return abortResult(CANCELLATION_ERROR);
      if (execution.status === 'failure') {
        if (execution.failureMode === 'closed') return abortResult(execution.error);
        continue;
      }

      try {
        const result = parseMessageOutcome(execution.result);
        const kind = result.kind;
        if (kind === 'continue') {
          if (result.message !== undefined) {
            current = validateDraft(result.message, current);
          }
          this.recordSuccess(instance, input.phase, input, execution);
          continue;
        }
        if (kind === 'reject') {
          const error = requireString(result.error, 'error');
          this.recordSuccess(instance, input.phase, input, execution);
          return { kind: 'reject', error };
        }
        if (kind === 'tool') {
          const outcome = await this.requestTool(
            instance,
            input.phase,
            input,
            snapshots,
            index,
            result as unknown as ToolRequest,
            current,
          );
          if (outcome.kind === 'pending_approval') return outcome;
          snapshots = outcome.snapshots;
          if (outcome.kind === 'cancelled') return abortResult(CANCELLATION_ERROR);
          if (outcome.kind === 'failure' && outcome.failure.failureMode === 'closed') {
            return abortResult(outcome.failure.error);
          }
          continue;
        }
        throw new TypeError(`Unsupported ${input.phase} middleware outcome: ${kind}`);
      } catch (error) {
        const failure = this.recordFailure(
          instance,
          input.phase,
          input,
          error,
          execution.duration,
          execution.failureMode,
        );
        if (failure.failureMode === 'closed') return abortResult(failure.error);
      }
    }
    return {
      kind: 'continue',
      value: cloneJsonSafe(current),
      actions: cloneJsonSafe(snapshots.actions),
    };
  }

  private async runAfterReceiveUnlocked(
    input: AfterReceiveInput,
  ): Promise<AfterReceivePhaseResult> {
    const persisted = persistedMessage(input.thread, input.message, input.persistedMessageId);
    const storedMessageId = persisted.id;
    if (input.signal?.aborted) return abortResult(CANCELLATION_ERROR, storedMessageId);
    const current = persisted.message;
    const instances = input.participant.middleware ?? [];
    const startIndex = validateStartIndex(input.startIndex, instances.length);
    let snapshots = this.buildPhaseSnapshots(input);
    for (let index = startIndex; index < instances.length; index += 1) {
      const instance = instances[index];
      if (!this.enabled(instance, input, 'afterReceive')) continue;
      const execution = await this.invoke(instance, 'afterReceive', input, snapshots, (base) => ({
        ...base,
        message: cloneJsonSafe(current, '$.message'),
        mode: input.mode,
      }));
      if (execution.status === 'skipped') continue;
      if (execution.status === 'cancelled') {
        return abortResult(CANCELLATION_ERROR, storedMessageId);
      }
      if (execution.status === 'failure') {
        if (execution.failureMode === 'closed') {
          return abortResult(execution.error, storedMessageId);
        }
        continue;
      }

      try {
        const result = parseAfterReceiveOutcome(execution.result);
        const kind = result.kind;
        if (kind === 'continue') {
          this.recordSuccess(instance, 'afterReceive', input, execution);
          continue;
        }
        if (kind === 'complete') {
          this.recordSuccess(instance, 'afterReceive', input, execution);
          return { kind: 'complete', actions: cloneJsonSafe(snapshots.actions) };
        }
        if (kind === 'respond') {
          if (input.mode === 'post_response') {
            throw new TypeError('Middleware respond outcome is invalid in post_response mode');
          }
          const draft = validateDraft(result.message, {
            senderId: input.participant.id,
            recipientId: current.replyTo ?? current.senderId,
            role: 'assistant',
            content: '',
          });
          this.recordSuccess(instance, 'afterReceive', input, execution);
          return {
            kind: 'respond',
            draft,
            actions: cloneJsonSafe(snapshots.actions),
          };
        }
        if (kind === 'abort') {
          const error = requireString(result.error, 'error');
          this.recordSuccess(instance, 'afterReceive', input, execution);
          return abortResult(error, storedMessageId);
        }
        if (kind === 'tool') {
          const outcome = await this.requestTool(
            instance,
            'afterReceive',
            input,
            snapshots,
            index,
            result as unknown as ToolRequest,
            current,
            storedMessageId,
          );
          if (outcome.kind === 'pending_approval') return outcome;
          snapshots = outcome.snapshots;
          if (outcome.kind === 'cancelled') return abortResult(CANCELLATION_ERROR, storedMessageId);
          if (outcome.kind === 'failure' && outcome.failure.failureMode === 'closed') {
            return abortResult(outcome.failure.error, storedMessageId);
          }
          continue;
        }
        throw new TypeError(`Unsupported afterReceive middleware outcome: ${kind}`);
      } catch (error) {
        const failure = this.recordFailure(
          instance,
          'afterReceive',
          input,
          error,
          execution.duration,
          execution.failureMode,
        );
        if (failure.failureMode === 'closed') {
          return abortResult(failure.error, storedMessageId);
        }
      }
    }
    return { kind: 'continue', value: current, actions: cloneJsonSafe(snapshots.actions) };
  }

  private async runSystemPromptUnlocked(
    input: SystemPromptInput,
  ): Promise<SystemPromptPhaseResult> {
    if (input.participant.type !== 'agent') {
      throw new TypeError('Middleware system prompt requires an agent participant');
    }
    const storedMessageId = validatePersistedMessageId(input.thread, input.persistedMessageId);
    if (input.signal?.aborted) return abortResult(CANCELLATION_ERROR, storedMessageId);
    let current = input.prompt;
    const instances = input.participant.middleware ?? [];
    const startIndex = validateStartIndex(input.startIndex, instances.length);
    let snapshots = this.buildPhaseSnapshots(input);
    for (let index = startIndex; index < instances.length; index += 1) {
      const instance = instances[index];
      if (!this.enabled(instance, input, 'buildSystemPrompt')) continue;
      const execution = await this.invoke(
        instance,
        'buildSystemPrompt',
        input,
        snapshots,
        (base) => ({
          ...base,
          prompt: current,
        }),
      );
      if (execution.status === 'skipped') continue;
      if (execution.status === 'cancelled') {
        return abortResult(CANCELLATION_ERROR, storedMessageId);
      }
      if (execution.status === 'failure') {
        if (execution.failureMode === 'closed') {
          return abortResult(execution.error, storedMessageId);
        }
        continue;
      }

      try {
        const result = parseSystemPromptOutcome(execution.result);
        const kind = result.kind;
        if (kind === 'continue') {
          if (result.change !== undefined) {
            const change = result.change as Record<string, unknown>;
            const operation = requireString(change.operation, 'change.operation');
            const content = requireString(change.content, 'change.content');
            if (operation === 'append') current += content;
            else if (operation === 'prepend') current = content + current;
            else if (operation === 'replace') current = content;
          }
          this.recordSuccess(instance, 'buildSystemPrompt', input, execution);
          continue;
        }
        if (kind === 'abort') {
          const error = requireString(result.error, 'error');
          this.recordSuccess(instance, 'buildSystemPrompt', input, execution);
          return abortResult(error, storedMessageId);
        }
        if (kind === 'tool') {
          const outcome = await this.requestTool(
            instance,
            'buildSystemPrompt',
            input,
            snapshots,
            index,
            result as unknown as ToolRequest,
            current,
            storedMessageId,
          );
          if (outcome.kind === 'pending_approval') return outcome;
          snapshots = outcome.snapshots;
          if (outcome.kind === 'cancelled') return abortResult(CANCELLATION_ERROR, storedMessageId);
          if (outcome.kind === 'failure' && outcome.failure.failureMode === 'closed') {
            return abortResult(outcome.failure.error, storedMessageId);
          }
          continue;
        }
        throw new TypeError(`Unsupported buildSystemPrompt middleware outcome: ${kind}`);
      } catch (error) {
        const failure = this.recordFailure(
          instance,
          'buildSystemPrompt',
          input,
          error,
          execution.duration,
          execution.failureMode,
        );
        if (failure.failureMode === 'closed') {
          return abortResult(failure.error, storedMessageId);
        }
      }
    }
    return { kind: 'continue', value: current, actions: cloneJsonSafe(snapshots.actions) };
  }

  private async runAfterSendUnlocked(input: AfterSendInput): Promise<AfterSendPhaseResult> {
    const persisted = persistedMessage(input.thread, input.message, input.persistedMessageId);
    const storedMessageId = persisted.id;
    if (input.signal?.aborted) return abortResult(CANCELLATION_ERROR, storedMessageId);
    const current = persisted.message;
    const instances = input.participant.middleware ?? [];
    const startIndex = validateStartIndex(input.startIndex, instances.length);
    let snapshots = this.buildPhaseSnapshots(input);
    for (let index = startIndex; index < instances.length; index += 1) {
      const instance = instances[index];
      if (!this.enabled(instance, input, 'afterSend')) continue;
      const execution = await this.invoke(instance, 'afterSend', input, snapshots, (base) => ({
        ...base,
        message: cloneJsonSafe(current, '$.message'),
      }));
      if (execution.status === 'skipped') continue;
      if (execution.status === 'cancelled') {
        return abortResult(CANCELLATION_ERROR, storedMessageId);
      }
      if (execution.status === 'failure') {
        if (execution.failureMode === 'closed') {
          return abortResult(execution.error, storedMessageId);
        }
        continue;
      }

      try {
        const result = parseAfterSendOutcome(execution.result);
        const kind = result.kind;
        if (kind === 'continue') {
          this.recordSuccess(instance, 'afterSend', input, execution);
          continue;
        }
        if (kind === 'abort') {
          const error = requireString(result.error, 'error');
          this.recordSuccess(instance, 'afterSend', input, execution);
          return abortResult(error, storedMessageId);
        }
        if (kind === 'tool') {
          const outcome = await this.requestTool(
            instance,
            'afterSend',
            input,
            snapshots,
            index,
            result as unknown as ToolRequest,
            current,
            storedMessageId,
          );
          if (outcome.kind === 'pending_approval') return outcome;
          snapshots = outcome.snapshots;
          if (outcome.kind === 'cancelled') return abortResult(CANCELLATION_ERROR, storedMessageId);
          if (outcome.kind === 'failure' && outcome.failure.failureMode === 'closed') {
            return abortResult(outcome.failure.error, storedMessageId);
          }
          continue;
        }
        throw new TypeError(`Unsupported afterSend middleware outcome: ${kind}`);
      } catch (error) {
        const failure = this.recordFailure(
          instance,
          'afterSend',
          input,
          error,
          execution.duration,
          execution.failureMode,
        );
        if (failure.failureMode === 'closed') {
          return abortResult(failure.error, storedMessageId);
        }
      }
    }
    return { kind: 'continue', value: current, actions: cloneJsonSafe(snapshots.actions) };
  }

  private appendAction(snapshots: PhaseSnapshots, action: MiddlewareActionResult): PhaseSnapshots {
    return {
      ...snapshots,
      actions: deepFreeze(cloneJsonSafe([...snapshots.actions, action], '$.actions')),
    };
  }

  private rebuildSnapshots(input: CommonInput, actions: MiddlewareActionResult[]): PhaseSnapshots {
    return this.buildPhaseSnapshots({ ...input, actions });
  }

  private toolAction(
    instance: MiddlewareInstanceConfig,
    input: CommonInput,
    request: ToolRequest,
    status: MiddlewareActionResult['status'],
    result?: ToolResult,
  ): MiddlewareActionResult {
    return {
      requestId: request.requestId,
      participantId: input.participant.id,
      instanceId: instance.id,
      tool: request.tool,
      status,
      ...(result === undefined ? {} : { result: cloneJsonSafe(result, '$.toolResult') }),
    };
  }

  private toolFailure(
    instance: MiddlewareInstanceConfig,
    phase: MiddlewarePhase,
    input: ToolPhaseInput,
    snapshots: PhaseSnapshots,
    request: ToolRequest,
    status: MiddlewareActionResult['status'],
    error: unknown,
    result?: ToolResult,
  ): Extract<ToolRequestOutcome, { kind: 'failure' }> {
    return {
      kind: 'failure',
      snapshots: this.appendAction(
        snapshots,
        this.toolAction(instance, input, request, status, result),
      ),
      failure: this.recordFailure(instance, phase, input, error, 0),
    };
  }

  private safeToolResult(value: unknown): ToolResult {
    try {
      const result = cloneJsonSafe(value, '$.toolResult') as ToolResult;
      if (
        !isPlainRecord(result) ||
        !['success', 'error', 'pending_approval', 'rejected'].includes(result.status)
      ) {
        throw new TypeError('Middleware tool returned an invalid result');
      }
      if (result.status === 'success') {
        return {
          status: 'success',
          ...(result.data === undefined
            ? {}
            : { data: cloneJsonSafe(result.data, '$.toolResult.data') }),
        };
      }
      if (
        result.status === 'pending_approval' &&
        typeof result.approvalId === 'string' &&
        result.approvalId.length > 0 &&
        isPlainRecord(result.data) &&
        typeof result.data.checkpointId === 'string' &&
        typeof result.data.pendingParticipantId === 'string'
      ) {
        return result;
      }
      return this.safeToolFailure(result.status === 'rejected' ? 'rejected' : 'error');
    } catch {
      return this.safeToolFailure('error');
    }
  }

  private safeToolFailure(status: 'error' | 'rejected'): ToolResult {
    const diagnosticId = createId('diag');
    return { status, error: `Middleware tool failed (diagnostic ${diagnosticId})` };
  }

  private async applyToolState(
    instance: MiddlewareInstanceConfig,
    input: ToolPhaseInput,
    value: JSONValue,
    signal: AbortSignal,
  ): Promise<void> {
    const detached = cloneJsonSafe(value, '$.stateOnSuccess');
    const mutation = await this.dependencies.conversationStore.mutate(
      input.thread.id,
      (conversation) => {
        if (signal.aborted) throw new Error('Middleware operation cancelled');
        return {
          ...conversation,
          middlewareState: {
            ...conversation.middlewareState,
            [input.participant.id]: {
              ...conversation.middlewareState?.[input.participant.id],
              [instance.id]: detached,
            },
          },
        };
      },
      { signal },
    );
    input.thread.data = mutation.after;
  }

  private checkpoint(
    instance: MiddlewareInstanceConfig,
    phase: MiddlewarePhase,
    input: ToolPhaseInput,
    index: number,
    request: ToolRequest,
    value: MessageDraft | MessageData | string,
    actions: MiddlewareActionResult[],
    persistedMessageId?: string,
  ): MiddlewareCheckpoint {
    const checkpoint: MiddlewareCheckpoint = {
      checkpointId: createId('mwcp'),
      operationId: input.operationId,
      conversationId: input.thread.id,
      phase,
      participantId: input.participant.id,
      instanceId: instance.id,
      middlewareType: instance.type,
      middlewareRevision: input.participant.middlewareRevision ?? 0,
      middlewareConfig: cloneJsonSafe(instance.config, '$.checkpoint.middlewareConfig'),
      nextHookIndex: index + 1,
      actionCursor: actions.length,
      request: {
        requestId: request.requestId,
        tool: request.tool,
        arguments: cloneJsonSafe(request.arguments, '$.request.arguments'),
        ...(request.stateOnSuccess === undefined
          ? {}
          : { stateOnSuccess: cloneJsonSafe(request.stateOnSuccess, '$.request.stateOnSuccess') }),
      },
      actions: cloneJsonSafe(actions, '$.actions'),
      observedHead: input.thread.data.activeBranchHead,
      ...(phase === 'beforeSend' || phase === 'beforeReceive'
        ? {
            draft: cloneDraft(value as MessageDraft, '$.checkpoint.draft'),
            final: (input as MessagePhaseInput).final,
            ...((input as MessagePhaseInput).iteration === undefined
              ? {}
              : { iteration: (input as MessagePhaseInput).iteration }),
            ...((input as MessagePhaseInput).mode === undefined
              ? {}
              : { mode: (input as MessagePhaseInput).mode }),
          }
        : phase === 'buildSystemPrompt'
          ? { prompt: value as string }
          : {
              message: cloneMessage(value as MessageData, '$.checkpoint.message'),
              ...(phase === 'afterReceive' ? { mode: (input as AfterReceiveInput).mode } : {}),
            }),
      ...(persistedMessageId === undefined ? {} : { persistedMessageId }),
      ...(phase === 'afterSend' && (input as AfterSendInput).mode !== undefined
        ? { mode: (input as AfterSendInput).mode }
        : {}),
      ...(input.runtimeResume === undefined
        ? {}
        : { runtimeResume: cloneJsonSafe(input.runtimeResume, '$.runtimeResume') }),
      createdAt: new Date().toISOString(),
    };
    return checkpoint;
  }

  private async requestTool(
    instance: MiddlewareInstanceConfig,
    phase: MiddlewarePhase,
    input: ToolPhaseInput,
    snapshots: PhaseSnapshots,
    index: number,
    request: ToolRequest,
    value: MessageDraft | MessageData | string,
    persistedMessageId?: string,
  ): Promise<ToolRequestOutcome> {
    const signal = input.signal ?? new AbortController().signal;
    if (signal.aborted) return { kind: 'cancelled', snapshots };
    try {
      requireNonEmptyString(request.requestId, 'requestId');
      requireNonEmptyString(request.tool, 'tool');
      cloneJsonSafe(request.arguments, '$.request.arguments');
      if (snapshots.actions.some((action) => action.requestId === request.requestId)) {
        return this.toolFailure(
          instance,
          phase,
          input,
          snapshots,
          request,
          'error',
          new TypeError('Duplicate middleware tool request ID'),
        );
      }
      if ('final' in input && input.final !== true) {
        return this.toolFailure(
          instance,
          phase,
          input,
          snapshots,
          request,
          'error',
          new TypeError('Middleware tool requests require final message output'),
        );
      }

      const authorization = this.dependencies.authEngine.authorize(
        input.participant.id,
        request.tool,
        request.arguments,
        input.participant.tools,
      );
      if (!authorization.authorized && authorization.reason !== 'requires_approval') {
        return this.toolFailure(
          instance,
          phase,
          input,
          snapshots,
          request,
          'rejected',
          new Error('Middleware tool is not authorized'),
          { status: 'rejected', message: 'Middleware tool is not authorized' },
        );
      }

      if (authorization.reason === 'requires_approval') {
        const checkpoint = this.checkpoint(
          instance,
          phase,
          input,
          index,
          request,
          value,
          snapshots.actions,
          persistedMessageId,
        );
        const { approvalId } = await this.dependencies.pendingApprovals.create(
          {
            conversationId: input.thread.id,
            requesterId: input.participant.id,
            tool: request.tool,
            args: request.arguments,
            continuation: { kind: 'middleware', checkpoint },
          },
          input.approvalContinuationSeed,
        );
        this.recordSuccess(instance, phase, input, {
          status: 'success',
          result: request,
          duration: 0,
          failureMode: this.failureMode(instance),
        });
        this.safeEmit('tool:call', {
          conversationId: input.thread.id,
          participantId: input.participant.id,
          tool: request.tool,
          callId: request.requestId,
        });
        this.safeEmit('tool:result', {
          conversationId: input.thread.id,
          participantId: input.participant.id,
          tool: request.tool,
          callId: request.requestId,
          status: 'pending_approval',
        });
        this.safeEmit('approval:requested', {
          conversationId: input.thread.id,
          participantId: input.participant.id,
          tool: request.tool,
          approvalId,
        });
        return {
          kind: 'pending_approval',
          approvalId,
          checkpointId: checkpoint.checkpointId,
          participantId: input.participant.id,
        };
      }

      const actionInput = {
        operationId: input.operationId,
        conversationId: input.thread.id,
        participantId: input.participant.id,
        instanceId: instance.id,
        requestId: request.requestId,
        tool: request.tool,
        args: cloneJsonSafe(request.arguments, '$.request.arguments'),
      };
      const middlewareCheckpoint = this.checkpoint(
        instance,
        phase,
        input,
        index,
        request,
        value,
        snapshots.actions,
        persistedMessageId,
      );
      const claim = await this.dependencies.pendingApprovals.claimMiddlewareAction(actionInput);
      let action: MiddlewareActionResult;
      if (claim.kind === 'completed') {
        action = claim.result;
      } else if (claim.kind === 'in_progress') {
        return this.toolFailure(
          instance,
          phase,
          input,
          snapshots,
          request,
          'error',
          new Error('Middleware tool execution is already in progress'),
        );
      } else {
        let result: ToolResult;
        if (signal.aborted) {
          result = this.safeToolFailure('error');
        } else {
          try {
            const rawResult = await this.dependencies.toolRegistry.execute(
              request.tool,
              actionInput.args,
              {
                ...this.dependencies.buildToolContext(input.participant, input.thread, signal),
                middlewareCheckpoint,
              },
            );
            result = this.safeToolResult(rawResult);
          } catch {
            result = this.safeToolFailure('error');
          }
        }
        if (result.status === 'pending_approval') {
          await this.dependencies.pendingApprovals.suspendMiddlewareAction(actionInput);
          const data = result.data as { checkpointId: string; pendingParticipantId: string };
          return {
            kind: 'pending_approval',
            approvalId: result.approvalId!,
            checkpointId: data.checkpointId,
            participantId: data.pendingParticipantId,
          };
        }
        const status: MiddlewareActionResult['status'] =
          result.status === 'success'
            ? 'success'
            : result.status === 'rejected'
              ? 'rejected'
              : 'error';
        action = this.toolAction(instance, input, request, status, result);
        await this.dependencies.pendingApprovals.recordMiddlewareActionResult(actionInput, action);
      }
      await this.refreshThread(input.thread);
      if (signal.aborted) return { kind: 'cancelled', snapshots };
      const nextSnapshots = this.rebuildSnapshots(input, [...snapshots.actions, action]);
      if (action.status !== 'success') {
        return {
          kind: 'failure',
          snapshots: nextSnapshots,
          failure: this.recordFailure(
            instance,
            phase,
            input,
            new Error('Middleware tool did not succeed'),
            0,
          ),
        };
      }
      if (request.stateOnSuccess !== undefined) {
        if (signal.aborted) return { kind: 'cancelled', snapshots: nextSnapshots };
        try {
          await this.applyToolState(instance, input, request.stateOnSuccess, signal);
        } catch (error) {
          return {
            kind: 'failure',
            snapshots: nextSnapshots,
            failure: this.recordFailure(instance, phase, input, error, 0),
          };
        }
      }
      this.recordSuccess(instance, phase, input, {
        status: 'success',
        result: action.result,
        duration: 0,
        failureMode: this.failureMode(instance),
      });
      return { kind: 'continue', snapshots: nextSnapshots };
    } catch (error) {
      return this.toolFailure(instance, phase, input, snapshots, request, 'error', error);
    }
  }

  private enabled(
    instance: MiddlewareInstanceConfig,
    input: CommonInput,
    phase: MiddlewarePhase,
  ): boolean {
    if (instance.enabled !== false) return true;
    const started = performance.now();
    this.safeLog('debug', 'Middleware hook skipped', {
      operationId: input.operationId,
      conversationId: input.thread.id,
      participantId: input.participant.id,
      instanceId: instance.id,
      middlewareType: instance.type,
      phase,
      duration: performance.now() - started,
      failureMode: instance.failureMode ?? 'closed',
    });
    return false;
  }

  private async invoke(
    instance: MiddlewareInstanceConfig,
    phase: MiddlewarePhase,
    input: CommonInput,
    snapshots: PhaseSnapshots,
    phaseContext: (base: MiddlewareHookContext<unknown>) => object,
  ): Promise<HookExecution> {
    const started = performance.now();
    let definition: MiddlewareDefinition | undefined;
    let failureMode: FailureMode = instance.failureMode ?? 'closed';
    try {
      definition = this.dependencies.registry.get(instance.type);
      if (!definition) throw new TypeError(`Middleware definition unavailable: ${instance.type}`);
      failureMode = instance.failureMode ?? definition.defaultFailureMode;
      const configurationErrors = this.dependencies.registry.validateConfig(
        instance.type,
        instance.config,
      );
      if (configurationErrors.length > 0) {
        throw new TypeError(`Middleware configuration invalid: ${configurationErrors.join('; ')}`);
      }
      const hook = definition.hooks[phase] as
        ((context: object) => unknown | Promise<unknown>) | undefined;
      if (!hook) return { status: 'skipped' };

      const signal = input.signal ?? new AbortController().signal;
      if (signal.aborted) return { status: 'cancelled' };
      const lifecycle: HookLifecycle = {
        accepting: true,
        cancelled: false,
        pending: new Set(),
      };
      const context = phaseContext(
        this.buildBaseContext(instance, input, signal, snapshots, lifecycle),
      );
      const hookPromise = Promise.resolve()
        .then(() => hook(context))
        .then(
          (value) => {
            lifecycle.accepting = false;
            return { ok: true as const, value };
          },
          (error: unknown) => {
            lifecycle.accepting = false;
            return { ok: false as const, error };
          },
        );
      const hookRace = await raceAbort(hookPromise, signal);
      if (hookRace.cancelled) {
        lifecycle.accepting = false;
        lifecycle.cancelled = true;
        await Promise.allSettled([...lifecycle.pending]);
        return { status: 'cancelled' };
      }
      lifecycle.accepting = false;
      const pendingRace = await raceAbort(Promise.all([...lifecycle.pending]), signal);
      if (pendingRace.cancelled) {
        lifecycle.cancelled = true;
        await Promise.allSettled([...lifecycle.pending]);
        return { status: 'cancelled' };
      }
      if (!hookRace.value.ok) throw hookRace.value.error;
      return {
        status: 'success',
        result: hookRace.value.value,
        duration: performance.now() - started,
        failureMode,
      };
    } catch (error) {
      return this.recordFailure(
        instance,
        phase,
        input,
        error,
        performance.now() - started,
        failureMode,
      );
    }
  }

  private buildBaseContext(
    instance: MiddlewareInstanceConfig,
    input: CommonInput,
    signal: AbortSignal,
    snapshots: PhaseSnapshots,
    lifecycle: HookLifecycle,
  ): MiddlewareHookContext<unknown> {
    const detachedInstance = deepFreeze(cloneJsonSafe(instance, '$.instance'));
    const config = deepFreeze(cloneJsonSafe(instance.config, '$.config'));
    return {
      operationId: input.operationId,
      participant: snapshots.participant,
      instance: detachedInstance,
      config,
      conversationId: input.thread.id,
      activeChain: snapshots.activeChain,
      actions: snapshots.actions,
      getState: () => {
        if (!lifecycle.accepting || lifecycle.cancelled || signal.aborted) {
          throw new Error('Middleware context is inactive');
        }
        const state = input.thread.data.middlewareState?.[input.participant.id]?.[instance.id];
        return state === undefined ? undefined : cloneJsonSafe(state, '$.state');
      },
      setState: (value: JSONValue) => {
        if (!lifecycle.accepting || lifecycle.cancelled || signal.aborted) {
          const rejected = Promise.reject(new Error('Middleware context is inactive'));
          void rejected.catch(() => undefined);
          return rejected;
        }
        const operation = (async () => {
          const detached = cloneJsonSafe(value, '$.state');
          const mutation = await this.dependencies.conversationStore.mutate(
            input.thread.id,
            (conversation) => {
              if (lifecycle.cancelled || signal.aborted) {
                throw new Error('Middleware context is inactive');
              }
              return {
                ...conversation,
                middlewareState: {
                  ...conversation.middlewareState,
                  [input.participant.id]: {
                    ...conversation.middlewareState?.[input.participant.id],
                    [instance.id]: detached,
                  },
                },
              };
            },
            { signal },
          );
          input.thread.data = mutation.after;
        })();
        lifecycle.pending.add(operation);
        void operation.catch(() => undefined);
        return operation;
      },
      signal,
      eventBus: snapshots.eventBus,
      logger: snapshots.logger,
    };
  }

  private recordFailure(
    instance: MiddlewareInstanceConfig,
    phase: MiddlewarePhase,
    input: CommonInput,
    error: unknown,
    duration: number,
    resolvedFailureMode?: FailureMode,
  ): HookFailure {
    const failureMode = resolvedFailureMode ?? this.failureMode(instance);
    const diagnosticId = createId('diag');
    const errorCategory = this.errorCategory(error);
    const message = `Middleware execution failed (diagnostic ${diagnosticId})`;
    this.safeEmit('middleware:error', {
      conversationId: input.thread.id,
      participantId: input.participant.id,
      instanceId: instance.id,
      middlewareType: instance.type,
      phase,
      failureMode,
      error: { name: 'MiddlewareError', message },
    });
    this.safeLog('warn', 'Middleware hook failed', {
      ...this.logFields(instance, phase, input, duration),
      failureMode,
      diagnosticId,
      errorCategory,
    });
    return { status: 'failure', failureMode, error: message };
  }

  private recordSuccess(
    instance: MiddlewareInstanceConfig,
    phase: MiddlewarePhase,
    input: CommonInput,
    execution: HookSuccess,
  ): void {
    this.safeLog('debug', 'Middleware hook completed', {
      ...this.logFields(instance, phase, input, execution.duration),
      failureMode: execution.failureMode,
    });
  }

  private failureMode(instance: MiddlewareInstanceConfig): FailureMode {
    if (instance.failureMode) return instance.failureMode;
    return this.dependencies.registry.get(instance.type)?.defaultFailureMode ?? 'closed';
  }

  private async runSerialized<T>(
    input: CommonInput,
    operation: () => Promise<T>,
    queuedCancellation: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await serializeConversation(
        this.dependencies.conversationStore,
        input.thread.id,
        input.signal,
        operation,
      );
    } catch (error) {
      if (error instanceof QueueCancelledError) return queuedCancellation();
      throw error;
    }
  }

  private async loadAuthoritativeThread(conversationId: string): Promise<ConversationThread> {
    const stored = await this.dependencies.conversationStore.load(conversationId);
    if (!stored) throw new TypeError('Middleware conversation must exist in storage');
    return new ConversationThread(stored, this.dependencies.conversationStore);
  }

  private async refreshThread(thread: ConversationThread): Promise<void> {
    const stored = await this.dependencies.conversationStore.load(thread.id);
    if (!stored) throw new TypeError('Middleware conversation must exist in storage');
    thread.data = stored;
  }

  private buildPhaseSnapshots(input: CommonInput): PhaseSnapshots {
    return {
      participant: deepFreeze(cloneJsonSafe(input.participant, '$.participant')),
      activeChain: deepFreeze(
        input.thread.activeChain.map((message, index) =>
          cloneMessage(message, `$.activeChain[${index}]`),
        ),
      ),
      actions: deepFreeze(cloneJsonSafe(input.actions, '$.actions')),
      eventBus: Object.freeze({
        emit: (
          event: Parameters<MiddlewareEventBus['emit']>[0],
          data: Parameters<MiddlewareEventBus['emit']>[1],
        ) => {
          this.safeEmit(event, data);
        },
      }) as MiddlewareEventBus,
      logger: Object.freeze({
        debug: (message: string, fields?: Record<string, unknown>) =>
          this.safeLog('debug', message, fields),
        info: (message: string, fields?: Record<string, unknown>) =>
          this.safeLog('info', message, fields),
        warn: (message: string, fields?: Record<string, unknown>) =>
          this.safeLog('warn', message, fields),
        error: (message: string, fields?: Record<string, unknown>) =>
          this.safeLog('error', message, fields),
      }),
    };
  }

  private safeEmit<TEvent extends Parameters<MiddlewareEventBus['emit']>[0]>(
    event: TEvent,
    data: Parameters<MiddlewareEventBus['emit']>[1],
  ): void {
    try {
      const detached = cloneJsonSafe(data, '$.event');
      const result = (
        this.dependencies.eventBus.emit as (name: TEvent, payload: typeof detached) => unknown
      ).call(this.dependencies.eventBus, event, detached);
      this.ignoreTelemetryResult(result);
    } catch {
      // Telemetry must not affect middleware control flow.
    }
  }

  private safeLog(
    level: keyof MiddlewareLogger,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    try {
      const detached = fields === undefined ? undefined : cloneJsonSafe(fields, '$.logFields');
      const result = (
        this.dependencies.logger[level] as (
          logMessage: string,
          logFields?: Record<string, unknown>,
        ) => unknown
      ).call(this.dependencies.logger, message, detached);
      this.ignoreTelemetryResult(result);
    } catch {
      // Telemetry must not affect middleware control flow.
    }
  }

  private ignoreTelemetryResult(value: unknown): void {
    try {
      if (
        value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof (value as { then?: unknown }).then === 'function'
      ) {
        void Promise.resolve(value).catch(() => undefined);
      }
    } catch {
      // Telemetry thenable inspection must not affect middleware control flow.
    }
  }

  private errorCategory(error: unknown): string {
    try {
      if (error instanceof TypeError) return 'TypeError';
      if (error instanceof RangeError) return 'RangeError';
      if (error instanceof SyntaxError) return 'SyntaxError';
      if (error instanceof ReferenceError) return 'ReferenceError';
      if (error instanceof Error) return 'Error';
    } catch {
      return 'UnknownError';
    }
    return 'NonErrorThrow';
  }

  private logFields(
    instance: MiddlewareInstanceConfig,
    phase: MiddlewarePhase,
    input: CommonInput,
    duration: number,
  ): Record<string, unknown> {
    return {
      operationId: input.operationId,
      conversationId: input.thread.id,
      participantId: input.participant.id,
      instanceId: instance.id,
      middlewareType: instance.type,
      phase,
      duration,
    };
  }
}
