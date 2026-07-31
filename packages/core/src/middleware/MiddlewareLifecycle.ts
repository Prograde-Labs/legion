import type {
  LLMChunk,
  MessageData,
  MessageDraft,
  MessageUsage,
  MiddlewareActionResult,
  ParticipantConfig,
} from '@legion/types';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeResult } from '../runtime/Runtime.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import type { EventBus } from '../events/EventBus.js';
import type { MessageRouterResult } from '../tools/Tool.js';
import type { AutomationCompactionSeed } from '../auth/PendingApprovalRegistry.js';
import type {
  AfterReceivePhaseResult,
  AfterSendPhaseResult,
  MessagePhaseResult,
} from './MiddlewareRunner.js';
import { MiddlewareRunner } from './MiddlewareRunner.js';

export type InboundLifecycleResult =
  | { kind: 'continue'; value: MessageData; actions: MiddlewareActionResult[] }
  | { kind: 'complete'; value: MessageData; actions: MiddlewareActionResult[] }
  | {
      kind: 'respond';
      value: MessageData;
      response: MessageDraft;
      actions: MiddlewareActionResult[];
    }
  | { kind: 'error'; error: string; partial?: boolean; storedMessageId?: string }
  | {
      kind: 'pending_approval';
      approvalId: string;
      checkpointId: string;
      participantId: string;
      partial?: boolean;
      storedMessageId?: string;
    };

export interface ReceiveLifecycleInput {
  operationId: string;
  sender: ParticipantConfig;
  recipient: ParticipantConfig;
  thread: ConversationThread;
  draft: MessageDraft;
  actions: MiddlewareActionResult[];
  mode: 'pre_runtime' | 'post_response';
  usage?: MessageUsage;
  signal?: AbortSignal;
  /** Final streaming delivery already ran response draft hooks. */
  skipDraftHooks?: boolean;
  approvalContinuationSeed?: AutomationCompactionSeed;
}

export interface RespondLifecycleInput extends Omit<ReceiveLifecycleInput, 'mode'> {}

export interface ResponseStreamInput {
  operationId: string;
  sender: ParticipantConfig;
  recipient: ParticipantConfig;
  thread: ConversationThread;
  actions: MiddlewareActionResult[];
  signal?: AbortSignal;
}

export interface ResponseStreamTransformer {
  readonly signal: AbortSignal;
  push(chunk: LLMChunk): Promise<LLMChunk[]>;
  finish(result: RuntimeResult): Promise<{ chunks: LLMChunk[]; result: MessageRouterResult }>;
  finalizePartial(): Promise<{ chunks: LLMChunk[]; result: MessageRouterResult } | undefined>;
  abort(): LLMChunk[];
  dispose(): void;
}

export class MiddlewareStreamError extends Error {
  constructor(
    message: string,
    readonly chunks: LLMChunk[],
    readonly lifecycleResult: Extract<
      InboundLifecycleResult,
      { kind: 'error' | 'pending_approval' }
    >,
  ) {
    super(message);
  }
}

function actionsCopy(actions: MiddlewareActionResult[]): MiddlewareActionResult[] {
  return structuredClone(actions);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MiddlewareLifecycle {
  constructor(
    private readonly runner: MiddlewareRunner,
    private readonly eventBus: EventBus,
  ) {}

  async receive(input: ReceiveLifecycleInput): Promise<InboundLifecycleResult> {
    if (
      input.draft.senderId !== input.sender.id ||
      input.draft.recipientId !== input.recipient.id
    ) {
      return {
        kind: 'error',
        error: 'Middleware lifecycle draft identity does not match sender and recipient',
      };
    }
    let stored: MessageData | undefined;
    try {
      let draft = input.draft;
      let actions = actionsCopy(input.actions);
      if (!input.skipDraftHooks) {
        const senderBefore = await this.runner.runMessagePhase({
          operationId: input.operationId,
          phase: 'beforeSend',
          participant: input.sender,
          thread: input.thread,
          draft,
          actions,
          final: true,
          mode: input.mode,
          signal: input.signal,
          approvalContinuationSeed: input.approvalContinuationSeed,
        });
        if (senderBefore.kind !== 'continue') return this.messageTerminal(senderBefore);
        draft = senderBefore.value;
        actions = senderBefore.actions;

        const recipientBefore = await this.runner.runMessagePhase({
          operationId: input.operationId,
          phase: 'beforeReceive',
          participant: input.recipient,
          thread: input.thread,
          draft,
          actions: actionsCopy(actions),
          final: true,
          mode: input.mode,
          signal: input.signal,
          approvalContinuationSeed: input.approvalContinuationSeed,
        });
        if (recipientBefore.kind !== 'continue') return this.messageTerminal(recipientBefore);
        draft = recipientBefore.value;
        actions = recipientBefore.actions;
      }

      if (input.signal?.aborted) {
        return { kind: 'error', error: 'Middleware operation cancelled' };
      }
      stored = await input.thread.append(
        {
          ...draft,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
        },
        {
          reactivate: input.mode === 'pre_runtime',
          signal: input.signal,
        },
      );
      this.eventBus.emit('message:sent', {
        conversationId: input.thread.id,
        senderId: stored.senderId,
        recipientId: stored.recipientId,
        messageId: stored.id,
      });

      const senderAfter = await this.runner.runAfterSend({
        operationId: input.operationId,
        participant: input.sender,
        thread: input.thread,
        message: stored,
        persistedMessageId: stored.id,
        actions: actionsCopy(actions),
        mode: input.mode,
        signal: input.signal,
        approvalContinuationSeed: input.approvalContinuationSeed,
      });
      if (senderAfter.kind !== 'continue') return this.afterSendTerminal(senderAfter, stored.id);

      const recipientAfter = await this.runner.runAfterReceive({
        operationId: input.operationId,
        participant: input.recipient,
        thread: input.thread,
        message: stored,
        persistedMessageId: stored.id,
        mode: input.mode,
        actions: actionsCopy(senderAfter.actions),
        signal: input.signal,
        approvalContinuationSeed: input.approvalContinuationSeed,
      });
      return this.afterReceiveTerminal(recipientAfter, stored);
    } catch (error) {
      return {
        kind: 'error',
        error: errorMessage(error),
        ...(stored === undefined ? {} : { partial: true, storedMessageId: stored.id }),
      };
    }
  }

  async respond(input: RespondLifecycleInput): Promise<MessageRouterResult> {
    const result = await this.receive({ ...input, mode: 'post_response' });
    if (result.kind === 'continue' || result.kind === 'complete') {
      this.eventBus.emit('message:delivered', {
        conversationId: input.thread.id,
        recipientId: result.value.recipientId,
        messageId: result.value.id,
      });
      return {
        conversationId: input.thread.id,
        response: result.value.content,
        status: 'success',
      };
    }
    if (result.kind === 'pending_approval') {
      return {
        conversationId: input.thread.id,
        status: 'pending_approval',
        approvalId: result.approvalId,
        checkpointId: result.checkpointId,
        pendingParticipantId: result.participantId,
        ...(result.partial === undefined ? {} : { partial: result.partial }),
        ...(result.storedMessageId === undefined
          ? {}
          : { storedMessageId: result.storedMessageId }),
      };
    }
    if (result.kind === 'respond') {
      return {
        conversationId: input.thread.id,
        status: 'error',
        error: 'Middleware response pipeline returned an unexpected response',
        partial: true,
        storedMessageId: result.value.id,
      };
    }
    return {
      conversationId: input.thread.id,
      status: 'error',
      error: result.error,
      ...(result.partial === undefined ? {} : { partial: result.partial }),
      ...(result.storedMessageId === undefined ? {} : { storedMessageId: result.storedMessageId }),
    };
  }

  createResponseStream(input: ResponseStreamInput): ResponseStreamTransformer {
    return new ResponseStreamTransformerImpl(this, input);
  }

  async runResponseDraft(
    input: ResponseStreamInput,
    draft: MessageDraft,
    final: boolean,
    actions: MiddlewareActionResult[],
    controller: AbortController,
    iteration?: number,
    chunk?: LLMChunk,
  ): Promise<MessagePhaseResult> {
    const senderBefore = await this.runner.runMessagePhase({
      operationId: input.operationId,
      phase: 'beforeSend',
      participant: input.sender,
      thread: input.thread,
      draft,
      actions: actionsCopy(actions),
      final,
      mode: 'post_response',
      ...(iteration === undefined ? {} : { iteration }),
      ...(chunk === undefined ? {} : { chunk }),
      signal: controller.signal,
    });
    if (senderBefore.kind !== 'continue') return senderBefore;
    return this.runner.runMessagePhase({
      operationId: input.operationId,
      phase: 'beforeReceive',
      participant: input.recipient,
      thread: input.thread,
      draft: senderBefore.value,
      actions: actionsCopy(senderBefore.actions),
      final,
      mode: 'post_response',
      ...(iteration === undefined ? {} : { iteration }),
      ...(chunk === undefined ? {} : { chunk }),
      signal: controller.signal,
    });
  }

  messageTerminal(
    result: Exclude<MessagePhaseResult, { kind: 'continue' }>,
  ): Extract<InboundLifecycleResult, { kind: 'error' | 'pending_approval' }> {
    if (result.kind === 'pending_approval') {
      return {
        kind: 'pending_approval',
        approvalId: result.approvalId,
        checkpointId: result.checkpointId,
        participantId: result.participantId,
      };
    }
    return { kind: 'error', error: result.error };
  }

  private afterSendTerminal(
    result: Exclude<AfterSendPhaseResult, { kind: 'continue' }>,
    storedMessageId?: string,
  ): InboundLifecycleResult {
    if (result.kind === 'pending_approval') {
      return {
        kind: 'pending_approval',
        approvalId: result.approvalId,
        checkpointId: result.checkpointId,
        participantId: result.participantId,
        partial: true,
        ...(storedMessageId === undefined ? {} : { storedMessageId }),
      };
    }
    return {
      kind: 'error',
      error: result.error,
      partial: result.persisted,
      ...(result.storedMessageId === undefined ? {} : { storedMessageId: result.storedMessageId }),
    };
  }

  private afterReceiveTerminal(
    result: AfterReceivePhaseResult,
    stored: MessageData,
  ): InboundLifecycleResult {
    if (result.kind === 'continue') {
      return { kind: 'continue', value: stored, actions: actionsCopy(result.actions) };
    }
    if (result.kind === 'complete') {
      return { kind: 'complete', value: stored, actions: actionsCopy(result.actions) };
    }
    if (result.kind === 'respond') {
      return {
        kind: 'respond',
        value: stored,
        response: structuredClone(result.draft),
        actions: actionsCopy(result.actions),
      };
    }
    if (result.kind === 'pending_approval') {
      return {
        kind: 'pending_approval',
        approvalId: result.approvalId,
        checkpointId: result.checkpointId,
        participantId: result.participantId,
        partial: true,
        storedMessageId: stored.id,
      };
    }
    return {
      kind: 'error',
      error: result.error,
      partial: result.persisted,
      ...(result.storedMessageId === undefined ? {} : { storedMessageId: result.storedMessageId }),
    };
  }
}

class ResponseStreamTransformerImpl implements ResponseStreamTransformer {
  private readonly controller = new AbortController();
  private raw: MessageDraft;
  private emitted: MessageDraft;
  private approved: MessageDraft;
  private iteration: number | undefined;
  private actions: MiddlewareActionResult[];
  private terminated = false;
  private readonly forwardAbort?: () => void;
  private partialFinalization?: Promise<
    { chunks: LLMChunk[]; result: MessageRouterResult } | undefined
  >;

  constructor(
    private readonly lifecycle: MiddlewareLifecycle,
    private readonly input: ResponseStreamInput,
  ) {
    this.raw = this.baseDraft();
    this.emitted = this.baseDraft();
    this.approved = this.baseDraft();
    this.actions = actionsCopy(input.actions);
    if (input.signal) {
      if (input.signal.aborted) this.controller.abort();
      else {
        this.forwardAbort = () => this.controller.abort();
        input.signal.addEventListener('abort', this.forwardAbort, { once: true });
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(): LLMChunk[] {
    this.terminated = true;
    this.controller.abort();
    return this.retract();
  }

  dispose(): void {
    if (this.forwardAbort) this.input.signal?.removeEventListener('abort', this.forwardAbort);
  }

  async push(chunk: LLMChunk): Promise<LLMChunk[]> {
    if (this.terminated) return [];
    if (chunk.type === 'iteration_start') {
      this.iteration = chunk.iteration;
      this.raw = this.baseDraft();
      this.emitted = this.baseDraft();
      this.approved = this.baseDraft();
      return [chunk];
    }
    if (chunk.type !== 'text_delta' && chunk.type !== 'reasoning_delta') return [chunk];
    this.raw = {
      ...this.raw,
      ...(chunk.type === 'text_delta'
        ? { content: `${this.raw.content}${chunk.delta}` }
        : { reasoning: `${this.raw.reasoning ?? ''}${chunk.delta}` }),
    };
    const phase = await this.lifecycle.runResponseDraft(
      this.input,
      this.raw,
      false,
      this.actions,
      this.controller,
      this.iteration,
      chunk,
    );
    if (this.terminated) return [];
    if (phase.kind !== 'continue') throw this.terminalError(phase);
    this.actions = actionsCopy(phase.actions);
    const next = phase.value;
    const chunks = diffDraft(this.emitted, next);
    this.emitted = structuredClone(next);
    this.approved = structuredClone(next);
    return chunks;
  }

  async finish(
    result: RuntimeResult,
  ): Promise<{ chunks: LLMChunk[]; result: MessageRouterResult }> {
    if (this.terminated || this.controller.signal.aborted) {
      const partial = await this.finalizePartial();
      if (partial) return partial;
      throw new MiddlewareStreamError('Middleware response stream aborted', this.retract(), {
        kind: 'error',
        error: 'Middleware response stream aborted',
      });
    }
    if (result.kind !== 'response') {
      return {
        chunks: this.retract(),
        result: { conversationId: this.input.thread.id, status: 'success' },
      };
    }
    let actions: MiddlewareActionResult[];
    try {
      actions = mergeActions(this.input.actions, this.actions, result.actions ?? []);
    } catch (error) {
      this.terminated = true;
      this.controller.abort();
      throw new MiddlewareStreamError(
        error instanceof Error ? error.message : String(error),
        this.retract(),
        { kind: 'error', error: 'Conflicting middleware action ledger' },
      );
    }
    this.actions = actionsCopy(actions);
    const phasePromise = this.lifecycle.runResponseDraft(
      this.input,
      {
        ...this.baseDraft(),
        content: result.content,
        ...(result.reasoning === undefined ? {} : { reasoning: result.reasoning }),
      },
      true,
      actions,
      this.controller,
    );
    const phase = await this.unlessAborted(phasePromise, this.controller.signal);
    if (phase === undefined || this.controller.signal.aborted) {
      const partial = await this.finalizePartial();
      if (partial) return partial;
      throw new MiddlewareStreamError('Middleware response stream aborted', this.retract(), {
        kind: 'error',
        error: 'Middleware response stream aborted',
      });
    }
    if (phase.kind !== 'continue') throw this.terminalError(phase);
    this.actions = actionsCopy(phase.actions);
    const finalDraft = phase.value;
    const chunks = diffDraft(this.emitted, finalDraft);
    this.emitted = structuredClone(finalDraft);
    this.approved = structuredClone(finalDraft);
    const deliveryController = new AbortController();
    const delivered = await this.lifecycle.respond({
      operationId: this.input.operationId,
      sender: this.input.sender,
      recipient: this.input.recipient,
      thread: this.input.thread,
      draft: finalDraft,
      actions: this.actions,
      signal: deliveryController.signal,
      skipDraftHooks: true,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    });
    return { chunks, result: delivered };
  }

  finalizePartial(): Promise<{ chunks: LLMChunk[]; result: MessageRouterResult } | undefined> {
    this.partialFinalization ??= this.finalizePartialInner();
    return this.partialFinalization;
  }

  private async finalizePartialInner(): Promise<
    { chunks: LLMChunk[]; result: MessageRouterResult } | undefined
  > {
    const partial = structuredClone(this.approved);
    this.terminated = true;
    this.controller.abort();
    if (partial.content === '' && partial.reasoning === undefined) return undefined;

    this.emitted = structuredClone(partial);
    const finalController = new AbortController();
    const phase = await this.lifecycle.runResponseDraft(
      this.input,
      partial,
      true,
      this.actions,
      finalController,
    );
    if (phase.kind !== 'continue') throw this.terminalError(phase);
    this.actions = actionsCopy(phase.actions);
    const finalDraft = phase.value;
    const chunks = diffDraft(this.emitted, finalDraft);
    this.emitted = structuredClone(finalDraft);
    this.approved = structuredClone(finalDraft);
    const delivered = await this.lifecycle.respond({
      operationId: this.input.operationId,
      sender: this.input.sender,
      recipient: this.input.recipient,
      thread: this.input.thread,
      draft: finalDraft,
      actions: this.actions,
      signal: finalController.signal,
      skipDraftHooks: true,
    });
    return { chunks, result: delivered };
  }

  private async unlessAborted<T>(
    operation: Promise<T>,
    signal: AbortSignal,
  ): Promise<T | undefined> {
    if (signal.aborted) {
      void operation.catch(() => undefined);
      return undefined;
    }
    let removeAbort: () => void = () => undefined;
    const aborted = new Promise<undefined>((resolve) => {
      const abort = () => resolve(undefined);
      removeAbort = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      removeAbort();
    }
  }

  private baseDraft(): MessageDraft {
    return {
      senderId: this.input.sender.id,
      recipientId: this.input.recipient.id,
      role: 'assistant',
      content: '',
    };
  }

  private retract(force = false): LLMChunk[] {
    const emitted = this.emitted.content !== '' || this.emitted.reasoning !== undefined;
    this.emitted = this.baseDraft();
    return emitted || force ? [{ type: 'message_snapshot', content: '' }] : [];
  }

  private terminalError(
    phase: Exclude<MessagePhaseResult, { kind: 'continue' }>,
  ): MiddlewareStreamError {
    this.terminated = true;
    this.controller.abort();
    const lifecycleResult = this.lifecycle.messageTerminal(phase);
    return new MiddlewareStreamError(
      lifecycleResult.kind === 'error'
        ? lifecycleResult.error
        : 'Middleware response stream stopped',
      this.retract(true),
      lifecycleResult,
    );
  }
}

function mergeActions(...ledgers: MiddlewareActionResult[][]): MiddlewareActionResult[] {
  const merged = new Map<string, MiddlewareActionResult>();
  for (const ledger of ledgers) {
    for (const action of ledger) {
      const existing = merged.get(action.requestId);
      if (existing === undefined) {
        merged.set(action.requestId, structuredClone(action));
      } else if (!isDeepStrictEqual(existing, action)) {
        throw new Error(`Conflicting middleware action result for request ${action.requestId}`);
      }
    }
  }
  return [...merged.values()];
}

function diffDraft(previous: MessageDraft, current: MessageDraft): LLMChunk[] {
  const priorReasoning = previous.reasoning ?? '';
  const nextReasoning = current.reasoning ?? '';
  const contentAppends = current.content.startsWith(previous.content);
  const reasoningAppends = nextReasoning.startsWith(priorReasoning);
  if (!contentAppends || !reasoningAppends) {
    return [
      {
        type: 'message_snapshot',
        content: current.content,
        ...(current.reasoning === undefined ? {} : { reasoning: current.reasoning }),
      },
    ];
  }
  const chunks: LLMChunk[] = [];
  const reasoningDelta = nextReasoning.slice(priorReasoning.length);
  const contentDelta = current.content.slice(previous.content.length);
  if (reasoningDelta) chunks.push({ type: 'reasoning_delta', delta: reasoningDelta });
  if (contentDelta) chunks.push({ type: 'text_delta', delta: contentDelta });
  return chunks;
}
