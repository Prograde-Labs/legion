import { isDeepStrictEqual } from 'node:util';
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
  MiddlewareLogger,
  MiddlewarePhase,
  ParticipantConfig,
} from '@legion/types';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import type { EventBus } from '../events/EventBus.js';
import type { ToolContext } from '../tools/Tool.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
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
  result: Record<string, unknown>;
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

type HookExecution = HookSuccess | HookFailure | HookSkipped;

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
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`Value at ${path} is not JSON-safe: symbol keys are unsupported`);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
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

function safeError(error: unknown): { name: string; message: string } {
  if (typeof error === 'string') return { name: 'Error', message: error };
  if (error === null || typeof error !== 'object') {
    return { name: 'Error', message: String(error) };
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(error);
  } catch {
    return { name: 'Error', message: 'Middleware hook failed' };
  }
  const ownName = descriptors.name;
  const ownMessage = descriptors.message;
  let name =
    ownName && 'value' in ownName && typeof ownName.value === 'string' ? ownName.value : 'Error';
  const message =
    ownMessage && 'value' in ownMessage && typeof ownMessage.value === 'string'
      ? ownMessage.value
      : 'Middleware hook failed';

  if (name === 'Error') {
    try {
      const prototype = Object.getPrototypeOf(error) as object | null;
      const prototypeName = prototype && Object.getOwnPropertyDescriptor(prototype, 'name');
      if (prototypeName && 'value' in prototypeName && typeof prototypeName.value === 'string') {
        name = prototypeName.value;
      }
    } catch {
      // Keep generic Error without touching accessors.
    }
  }
  return { name, message };
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

export class MiddlewareRunner {
  constructor(private readonly dependencies: MiddlewareRunnerDependencies) {}

  async runMessagePhase(input: MessagePhaseInput): Promise<MessagePhaseResult> {
    let current = cloneDraft(input.draft, '$.draft');
    const actions = cloneJsonSafe(input.actions, '$.actions');
    const instances = input.participant.middleware ?? [];
    const startIndex = validateStartIndex(input.startIndex, instances.length);
    for (let index = startIndex; index < instances.length; index += 1) {
      const instance = instances[index];
      if (!this.enabled(instance, input, input.phase)) continue;
      const execution = await this.invoke(instance, input.phase, input, (base) => ({
        ...base,
        message: cloneJsonSafe(current, '$.message'),
        final: input.final,
        ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
        ...(input.chunk === undefined ? {} : { chunk: cloneJsonSafe(input.chunk, '$.chunk') }),
      }));
      if (execution.status === 'skipped') continue;
      if (execution.status === 'failure') {
        if (execution.failureMode === 'closed') return abortResult(execution.error);
        continue;
      }

      try {
        const kind = requireString(execution.result.kind, 'kind');
        if (kind === 'continue') {
          if (execution.result.message !== undefined) {
            current = validateDraft(execution.result.message, current);
          }
          this.recordSuccess(instance, input.phase, input, execution);
          continue;
        }
        if (kind === 'reject') {
          const error = requireString(execution.result.error, 'error');
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
    return { kind: 'continue', value: cloneJsonSafe(current), actions: cloneJsonSafe(actions) };
  }

  async runAfterReceive(input: AfterReceiveInput): Promise<AfterReceivePhaseResult> {
    const persisted = persistedMessage(input.thread, input.message, input.persistedMessageId);
    const storedMessageId = persisted.id;
    const current = persisted.message;
    const actions = cloneJsonSafe(input.actions, '$.actions');
    const instances = input.participant.middleware ?? [];
    const startIndex = validateStartIndex(input.startIndex, instances.length);
    for (let index = startIndex; index < instances.length; index += 1) {
      const instance = instances[index];
      if (!this.enabled(instance, input, 'afterReceive')) continue;
      const execution = await this.invoke(instance, 'afterReceive', input, (base) => ({
        ...base,
        message: cloneJsonSafe(current, '$.message'),
        mode: input.mode,
      }));
      if (execution.status === 'skipped') continue;
      if (execution.status === 'failure') {
        if (execution.failureMode === 'closed') {
          return abortResult(execution.error, storedMessageId);
        }
        continue;
      }

      try {
        const kind = requireString(execution.result.kind, 'kind');
        if (kind === 'continue') {
          this.recordSuccess(instance, 'afterReceive', input, execution);
          continue;
        }
        if (kind === 'complete') {
          this.recordSuccess(instance, 'afterReceive', input, execution);
          return { kind: 'complete', actions: cloneJsonSafe(actions) };
        }
        if (kind === 'respond') {
          if (input.mode === 'post_response') {
            throw new TypeError('Middleware respond outcome is invalid in post_response mode');
          }
          const draft = validateDraft(execution.result.message, {
            senderId: input.participant.id,
            recipientId: current.replyTo ?? current.senderId,
            role: 'assistant',
            content: '',
          });
          this.recordSuccess(instance, 'afterReceive', input, execution);
          return {
            kind: 'respond',
            draft,
            actions: cloneJsonSafe(actions),
          };
        }
        if (kind === 'abort') {
          const error = requireString(execution.result.error, 'error');
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
    return { kind: 'continue', value: current, actions: cloneJsonSafe(actions) };
  }

  async runSystemPrompt(input: SystemPromptInput): Promise<SystemPromptPhaseResult> {
    if (input.participant.type !== 'agent') {
      throw new TypeError('Middleware system prompt requires an agent participant');
    }
    const storedMessageId = validatePersistedMessageId(input.thread, input.persistedMessageId);
    let current = input.prompt;
    const actions = cloneJsonSafe(input.actions, '$.actions');
    const instances = input.participant.middleware ?? [];
    const startIndex = validateStartIndex(input.startIndex, instances.length);
    for (let index = startIndex; index < instances.length; index += 1) {
      const instance = instances[index];
      if (!this.enabled(instance, input, 'buildSystemPrompt')) continue;
      const execution = await this.invoke(instance, 'buildSystemPrompt', input, (base) => ({
        ...base,
        prompt: current,
      }));
      if (execution.status === 'skipped') continue;
      if (execution.status === 'failure') {
        if (execution.failureMode === 'closed') {
          return abortResult(execution.error, storedMessageId);
        }
        continue;
      }

      try {
        const kind = requireString(execution.result.kind, 'kind');
        if (kind === 'continue') {
          if (execution.result.change !== undefined) {
            if (!isPlainRecord(execution.result.change)) {
              throw new TypeError('Middleware prompt change must be a plain object');
            }
            const operation = requireString(execution.result.change.operation, 'change.operation');
            const content = requireString(execution.result.change.content, 'change.content');
            if (operation === 'append') current += content;
            else if (operation === 'prepend') current = content + current;
            else if (operation === 'replace') current = content;
            else throw new TypeError(`Unsupported prompt change operation: ${operation}`);
          }
          this.recordSuccess(instance, 'buildSystemPrompt', input, execution);
          continue;
        }
        if (kind === 'abort') {
          const error = requireString(execution.result.error, 'error');
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
    return { kind: 'continue', value: current, actions: cloneJsonSafe(actions) };
  }

  async runAfterSend(input: AfterSendInput): Promise<AfterSendPhaseResult> {
    const persisted = persistedMessage(input.thread, input.message, input.persistedMessageId);
    const storedMessageId = persisted.id;
    const current = persisted.message;
    const actions = cloneJsonSafe(input.actions, '$.actions');
    const instances = input.participant.middleware ?? [];
    const startIndex = validateStartIndex(input.startIndex, instances.length);
    for (let index = startIndex; index < instances.length; index += 1) {
      const instance = instances[index];
      if (!this.enabled(instance, input, 'afterSend')) continue;
      const execution = await this.invoke(instance, 'afterSend', input, (base) => ({
        ...base,
        message: cloneJsonSafe(current, '$.message'),
      }));
      if (execution.status === 'skipped') continue;
      if (execution.status === 'failure') {
        if (execution.failureMode === 'closed') {
          return abortResult(execution.error, storedMessageId);
        }
        continue;
      }

      try {
        const kind = requireString(execution.result.kind, 'kind');
        if (kind === 'continue') {
          this.recordSuccess(instance, 'afterSend', input, execution);
          continue;
        }
        if (kind === 'abort') {
          const error = requireString(execution.result.error, 'error');
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
    return { kind: 'continue', value: current, actions: cloneJsonSafe(actions) };
  }

  private enabled(
    instance: MiddlewareInstanceConfig,
    input: CommonInput,
    phase: MiddlewarePhase,
  ): boolean {
    if (instance.enabled !== false) return true;
    const started = performance.now();
    this.dependencies.logger.debug('Middleware hook skipped', {
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
      const context = phaseContext(this.buildBaseContext(instance, input, signal));
      const rawResult = await hook(context);
      const result = cloneJsonSafe(rawResult, '$.result');
      if (!isPlainRecord(result)) throw new TypeError('Middleware result must be a plain object');
      return {
        status: 'success',
        result,
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
  ): MiddlewareHookContext<unknown> {
    const participant = cloneJsonSafe(input.participant, '$.participant');
    const detachedInstance = cloneJsonSafe(instance, '$.instance');
    const config = cloneJsonSafe(instance.config, '$.config');
    const activeChain = input.thread.activeChain.map((message, index) =>
      cloneMessage(message, `$.activeChain[${index}]`),
    );
    const actions = cloneJsonSafe(input.actions, '$.actions');
    return {
      operationId: input.operationId,
      participant,
      instance: detachedInstance,
      config,
      conversationId: input.thread.id,
      activeChain,
      actions,
      getState: () => {
        const state = input.thread.data.middlewareState?.[input.participant.id]?.[instance.id];
        return state === undefined ? undefined : cloneJsonSafe(state, '$.state');
      },
      setState: async (value: JSONValue) => {
        const detached = cloneJsonSafe(value, '$.state');
        const mutation = await this.dependencies.conversationStore.mutate(
          input.thread.id,
          (conversation) => ({
            ...conversation,
            middlewareState: {
              ...conversation.middlewareState,
              [input.participant.id]: {
                ...conversation.middlewareState?.[input.participant.id],
                [instance.id]: detached,
              },
            },
          }),
        );
        input.thread.data = mutation.after;
      },
      signal,
      eventBus: this.dependencies.eventBus,
      logger: this.dependencies.logger,
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
    const details = safeError(error);
    const failureMode = resolvedFailureMode ?? this.failureMode(instance);
    this.dependencies.eventBus.emit('middleware:error', {
      conversationId: input.thread.id,
      participantId: input.participant.id,
      instanceId: instance.id,
      middlewareType: instance.type,
      phase,
      failureMode,
      error: details,
    });
    this.dependencies.logger.warn('Middleware hook failed', {
      ...this.logFields(instance, phase, input, duration),
      failureMode,
    });
    return { status: 'failure', failureMode, error: details.message };
  }

  private recordSuccess(
    instance: MiddlewareInstanceConfig,
    phase: MiddlewarePhase,
    input: CommonInput,
    execution: HookSuccess,
  ): void {
    this.dependencies.logger.debug('Middleware hook completed', {
      ...this.logFields(instance, phase, input, execution.duration),
      failureMode: execution.failureMode,
    });
  }

  private failureMode(instance: MiddlewareInstanceConfig): FailureMode {
    if (instance.failureMode) return instance.failureMode;
    return this.dependencies.registry.get(instance.type)?.defaultFailureMode ?? 'closed';
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
