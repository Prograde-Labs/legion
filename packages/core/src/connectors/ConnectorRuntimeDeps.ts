import type { Collective } from '../collective/Collective.js';
import type { EventBus } from '../events/EventBus.js';
import type { Connector } from './Connector.js';

/**
 * Runtime internals handed to external connector factories at construction time.
 * Everything else a connector needs arrives through `ConnectorContext` at `start()`.
 */
export interface ConnectorRuntimeDeps {
  /** Read access for identity mapping (`findByIdentity`). */
  collective: Collective;
  /** Subscribe to runtime events (e.g. `approval:requested`). */
  eventBus: EventBus;
}

export type ConnectorFactory = (
  options: Record<string, unknown>,
  deps: ConnectorRuntimeDeps,
) => Connector;
