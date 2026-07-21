import { isDeepStrictEqual } from 'node:util';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import type { Collective } from '../collective/Collective.js';
import type { EventBus } from '../events/EventBus.js';
import type { ToolContext, MessageRouterPort, MessageRouterResult } from '../tools/Tool.js';
import {
  archiveAutomationHelper,
  snapshotMiddlewareActions,
} from '../auth/PendingApprovalRegistry.js';
import type {
  ApprovalRecord,
  AutomationCompactionContinuation,
  AutomationCompactionSeed,
  AutomationTitleContinuation,
  PendingApprovalRegistry,
} from '../auth/PendingApprovalRegistry.js';
import { ParticipantNotFoundError } from '../errors/LegionError.js';
import type { RuntimeRegistry } from './RuntimeRegistry.js';
import type { RuntimeContext, RuntimeResult } from './Runtime.js';
import type {
  AgentConfig,
  ConversationOrigin,
  MessageUsage,
  LLMChunk,
  MessageDraft,
  MiddlewareActionResult,
} from '@legion/types';
import { createId } from '../util/ids.js';
import {
  MiddlewareLifecycle,
  MiddlewareStreamError,
  type InboundLifecycleResult,
  type ResponseStreamTransformer,
} from '../middleware/MiddlewareLifecycle.js';
import type { MiddlewareRunner } from '../middleware/MiddlewareRunner.js';
import { compactRange, getActiveChain } from '../conversation/conversation-ops.js';

export interface SendOptions {
  senderId: string;
  recipientId: string;
  message: string;
  conversationId?: string;
  replyTo?: string;
  origin?: ConversationOrigin;
  context: ToolContext;
}

const DEFAULT_DEPTH_LIMIT = 10;

class RetryableAutomationError extends Error {}

type ResponseOperation = {
  thread: ConversationThread;
  recipientId: string;
  responseRecipientId: string;
  lifecycleState?: {
    operationId: string;
    actions: MiddlewareActionResult[];
    context: ToolContext;
    storedMessageId?: string;
  };
};

export class MessageRouter implements MessageRouterPort {
  private background = new Set<Promise<void>>();
  private locks = new Map<string, Promise<void>>();

  constructor(
    private store: ConversationStore,
    private registry: RuntimeRegistry,
    private collective: Collective,
    private eventBus: EventBus,
    private lifecycle?: MiddlewareLifecycle,
    private middlewareRunner?: MiddlewareRunner,
  ) {}

  /** Await all in-flight fire-and-forget dispatches (test/shutdown aid). */
  async drain(): Promise<void> {
    await Promise.all([...this.background]);
  }

  private withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    return this.acquireLock(conversationId).then(async (release) => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  private async acquireLock(conversationId: string): Promise<() => void> {
    const prev = this.locks.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    const queued = prev.then(() => next);
    this.locks.set(conversationId, queued);
    await prev;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.locks.get(conversationId) === queued) this.locks.delete(conversationId);
    };
  }

  private combineAbortSignals(signal?: AbortSignal): {
    signal: AbortSignal;
    abort(): void;
    dispose(): void;
  } {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      dispose: () => signal?.removeEventListener('abort', forwardAbort),
    };
  }

  private async nextStreamResult(
    stream: AsyncGenerator<LLMChunk, RuntimeResult>,
    signal: AbortSignal,
  ): Promise<IteratorResult<LLMChunk, RuntimeResult> | undefined> {
    if (signal.aborted) return undefined;
    let removeAbort: () => void = () => undefined;
    const aborted = new Promise<undefined>((resolve) => {
      const abort = () => resolve(undefined);
      removeAbort = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([stream.next(), aborted]);
    } finally {
      removeAbort();
    }
  }

  private async getThread(
    conversationId?: string,
    creation?: {
      parentConversationId?: string;
      parentToolCallId?: string;
      origin?: ConversationOrigin;
    },
    signal?: AbortSignal,
  ): Promise<ConversationThread> {
    if (conversationId) {
      const existing = await this.store.load(conversationId);
      if (existing) return new ConversationThread(existing, this.store);
    }
    const created = await this.store.create(
      {
        schemaVersion: '2.0',
        activeBranchHead: '',
        messages: {},
        parentConversationId: creation?.origin
          ? creation.origin.parentConversationId
          : creation?.parentConversationId,
        parentToolCallId: creation?.origin
          ? creation.origin.parentToolCallId
          : creation?.parentToolCallId,
        origin: creation?.origin,
      },
      { signal },
    );
    return new ConversationThread(created, this.store);
  }

  private createAppendSafeThread(thread: ConversationThread): ConversationThread {
    return new ConversationThread(thread.data, this.store, (guardedThread, append) =>
      this.withLock(guardedThread.id, async () => {
        await guardedThread.reload();
        return append();
      }),
    );
  }

  private createAbortSafeThread(
    thread: ConversationThread,
    signal: AbortSignal,
  ): ConversationThread {
    return new ConversationThread(thread.data, this.store, undefined, signal);
  }

  private buildRuntimeContext(
    thread: ConversationThread,
    participantId: string,
    toolContext: ToolContext,
    depth: number,
    middlewareState?: {
      operationId: string;
      incomingMessageId: string;
      actions: MiddlewareActionResult[];
    },
  ): RuntimeContext {
    const participant = this.collective.getOrThrow(participantId);
    const context: RuntimeContext = {
      ...(toolContext as RuntimeContext),
      participant,
      conversationId: thread.id,
      conversation: thread,
      communicationDepth: depth,
      messageRouter: this,
      ...(middlewareState === undefined
        ? {}
        : { middlewareActions: snapshotMiddlewareActions(middlewareState.actions) }),
    };
    if (
      this.lifecycle &&
      this.middlewareRunner &&
      middlewareState &&
      participant.type === 'agent'
    ) {
      const agent = participant as AgentConfig;
      context.buildSystemPrompt = async ({ basePrompt, iteration, incomingMessageId, actions }) => {
        const result = await this.middlewareRunner!.runSystemPrompt({
          operationId: middlewareState.operationId,
          participant: agent,
          thread,
          prompt: basePrompt,
          actions,
          persistedMessageId: incomingMessageId,
          signal: toolContext.signal,
          runtimeResume: {
            kind: 'agent_provider',
            participantId: agent.id,
            incomingMessageId: middlewareState.incomingMessageId,
            iteration,
            preparedPrompt: basePrompt,
            actionCursor: actions.length,
            actions,
          },
          approvalContinuationSeed: toolContext.approvalContinuationSeed,
        });
        if (result.kind === 'continue') {
          return { kind: 'continue', prompt: result.value, actions: result.actions };
        }
        if (result.kind === 'pending_approval') {
          return {
            kind: 'pending',
            approvalId: result.approvalId,
            checkpointId: result.checkpointId,
            preparedPrompt: basePrompt,
            actionCursor: actions.length,
          };
        }
        return { kind: 'abort', error: result.error };
      };
    }
    return context;
  }

  private async persistResponse(
    thread: ConversationThread,
    senderId: string,
    recipientId: string,
    response: { content: string; reasoning?: string; usage?: MessageUsage },
    lifecycleState?: {
      operationId: string;
      actions: MiddlewareActionResult[];
      context: ToolContext;
      storedMessageId?: string;
    },
  ): Promise<MessageRouterResult> {
    if (this.lifecycle && lifecycleState) {
      return this.respondWithLifecycle(
        thread,
        {
          senderId,
          recipientId,
          role: 'assistant',
          content: response.content,
          ...(response.reasoning === undefined ? {} : { reasoning: response.reasoning }),
        },
        lifecycleState,
        response.usage,
      );
    }
    const responseMsg = await thread.append({
      senderId,
      recipientId,
      role: 'assistant',
      content: response.content,
      reasoning: response.reasoning,
      usage: response.usage,
    });
    this.eventBus.emit('message:delivered', {
      conversationId: thread.id,
      recipientId,
      messageId: responseMsg.id,
    });
    return { conversationId: thread.id, response: response.content, status: 'success' };
  }

  private withRuntimeActions(
    lifecycleState:
      | {
          operationId: string;
          actions: MiddlewareActionResult[];
          context: ToolContext;
          storedMessageId?: string;
        }
      | undefined,
    result: RuntimeResult,
  ) {
    if (!lifecycleState || result.actions === undefined) return lifecycleState;
    return {
      ...lifecycleState,
      actions: snapshotMiddlewareActions(result.actions, '$.runtimeActions'),
    };
  }

  private approvalRequests(context: ToolContext, approvalId: string) {
    const registry = context.pendingApprovalRegistry as
      | {
          get(id: string): NonNullable<MessageRouterResult['approvalRequests']>[number] | undefined;
        }
      | undefined;
    const request = registry?.get(approvalId);
    return request === undefined ? [] : [request];
  }

  private mapLifecycleResult(
    result: Exclude<InboundLifecycleResult, { kind: 'continue' | 'respond' }>,
    conversationId: string,
    context: ToolContext,
  ): MessageRouterResult {
    if (result.kind === 'complete') return { conversationId, status: 'success' };
    if (result.kind === 'pending_approval') {
      return {
        conversationId,
        status: 'pending_approval',
        approvalId: result.approvalId,
        checkpointId: result.checkpointId,
        pendingParticipantId: result.participantId,
        approvalRequests: this.approvalRequests(context, result.approvalId),
        ...(result.partial === undefined ? {} : { partial: result.partial }),
        ...(result.storedMessageId === undefined
          ? {}
          : { storedMessageId: result.storedMessageId }),
      };
    }
    return {
      conversationId,
      status: 'error',
      error: result.error,
      ...(result.partial === undefined ? {} : { partial: result.partial }),
      ...(result.storedMessageId === undefined ? {} : { storedMessageId: result.storedMessageId }),
    };
  }

  private async respondWithLifecycle(
    thread: ConversationThread,
    draft: MessageDraft,
    state: { operationId: string; actions: MiddlewareActionResult[]; context: ToolContext },
    usage?: MessageUsage,
  ): Promise<MessageRouterResult> {
    if (!this.lifecycle) throw new Error('Middleware lifecycle is unavailable');
    const sender = this.collective.get(draft.senderId);
    const recipient = this.collective.get(draft.recipientId);
    if (!sender) {
      return {
        conversationId: thread.id,
        status: 'error',
        error: new ParticipantNotFoundError(draft.senderId).message,
      };
    }
    if (!recipient) {
      return {
        conversationId: thread.id,
        status: 'error',
        error: new ParticipantNotFoundError(draft.recipientId).message,
      };
    }
    const result = await this.lifecycle.respond({
      operationId: state.operationId,
      sender,
      recipient,
      thread,
      draft,
      actions: state.actions,
      signal: state.context.signal,
      approvalContinuationSeed: state.context.approvalContinuationSeed,
      ...(usage === undefined ? {} : { usage }),
    });
    if (result.status !== 'pending_approval' || !result.approvalId) return result;
    return { ...result, approvalRequests: this.approvalRequests(state.context, result.approvalId) };
  }

  async send(opts: SendOptions): Promise<MessageRouterResult> {
    if (!this.collective.get(opts.senderId)) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: new ParticipantNotFoundError(opts.senderId).message,
      };
    }
    if (!this.collective.get(opts.recipientId)) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: new ParticipantNotFoundError(opts.recipientId).message,
      };
    }
    if (opts.conversationId) {
      return this.withLock(opts.conversationId, () => this.sendInner(opts));
    }
    return this.sendInner(opts);
  }

  sendStream(opts: SendOptions): AsyncGenerator<LLMChunk, MessageRouterResult> {
    const controller = new AbortController();
    const signal = opts.context.signal
      ? AbortSignal.any([opts.context.signal, controller.signal])
      : controller.signal;
    const inner = this.sendStreamWithController({ ...opts, context: { ...opts.context, signal } });
    return {
      next: (...args) => inner.next(...args),
      return: (value) => {
        controller.abort();
        return inner.return(value as never);
      },
      throw: (error) => {
        controller.abort();
        return inner.throw(error);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  private async *sendStreamWithController(
    opts: SendOptions,
  ): AsyncGenerator<LLMChunk, MessageRouterResult> {
    let release: (() => void) | undefined;
    let lockedConversationId: string | undefined;
    const ensureLock = async (conversationId: string) => {
      if (lockedConversationId === conversationId) return;
      release?.();
      release = await this.acquireLock(conversationId);
      lockedConversationId = conversationId;
    };
    try {
      if (opts.conversationId) await ensureLock(opts.conversationId);
      return yield* this.sendStreamInner(opts, ensureLock);
    } finally {
      release?.();
    }
  }

  private async *sendStreamInner(
    opts: SendOptions,
    ensureLock: (conversationId: string) => Promise<void>,
  ): AsyncGenerator<LLMChunk, MessageRouterResult> {
    if (opts.context.signal?.aborted) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: 'Runtime cancelled',
      };
    }
    if (!this.collective.get(opts.senderId)) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: new ParticipantNotFoundError(opts.senderId).message,
      };
    }
    const recipient = this.collective.get(opts.recipientId);
    if (!recipient) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: new ParticipantNotFoundError(opts.recipientId).message,
      };
    }

    const depth = opts.context.communicationDepth ?? 0;
    if (depth > DEFAULT_DEPTH_LIMIT) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: `Communication depth limit exceeded (${DEFAULT_DEPTH_LIMIT})`,
      };
    }

    const parentConversationId =
      opts.context.conversationId && opts.context.conversationId !== opts.conversationId
        ? opts.context.conversationId
        : undefined;
    const parentToolCallId = opts.context.toolCallId;
    const origin: ConversationOrigin = opts.origin ?? {
      kind: parentToolCallId ? 'tool' : 'participant',
      participantId: opts.senderId,
      parentConversationId,
      parentToolCallId,
    };
    const thread = await this.getThread(
      opts.conversationId,
      {
        parentConversationId,
        parentToolCallId,
        origin,
      },
      opts.context.signal,
    );
    await ensureLock(thread.id);

    let inbound: Awaited<ReturnType<ConversationThread['append']>>;
    let lifecycleState: ResponseOperation['lifecycleState'];
    if (this.lifecycle) {
      const sender = this.collective.get(opts.senderId);
      if (!sender) {
        return {
          conversationId: thread.id,
          status: 'error',
          error: new ParticipantNotFoundError(opts.senderId).message,
        };
      }
      const operationId = createId('route');
      const inboundResult = await this.lifecycle.receive({
        operationId,
        sender,
        recipient,
        thread,
        draft: {
          senderId: opts.senderId,
          recipientId: opts.recipientId,
          role: 'user',
          content: opts.message,
          ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
        },
        actions: [],
        mode: 'pre_runtime',
        signal: opts.context.signal,
        approvalContinuationSeed: opts.context.approvalContinuationSeed,
      });
      if (inboundResult.kind === 'respond') {
        return this.respondWithLifecycle(thread, inboundResult.response, {
          operationId,
          actions: inboundResult.actions,
          context: opts.context,
        });
      }
      if (inboundResult.kind !== 'continue') {
        return this.mapLifecycleResult(inboundResult, thread.id, opts.context);
      }
      inbound = inboundResult.value;
      lifecycleState = {
        operationId,
        actions: inboundResult.actions,
        context: opts.context,
        storedMessageId: inbound.id,
      };
    } else {
      inbound = await thread.append(
        {
          senderId: opts.senderId,
          recipientId: opts.recipientId,
          role: 'user',
          content: opts.message,
          replyTo: opts.replyTo,
        },
        { reactivate: true, signal: opts.context.signal },
      );
      this.eventBus.emit('message:sent', {
        conversationId: thread.id,
        senderId: opts.senderId,
        recipientId: opts.recipientId,
        messageId: inbound.id,
      });
    }

    const runtime = this.registry.build(recipient.type, recipient.id);
    const streamAbort = this.combineAbortSignals(opts.context.signal);
    const runtimeThread = this.createAbortSafeThread(thread, streamAbort.signal);
    const runtimeContext = this.buildRuntimeContext(
      runtimeThread,
      recipient.id,
      { ...opts.context, communicationDepth: depth, signal: streamAbort.signal },
      depth,
      lifecycleState === undefined
        ? undefined
        : {
            operationId: lifecycleState.operationId,
            incomingMessageId: inbound.id,
            actions: lifecycleState.actions,
          },
    );

    if (opts.replyTo) {
      const task = this.dispatchAsync(
        runtime,
        inbound,
        runtimeContext,
        thread,
        opts,
        lifecycleState,
      );
      this.background.add(task);
      void task
        .finally(() => {
          this.background.delete(task);
          streamAbort.dispose();
        })
        .catch(() => undefined);
      return { conversationId: thread.id, status: 'dispatched' };
    }

    let transformer: ResponseStreamTransformer | undefined;
    let runtimeStream: AsyncGenerator<LLMChunk, RuntimeResult> | undefined;
    let streamFinished = false;
    try {
      if (this.lifecycle && lifecycleState) {
        const sender = this.collective.get(recipient.id);
        const responseRecipient = this.collective.get(opts.replyTo ?? opts.senderId);
        if (sender && responseRecipient) {
          transformer = this.lifecycle.createResponseStream({
            operationId: lifecycleState.operationId,
            sender,
            recipient: responseRecipient,
            thread,
            actions: lifecycleState.actions,
            signal: streamAbort.signal,
          });
        }
      }
      if (runtime.handleStream) {
        const stream = runtime.handleStream(inbound, runtimeContext);
        runtimeStream = stream;
        let next = await this.nextStreamResult(stream, streamAbort.signal);
        if (next === undefined) {
          streamFinished = true;
          const chunks = transformer?.abort() ?? [];
          void stream.return(undefined as never).catch(() => undefined);
          for (const chunk of chunks) yield chunk;
          return { conversationId: thread.id, status: 'error', error: 'Runtime cancelled' };
        }
        while (!next.done) {
          try {
            const chunks = transformer ? await transformer.push(next.value) : [next.value];
            for (const chunk of chunks) yield chunk;
          } catch (error) {
            if (error instanceof MiddlewareStreamError) {
              try {
                await stream.return(undefined as never);
                streamFinished = true;
              } catch {
                // Middleware rejection owns terminal result; runtime cleanup errors are secondary.
              }
              for (const chunk of error.chunks) yield chunk;
              return this.mapLifecycleResult(error.lifecycleResult, thread.id, opts.context);
            }
            throw error;
          }
          next = await this.nextStreamResult(stream, streamAbort.signal);
          if (next === undefined) {
            streamFinished = true;
            const chunks = transformer?.abort() ?? [];
            void stream.return(undefined as never).catch(() => undefined);
            for (const chunk of chunks) yield chunk;
            return { conversationId: thread.id, status: 'error', error: 'Runtime cancelled' };
          }
        }
        const result = next.value;
        streamFinished = true;
        if (transformer) {
          try {
            const finished = await transformer.finish(result);
            for (const chunk of finished.chunks) yield chunk;
            if (result.kind === 'response') return finished.result;
          } catch (error) {
            if (error instanceof MiddlewareStreamError) {
              for (const chunk of error.chunks) yield chunk;
              return this.mapLifecycleResult(error.lifecycleResult, thread.id, opts.context);
            }
            throw error;
          }
        }
        return await this.completeResponse(
          {
            thread,
            recipientId: recipient.id,
            responseRecipientId: opts.replyTo ?? opts.senderId,
            lifecycleState,
          },
          result,
        );
      } else {
        const result = await runtime.handle(inbound, runtimeContext);
        if (transformer) {
          try {
            const finished = await transformer.finish(result);
            for (const chunk of finished.chunks) yield chunk;
            if (result.kind === 'response') return finished.result;
          } catch (error) {
            if (error instanceof MiddlewareStreamError) {
              for (const chunk of error.chunks) yield chunk;
              return this.mapLifecycleResult(error.lifecycleResult, thread.id, opts.context);
            }
            throw error;
          }
        }
        return await this.completeResponse(
          {
            thread,
            recipientId: recipient.id,
            responseRecipientId: opts.replyTo ?? opts.senderId,
            lifecycleState,
          },
          result,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { conversationId: thread.id, status: 'error', error: msg };
    } finally {
      if (!streamFinished && runtimeStream) {
        streamAbort.abort();
        transformer?.abort();
        void runtimeStream.return(undefined as never).catch(() => undefined);
      }
      transformer?.dispose();
      streamAbort.dispose();
    }
  }

  private async sendInner(opts: SendOptions): Promise<MessageRouterResult> {
    const recipient = this.collective.get(opts.recipientId);
    if (!recipient) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: new ParticipantNotFoundError(opts.recipientId).message,
      };
    }

    const depth = opts.context.communicationDepth ?? 0;
    if (depth > DEFAULT_DEPTH_LIMIT) {
      return {
        conversationId: opts.conversationId ?? '',
        status: 'error',
        error: `Communication depth limit exceeded (${DEFAULT_DEPTH_LIMIT})`,
      };
    }

    // When no explicit conversationId is provided, create a new conversation.
    // If the caller is itself in a real conversation, stamp the parent link.
    const parentConversationId =
      opts.context.conversationId && opts.context.conversationId !== opts.conversationId
        ? opts.context.conversationId
        : undefined;
    const parentToolCallId = opts.context.toolCallId;
    const origin: ConversationOrigin = opts.origin ?? {
      kind: parentToolCallId ? 'tool' : 'participant',
      participantId: opts.senderId,
      parentConversationId,
      parentToolCallId,
    };
    const thread = await this.getThread(opts.conversationId, {
      parentConversationId,
      parentToolCallId,
      origin,
    });

    let inbound: Awaited<ReturnType<ConversationThread['append']>>;
    let lifecycleState:
      | {
          operationId: string;
          actions: MiddlewareActionResult[];
          context: ToolContext;
          storedMessageId?: string;
        }
      | undefined;
    if (this.lifecycle) {
      const sender = this.collective.get(opts.senderId);
      if (!sender) {
        return {
          conversationId: thread.id,
          status: 'error',
          error: new ParticipantNotFoundError(opts.senderId).message,
        };
      }
      const operationId = createId('route');
      const result = await this.lifecycle.receive({
        operationId,
        sender,
        recipient,
        thread,
        draft: {
          senderId: opts.senderId,
          recipientId: opts.recipientId,
          role: 'user',
          content: opts.message,
          ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
        },
        actions: [],
        mode: 'pre_runtime',
        signal: opts.context.signal,
        approvalContinuationSeed: opts.context.approvalContinuationSeed,
      });
      if (result.kind === 'respond') {
        return this.respondWithLifecycle(thread, result.response, {
          operationId,
          actions: result.actions,
          context: opts.context,
        });
      }
      if (result.kind !== 'continue')
        return this.mapLifecycleResult(result, thread.id, opts.context);
      inbound = result.value;
      lifecycleState = {
        operationId,
        actions: result.actions,
        context: opts.context,
        storedMessageId: inbound.id,
      };
    } else {
      inbound = await thread.append(
        {
          senderId: opts.senderId,
          recipientId: opts.recipientId,
          role: 'user',
          content: opts.message,
          replyTo: opts.replyTo,
        },
        { reactivate: true },
      );
      this.eventBus.emit('message:sent', {
        conversationId: thread.id,
        senderId: opts.senderId,
        recipientId: opts.recipientId,
        messageId: inbound.id,
      });
    }

    const runtime = this.registry.build(recipient.type, recipient.id);
    const runtimeContext = this.buildRuntimeContext(
      thread,
      recipient.id,
      { ...opts.context, communicationDepth: depth },
      depth,
      lifecycleState === undefined
        ? undefined
        : {
            operationId: lifecycleState.operationId,
            incomingMessageId: inbound.id,
            actions: lifecycleState.actions,
          },
    );

    if (opts.replyTo) {
      const task = this.dispatchAsync(
        runtime,
        inbound,
        runtimeContext,
        thread,
        opts,
        lifecycleState,
      );
      this.background.add(task);
      void task.finally(() => this.background.delete(task)).catch(() => undefined);
      return { conversationId: thread.id, status: 'dispatched' };
    }

    try {
      const result = await runtime.handle(inbound, runtimeContext);
      return await this.completeResponse(
        {
          thread,
          recipientId: recipient.id,
          responseRecipientId: opts.senderId,
          lifecycleState,
        },
        result,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { conversationId: thread.id, status: 'error', error: msg };
    }
  }

  /**
   * Re-trigger a paused participant after approval decisions have been recorded.
   * Finds the last user message addressed to `participantId` and calls handle() again.
   */
  async resume(
    conversationId: string,
    participantId: string,
    toolContext: ToolContext,
  ): Promise<MessageRouterResult> {
    const thread = await this.getThread(conversationId);
    const participant = this.collective.get(participantId);
    if (!participant) {
      return {
        conversationId,
        status: 'error',
        error: new ParticipantNotFoundError(participantId).message,
      };
    }

    // Find the last user message addressed to this participant — that is the
    // 'incoming' message the participant was responding to when it paused.
    const chain = thread.activeChain;
    const lastIncoming = [...chain]
      .reverse()
      .find((m) => m.recipientId === participantId && m.role === 'user');

    if (!lastIncoming) {
      return {
        conversationId,
        status: 'error',
        error: `No incoming message to resume from in conversation ${conversationId}`,
      };
    }

    const runtime = this.registry.build(participant.type, participant.id);
    const runtimeContext = this.buildRuntimeContext(thread, participant.id, toolContext, 0);

    try {
      const result = await runtime.handle(lastIncoming, runtimeContext);
      return await this.completeResponse(
        {
          thread,
          recipientId: participant.id,
          responseRecipientId: lastIncoming.senderId,
          lifecycleState: { operationId: createId('route'), actions: [], context: toolContext },
        },
        result,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { conversationId: thread.id, status: 'error', error: msg };
    }
  }

  async resumeApproval(approvalId: string, context: ToolContext): Promise<MessageRouterResult> {
    const approvals = context.pendingApprovalRegistry as PendingApprovalRegistry | undefined;
    const record = approvals?.getRecord(approvalId);
    if (!record || !approvals) {
      return {
        conversationId: '',
        status: 'error',
        error: 'Approval continuation is unavailable',
      };
    }
    if (record.lifecycle === 'acknowledged') {
      return record.routerResult ?? { conversationId: record.conversationId, status: 'success' };
    }
    const successorApprovalIds =
      record.successorApprovalIds ??
      (record.successorApprovalId === undefined ? [] : [record.successorApprovalId]);
    if (successorApprovalIds.length > 0) {
      return this.resolveApprovalSuccessors(record, approvals);
    }
    if (record.routerResult) {
      if (record.continuation?.kind === 'automation_compaction') {
        await this.archiveAutomationHelper(record.continuation);
        if (
          record.automationCompaction?.lifecycle === 'parent_committed' ||
          record.automationCompaction?.lifecycle === 'completed'
        ) {
          await approvals.terminalizeAutomationSuccess(approvalId, {
            routerResult: record.routerResult,
          });
        } else {
          await approvals.acknowledge(approvalId);
        }
      } else {
        await approvals.acknowledge(approvalId);
      }
      return record.routerResult;
    }
    if (
      record.continuation?.kind === 'automation_compaction' &&
      record.automationCompaction?.summary &&
      (record.automationCompaction.lifecycle === 'summary_ready' ||
        record.automationCompaction.lifecycle === 'parent_committed')
    ) {
      return this.finalizeAutomationCompaction(
        approvalId,
        record.continuation,
        record.automationCompaction.summary,
        context,
      );
    }
    const checkpoint =
      record.continuation?.kind === 'middleware'
        ? record.continuation.checkpoint
        : record.continuation?.helperContinuation.checkpoint;
    const helperContext: ToolContext =
      record.continuation?.kind === 'automation_compaction'
        ? {
            ...context,
            approvalContinuationSeed: this.automationCompactionSeed(record.continuation),
          }
        : record.continuation?.kind === 'automation_title'
          ? { ...context, approvalContinuationSeed: this.automationTitleSeed(record.continuation) }
          : context;
    if (!checkpoint || !this.middlewareRunner) {
      return {
        conversationId: record.conversationId,
        status: 'error',
        error: 'Approval continuation is unavailable',
      };
    }
    return this.withLock(checkpoint.conversationId, async () => {
      const current = approvals.getRecord(approvalId);
      if (current?.routerResult) return current.routerResult;
      if (current?.lifecycle === 'acknowledged') {
        return { conversationId: current.conversationId, status: 'success' };
      }
      if (current?.continuation?.kind === 'automation_compaction') {
        const helper = await this.store.load(current.continuation.helperConversationId);
        if (!this.matchesAutomationHelper(helper, current.continuation)) {
          return this.failAutomationCompaction(
            approvalId,
            current.continuation,
            'Automation compaction helper provenance is stale',
            approvals,
          );
        }
      }
      let resumed: Awaited<ReturnType<MiddlewareRunner['resumeApproval']>>;
      try {
        const stored = await this.store.load(checkpoint.conversationId);
        if (!stored) {
          return {
            conversationId: checkpoint.conversationId,
            status: 'error',
            error: 'Approval continuation is unavailable',
          };
        }
        resumed = await this.middlewareRunner!.resumeApproval(
          approvalId,
          new ConversationThread(stored, this.store),
        );
      } catch {
        return {
          conversationId: checkpoint.conversationId,
          status: 'error',
          error: 'Approval continuation could not resume',
        };
      }
      if (resumed.kind === 'resume_pending' || resumed.kind === 'pending_approval') {
        if (resumed.kind === 'resume_pending') {
          const authoritative = await approvals.getAuthoritativeRecord(approvalId);
          if (authoritative?.routerResult) return authoritative.routerResult;
          if (authoritative?.lifecycle === 'acknowledged') {
            return { conversationId: authoritative.conversationId, status: 'success' };
          }
          const authoritativeSuccessors =
            authoritative?.successorApprovalIds ??
            (authoritative?.successorApprovalId === undefined
              ? []
              : [authoritative.successorApprovalId]);
          if (authoritative && authoritativeSuccessors.length > 0)
            return this.resolveApprovalSuccessors(authoritative, approvals);
        }
        if (resumed.kind === 'pending_approval') {
          if (record.continuation?.kind === 'automation_compaction') {
            await approvals.transferAutomationCompaction(approvalId, [resumed.approvalId]);
          } else if (record.continuation?.kind === 'automation_title') {
            await approvals.transferAutomationTitle(approvalId, [resumed.approvalId]);
          } else {
            await approvals.recordSuccessor(approvalId, resumed.approvalId);
          }
          try {
            await approvals.acknowledge(approvalId);
          } catch {
            // Successor handoff is durable. Retrying parent only retries acknowledgement.
          }
        }
        return {
          conversationId: checkpoint.conversationId,
          status: 'pending_approval',
          approvalId: resumed.kind === 'pending_approval' ? resumed.approvalId : approvalId,
          checkpointId:
            resumed.kind === 'pending_approval' ? resumed.checkpointId : resumed.checkpointId,
          ...(resumed.kind === 'pending_approval'
            ? { pendingParticipantId: resumed.participantId }
            : {}),
        };
      }
      if (record.continuation?.kind === 'automation_title') {
        if (resumed.kind !== 'continue') {
          return this.failAutomationTitle(
            approvalId,
            record.continuation,
            resumed.kind === 'abort' ? resumed.error : 'Title helper did not complete',
            approvals,
          );
        }
        const helperResult = await this.resumeNonPromptCheckpoint(
          checkpoint,
          resumed,
          helperContext,
          approvalId,
        );
        if (helperResult.status === 'pending_approval') {
          const successors = [
            ...new Set([
              ...(helperResult.approvalId ? [helperResult.approvalId] : []),
              ...(helperResult.approvalRequests?.map((request) => request.approvalId) ?? []),
            ]),
          ];
          if (successors.length > 0) {
            await approvals.transferAutomationTitle(approvalId, successors);
            await approvals.acknowledge(approvalId);
          }
          return helperResult;
        }
        if (helperResult.status !== 'success' || helperResult.response === undefined) {
          return this.failAutomationTitle(
            approvalId,
            record.continuation,
            helperResult.error ?? 'Title helper did not complete',
            approvals,
          );
        }
        return this.finalizeAutomationTitle(
          approvalId,
          record.continuation,
          helperResult.response,
          context,
        );
      }
      if (resumed.kind === 'abort') {
        if (record.continuation?.kind === 'automation_compaction') {
          return this.failAutomationCompaction(
            approvalId,
            record.continuation,
            resumed.error,
            approvals,
          );
        }
        const result: MessageRouterResult = {
          conversationId: checkpoint.conversationId,
          status: 'error',
          error: resumed.error,
          ...(resumed.persisted ? { partial: true, storedMessageId: resumed.storedMessageId } : {}),
        };
        await approvals.recordRouterResult(
          approvalId,
          result as import('../auth/PendingApprovalRegistry.js').ApprovalRouterResult,
        );
        try {
          await approvals.acknowledge(approvalId);
        } catch {
          return result;
        }
        return result;
      }
      if (
        checkpoint.phase !== 'buildSystemPrompt' ||
        !checkpoint.runtimeResume ||
        resumed.kind !== 'continue'
      ) {
        if (resumed.kind !== 'continue') {
          return {
            conversationId: checkpoint.conversationId,
            status: 'error',
            error: 'Approval continuation is unavailable',
          };
        }
        const result = await this.resumeNonPromptCheckpoint(
          checkpoint,
          resumed,
          helperContext,
          approvalId,
        );
        if (result.status === 'pending_approval') {
          const successorApprovalIds = [
            ...new Set([
              ...(result.approvalId === undefined ? [] : [result.approvalId]),
              ...(result.approvalRequests?.map((request) => request.approvalId) ?? []),
            ]),
          ];
          if (successorApprovalIds.length > 0) {
            if (record.continuation?.kind === 'automation_compaction') {
              await approvals.transferAutomationCompaction(approvalId, successorApprovalIds);
            } else {
              await approvals.recordSuccessors(approvalId, successorApprovalIds);
            }
            try {
              await approvals.acknowledge(approvalId);
            } catch {
              // Durable successor linkage prevents runtime replay.
            }
          }
        }
        if (result.status === 'success' || result.status === 'error') {
          if (record.continuation?.kind === 'automation_compaction') {
            const summary =
              result.response ??
              (await this.automationSummaryAfterResume(record.continuation, resumed.value));
            if (result.status === 'success' && summary) {
              return this.finalizeAutomationCompactionWithHelperLock(
                approvalId,
                record.continuation,
                summary,
                context,
              );
            }
            return this.failAutomationCompaction(
              approvalId,
              record.continuation,
              result.error ?? 'Summary failed',
              approvals,
            );
          }
          await approvals.recordRouterResult(
            approvalId,
            result as import('../auth/PendingApprovalRegistry.js').ApprovalRouterResult,
          );
          try {
            await approvals.acknowledge(approvalId);
          } catch {
            return result;
          }
        }
        return result;
      }
      const participant = this.collective.get(checkpoint.participantId);
      const stored = await this.store.load(checkpoint.conversationId);
      if (!participant || !stored) {
        return {
          conversationId: checkpoint.conversationId,
          status: 'error',
          error: 'Approval continuation is unavailable',
        };
      }
      const thread = new ConversationThread(stored, this.store);
      const runtime = this.registry.build(participant.type, participant.id);
      if (!runtime.resumeFromMiddleware) {
        return {
          conversationId: checkpoint.conversationId,
          status: 'error',
          error: 'Approval continuation is unavailable',
        };
      }
      let providerClaimed = false;
      try {
        const providerClaim = await approvals.claimProviderExecution(approvalId);
        if (providerClaim !== 'claimed') {
          const cached = approvals.getRecord(approvalId)?.routerResult;
          if (cached) return cached;
          return {
            conversationId: checkpoint.conversationId,
            status: 'error',
            error: 'Middleware provider outcome unknown and was not retried',
          };
        }
        providerClaimed = true;
        const runtimeContext = this.buildRuntimeContext(
          thread,
          participant.id,
          helperContext,
          helperContext.communicationDepth ?? 0,
          {
            operationId: checkpoint.operationId,
            incomingMessageId: checkpoint.runtimeResume.incomingMessageId,
            actions: resumed.actions,
          },
        );
        const runtimeResult = await runtime.resumeFromMiddleware(
          {
            ...checkpoint.runtimeResume,
            preparedPrompt: resumed.value as string,
            actionCursor: resumed.actions.length,
            actions: resumed.actions,
          },
          runtimeContext,
        );
        const incoming = thread.data.messages[checkpoint.runtimeResume.incomingMessageId];
        const result = await this.completeResponse(
          {
            thread,
            recipientId: participant.id,
            responseRecipientId:
              incoming?.replyTo ?? incoming?.senderId ?? checkpoint.participantId,
            lifecycleState: {
              operationId: checkpoint.operationId,
              actions: resumed.actions,
              context: helperContext,
              storedMessageId: checkpoint.runtimeResume.incomingMessageId,
            },
          },
          runtimeResult,
        );
        if (result.status === 'pending_approval') {
          const successorApprovalIds = [
            ...new Set([
              ...(result.approvalId === undefined ? [] : [result.approvalId]),
              ...(result.approvalRequests?.map((request) => request.approvalId) ?? []),
            ]),
          ];
          if (successorApprovalIds.length > 0) {
            if (record.continuation?.kind === 'automation_compaction') {
              await approvals.transferAutomationCompaction(approvalId, successorApprovalIds);
            } else {
              await approvals.recordSuccessors(approvalId, successorApprovalIds);
            }
            try {
              await approvals.acknowledge(approvalId);
            } catch {
              // Durable successor linkage prevents provider replay.
            }
          }
        }
        if (result.status === 'success' || result.status === 'error') {
          if (record.continuation?.kind === 'automation_compaction') {
            if (result.status === 'success' && result.response) {
              return this.finalizeAutomationCompactionWithHelperLock(
                approvalId,
                record.continuation,
                result.response,
                context,
              );
            }
            return this.failAutomationCompaction(
              approvalId,
              record.continuation,
              result.error ?? 'Summary failed',
              approvals,
            );
          }
          await approvals.recordRouterResult(
            approvalId,
            result as import('../auth/PendingApprovalRegistry.js').ApprovalRouterResult,
          );
          try {
            await approvals.acknowledge(approvalId);
          } catch {
            return result;
          }
        }
        return result;
      } catch {
        if (providerClaimed) {
          const result = await approvals.markProviderExecutionUnknown(approvalId);
          try {
            await approvals.acknowledge(approvalId);
          } catch {
            // Unknown provider outcome is terminal and must never replay.
          }
          return result;
        }
        return {
          conversationId: checkpoint.conversationId,
          status: 'error',
          error: 'Approval continuation could not resume',
        };
      }
    });
  }

  private async resolveApprovalSuccessors(
    record: ApprovalRecord,
    approvals: PendingApprovalRegistry,
  ): Promise<MessageRouterResult> {
    const successorApprovalIds =
      record.successorApprovalIds ??
      (record.successorApprovalId === undefined ? [] : [record.successorApprovalId]);
    const successors = successorApprovalIds
      .map((successorApprovalId) => approvals.getRecord(successorApprovalId))
      .filter((successor): successor is NonNullable<typeof successor> => successor !== undefined);
    const pendingSuccessors = successors.filter(
      (successor) => successor.lifecycle !== 'acknowledged',
    );
    if (
      record.continuation?.kind === 'automation_compaction' &&
      record.automationCompaction?.lifecycle === 'parent_committed'
    ) {
      await approvals.terminalizeAutomationSuccess(record.approvalId, { successorApprovalIds });
    } else {
      await approvals.acknowledge(record.approvalId);
    }
    if (pendingSuccessors.length === 0) {
      return (
        successors[0]?.routerResult ?? {
          conversationId: record.conversationId,
          status: 'success',
        }
      );
    }
    const first = pendingSuccessors[0];
    const firstCheckpoint =
      first.continuation?.kind === 'middleware'
        ? first.continuation.checkpoint
        : first.continuation?.helperContinuation.checkpoint;
    return {
      conversationId: first.conversationId,
      status: 'pending_approval',
      ...(pendingSuccessors.length === 1 ? { approvalId: first.approvalId } : {}),
      ...(firstCheckpoint === undefined
        ? {}
        : {
            checkpointId: firstCheckpoint.checkpointId,
            pendingParticipantId: firstCheckpoint.participantId,
          }),
      approvalRequests: pendingSuccessors
        .map((successor) => approvals.get(successor.approvalId))
        .filter((successor): successor is NonNullable<typeof successor> => successor !== undefined),
    };
  }

  private async finalizeAutomationCompaction(
    approvalId: string,
    continuation: AutomationCompactionContinuation,
    summary: string,
    context: ToolContext,
  ): Promise<MessageRouterResult> {
    return this.withLock(continuation.helperConversationId, () =>
      this.finalizeAutomationCompactionWithHelperLock(approvalId, continuation, summary, context),
    );
  }

  private async finalizeAutomationTitle(
    approvalId: string,
    continuation: AutomationTitleContinuation,
    value: MessageDraft | import('@legion/types').MessageData | string,
    context: ToolContext,
  ): Promise<MessageRouterResult> {
    return this.withLock(continuation.parentConversationId, async () => {
      const approvals = context.pendingApprovalRegistry!;
      const current = approvals.getRecord(approvalId);
      if (current?.routerResult) return current.routerResult;
      if (current?.continuation?.kind !== 'automation_title') {
        return {
          conversationId: continuation.parentConversationId,
          status: 'error',
          error: 'Automation title continuation is unavailable',
        };
      }
      continuation = current.continuation;
      const helper = await this.store.load(continuation.helperConversationId);
      const parent = await this.store.load(continuation.parentConversationId);
      const participant = this.collective.get(continuation.participantId);
      const instance = participant?.middleware?.find(
        (candidate) => candidate.id === continuation.middlewareInstanceId,
      );
      if (
        !this.matchesAutomationTitleHelper(helper, continuation) ||
        !parent ||
        !participant ||
        (participant.status ?? 'active') !== 'active' ||
        (participant.middlewareRevision ?? 0) !== continuation.middlewareRevision ||
        !instance ||
        instance.type !== continuation.middlewareType ||
        !isDeepStrictEqual(instance.config, continuation.middlewareConfig)
      ) {
        return this.failAutomationTitle(
          approvalId,
          continuation,
          'Automation title continuation is stale',
          approvals,
        );
      }
      const helperMessage = helper!.messages[helper!.activeBranchHead];
      const title = (
        helperMessage?.content ?? (typeof value === 'string' ? value : value.content)
      ).trim();
      if (!title || /[\r\n]/.test(title) || title.length > continuation.maximumLength) {
        return this.failAutomationTitle(
          approvalId,
          continuation,
          'Generated title is invalid',
          approvals,
        );
      }
      const mutation = await this.store.mutate(continuation.parentConversationId, (stored) => {
        const existing =
          continuation.scope === 'shared'
            ? stored.title
            : stored.titles?.[continuation.attachedParticipantId];
        if (existing !== undefined) return stored;
        return continuation.scope === 'shared'
          ? { ...stored, title }
          : {
              ...stored,
              titles: { ...stored.titles, [continuation.attachedParticipantId]: title },
            };
      });
      const effectiveTitle =
        continuation.scope === 'shared'
          ? mutation.after.title
          : mutation.after.titles?.[continuation.attachedParticipantId];
      const checkpoint = continuation.parentCheckpoint;
      const action = {
        requestId: checkpoint.request.requestId,
        participantId: continuation.participantId,
        instanceId: continuation.middlewareInstanceId,
        tool: checkpoint.request.tool,
        status: 'success' as const,
        result: {
          status: 'success' as const,
          data: { title: effectiveTitle, written: mutation.changed },
        },
      };
      await approvals.recordMiddlewareActionResult(
        {
          operationId: checkpoint.operationId,
          conversationId: checkpoint.conversationId,
          participantId: continuation.participantId,
          instanceId: continuation.middlewareInstanceId,
          requestId: checkpoint.request.requestId,
          tool: checkpoint.request.tool,
          args: checkpoint.request.arguments,
        },
        action,
      );
      if (!this.middlewareRunner)
        return this.failAutomationTitle(
          approvalId,
          continuation,
          'Automation title parent unavailable',
          approvals,
        );
      const resumed = await this.middlewareRunner.resumeAutomationParent(
        continuation,
        new ConversationThread(mutation.after, this.store),
        action,
        mutation.after.activeBranchHead,
      );
      if (resumed.kind === 'pending_approval') {
        await approvals.transferAutomationTitle(approvalId, [resumed.approvalId]);
        await approvals.acknowledge(approvalId);
        await this.archiveAutomationTitleHelper(continuation);
        return {
          conversationId: continuation.parentConversationId,
          status: 'pending_approval',
          approvalId: resumed.approvalId,
          checkpointId: resumed.checkpointId,
          pendingParticipantId: resumed.participantId,
        };
      }
      if (resumed.kind !== 'continue')
        return this.failAutomationTitle(
          approvalId,
          continuation,
          'Automation title parent could not continue',
          approvals,
        );
      const result = await this.resumeNonPromptCheckpoint(checkpoint, resumed, context, approvalId);
      await approvals.recordRouterResult(
        approvalId,
        result as import('../auth/PendingApprovalRegistry.js').ApprovalRouterResult,
      );
      await approvals.acknowledge(approvalId);
      await this.archiveAutomationTitleHelper(continuation);
      return result;
    });
  }

  private async failAutomationTitle(
    approvalId: string,
    continuation: AutomationTitleContinuation,
    error: string,
    approvals: PendingApprovalRegistry,
  ): Promise<MessageRouterResult> {
    const result = {
      conversationId: continuation.parentConversationId,
      status: 'error' as const,
      error,
    };
    const record = approvals.getRecord(approvalId);
    if (record?.resumeResult === undefined)
      await approvals.recordResumeResult(approvalId, { status: 'error', error });
    await approvals.recordRouterResult(approvalId, result);
    await approvals.acknowledge(approvalId);
    await this.archiveAutomationTitleHelper(continuation);
    return result;
  }

  private matchesAutomationTitleHelper(
    helper: Awaited<ReturnType<ConversationStore['load']>>,
    continuation: AutomationTitleContinuation,
  ): boolean {
    return (
      helper?.origin?.kind === 'middleware' &&
      helper.origin.participantId === continuation.participantId &&
      helper.origin.middlewareInstanceId === continuation.middlewareInstanceId &&
      helper.origin.parentConversationId === continuation.parentConversationId &&
      helper.origin.parentMessageId === continuation.parentMessageId
    );
  }

  private async archiveAutomationTitleHelper(
    continuation: AutomationTitleContinuation,
  ): Promise<void> {
    await this.store.mutate(continuation.helperConversationId, (helper) =>
      this.matchesAutomationTitleHelper(helper, continuation) && helper.status !== 'archived'
        ? { ...helper, status: 'archived' }
        : helper,
    );
  }

  private async finalizeAutomationCompactionWithHelperLock(
    approvalId: string,
    continuation: AutomationCompactionContinuation,
    summary: string,
    context: ToolContext,
  ): Promise<MessageRouterResult> {
    return context.pendingApprovalRegistry!.withAutomationCompactionLock(approvalId, () =>
      this.withLock(continuation.parentConversationId, () =>
        this.finalizeAutomationCompactionUnlocked(approvalId, continuation, summary, context),
      ),
    );
  }

  private async finalizeAutomationCompactionUnlocked(
    approvalId: string,
    continuation: AutomationCompactionContinuation,
    summary: string,
    context: ToolContext,
  ): Promise<MessageRouterResult> {
    const approvals = context.pendingApprovalRegistry!;
    const current = approvals.getRecord(approvalId);
    if (current?.routerResult) return current.routerResult;
    if (current?.lifecycle === 'acknowledged') {
      return { conversationId: continuation.parentConversationId, status: 'success' };
    }
    if (current?.continuation?.kind !== 'automation_compaction') {
      return {
        conversationId: continuation.parentConversationId,
        status: 'error',
        error: 'Automation compaction continuation is unavailable',
      };
    }
    continuation = current.continuation;
    const authoritativeHelper = await this.store.load(continuation.helperConversationId);
    const authoritativeParent = await this.store.load(continuation.parentConversationId);
    if (!this.matchesAutomationHelper(authoritativeHelper, continuation) || !authoritativeParent) {
      return this.failAutomationCompaction(
        approvalId,
        continuation,
        'Automation compaction continuation is stale',
        approvals,
      );
    }
    if (summary.trim() === '') {
      return this.failAutomationCompaction(
        approvalId,
        continuation,
        'Summary agent returned no response',
        approvals,
      );
    }
    let parentClaimed = false;
    try {
      await approvals.recordAutomationSummary(approvalId, summary);
      let state = approvals.getRecord(approvalId)?.automationCompaction;
      let summaryMessageId = state?.summaryMessageId;
      let parentHead = state?.parentHead;
      if (!summaryMessageId) {
        const participant = this.collective.get(continuation.participantId);
        const instance = participant?.middleware?.find(
          (candidate) => candidate.id === continuation.middlewareInstanceId,
        );
        if (
          !participant ||
          (participant.status ?? 'active') !== 'active' ||
          (participant.middlewareRevision ?? 0) !== continuation.middlewareRevision ||
          !instance ||
          instance.type !== continuation.middlewareType ||
          !isDeepStrictEqual(instance.config, continuation.middlewareConfig) ||
          !this.matchesAutomationHelper(authoritativeHelper, continuation)
        ) {
          throw new Error('Automation compaction continuation is stale');
        }
        const selectedIds = continuation.selectedMessages.map((message) => message.id);
        const storedParent = await this.store.load(continuation.parentConversationId);
        const watermark =
          storedParent?.middlewareState?.[continuation.participantId]?.[
            continuation.middlewareInstanceId
          ];
        const committedSummaryId =
          watermark && typeof watermark === 'object' && !Array.isArray(watermark)
            ? watermark.summaryMessageId
            : undefined;
        const committedSummary =
          typeof committedSummaryId === 'string'
            ? storedParent?.messages[committedSummaryId]
            : undefined;
        const alreadyCommitted =
          committedSummary?.type === 'summary' &&
          committedSummary.content === summary &&
          isDeepStrictEqual(committedSummary.compacts, selectedIds) &&
          continuation.selectedMessages.every((message) =>
            isDeepStrictEqual(storedParent?.messages[message.id], {
              ...message,
              status: 'compacted',
            }),
          );
        if (alreadyCommitted) {
          summaryMessageId = committedSummaryId as string;
          parentHead =
            continuation.observedParentHead === continuation.parentMessageId
              ? summaryMessageId
              : continuation.observedParentHead;
          if (!getActiveChain(storedParent!).some((message) => message.id === parentHead)) {
            throw new Error('Automation compaction parent checkpoint is stale');
          }
        } else {
          const mutation = await this.store.mutate(
            continuation.parentConversationId,
            (parent) => {
              const chain = getActiveChain(parent);
              if (
                !selectedIds.every((id, index) => chain[index]?.id === id) ||
                !continuation.selectedMessages.every((message) =>
                  isDeepStrictEqual(parent.messages[message.id], message),
                )
              ) {
                throw new Error('Automation compaction selected messages are stale');
              }
              const compacted = compactRange(parent, selectedIds, summary);
              summaryMessageId = Object.keys(compacted.messages).find(
                (id) =>
                  !Object.hasOwn(parent.messages, id) && compacted.messages[id].type === 'summary',
              );
              if (!summaryMessageId)
                throw new Error('Automation compaction summary was not created');
              const currentState =
                compacted.middlewareState?.[continuation.participantId]?.[
                  continuation.middlewareInstanceId
                ];
              const existing =
                currentState && typeof currentState === 'object' && !Array.isArray(currentState)
                  ? currentState
                  : {};
              return {
                ...compacted,
                middlewareState: {
                  ...compacted.middlewareState,
                  [continuation.participantId]: {
                    ...compacted.middlewareState?.[continuation.participantId],
                    [continuation.middlewareInstanceId]: { ...existing, summaryMessageId },
                  },
                },
              };
            },
            { expectedActiveBranchHead: continuation.observedParentHead },
          );
          parentHead = mutation.after.activeBranchHead;
        }
        try {
          await approvals.recordAutomationParentCommitted(
            approvalId,
            summaryMessageId!,
            parentHead!,
          );
        } catch (error) {
          throw new RetryableAutomationError(
            error instanceof Error ? error.message : String(error),
          );
        }
        state = approvals.getRecord(approvalId)?.automationCompaction;
      }
      const parent = await this.store.load(continuation.parentConversationId);
      const committedParentHead = state?.parentHead ?? parentHead;
      if (
        !parent ||
        !committedParentHead ||
        !getActiveChain(parent).some((message) => message.id === committedParentHead)
      ) {
        throw new Error('Automation compaction parent checkpoint is stale');
      }
      const parentClaim = await approvals.claimAutomationParentExecution(approvalId);
      if (parentClaim !== 'claimed') {
        const cached = approvals.getRecord(approvalId)?.routerResult;
        if (cached) return cached;
        return {
          conversationId: continuation.parentConversationId,
          status: 'error',
          error: 'Automation parent outcome unknown and was not retried',
        };
      }
      parentClaimed = true;
      try {
        await this.archiveAutomationHelper(continuation);
      } catch (error) {
        throw new RetryableAutomationError(error instanceof Error ? error.message : String(error));
      }
      const checkpoint = continuation.parentCheckpoint;
      const action = {
        requestId: checkpoint.request.requestId,
        participantId: continuation.participantId,
        instanceId: continuation.middlewareInstanceId,
        tool: checkpoint.request.tool,
        status: 'success' as const,
        result: { status: 'success' as const, data: { summaryMessageId } },
      };
      await approvals.recordMiddlewareActionResult(
        {
          operationId: checkpoint.operationId,
          conversationId: checkpoint.conversationId,
          participantId: continuation.participantId,
          instanceId: continuation.middlewareInstanceId,
          requestId: checkpoint.request.requestId,
          tool: checkpoint.request.tool,
          args: checkpoint.request.arguments,
        },
        action,
      );
      if (!this.middlewareRunner) throw new Error('Automation compaction parent unavailable');
      const resumed = await this.middlewareRunner.resumeAutomationParent(
        continuation,
        new ConversationThread(parent, this.store),
        action,
        parent.activeBranchHead,
      );
      let result: MessageRouterResult;
      if (resumed.kind === 'continue') {
        result = await this.resumeNonPromptCheckpoint(
          continuation.parentCheckpoint,
          resumed,
          context,
          approvalId,
        );
      } else if (resumed.kind === 'pending_approval') {
        result = {
          conversationId: continuation.parentConversationId,
          status: 'pending_approval',
          approvalId: resumed.approvalId,
          checkpointId: resumed.checkpointId,
          pendingParticipantId: resumed.participantId,
        };
      } else {
        throw new Error(
          resumed.kind === 'abort' || resumed.kind === 'reject'
            ? resumed.error
            : 'Automation compaction parent could not continue',
        );
      }
      if (result.status === 'pending_approval') {
        const successors = [
          ...new Set([
            ...(result.approvalId ? [result.approvalId] : []),
            ...(result.approvalRequests?.map((request) => request.approvalId) ?? []),
          ]),
        ];
        if (successors.length > 0) {
          await approvals.terminalizeAutomationSuccess(approvalId, {
            successorApprovalIds: successors,
          });
        }
        return result;
      }
      await approvals.terminalizeAutomationSuccess(approvalId, {
        routerResult: result as import('../auth/PendingApprovalRegistry.js').ApprovalRouterResult,
      });
      return result;
    } catch (error) {
      if (parentClaimed) {
        const result = await approvals.markAutomationParentExecutionUnknown(approvalId);
        try {
          await approvals.acknowledge(approvalId);
        } catch {
          // Unknown parent outcome is terminal and must never replay.
        }
        return result;
      }
      if (error instanceof RetryableAutomationError) {
        return {
          conversationId: continuation.parentConversationId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return this.failAutomationCompaction(
        approvalId,
        continuation,
        error instanceof Error ? error.message : String(error),
        approvals,
      );
    }
  }

  private async failAutomationCompaction(
    approvalId: string,
    continuation: AutomationCompactionContinuation,
    error: string,
    approvals: PendingApprovalRegistry,
  ): Promise<MessageRouterResult> {
    const result = await approvals.terminalizeAutomationFailure(approvalId, error);
    await this.archiveAutomationHelper(continuation);
    await approvals.acknowledge(approvalId);
    return result;
  }

  private async archiveAutomationHelper(
    continuation: AutomationCompactionContinuation,
  ): Promise<void> {
    await archiveAutomationHelper(this.store, continuation);
  }

  private matchesAutomationHelper(
    helper: Awaited<ReturnType<ConversationStore['load']>>,
    continuation: AutomationCompactionContinuation,
  ): boolean {
    return (
      helper?.origin?.kind === 'middleware' &&
      helper.origin.participantId === continuation.participantId &&
      helper.origin.middlewareInstanceId === continuation.middlewareInstanceId &&
      helper.origin.parentConversationId === continuation.parentConversationId &&
      helper.origin.parentMessageId === continuation.parentMessageId
    );
  }

  private automationCompactionSeed(
    continuation: AutomationCompactionContinuation,
  ): AutomationCompactionSeed {
    const { kind: _kind, helperContinuation: _helperContinuation, ...seed } = continuation;
    return seed;
  }

  private automationTitleSeed(
    continuation: AutomationTitleContinuation,
  ): import('../auth/PendingApprovalRegistry.js').AutomationTitleSeed {
    const { kind: _kind, helperContinuation: _helperContinuation, ...seed } = continuation;
    return seed;
  }

  private async automationSummaryAfterResume(
    continuation: AutomationCompactionContinuation,
    value: MessageDraft | import('@legion/types').MessageData | string,
  ): Promise<string | undefined> {
    const helper = await this.store.load(continuation.helperConversationId);
    const finalMessage = helper?.messages[helper.activeBranchHead];
    if (finalMessage?.role === 'assistant') return finalMessage.content;
    return typeof value === 'string' ? value : value.content;
  }

  private async resumeNonPromptCheckpoint(
    checkpoint: import('@legion/types').MiddlewareCheckpoint,
    resumed: Extract<Awaited<ReturnType<MiddlewareRunner['resumeApproval']>>, { kind: 'continue' }>,
    context: ToolContext,
    approvalId: string,
  ): Promise<MessageRouterResult> {
    if (!this.lifecycle || !this.middlewareRunner) {
      return {
        conversationId: checkpoint.conversationId,
        status: 'error',
        error: 'Approval continuation is unavailable',
      };
    }
    const stored = await this.store.load(checkpoint.conversationId);
    if (!stored) {
      return {
        conversationId: checkpoint.conversationId,
        status: 'error',
        error: 'Approval continuation is unavailable',
      };
    }
    const thread = new ConversationThread(stored, this.store);
    const continueInbound = async (draft: MessageDraft, actions: MiddlewareActionResult[]) => {
      const sender = this.collective.get(draft.senderId);
      const recipient = this.collective.get(draft.recipientId);
      if (!sender || !recipient) {
        return {
          conversationId: thread.id,
          status: 'error' as const,
          error: 'Approval continuation is unavailable',
        };
      }
      const inbound = await this.lifecycle!.receive({
        operationId: checkpoint.operationId,
        sender,
        recipient,
        thread,
        draft,
        actions,
        mode: checkpoint.mode ?? 'pre_runtime',
        signal: context.signal,
        skipDraftHooks: true,
        approvalContinuationSeed: context.approvalContinuationSeed,
      });
      if (inbound.kind === 'error' || inbound.kind === 'pending_approval') {
        return this.mapLifecycleResult(inbound, thread.id, context);
      }
      if (inbound.kind === 'complete')
        return { conversationId: thread.id, status: 'success' as const };
      if (inbound.kind === 'respond') {
        return this.respondWithLifecycle(thread, inbound.response, {
          operationId: checkpoint.operationId,
          actions: inbound.actions,
          context,
        });
      }
      if ((checkpoint.mode ?? 'pre_runtime') === 'post_response') {
        return { conversationId: thread.id, status: 'success' as const };
      }
      return this.resumeRuntime(
        thread,
        inbound.value,
        recipient.id,
        inbound.actions,
        checkpoint.operationId,
        context,
        approvalId,
      );
    };
    if (checkpoint.phase === 'beforeSend') {
      const draft = resumed.value as MessageDraft;
      const recipient = this.collective.get(draft.recipientId);
      if (!recipient) {
        return {
          conversationId: thread.id,
          status: 'error',
          error: 'Approval continuation is unavailable',
        };
      }
      const beforeReceive = await this.middlewareRunner.runMessagePhase({
        operationId: checkpoint.operationId,
        phase: 'beforeReceive',
        participant: recipient,
        thread,
        draft,
        actions: resumed.actions,
        final: checkpoint.final!,
        ...(checkpoint.iteration === undefined ? {} : { iteration: checkpoint.iteration }),
        ...(checkpoint.mode === undefined ? {} : { mode: checkpoint.mode }),
        signal: context.signal,
        approvalContinuationSeed: context.approvalContinuationSeed,
      });
      if (beforeReceive.kind !== 'continue') {
        return this.mapLifecycleResult(
          this.lifecycle.messageTerminal(beforeReceive),
          thread.id,
          context,
        );
      }
      return continueInbound(beforeReceive.value, beforeReceive.actions);
    }
    if (checkpoint.phase === 'beforeReceive') {
      return continueInbound(resumed.value as MessageDraft, resumed.actions);
    }
    const message = checkpoint.message!;
    if (checkpoint.phase === 'afterSend') {
      const recipient = this.collective.get(message.recipientId);
      if (!recipient) {
        return {
          conversationId: thread.id,
          status: 'error',
          error: 'Approval continuation is unavailable',
        };
      }
      const afterReceive = await this.middlewareRunner.runAfterReceive({
        operationId: checkpoint.operationId,
        participant: recipient,
        thread,
        message,
        persistedMessageId: message.id,
        mode: checkpoint.mode ?? 'pre_runtime',
        actions: resumed.actions,
        signal: context.signal,
        approvalContinuationSeed: context.approvalContinuationSeed,
      });
      return this.finishAfterReceive(
        checkpoint.operationId,
        thread,
        message,
        afterReceive,
        context,
        checkpoint.mode ?? 'pre_runtime',
        approvalId,
      );
    }
    return this.finishAfterReceive(
      checkpoint.operationId,
      thread,
      message,
      resumed as never,
      context,
      checkpoint.mode ?? 'pre_runtime',
      approvalId,
    );
  }

  private async finishAfterReceive(
    operationId: string,
    thread: ConversationThread,
    message: import('@legion/types').MessageData,
    result: import('../middleware/MiddlewareRunner.js').AfterReceivePhaseResult,
    context: ToolContext,
    mode: 'pre_runtime' | 'post_response',
    approvalId: string,
  ): Promise<MessageRouterResult> {
    if (!this.lifecycle)
      return {
        conversationId: thread.id,
        status: 'error',
        error: 'Approval continuation is unavailable',
      };
    if (result.kind === 'pending_approval') {
      return {
        conversationId: thread.id,
        status: 'pending_approval',
        approvalId: result.approvalId,
        checkpointId: result.checkpointId,
        pendingParticipantId: result.participantId,
        partial: true,
        storedMessageId: message.id,
      };
    }
    if (result.kind === 'abort') {
      return {
        conversationId: thread.id,
        status: 'error',
        error: result.error,
        ...(result.persisted ? { partial: true, storedMessageId: result.storedMessageId } : {}),
      };
    }
    if (result.kind === 'complete' || mode === 'post_response') {
      return { conversationId: thread.id, status: 'success' };
    }
    if (result.kind === 'respond') {
      return this.respondWithLifecycle(thread, result.draft, {
        operationId,
        actions: result.actions,
        context,
      });
    }
    if (message.recipientId !== result.value.recipientId) {
      return {
        conversationId: thread.id,
        status: 'error',
        error: 'Approval continuation is unavailable',
      };
    }
    return this.resumeRuntime(
      thread,
      message,
      message.recipientId,
      result.actions,
      operationId,
      context,
      approvalId,
    );
  }

  private async resumeRuntime(
    thread: ConversationThread,
    incoming: import('@legion/types').MessageData,
    participantId: string,
    actions: MiddlewareActionResult[],
    operationId: string,
    context: ToolContext,
    approvalId: string,
  ): Promise<MessageRouterResult> {
    const participant = this.collective.get(participantId);
    if (!participant)
      return {
        conversationId: thread.id,
        status: 'error',
        error: 'Approval continuation is unavailable',
      };
    const runtime = this.registry.build(participant.type, participant.id);
    const approvals = context.pendingApprovalRegistry as PendingApprovalRegistry | undefined;
    let providerClaimed = false;
    try {
      if (!approvals) {
        return {
          conversationId: thread.id,
          status: 'error',
          error: 'Approval continuation is unavailable',
        };
      }
      const approvalRecord = approvals.getRecord(approvalId);
      const automationParent =
        approvalRecord?.continuation?.kind === 'automation_compaction' &&
        approvalRecord.automationCompaction?.lifecycle === 'parent_committed';
      const providerClaim = automationParent
        ? approvalRecord.automationCompaction?.parentExecution === 'executing'
          ? 'claimed'
          : await approvals.claimAutomationParentExecution(approvalId)
        : await approvals.claimProviderExecution(approvalId);
      if (providerClaim !== 'claimed') {
        const cached = approvals.getRecord(approvalId)?.routerResult;
        if (cached) return cached;
        return {
          conversationId: thread.id,
          status: 'error',
          error: 'Middleware provider outcome unknown and was not retried',
        };
      }
      providerClaimed = true;
      const result = await runtime.handle(
        incoming,
        this.buildRuntimeContext(thread, participant.id, context, context.communicationDepth ?? 0, {
          operationId,
          incomingMessageId: incoming.id,
          actions,
        }),
      );
      return this.completeResponse(
        {
          thread,
          recipientId: participant.id,
          responseRecipientId: incoming.replyTo ?? incoming.senderId,
          lifecycleState: { operationId, actions, context, storedMessageId: incoming.id },
        },
        result,
      );
    } catch {
      if (providerClaimed) {
        const record = approvals!.getRecord(approvalId);
        return record?.continuation?.kind === 'automation_compaction' &&
          record.automationCompaction?.lifecycle === 'parent_committed'
          ? approvals!.markAutomationParentExecutionUnknown(approvalId)
          : approvals!.markProviderExecutionUnknown(approvalId);
      }
      return {
        conversationId: thread.id,
        status: 'error',
        error: 'Approval continuation could not resume',
      };
    }
  }

  async generate(
    conversationId: string,
    participantId: string,
    toolContext: ToolContext,
  ): Promise<MessageRouterResult> {
    return this.withLock(conversationId, async () => {
      const thread = await this.getThread(conversationId);
      const participant = this.collective.get(participantId);
      if (!participant) {
        return {
          conversationId,
          status: 'error',
          error: new ParticipantNotFoundError(participantId).message,
        };
      }

      const lastIncoming = [...thread.activeChain]
        .reverse()
        .find((m) => m.recipientId === participantId && m.role === 'user');

      if (!lastIncoming) {
        return {
          conversationId,
          status: 'error',
          error: `No incoming message to generate from in conversation ${conversationId}`,
        };
      }

      const runtime = this.registry.build(participant.type, participant.id);
      const lifecycleState = {
        operationId: createId('route'),
        actions: [] as MiddlewareActionResult[],
        context: toolContext,
        storedMessageId: lastIncoming.id,
      };
      const runtimeContext = this.buildRuntimeContext(thread, participant.id, toolContext, 0, {
        operationId: lifecycleState.operationId,
        incomingMessageId: lastIncoming.id,
        actions: lifecycleState.actions,
      });
      const opts: SendOptions = {
        senderId: lastIncoming.senderId,
        recipientId: participant.id,
        message: lastIncoming.content,
        conversationId,
        replyTo: lastIncoming.replyTo ?? lastIncoming.senderId,
        context: toolContext,
      };

      const task = this.dispatchAsync(
        runtime,
        lastIncoming,
        runtimeContext,
        thread,
        opts,
        lifecycleState,
      );
      this.background.add(task);
      void task.finally(() => this.background.delete(task)).catch(() => undefined);
      return { conversationId: thread.id, status: 'dispatched' };
    });
  }

  private async completeResponse(
    operation: ResponseOperation,
    result: RuntimeResult,
  ): Promise<MessageRouterResult> {
    const lifecycleState = this.withRuntimeActions(operation.lifecycleState, result);
    if (result.kind === 'response') {
      return this.persistResponse(
        operation.thread,
        operation.recipientId,
        operation.responseRecipientId,
        result,
        lifecycleState,
      );
    }
    if (result.kind === 'pending_approval') {
      return {
        conversationId: operation.thread.id,
        status: 'pending_approval',
        approvalRequests: result.approvalRequests,
      };
    }
    if (result.kind === 'middleware_pending') {
      return {
        conversationId: operation.thread.id,
        status: 'pending_approval',
        approvalId: result.approvalId,
        checkpointId: result.checkpointId,
        pendingParticipantId: operation.recipientId,
        approvalRequests: lifecycleState
          ? this.approvalRequests(lifecycleState.context, result.approvalId)
          : [],
        ...(lifecycleState?.storedMessageId === undefined
          ? {}
          : { partial: true, storedMessageId: lifecycleState.storedMessageId }),
      };
    }
    if (result.kind === 'middleware_abort') {
      return {
        conversationId: operation.thread.id,
        status: 'error',
        error: result.error,
        ...(lifecycleState?.storedMessageId === undefined
          ? {}
          : { partial: true, storedMessageId: lifecycleState.storedMessageId }),
      };
    }
    // kind === 'void'
    return { conversationId: operation.thread.id, status: 'success' };
  }

  private async dispatchAsync(
    runtime: ReturnType<RuntimeRegistry['build']>,
    inbound: Awaited<ReturnType<ConversationThread['append']>>,
    runtimeContext: RuntimeContext,
    thread: ConversationThread,
    opts: SendOptions,
    lifecycleState?: {
      operationId: string;
      actions: MiddlewareActionResult[];
      context: ToolContext;
      storedMessageId?: string;
    },
  ): Promise<void> {
    await this.withLock(thread.id, async () => undefined);
    const backgroundThread = this.createAppendSafeThread(thread);
    const backgroundContext: RuntimeContext = {
      ...runtimeContext,
      conversation: backgroundThread,
    };

    try {
      const result = await runtime.handle(inbound, backgroundContext);
      await this.completeResponse(
        {
          thread: backgroundThread,
          recipientId: opts.recipientId,
          responseRecipientId: opts.replyTo!,
          lifecycleState,
        },
        result,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.completeResponse(
        {
          thread: backgroundThread,
          recipientId: opts.recipientId,
          responseRecipientId: opts.replyTo!,
          lifecycleState,
        },
        { kind: 'response', content: `[Runtime error: ${msg}]` },
      );
    }
  }
}
