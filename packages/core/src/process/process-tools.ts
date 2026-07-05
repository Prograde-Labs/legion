import type { ToolResult } from '@legion/types';
import type { Tool, ToolContext } from '../tools/Tool.js';
import type { ProcessManager } from './ProcessManager.js';

function pm(ctx: ToolContext): ProcessManager {
  return ctx.processManager as ProcessManager;
}

function ok(data: unknown): ToolResult {
  return { status: 'success', data };
}

function err(error: unknown): ToolResult {
  return { status: 'error', error: String(error) };
}

const spawnInputSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Executable path or name' },
    args: { type: 'array', items: { type: 'string' }, default: [] },
    cwd: { type: 'string', description: 'Working directory; defaults to workspaceRoot' },
    env: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
    tty: { type: 'boolean', default: false, description: 'Allocate a PTY (pseudo-terminal)' },
    shell: { type: 'boolean', default: false, description: 'Wrap command in /bin/sh -c' },
    name: { type: 'string', description: 'Optional display name' },
    cols: { type: 'number', default: 80, description: 'PTY columns (tty mode only)' },
    rows: { type: 'number', default: 24, description: 'PTY rows (tty mode only)' },
  },
  required: ['command'],
};

export const executeCommandTool: Tool = {
  name: 'execute_command',
  description:
    'Run a shell command synchronously and return its stdout, stderr, and exit code. Blocks until the command exits or timeoutMs is reached.',
  parameters: {
    ...spawnInputSchema,
    properties: {
      ...spawnInputSchema.properties,
      timeoutMs: {
        type: 'number',
        default: 60000,
        description: 'Milliseconds before SIGTERM is sent; 0 = no timeout',
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      const result = await pm(ctx).execute(
        {
          command: a.command,
          args: a.args,
          cwd: a.cwd,
          env: a.env,
          tty: a.tty,
          shell: a.shell,
          name: a.name,
          cols: a.cols,
          rows: a.rows,
        },
        ctx.participant.id,
        { timeoutMs: a.timeoutMs },
      );
      return ok(result);
    } catch (e) {
      return err(e);
    }
  },
};

export const startProcessTool: Tool = {
  name: 'start_process',
  description:
    'Start a long-running process asynchronously. Returns immediately with a process handle. Use read_process_output, write_process_input, and stop_process to interact with it.',
  parameters: spawnInputSchema,
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const handle = await pm(ctx).start(args as any, ctx.participant.id);
      return ok(handle);
    } catch (e) {
      return err(e);
    }
  },
};

export const listProcessesTool: Tool = {
  name: 'list_processes',
  description: 'List processes (running and historical). Sorted by startedAt descending.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['running', 'exited', 'killed', 'abandoned', 'all'],
        default: 'all',
      },
      limit: { type: 'number', default: 100 },
      offset: { type: 'number', default: 0 },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      const handles = await pm(ctx).list({ status: a.status, limit: a.limit, offset: a.offset });
      return ok(handles);
    } catch (e) {
      return err(e);
    }
  },
};

export const getProcessTool: Tool = {
  name: 'get_process',
  description: 'Get the current state of a single process by id.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as any;
    const handle = pm(ctx).get(a.id);
    if (!handle) return err(`Process ${a.id} not found`);
    return ok(handle);
  },
};

export const readProcessOutputTool: Tool = {
  name: 'read_process_output',
  description:
    'Read captured output from a process. Omit `from` to get the ring buffer tail (fast). Provide `from` (byte offset) to read historical output from the log file.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      bytes: { type: 'number', default: 8192, description: 'Max bytes to return (cap: 1 MiB)' },
      from: { type: 'number', description: 'Byte offset in output.log; omit for ring buffer tail' },
      decode: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
    },
    required: ['id'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      const result = await pm(ctx).readOutput(a.id, { bytes: a.bytes, from: a.from });
      const decode = a.decode ?? 'utf8';
      return ok({
        data: decode === 'base64' ? result.data.toString('base64') : result.data.toString('utf8'),
        totalBytes: result.totalBytes,
        from: result.from,
      });
    } catch (e) {
      return err(e);
    }
  },
};

export const writeProcessInputTool: Tool = {
  name: 'write_process_input',
  description: 'Write data to a running process stdin (pipe mode) or PTY (tty mode).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      data: { type: 'string' },
      eof: { type: 'boolean', default: false, description: 'Send EOF / close stdin after write' },
    },
    required: ['id', 'data'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      await pm(ctx).writeInput(a.id, a.data, a.eof);
      return ok({ ok: true });
    } catch (e) {
      return err(e);
    }
  },
};

export const stopProcessTool: Tool = {
  name: 'stop_process',
  description:
    'Stop a running process. Sends SIGTERM by default, waits graceMs, then escalates to SIGKILL.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      signal: { type: 'string', enum: ['SIGTERM', 'SIGKILL'], default: 'SIGTERM' },
      graceMs: { type: 'number', default: 5000 },
    },
    required: ['id'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      await pm(ctx).stop(a.id, { signal: a.signal, graceMs: a.graceMs });
      const handle = pm(ctx).get(a.id);
      return ok(handle);
    } catch (e) {
      return err(e);
    }
  },
};

export const deleteProcessTool: Tool = {
  name: 'delete_process',
  description:
    'Delete the record of a dead process (meta.json, output.log, and directory). Refuses if the process is still running — call stop_process first.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const a = args as any;
      await pm(ctx).delete(a.id);
      return ok({ ok: true, id: a.id });
    } catch (e) {
      return err(e);
    }
  },
};

export const processTools: Tool[] = [
  executeCommandTool,
  startProcessTool,
  listProcessesTool,
  getProcessTool,
  readProcessOutputTool,
  writeProcessInputTool,
  stopProcessTool,
  deleteProcessTool,
];
