import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Connector,
  ConnectorContext,
  ConnectorRegistry,
  ConnectorRuntimeDeps,
} from '@legion/core';
import type { ConnectorConfig } from '@legion/types';

export interface LoadConnectorsDeps {
  configs: ConnectorConfig[];
  connectorRegistry: ConnectorRegistry;
  workspaceRoot: string;
  runtimeDeps: ConnectorRuntimeDeps;
  /** Builds the built-in web connector with its runtime-internal dependencies. */
  createWebConnector: () => Connector;
  /** Builds the shared ConnectorContext once all connectors are registered. */
  buildContext: () => ConnectorContext;
}

function resolveConnectorModule(spec: string, workspaceRoot: string): string {
  if (isAbsolute(spec)) return pathToFileURL(spec).href;
  const require = createRequire(join(workspaceRoot, 'package.json'));
  try {
    return pathToFileURL(require.resolve(spec)).href;
  } catch {
    const direct = resolve(workspaceRoot, spec);
    if (existsSync(direct)) return pathToFileURL(direct).href;
    throw new Error(
      `Connector module '${spec}' not found (tried Node resolution from ${workspaceRoot} and path ${direct})`,
    );
  }
}

async function loadExternalConnector(
  entry: ConnectorConfig,
  workspaceRoot: string,
  runtimeDeps: ConnectorRuntimeDeps,
): Promise<Connector> {
  if (!entry.module) {
    throw new Error(`Connector '${entry.name}' requires a 'module' (built-in names: web)`);
  }
  const resolved = resolveConnectorModule(entry.module, workspaceRoot);
  const mod = (await import(resolved)) as Record<string, unknown>;
  const factory = mod.connector;
  if (typeof factory !== 'function') {
    throw new Error(
      `Connector module '${entry.module}' must export a named 'connector' factory ` +
        `(options, deps) => Connector`,
    );
  }
  const factoryOptions = entry.defaultParticipantId
    ? { ...(entry.options ?? {}), defaultParticipantId: entry.defaultParticipantId }
    : (entry.options ?? {});
  return (factory as (options: Record<string, unknown>, deps: ConnectorRuntimeDeps) => Connector)(
    factoryOptions,
    runtimeDeps,
  );
}

/**
 * Register all configured connectors, build the shared ConnectorContext, then start
 * every connector. The web connector fails fast on construction/start errors; external
 * connectors log-and-skip so a broken plugin cannot take the process down.
 */
export async function loadAndStartConnectors(deps: LoadConnectorsDeps): Promise<void> {
  const registered: Array<{ connector: Connector; external: boolean }> = [];
  const configs: ConnectorConfig[] = deps.configs.length > 0 ? deps.configs : [{ name: 'web' }];

  for (const entry of configs) {
    if (entry.enabled === false) continue;
    const external = entry.name !== 'web';
    try {
      const connector = external
        ? await loadExternalConnector(entry, deps.workspaceRoot, deps.runtimeDeps)
        : deps.createWebConnector();
      deps.connectorRegistry.register(connector);
      registered.push({ connector, external });
    } catch (err) {
      if (!external) throw err;
      console.error(`  [connectors] failed to load connector '${entry.name}':`, err);
    }
  }

  const context = deps.buildContext();
  for (const { connector, external } of registered) {
    if (!external) {
      await connector.start(context);
      continue;
    }
    try {
      await connector.start(context);
    } catch (err) {
      deps.connectorRegistry.deregister(connector.name);
      console.error(`  [connectors] failed to start connector '${connector.name}':`, err);
    }
  }
}
