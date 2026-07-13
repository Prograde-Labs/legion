import type { ConversationStore } from '../conversation/ConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import type { Collective } from '../collective/Collective.js';
import type { EventBus } from '../events/EventBus.js';
import type { ToolContext, MessageRouterPort, MessageRouterResult } from '../tools/Tool.js';
import { snapshotMiddlewareActions } from '../auth/PendingApprovalRegistry.js';
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
  ): Promise<ConversationThread> {
    if (conversationId) {
      const existing = await this.store.load(conversationId);
      if (existing) return new ConversationThread(existing, this.store);
    }
    const created = await this.store.create({
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
    });
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

  async *sendStream(opts: SendOptions): AsyncGenerator<LLMChunk, MessageRouterResult> {
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
    const thread = await this.getThread(opts.conversationId, {
      parentConversationId,
      parentToolCallId,
      origin,
    });
    await ensureLock(thread.id);

    const inbound = await thread.append(
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

    const runtime = this.registry.build(recipient.type, recipient.id);
    const lifecycleState =
      this.lifecycle && this.middlewareRunner
        ? {
            operationId: createId('route'),
            actions: [] as MiddlewareActionResult[],
            context: opts.context,
            storedMessageId: inbound.id,
          }
        : undefined;
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
      const task = this.dispatchAsync(runtime, inbound, runtimeContext, thread, opts);
      this.background.add(task);
      void task.finally(() => {
        this.background.delete(task);
        streamAbort.dispose();
      });
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
        return await this.handleRuntimeResult(
          result,
          thread,
          recipient.id,
          opts.replyTo ?? opts.senderId,
          lifecycleState,
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
        return await this.handleRuntimeResult(
          result,
          thread,
          recipient.id,
          opts.replyTo ?? opts.senderId,
          lifecycleState,
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
      void task.finally(() => this.background.delete(task));
      return { conversationId: thread.id, status: 'dispatched' };
    }

    try {
      const result = await runtime.handle(inbound, runtimeContext);
      return await this.handleRuntimeResult(
        result,
        thread,
        recipient.id,
        opts.senderId,
        lifecycleState,
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
      return await this.handleRuntimeResult(result, thread, participant.id, lastIncoming.senderId, {
        operationId: createId('route'),
        actions: [],
        context: toolContext,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { conversationId: thread.id, status: 'error', error: msg };
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
      const runtimeContext = this.buildRuntimeContext(thread, participant.id, toolContext, 0);
      const opts: SendOptions = {
        senderId: lastIncoming.senderId,
        recipientId: participant.id,
        message: lastIncoming.content,
        conversationId,
        replyTo: lastIncoming.replyTo ?? lastIncoming.senderId,
        context: toolContext,
      };

      const task = this.dispatchAsync(runtime, lastIncoming, runtimeContext, thread, opts, {
        operationId: createId('route'),
        actions: [],
        context: toolContext,
      });
      this.background.add(task);
      void task.finally(() => this.background.delete(task));
      return { conversationId: thread.id, status: 'dispatched' };
    });
  }

  private async handleRuntimeResult(
    result: RuntimeResult,
    thread: ConversationThread,
    senderId: string,
    defaultRecipientId: string,
    lifecycleState?: {
      operationId: string;
      actions: MiddlewareActionResult[];
      context: ToolContext;
      storedMessageId?: string;
    },
  ): Promise<MessageRouterResult> {
    lifecycleState = this.withRuntimeActions(lifecycleState, result);
    if (result.kind === 'response') {
      return this.persistResponse(thread, senderId, defaultRecipientId, result, lifecycleState);
    }
    if (result.kind === 'pending_approval') {
      return {
        conversationId: thread.id,
        status: 'pending_approval',
        approvalRequests: result.approvalRequests,
      };
    }
    if (result.kind === 'middleware_pending') {
      return {
        conversationId: thread.id,
        status: 'pending_approval',
        approvalId: result.approvalId,
        checkpointId: result.checkpointId,
        pendingParticipantId: senderId,
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
        conversationId: thread.id,
        status: 'error',
        error: result.error,
        ...(lifecycleState?.storedMessageId === undefined
          ? {}
          : { partial: true, storedMessageId: lifecycleState.storedMessageId }),
      };
    }
    // kind === 'void'
    return { conversationId: thread.id, status: 'success' };
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
      if (result.kind !== 'response') return;
      lifecycleState = this.withRuntimeActions(lifecycleState, result);
      const replyTarget = opts.replyTo!;
      await this.persistResponse(
        backgroundThread,
        opts.recipientId,
        replyTarget,
        result,
        lifecycleState,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const replyTarget = opts.replyTo!;
      await this.persistResponse(
        backgroundThread,
        opts.recipientId,
        replyTarget,
        { content: `[Runtime error: ${msg}]` },
        lifecycleState,
      );
    }
  }
}
