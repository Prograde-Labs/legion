import type { Connector } from './Connector.js';

/**
 * Tracks registered connectors and which participants are actively connected
 * on each connector.
 *
 * - `register()` / `deregister()` — called at startup/shutdown for each connector.
 * - `setActive()` / `clearActive()` — called by connectors when clients connect/disconnect.
 * - `getActiveConnectors()` — presence-only: who is currently connected.
 * - `getDeliverableConnectors()` — what `UserDeliveryRuntime` uses to find where
 *   a message can be delivered, based on each connector's `canDeliver` predicate.
 */
export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();
  /** connectorName → Set<participantId> */
  private active = new Map<string, Set<string>>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.name)) {
      throw new Error(`Connector '${connector.name}' already registered`);
    }
    this.connectors.set(connector.name, connector);
    this.active.set(connector.name, new Set());
  }

  deregister(name: string): void {
    this.connectors.delete(name);
    this.active.delete(name);
  }

  get(name: string): Connector | undefined {
    return this.connectors.get(name);
  }

  getAll(): Connector[] {
    return [...this.connectors.values()];
  }

  /**
   * Mark a participant as actively connected on the named connector.
   * No-op if the connector is not registered.
   */
  setActive(participantId: string, connectorName: string): void {
    this.active.get(connectorName)?.add(participantId);
  }

  /**
   * Mark a participant as no longer actively connected.
   * No-op if the connector is not registered or the participant was not active.
   */
  clearActive(participantId: string, connectorName: string): void {
    this.active.get(connectorName)?.delete(participantId);
  }

  /**
   * Returns every registered connector that currently has an active connection
   * for `participantId`. Presence-only; delivery decisions belong to
   * `getDeliverableConnectors()`.
   */
  getActiveConnectors(participantId: string): Connector[] {
    const result: Connector[] = [];
    for (const [name, participants] of this.active) {
      if (participants.has(participantId)) {
        const connector = this.connectors.get(name);
        if (connector) result.push(connector);
      }
    }
    return result;
  }

  /**
   * Returns every registered connector whose `canDeliver` predicate accepts
   * `participantId`. Connectors without a predicate are treated as reachable.
   * This is independent of `setActive`, which remains presence-only.
   */
  getDeliverableConnectors(participantId: string): Connector[] {
    return this.getAll().filter((connector) => connector.canDeliver?.(participantId) ?? true);
  }
}
