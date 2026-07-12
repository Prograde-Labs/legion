import type { ConversationStore } from '../conversation/ConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import type { Collective } from '../collective/Collective.js';
import type { EventBus } from '../events/EventBus.js';
import type { ToolContext, MessageRouterPort, MessageRouterResult } from '../tools/Tool.js';
import { ParticipantNotFoundError } from '../errors/LegionError.js';
import type { RuntimeRegistry } from './RuntimeRegistry.js';
import type { RuntimeContext, RuntimeResult } from './Runtime.js';
import type { MessageUsage, LLMChunk } from '@legion/types';

export interface SendOptions {
  senderId: string;
  recipientId: string;
  message: string;
  conversationId?: string;
  replyTo?: string;
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
  ) {}

  /** Await all in-flight fire-and-forget dispatches (test/shutdown aid). */
  async drain(): Promise<void> {
    await Promise.all([...this.background]);
  }

  private withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    const queued = prev.then(() => next);
    this.locks.set(conversationId, queued);
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
        // Best-effort cleanup: remove if no one else queued after us.
        if (this.locks.get(conversationId) === queued) {
          this.locks.delete(conversationId);
        }
      }
    });
  }

  private async getThread(
    conversationId?: string,
    parent?: { parentConversationId: string; parentToolCallId?: string },
  ): Promise<ConversationThread> {
    if (conversationId) {
      const existing = await this.store.load(conversationId);
      if (existing) return new ConversationThread(existing, this.store);
    }
    const created = await this.store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      parentConversationId: parent?.parentConversationId,
      parentToolCallId: parent?.parentToolCallId,
    });
    this.eventBus.emit('conversation:created', { conversationId: created.id });
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

  private buildRuntimeContext(
    thread: ConversationThread,
    participantId: string,
    toolContext: ToolContext,
    depth: number,
  ): RuntimeContext {
    const participant = this.collective.getOrThrow(participantId);
    return {
      ...(toolContext as RuntimeContext),
      participant,
      conversationId: thread.id,
      conversation: thread,
      communicationDepth: depth,
      messageRouter: this,
    };
  }

  private async persistResponse(
    thread: ConversationThread,
    senderId: string,
    recipientId: string,
    response: { content: string; reasoning?: string; usage?: MessageUsage },
  ): Promise<void> {
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
  }

  async send(opts: SendOptions): Promise<MessageRouterResult> {
    if (opts.conversationId) {
      return this.withLock(opts.conversationId, () => this.sendInner(opts));
    }
    return this.sendInner(opts);
  }

  async *sendStream(opts: SendOptions): AsyncGenerator<LLMChunk, MessageRouterResult> {
    return yield* this.sendStreamInner(opts);
  }

  private async *sendStreamInner(opts: SendOptions): AsyncGenerator<LLMChunk, MessageRouterResult> {
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

    const parentConvId = opts.context.conversationId;
    const parentLink =
      !opts.conversationId && parentConvId && parentConvId !== ''
        ? {
            parentConversationId: parentConvId,
            parentToolCallId: opts.context.toolCallId as string | undefined,
          }
        : undefined;
    const thread = await this.getThread(opts.conversationId, parentLink);

    const inbound = await thread.append({
      senderId: opts.senderId,
      recipientId: opts.recipientId,
      role: 'user',
      content: opts.message,
      replyTo: opts.replyTo,
    });
    this.eventBus.emit('message:sent', {
      conversationId: thread.id,
      senderId: opts.senderId,
      recipientId: opts.recipientId,
      messageId: inbound.id,
    });

    const runtime = this.registry.build(recipient.type, recipient.id);
    const runtimeContext = this.buildRuntimeContext(
      thread,
      recipient.id,
      { ...opts.context, communicationDepth: depth },
      depth,
    );

    if (opts.replyTo) {
      const task = this.dispatchAsync(runtime, inbound, runtimeContext, thread, opts);
      this.background.add(task);
      void task.finally(() => this.background.delete(task));
      return { conversationId: thread.id, status: 'dispatched' };
    }

    try {
      if (runtime.handleStream) {
        const result = yield* runtime.handleStream(inbound, runtimeContext);
        return yield* this.handleRuntimeResultGenerator(
          result,
          thread,
          recipient.id,
          opts.senderId,
        );
      } else {
        const result = await runtime.handle(inbound, runtimeContext);
        return yield* this.handleRuntimeResultGenerator(
          result,
          thread,
          recipient.id,
          opts.senderId,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { conversationId: thread.id, status: 'error', error: msg };
    }
  }

  private async *handleRuntimeResultGenerator(
    result: RuntimeResult,
    thread: ConversationThread,
    senderId: string,
    defaultRecipientId: string,
  ): AsyncGenerator<LLMChunk, MessageRouterResult> {
    if (result.kind === 'response') {
      await this.persistResponse(thread, senderId, defaultRecipientId, result);
      return { conversationId: thread.id, response: result.content, status: 'success' };
    }
    if (result.kind === 'pending_approval') {
      return {
        conversationId: thread.id,
        status: 'pending_approval',
        approvalRequests: result.approvalRequests,
      };
    }
    return { conversationId: thread.id, status: 'success' };
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
    const parentConvId = opts.context.conversationId;
    const parentLink =
      !opts.conversationId && parentConvId && parentConvId !== ''
        ? {
            parentConversationId: parentConvId,
            parentToolCallId: opts.context.toolCallId as string | undefined,
          }
        : undefined;
    const thread = await this.getThread(opts.conversationId, parentLink);

    const inbound = await thread.append({
      senderId: opts.senderId,
      recipientId: opts.recipientId,
      role: 'user',
      content: opts.message,
      replyTo: opts.replyTo,
    });
    this.eventBus.emit('message:sent', {
      conversationId: thread.id,
      senderId: opts.senderId,
      recipientId: opts.recipientId,
      messageId: inbound.id,
    });

    const runtime = this.registry.build(recipient.type, recipient.id);
    const runtimeContext = this.buildRuntimeContext(
      thread,
      recipient.id,
      { ...opts.context, communicationDepth: depth },
      depth,
    );

    if (opts.replyTo) {
      const task = this.dispatchAsync(runtime, inbound, runtimeContext, thread, opts);
      this.background.add(task);
      void task.finally(() => this.background.delete(task));
      return { conversationId: thread.id, status: 'dispatched' };
    }

    try {
      const result = await runtime.handle(inbound, runtimeContext);
      return await this.handleRuntimeResult(result, thread, recipient.id, opts.senderId);
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
      return await this.handleRuntimeResult(result, thread, participant.id, lastIncoming.senderId);
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

      const task = this.dispatchAsync(runtime, lastIncoming, runtimeContext, thread, opts);
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
  ): Promise<MessageRouterResult> {
    if (result.kind === 'response') {
      await this.persistResponse(thread, senderId, defaultRecipientId, result);
      return { conversationId: thread.id, response: result.content, status: 'success' };
    }
    if (result.kind === 'pending_approval') {
      return {
        conversationId: thread.id,
        status: 'pending_approval',
        approvalRequests: result.approvalRequests,
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
      const replyTarget = opts.replyTo!;
      const responseMsg = await backgroundThread.append({
        senderId: opts.recipientId,
        recipientId: replyTarget,
        role: 'assistant',
        content: result.content,
        reasoning: result.reasoning,
        usage: result.usage,
      });
      this.eventBus.emit('message:delivered', {
        conversationId: backgroundThread.id,
        recipientId: replyTarget,
        messageId: responseMsg.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const replyTarget = opts.replyTo!;
      const responseMsg = await backgroundThread.append({
        senderId: opts.recipientId,
        recipientId: replyTarget,
        role: 'assistant',
        content: `[Runtime error: ${msg}]`,
      });
      this.eventBus.emit('message:delivered', {
        conversationId: backgroundThread.id,
        recipientId: replyTarget,
        messageId: responseMsg.id,
      });
    }
  }
}
