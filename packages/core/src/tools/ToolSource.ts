import type { Tool } from './Tool.js';

/**
 * A ToolSource contributes tools to the global ToolRegistry.
 * It is responsible for the full lifecycle of its connection:
 * `load()` establishes the connection and returns the available tools;
 * `unload()` (optional) tears it down cleanly.
 *
 * Spec §9.
 */
export interface ToolSource {
  /**
   * Connect to the underlying source and return all tools it exposes.
   * Called once at startup; the source must remain connected for the lifetime
   * of the process so that tool `execute()` calls can reach the server.
   */
  load(): Promise<Tool[]>;

  /**
   * Disconnect from the underlying source and release any held resources.
   * Called during graceful shutdown.
   */
  unload?(): Promise<void>;
}
