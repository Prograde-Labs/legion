import type { ConversationStore } from '../conversation/ConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import type { Collective } from '../collective/Collective.js';
import type { EventBus } from '../events/EventBus.js';
import type { ToolContext, MessageRouterPort, MessageRouterResult } from '../tools/Tool.js';
import { ParticipantNotFoundError } from '../errors/LegionError.js';
import type { RuntimeRegistry } from './RuntimeRegistry.js';
import type { RuntimeContext } from './Runtime.js';

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

  private async getThread(conversationId?: string): Promise<ConversationThread> {
    if (conversationId) {
      const existing = await this.store.load(conversationId);
      if (existing) return new ConversationThread(existing, this.store);
    }
    const created = await this.store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    this.eventBus.emit('conversation:created', { conversationId: created.id });
    return new ConversationThread(created, this.store);
  }

  async send(opts: SendOptions): Promise<MessageRouterResult> {
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

    const thread = await this.getThread(opts.conversationId);

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
    const runtimeContext: RuntimeContext = {
      ...(opts.context as RuntimeContext),
      participant: recipient,
      conversationId: thread.id,
      conversation: thread,
      communicationDepth: depth,
      messageRouter: this,
    };

    if (opts.replyTo) {
      const task = this.dispatchAsync(runtime, inbound, runtimeContext, thread, opts);
      this.background.add(task);
      void task.finally(() => this.background.delete(task));
      return { conversationId: thread.id, status: 'dispatched' };
    }

    const response = await runtime.handle(inbound, runtimeContext);
    if (typeof response === 'string') {
      const responseMsg = await thread.append({
        senderId: opts.recipientId,
        recipientId: opts.senderId,
        role: 'assistant',
        content: response,
      });
      this.eventBus.emit('message:sent', {
        conversationId: thread.id,
        senderId: opts.recipientId,
        recipientId: opts.senderId,
        messageId: responseMsg.id,
      });
      return { conversationId: thread.id, response, status: 'success' };
    }
    return { conversationId: thread.id, status: 'success' };
  }

  private async dispatchAsync(
    runtime: ReturnType<RuntimeRegistry['build']>,
    inbound: Awaited<ReturnType<ConversationThread['append']>>,
    runtimeContext: RuntimeContext,
    thread: ConversationThread,
    opts: SendOptions,
  ): Promise<void> {
    const response = await runtime.handle(inbound, runtimeContext);
    if (typeof response !== 'string') return;
    // Route the response to the replyTo participant (spec §3).
    const replyTarget = opts.replyTo!;
    const responseMsg = await thread.append({
      senderId: opts.recipientId,
      recipientId: replyTarget,
      role: 'assistant',
      content: response,
    });
    this.eventBus.emit('message:delivered', {
      conversationId: thread.id,
      recipientId: replyTarget,
      messageId: responseMsg.id,
    });
  }
}
