import type { EventBus } from '../events/EventBus.js';
import type { Storage } from '../storage/Storage.js';
import type { ToolResult } from '@legion/types';

/**
 * A message delivered inbound to a service (spec §5).
 * Mirrors the fields of MessageData that a service needs to handle a request.
 */
export interface IncomingMessage {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  replyTo?: string;
  content: string;
  timestamp: string;
}

/**
 * Result of ServiceContext.communicate() — mirrors MessageRouterResult (spec §3).
 */
export interface CommunicateResult {
  conversationId: string;
  response?: string;
  status: 'success' | 'error' | 'dispatched';
  error?: string;
}

/** Lifecycle state of a managed service. */
export type ServiceStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

/** Public summary of a loaded service — used by management tooling (Plan 10). */
export interface ServiceInfo {
  participantId: string;
  status: ServiceStatus;
  error?: string;
}

/**
 * The execution context given to a LegionService (spec §5).
 *
 * Two distinct context lifetimes:
 *  - Startup context (passed to `start()`): long-lived, bound to a startup conversation.
 *    Services that do background work (timers, polling) hold a reference to this.
 *  - Per-call context (passed to `onMessage()`): short-lived, bound to the inbound
 *    message's conversationId. Created fresh for each message dispatch.
 */
export interface ServiceContext {
  /** The participant ID this service is bound to. */
  participantId: string;
  /** Aborted when the service is stopped. Honor this in long-running background work. */
  stopped: AbortSignal;
  /** Storage scoped to `.legion/services/<participantId>/`. */
  storage: Storage;
  /** Process-level typed event bus. */
  eventBus: EventBus;
  /**
   * Send a message to another participant.
   * Creates a new conversation if `opts.conversationId` is omitted.
   */
  communicate(
    to: string,
    message: string,
    opts?: { conversationId?: string; replyTo?: string },
  ): Promise<CommunicateResult>;
  /**
   * Execute a registered tool as this service participant.
   * Authorization is enforced (spec §7: "all authorized identically").
   * `requires_approval` fails closed — no authority chain exists in service context.
   */
  callTool(toolName: string, args: unknown): Promise<ToolResult>;
  /**
   * Sleep for `ms` milliseconds.
   * Resolves early (without throwing) if the service's `stopped` signal is aborted.
   */
  sleep(ms: number): Promise<void>;
}

/**
 * Implemented by any npm module that participates as a service (spec §5).
 *
 * Module export convention — service modules must export a named `service` constant:
 *
 * ```typescript
 * import type { LegionService } from '@legion/core';
 *
 * export const service: LegionService = {
 *   async start(ctx) {
 *     // initialise background work; store ctx for later use
 *   },
 *   async stop() {
 *     // clean up background work; ctx.stopped is already aborted
 *   },
 *   async onMessage(msg, ctx) {
 *     return `Received: ${msg.content}`;
 *   },
 * };
 * ```
 *
 * `onMessage` is optional. A service without it (or with `canReceive: false` in config)
 * returns a polite decline to any inbound message rather than erroring.
 */
export interface LegionService {
  start(context: ServiceContext): Promise<void>;
  stop(): Promise<void>;
  onMessage?(message: IncomingMessage, context: ServiceContext): Promise<string | void>;
}
