import type { MCPServerConfig } from '@legion-collective/types';
import { MCPToolSource } from './MCPToolSource.js';
import type { ToolRegistry } from './ToolRegistry.js';
import type { ToolSource } from './ToolSource.js';

/**
 * Load all MCP tool sources declared in the workspace config and register their
 * tools into the global ToolRegistry.
 *
 * Called by LegionProcess during startup (spec §8 step 7). Returns the array of
 * loaded ToolSource instances so the caller can invoke `unload()` on each during
 * graceful shutdown.
 *
 * Throws if any source fails to connect, or if two sources expose a tool under
 * the same namespaced name (a ConflictError from ToolRegistry.register()).
 */
export async function loadMCPSources(
  configs: MCPServerConfig[],
  registry: ToolRegistry,
): Promise<ToolSource[]> {
  const sources: ToolSource[] = [];

  try {
    for (const config of configs) {
      const source = new MCPToolSource(config);
      const tools = await source.load();
      for (const tool of tools) {
        registry.register(tool); // throws ConflictError on duplicate name
      }
      sources.push(source);
    }
  } catch (e) {
    for (const source of sources) {
      await source.unload?.();
    }
    throw e;
  }

  return sources;
}
