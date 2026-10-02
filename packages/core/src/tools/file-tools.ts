import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import type { JSONSchema, ToolResult } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';

function resolveInWorkspace(context: ToolContext, path: string): string | null {
  if (isAbsolute(path)) return null;
  const root = context.workspaceRoot;
  const resolved = normalize(join(root, path));
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}

const pathParam: JSONSchema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};

export const fileReadTool: Tool = {
  name: 'file_read',
  description: 'Read a UTF-8 text file relative to the workspace root.',
  parameters: pathParam,
  async execute(args, context): Promise<ToolResult> {
    const { path } = args as { path: string };
    const target = resolveInWorkspace(context, path);
    if (!target) return { status: 'error', error: `Invalid path (outside workspace): ${path}` };
    try {
      return { status: 'success', data: await readFile(target, 'utf8') };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const fileWriteTool: Tool = {
  name: 'file_write',
  description: 'Write a UTF-8 text file relative to the workspace root, creating parents.',
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
  description: 'List entries of a directory relative to the workspace root.',
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
