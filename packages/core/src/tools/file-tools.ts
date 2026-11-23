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

function countOccurrences(text: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(search, index)) !== -1) {
    count += 1;
    index += search.length;
  }
  return count;
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
    const pageLimit = Math.min(limit, MAX_READ_LINES);
    const selected: string[] = [];
    let bytes = 0;
    let next: number | undefined;

    for (let i = start; i < total && selected.length < pageLimit; i++) {
      const line = clampLine(lines[i]);
      const rendered = `${i + 1}: ${line}`;
      const add = Buffer.byteLength(rendered, 'utf8') + (selected.length > 0 ? 1 : 0);
      const headerBytes = Buffer.byteLength(
        `Read file ${path}, lines ${start + 1}-${start + selected.length + 1}`,
        'utf8',
      );
      const markerBytes = Buffer.byteLength(
        `\n[Output truncated. Continue reading with offset: ${i + 2}]`,
        'utf8',
      );
      if (selected.length > 0 && headerBytes + 1 + bytes + add + markerBytes > MAX_READ_BYTES) {
        next = i + 1;
        break;
      }
      selected.push(line);
      bytes += add;
    }
    if (next === undefined && selected.length === pageLimit && start + selected.length < total) {
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

export const fileEditTool: Tool = {
  name: 'file_edit',
  description:
    'Edit a UTF-8 text file by replacing an exact string. Prefer this over file_write for partial changes. ' +
    'oldString must match exactly (including whitespace and indentation) and must be unique unless replaceAll is true. ' +
    'When copying text from file_read output, omit the leading line-number prefixes.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'File to edit, relative to the participant workspace root or absolute inside it',
      },
      oldString: { type: 'string', description: 'Exact text to find and replace' },
      newString: { type: 'string', description: 'Replacement text; must differ from oldString' },
      replaceAll: {
        type: 'boolean',
        default: false,
        description: 'Replace every occurrence. When false, oldString must match exactly once.',
      },
    },
    required: ['path', 'oldString', 'newString'],
  },
  async execute(args, context): Promise<ToolResult> {
    const {
      path,
      oldString,
      newString,
      replaceAll = false,
    } = args as {
      path: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    };

    const target = resolveInWorkspace(context, path);
    if (!target) return { status: 'error', error: `Invalid path (outside workspace): ${path}` };
    if (oldString.length === 0) {
      return {
        status: 'error',
        error: 'oldString must not be empty. Use file_write to create or overwrite a file.',
      };
    }
    if (oldString === newString) {
      return {
        status: 'error',
        error: 'No changes to apply: oldString and newString are identical.',
      };
    }

    let text: string;
    try {
      text = await readFile(target, 'utf8');
    } catch (err) {
      return fileError(path, err, 'edit');
    }
    if (isBinary(text)) return { status: 'error', error: `Cannot edit binary file: ${path}` };

    const matches = countOccurrences(text, oldString);
    if (matches === 0) {
      return {
        status: 'error',
        error: `Could not find oldString in ${path}. It must match exactly, including whitespace and indentation.`,
      };
    }
    if (matches > 1 && !replaceAll) {
      return {
        status: 'error',
        error: `Found ${matches} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true.`,
      };
    }

    const updated = replaceAll
      ? text.split(oldString).join(newString)
      : text.replace(oldString, () => newString);
    try {
      await writeFile(target, updated, 'utf8');
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    const replacements = replaceAll ? matches : 1;
    return {
      status: 'success',
      data: { path, replacements },
      content: `Edited ${path} (${replacements} replacement${replacements === 1 ? '' : 's'})`,
    };
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

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { status: 'error', error: `Directory not found: ${path}` };
      if (code === 'ENOTDIR') return { status: 'error', error: `Path is not a directory: ${path}` };
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    type Entry = { name: string; type: 'file' | 'directory' | 'other' };
    const order: Record<Entry['type'], number> = { directory: 0, file: 1, other: 2 };
    const entries = dirents
      .map((dirent): Entry => ({
        name: dirent.name,
        type: dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other',
      }))
      .sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name));

    const listing = entries.map((entry) =>
      entry.type === 'directory' ? `${entry.name}/` : entry.name,
    );
    const content = [`Read directory ${path}, ${entries.length} entries`, ...listing].join('\n');

    return { status: 'success', data: { path, entries }, content };
  },
};

export const fileTools: Tool[] = [fileReadTool, fileWriteTool, fileEditTool, fileListTool];
