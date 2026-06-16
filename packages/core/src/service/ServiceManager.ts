import { isAbsolute, resolve } from 'node:path';
import type { ServiceConfig, WorkspaceConfig } from '@legion/types';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { Collective } from '../collective/Collective.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import type { EventBus } from '../events/EventBus.js';
import type { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import type { Storage } from '../storage/Storage.js';
import type { MessageRouterPort, ToolContext, ToolRegistryLike } from '../tools/Tool.js';
import { ConfigError, ParticipantNotFoundError } from '../errors/LegionError.js';
import type { LegionService, ServiceInfo, ServiceStatus } from './LegionService.js';
import { ServiceContextImpl, type ServiceContextDeps } from './ServiceContextImpl.js';
import { ServiceRuntime } from './ServiceRuntime.js';

export interface ServiceManagerDeps {
  collective: Collective;
  store: ConversationStore;
  toolRegistry: ToolRegistryLike;
  authEngine: AuthEngine;
  pendingApprovalRegistry: PendingApprovalRegistry;
  messageRouter: MessageRouterPort;
  eventBus: EventBus;
  storage: Storage;
  workspaceConfig: WorkspaceConfig;
  workspaceRoot: string;
}

interface ServiceEntry {
  config: ServiceConfig;
  service: LegionService;
  runtime: ServiceRuntime;
  abortController: AbortController;
  makeContext: (conversationId: string) => ServiceContextImpl;
  status: ServiceStatus;
  startupConversationId?: string;
  error?: string;
}

export class ServiceManager {
  private readonly entries = new Map<string, ServiceEntry>();

  constructor(private readonly deps: ServiceManagerDeps) {}

  async loadService(config: ServiceConfig): Promise<void> {
    const modPath = isAbsolute(config.module)
      ? config.module
      : resolve(this.deps.workspaceRoot, config.module);

    const mod = (await import(modPath)) as Record<string, unknown>;
    const service = mod['service'] as LegionService | undefined;

    if (!service || typeof service.start !== 'function' || typeof service.stop !== 'function') {
      throw new ConfigError(
        `Service module '${config.module}' must export a named 'service' constant implementing LegionService ` +
          `(has start() and stop()).`,
      );
    }

    const abortController = new AbortController();
    const scopedStorage = this.deps.storage.scope(`services/${config.id}`);
    const manager = this;

    const makeContext = (conversationId: string): ServiceContextImpl => {
      const ctxDeps: ServiceContextDeps = {
        participant: config,
        conversationId,
        store: manager.deps.store,
        collective: manager.deps.collective,
        toolRegistry: manager.deps.toolRegistry,
        workspaceConfig: manager.deps.workspaceConfig,
        eventBus: manager.deps.eventBus,
        scopedStorage,
        rawStorage: manager.deps.storage,
        workspaceRoot: manager.deps.workspaceRoot,
        authEngine: manager.deps.authEngine,
        pendingApprovalRegistry: manager.deps.pendingApprovalRegistry,
        messageRouter: manager.deps.messageRouter,
        stopped: abortController.signal,
        serviceManager: manager,
      };
      return new ServiceContextImpl(ctxDeps);
    };

    const runtime = new ServiceRuntime(service, config, makeContext);

    this.entries.set(config.id, {
      config,
      service,
      runtime,
      abortController,
      makeContext,
      status: 'stopped',
    });
  }

  async startService(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new ParticipantNotFoundError(id);
    if (entry.status === 'running') return;

    entry.status = 'starting';
    entry.error = undefined;

    const startupConv = await this.deps.store.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      title: `Service startup: ${id}`,
    });
    entry.startupConversationId = startupConv.id;

    const ctx = entry.makeContext(startupConv.id);

    try {
      await entry.service.start(ctx);
      entry.status = 'running';
    } catch (rawErr) {
      const err = rawErr as Error;
      entry.status = 'failed';
      entry.error = err.message;

      this.deps.eventBus.emit('error', {
        conversationId: startupConv.id,
        error: { name: err.name, message: err.message },
      });

      if (entry.config.errorNotify) {
        try {
          await this.deps.messageRouter.send({
            senderId: id,
            recipientId: entry.config.errorNotify,
            message: `Service '${id}' failed to start: ${err.message}`,
            context: this.buildBaseToolContext(id, startupConv.id),
          });
        } catch {
          // Notification failures must not mask the service error state.
        }
      }
    }
  }

  async stopService(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new ParticipantNotFoundError(id);
    if (entry.status === 'stopped') return;

    entry.status = 'stopping';
    entry.abortController.abort();

    try {
      await entry.service.stop();
    } catch (rawErr) {
      const err = rawErr as Error;
      this.deps.eventBus.emit('error', {
        error: { name: err.name, message: err.message },
      });
    }

    entry.status = 'stopped';
  }

  async autoStart(): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.config.autoStart !== false && entry.status === 'stopped') {
        await this.startService(id);
      }
    }
  }

  getRuntime(id: string): ServiceRuntime {
    const entry = this.entries.get(id);
    if (!entry) throw new ParticipantNotFoundError(id);
    return entry.runtime;
  }

  getStatus(id: string): ServiceStatus | undefined {
    return this.entries.get(id)?.status;
  }

  getAll(): ServiceInfo[] {
    return [...this.entries.values()].map((e) => ({
      participantId: e.config.id,
      status: e.status,
      error: e.error,
    }));
  }

  private buildBaseToolContext(participantId: string, conversationId: string): ToolContext {
    const config = this.deps.collective.getOrThrow(participantId);
    return {
      participant: config,
      conversationId,
      collective: this.deps.collective,
      config: this.deps.workspaceConfig,
      eventBus: this.deps.eventBus,
      storage: this.deps.storage,
      workspaceRoot: this.deps.workspaceRoot,
      communicationDepth: 0,
      toolRegistry: this.deps.toolRegistry,
      messageRouter: this.deps.messageRouter,
      authEngine: this.deps.authEngine,
      pendingApprovalRegistry: this.deps.pendingApprovalRegistry,
    };
  }
}
