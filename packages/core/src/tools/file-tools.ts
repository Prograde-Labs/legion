import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { JSONSchema, ToolResult } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_LINE_LENGTH = 2000;

function resolveInWorkspace(context: ToolContext, path: string): string | null {
  const root = resolve(context.workspaceRoot);
  const resolved = isAbsolute(path) ? normalize(path) : normalize(join(root, path));
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}

function splitPhysicalLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function clampLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`;
}

function isBinary(text: string): boolean {
  return text.includes('\u0000');
}

function fileError(path: string, err: unknown, verb: 'read' | 'edit'): ToolResult {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return { status: 'error', error: `File not found: ${path}` };
  if (code === 'EISDIR') {
    return {
      status: 'error',
      error:
        verb === 'read'
          ? `Path is a directory, use file_list: ${path}`
          : `Path is a directory: ${path}`,
    };
  }
  return { status: 'error', error: err instanceof Error ? err.message : String(err) };
}

const pathParam: JSONSchema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};

export const fileReadTool: Tool = {
  name: 'file_read',
  description:
    'Read a UTF-8 text file relative to the participant workspace root; absolute paths inside it are accepted. ' +
    'Returns numbered lines and supports paging with offset and limit.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'File to read, relative to the participant workspace root or absolute inside it',
      },
      offset: {
        type: 'integer',
        minimum: 1,
        description: 'The 1-based line to start reading from (default: 1)',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_READ_LINES,
        description: `Maximum number of lines to return (default and cap: ${MAX_READ_LINES})`,
      },
    },
    required: ['path'],
  },
  async execute(args, context): Promise<ToolResult> {
    const {
      path,
      offset = 1,
      limit = MAX_READ_LINES,
    } = args as {
      path: string;
      offset?: number;
      limit?: number;
    };
    if (offset < 1) return { status: 'error', error: 'offset must be at least 1' };
    if (limit < 1) return { status: 'error', error: 'limit must be at least 1' };

    const target = resolveInWorkspace(context, path);
    if (!target) return { status: 'error', error: `Invalid path (outside workspace): ${path}` };

    let text: string;
    try {
      text = await readFile(target, 'utf8');
    } catch (err) {
      return fileError(path, err, 'read');
    }
    if (isBinary(text)) return { status: 'error', error: `Cannot read binary file: ${path}` };

    const lines = splitPhysicalLines(text);
    const total = lines.length;
    const start = offset - 1;
    const selected: string[] = [];
    let bytes = 0;
    let next: number | undefined;

    for (let i = start; i < total && selected.length < limit; i++) {
      const line = clampLine(lines[i]);
      const add = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
      if (selected.length > 0 && bytes + add > MAX_READ_BYTES) {
        next = i + 1;
        break;
      }
      selected.push(line);
      bytes += add;
    }
    if (next === undefined && selected.length === limit && start + selected.length < total) {
      next = start + selected.length + 1;
    }

    const header =
      total === 0
        ? `Read file ${path}, 0 lines`
        : selected.length === 0
          ? `Read file ${path}, 0 lines (offset ${offset} is past the end; the file has ${total} lines)`
          : `Read file ${path}, lines ${start + 1}-${start + selected.length}`;
    const numbered = selected.map((line, i) => `${start + i + 1}: ${line}`);
    const body = [header, ...numbered].join('\n');
    const content =
      next === undefined
        ? body
        : `${body}\n[Output truncated. Continue reading with offset: ${next}]`;

    return {
      status: 'success',
      data: {
        path,
        offset,
        lineCount: selected.length,
        ...(next !== undefined ? { next } : {}),
        content: selected.join('\n'),
      },
      content,
    };
  },
};

export const fileWriteTool: Tool = {
  name: 'file_write',
  description:
    'Write a UTF-8 text file relative to the participant workspace root, creating parents; absolute paths inside it are accepted.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { path, content } = args as { path: string; content: string };
    const target = resolveInWorkspace(context, path);
    if (!target) return { status: 'error', error: `Invalid path (outside workspace): ${path}` };
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      return { status: 'success', data: { path } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const fileListTool: Tool = {
  name: 'file_list',
  description:
    'List entries of a directory relative to the participant workspace root; absolute paths inside it are accepted.',
  parameters: pathParam,
  async execute(args, context): Promise<ToolResult> {
    const { path } = args as { path: string };
    const target = resolveInWorkspace(context, path);
    if (!target) return { status: 'error', error: `Invalid path (outside workspace): ${path}` };
    try {
      const entries = await readdir(target);
      return { status: 'success', data: entries };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const fileTools: Tool[] = [fileReadTool, fileWriteTool, fileListTool];
