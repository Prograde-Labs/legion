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
  ParticipantConfig,
} from '@legion/types';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
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
    };

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
}

export interface AfterSendInput {
  operationId: string;
  participant: ParticipantConfig;
  thread: ConversationThread;
  message: MessageData;
  actions: MiddlewareActionResult[];
  persistedMessageId?: string;
  signal?: AbortSignal;
  startIndex?: number;
}

export interface MiddlewareRunnerDependencies {
  registry: MiddlewareRegistry;
  authEngine: AuthEngine;
  toolRegistry: ToolRegistry;
  pendingApprovals: PendingApprovalRegistry;
  eventBus: EventBus;
  logger: MiddlewareLogger;
  conversationStore: ConversationStore;
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

interface PhaseSnapshots {
  participant: ParticipantConfig;
  activeChain: MessageData[];
  actions: MiddlewareActionResult[];
  eventBus: MiddlewareEventBus;
  logger: MiddlewareLogger;
}

interface HookLifecycle {
  accepting: boolean;
  cancelled: boolean;
  pending: Set<Promise<void>>;
}

const executionQueues = new WeakMap<ConversationStore, Map<string, Promise<void>>>();
const executionOwner = new AsyncLocalStorage<{
  store: ConversationStore;
  conversationId: string;
}>();
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
  if (owner?.store === store && owner.conversationId === conversationId) {
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
  try {
    return await executionOwner.run({ store, conversationId }, operation);
  } finally {
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`Middleware result ${field} must be a string`);
  return value;
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

  private async runMessagePhaseUnlocked(input: MessagePhaseInput): Promise<MessagePhaseResult> {
    if (input.signal?.aborted) return abortResult(CANCELLATION_ERROR);
    let current = cloneDraft(input.draft, '$.draft');
    const instances = input.participant.middleware ?? [];
    const startIndex = validateStartIndex(input.startIndex, instances.length);
    const snapshots = this.buildPhaseSnapshots(input);
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
        if (kind === 'tool') throw new TypeError('Middleware tool outcomes are unsupported');
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
    const snapshots = this.buildPhaseSnapshots(input);
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
        if (kind === 'tool') throw new TypeError('Middleware tool outcomes are unsupported');
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
    const snapshots = this.buildPhaseSnapshots(input);
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
        if (kind === 'tool') throw new TypeError('Middleware tool outcomes are unsupported');
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
    const snapshots = this.buildPhaseSnapshots(input);
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
        if (kind === 'tool') throw new TypeError('Middleware tool outcomes are unsupported');
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
        | ((context: object) => unknown | Promise<unknown>)
        | undefined;
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
    const participant = cloneJsonSafe(snapshots.participant, '$.participant');
    const detachedInstance = cloneJsonSafe(instance, '$.instance');
    const config = cloneJsonSafe(instance.config, '$.config');
    const activeChain = cloneJsonSafe(snapshots.activeChain, '$.activeChain');
    const actions = cloneJsonSafe(snapshots.actions, '$.actions');
    return {
      operationId: input.operationId,
      participant,
      instance: detachedInstance,
      config,
      conversationId: input.thread.id,
      activeChain,
      actions,
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
      participant: cloneJsonSafe(input.participant, '$.participant'),
      activeChain: input.thread.activeChain.map((message, index) =>
        cloneMessage(message, `$.activeChain[${index}]`),
      ),
      actions: cloneJsonSafe(input.actions, '$.actions'),
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
