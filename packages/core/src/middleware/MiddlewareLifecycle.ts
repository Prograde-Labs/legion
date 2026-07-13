import type {
  MessageData,
  MessageDraft,
  MessageUsage,
  MiddlewareActionResult,
  ParticipantConfig,
} from '@legion/types';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import type { EventBus } from '../events/EventBus.js';
import type { MessageRouterResult } from '../tools/Tool.js';
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
}

export interface RespondLifecycleInput extends Omit<ReceiveLifecycleInput, 'mode'> {}

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
      const senderBefore = await this.runner.runMessagePhase({
        operationId: input.operationId,
        phase: 'beforeSend',
        participant: input.sender,
        thread: input.thread,
        draft: input.draft,
        actions: actionsCopy(input.actions),
        final: true,
        signal: input.signal,
      });
      if (senderBefore.kind !== 'continue') return this.messageTerminal(senderBefore);

      const recipientBefore = await this.runner.runMessagePhase({
        operationId: input.operationId,
        phase: 'beforeReceive',
        participant: input.recipient,
        thread: input.thread,
        draft: senderBefore.value,
        actions: actionsCopy(senderBefore.actions),
        final: true,
        signal: input.signal,
      });
      if (recipientBefore.kind !== 'continue') return this.messageTerminal(recipientBefore);

      stored = await input.thread.append(
        {
          ...recipientBefore.value,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
        },
        {
          reactivate: input.mode === 'pre_runtime',
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
        actions: actionsCopy(recipientBefore.actions),
        signal: input.signal,
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

  private messageTerminal(
    result: Exclude<MessagePhaseResult, { kind: 'continue' }>,
  ): InboundLifecycleResult {
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
