import type { ToolResult } from '@legion/types';
import { ConflictError, ToolNotFoundError } from '../errors/LegionError.js';
import type { Tool, ToolContext, ToolRegistryLike } from './Tool.js';

export class ToolRegistry implements ToolRegistryLike {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new ConflictError(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  listAll(): string[] {
    return [...this.tools.keys()];
  }

  async execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { status: 'error', error: new ToolNotFoundError(name).message };
    }
    try {
      return await tool.execute(args, context) as ToolResult;
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
