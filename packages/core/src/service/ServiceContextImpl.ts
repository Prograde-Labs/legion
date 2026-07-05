import type { ServiceConfig, ToolResult, WorkspaceConfig } from '@legion/types';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { Collective } from '../collective/Collective.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import type { EventBus } from '../events/EventBus.js';
import type { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { Storage } from '../storage/Storage.js';
import type { MessageRouterPort, ToolContext, ToolRegistryLike } from '../tools/Tool.js';
import type { ServiceManager } from './ServiceManager.js';
import type { CommunicateResult, ServiceContext } from './LegionService.js';

export interface ServiceContextDeps {
  participant: ServiceConfig;
  /** The active conversationId for this context instance. */
  conversationId: string;
  store: ConversationStore;
  collective: Collective;
  toolRegistry: ToolRegistryLike;
  workspaceConfig: WorkspaceConfig;
  eventBus: EventBus;
  /** Storage scoped to `.legion/services/<id>/` — exposed as `ServiceContext.storage`. */
  scopedStorage: Storage;
  /** Process-level raw storage — placed in `ToolContext.storage` for tool execution. */
  rawStorage: Storage;
  workspaceRoot: string;
  authEngine: AuthEngine;
  pendingApprovalRegistry: PendingApprovalRegistry;
  messageRouter: MessageRouterPort;
  stopped: AbortSignal;
  serviceManager: ServiceManager | undefined;
}

/**
 * Concrete implementation of `ServiceContext` (spec §5).
 *
 * Created fresh per-call by `ServiceManager`'s `makeContext` closure:
 *   - Startup context: `conversationId` = the service's startup conversation
 *   - Per-message context: `conversationId` = the incoming message's conversationId
 *
 * `callTool` builds a minimal `ToolContext` from deps and calls `AuthEngine.authorize`
 * before delegating to `ToolRegistry.execute`. The `ToolContext` index signature
 * (`[key: string]: unknown`) carries `authEngine`, `pendingApprovalRegistry`, and
 * `serviceManager` through to any tools that need them.
 */
export class ServiceContextImpl implements ServiceContext {
  constructor(private readonly deps: ServiceContextDeps) {}

  get participantId(): string {
    return this.deps.participant.id;
  }

  get stopped(): AbortSignal {
    return this.deps.stopped;
  }

  get storage(): Storage {
    return this.deps.scopedStorage;
  }

  get eventBus(): EventBus {
    return this.deps.eventBus;
  }

  async communicate(
    to: string,
    message: string,
    opts?: { conversationId?: string; replyTo?: string },
  ): Promise<CommunicateResult> {
    const result = await this.deps.messageRouter.send({
      senderId: this.deps.participant.id,
      recipientId: to,
      message,
      conversationId: opts?.conversationId ?? this.deps.conversationId,
      replyTo: opts?.replyTo,
      context: this.buildToolContext(),
    });
    return {
      conversationId: result.conversationId,
      response: result.response,
      status:
        result.status === 'dispatched'
          ? 'dispatched'
          : result.status === 'error'
            ? 'error'
            : 'success',
      error: result.error,
    };
  }

  async callTool(toolName: string, args: unknown): Promise<ToolResult> {
    const { participant, authEngine } = this.deps;

    const authResult = authEngine.authorize(participant.id, toolName, args, participant.tools);
    if (!authResult.authorized) {
      const reason =
        authResult.reason === 'requires_approval'
          ? 'requires_approval — no authority chain in service context (denied)'
          : authResult.reason === 'hidden'
            ? 'tool not available to this participant'
            : (authResult.reason ?? 'denied');
      return { status: 'error', error: reason };
    }

    return this.deps.toolRegistry.execute(toolName, args, this.buildToolContext());
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const tid = setTimeout(resolve, ms);
      this.deps.stopped.addEventListener('abort', () => {
        clearTimeout(tid);
        resolve();
      });
    });
  }

  /**
   * Builds a minimal `ToolContext` for use in `communicate` and `callTool`.
   * The index signature on `ToolContext` (`[key: string]: unknown`) allows carrying
   * `authEngine`, `pendingApprovalRegistry`, and `serviceManager` through to tools.
   */
  private buildToolContext(): ToolContext {
    const {
      participant,
      conversationId,
      collective,
      workspaceConfig,
      eventBus,
      rawStorage,
      workspaceRoot,
      authEngine,
      pendingApprovalRegistry,
      messageRouter,
      serviceManager,
      toolRegistry,
    } = this.deps;

    return {
      participant,
      conversationId,
      collective,
      config: workspaceConfig,
      eventBus,
      storage: rawStorage,
      workspaceRoot,
      communicationDepth: 0,
      toolRegistry,
      messageRouter,
      authEngine,
      pendingApprovalRegistry,
      serviceManager,
    };
  }
}
