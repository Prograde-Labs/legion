import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import type { ConnectorConfig } from '@legion-collective/types';
import type { Connector, ConnectorContext } from './Connector.js';
import type { ConnectorRuntimeDeps } from './ConnectorRuntimeDeps.js';

export interface LoadedConnector {
  name: string;
  connector: Connector;
}

export interface LoaderFailure {
  name: string;
  reason: string;
}

type ConnectorFactory = (options: Record<string, unknown>, deps: ConnectorRuntimeDeps) => Connector;

function resolveModuleSpec(spec: string, workspaceRoot: string): string {
  if (isAbsolute(spec)) return pathToFileURL(spec).href;
  try {
    return pathToFileURL(createRequire(join(workspaceRoot, 'package.json')).resolve(spec)).href;
  } catch {
    return pathToFileURL(resolve(workspaceRoot, spec)).href;
  }
}

/**
 * Resolve, import, construct, and start every configured external connector
 * with the shared ConnectorContext. Never throws per-entry: broken modules /
 * bad factories / start() failures are reported in `failures` so the process
 * boots without them (log-and-skip).
 */
export async function loadExternalConnectors(
  entries: ConnectorConfig[],
  workspaceRoot: string,
  deps: ConnectorRuntimeDeps,
  context: ConnectorContext,
): Promise<{ loaded: LoadedConnector[]; failures: LoaderFailure[] }> {
  const loaded: LoadedConnector[] = [];
  const failures: LoaderFailure[] = [];

  for (const entry of entries) {
    const { name } = entry;
    if (!entry.module || entry.enabled === false) continue;
    try {
      const mod = (await import(resolveModuleSpec(entry.module, workspaceRoot))) as {
        connector?: unknown;
      };
      const factory = mod.connector;
      if (typeof factory !== 'function') {
        failures.push({ name, reason: 'module has no named `connector` factory export' });
        continue;
      }
      const factoryOptions = entry.defaultParticipantId
        ? { ...(entry.options ?? {}), defaultParticipantId: entry.defaultParticipantId }
        : (entry.options ?? {});
      const connector = (factory as ConnectorFactory)(factoryOptions, deps);
      if (
        !connector ||
        typeof connector.start !== 'function' ||
        typeof connector.deliver !== 'function' ||
        typeof connector.stop !== 'function'
      ) {
        failures.push({ name, reason: 'factory did not return a Connector (start/deliver/stop)' });
        continue;
      }
      await connector.start(context); // let start-throw become a per-entry failure, not a boot kill
      loaded.push({ name, connector });
    } catch (err) {
      failures.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`[connector-loader] skipped '${f.name}': ${f.reason}`);
  }
  // Duplicate connector names: last-wins (ConnectorRegistry.register would otherwise throw).
  const byName = new Map<string, LoadedConnector>();
  for (const entry of loaded) {
    if (byName.has(entry.connector.name)) {
      console.warn(
        `[connector-loader] duplicate connector name '${entry.connector.name}' — last wins`,
      );
    }
    byName.set(entry.connector.name, entry);
  }
  return { loaded: [...byName.values()], failures };
}
