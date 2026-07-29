import type { ToolResult, StreamChunk } from '@legion/types';
import type { MessageRouterResult } from '../tools/Tool.js';
import type { ConnectorRegistry } from './ConnectorRegistry.js';

/** The shape an external entity sends as a message through a connector. */
export interface ConnectorSubmitOptions {
  senderId: string;
  recipientId: string;
  content: string;
  conversationId?: string;
  replyTo?: string;
}

/**
 * Context object given to a connector when it starts. Provides the inbound
 * submit path (message routing), tool execution, and the active-participant registry.
 */
export interface ConnectorContext {
  /** Route an inbound message from an external entity into the collective. */
  submit(msg: ConnectorSubmitOptions): Promise<MessageRouterResult>;

  /**
   * Execute a named tool as the given participant.
   * Authorization is checked before execution; the result includes the
   * conversation created for this call.
   */
  callTool(
    participantId: string,
    toolName: string,
    args: unknown,
    opts?: { conversationId?: string; cancelStream?: (streamId: string) => boolean },
  ): Promise<{ result: ToolResult; conversationId: string }>;

  /**
   * Execute a named streaming tool as the given participant.
   * Authorization is checked before the generator is returned.
   * The generator must be iterated to drive execution.
   */
  streamTool(
    participantId: string,
    toolName: string,
    args: unknown,
    opts?: {
      conversationId?: string;
      signal?: AbortSignal;
      cancelStream?: (streamId: string) => boolean;
    },
  ): Promise<{ gen: AsyncGenerator<StreamChunk>; conversationId: string }>;

  /** The active-participant registry: register/deregister who this connector fronts. */
  registry: ConnectorRegistry;
}

/**
 * A boundary channel through which external entities interact with the collective.
 * The `deliver` method is called by `UserDeliveryRuntime` to push outbound messages.
 */
export interface Connector {
  /** Unique connector name, e.g. `'web'`, `'teams'`, `'slack'`. */
  readonly name: string;

  /** Called once at process startup to hand over the `ConnectorContext`. */
  start(ctx: ConnectorContext): Promise<void>;

  /**
   * Push a message outbound to the external entity the connector fronts.
   * Called by `UserDeliveryRuntime` when a message is addressed to a
   * connector-bound participant.
   */
  deliver(message: {
    id: string;
    conversationId: string;
    senderId: string;
    recipientId: string;
    replyTo?: string;
    content: string;
    timestamp: string;
  }): Promise<void>;

  /** Called on process shutdown. Release all resources. */
  stop(): Promise<void>;
}
