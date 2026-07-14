import { constants, type Dir, type Dirent } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { JSONValue, ToolResult } from '@legion/types';
import type { SkillRecord } from '../skills/SkillRegistry.js';
import { SkillRegistry } from '../skills/SkillRegistry.js';
import type { Tool } from './Tool.js';

const MAX_RESOURCES = 1000;
const MAX_RESOURCE_DIRECTORIES = 128;
const MAX_RESOURCE_ENTRIES = 1000;
const MAX_RESOURCE_DEPTH = 32;
const MAX_RESOURCE_ENTRIES_PER_DIRECTORY = 256;

export interface SkillTools {
  listSkills: Tool;
  loadSkills: Tool;
}

export function createSkillTools(registry: SkillRegistry): SkillTools {
  return {
    listSkills: {
      name: 'list_skills',
      description: 'List effective skills and discovery diagnostics.',
      parameters: { type: 'object', additionalProperties: false },
      async execute(): Promise<ToolResult> {
        return {
          status: 'success',
          data: {
            skills: registry
              .list()
              .map(({ name, description, scope }) => ({ name, description, scope })),
            diagnostics: registry.diagnostics().map(({ severity, code, message }) => ({
              severity,
              code,
              message: redactAbsolutePaths(message),
              location: '<redacted>',
            })),
          },
        };
      },
    },
    loadSkills: {
      name: 'load_skills',
      description: 'Load instructions for skills enabled by this participant.',
      parameters: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1 } },
        required: ['names'],
        additionalProperties: false,
      },
      async execute(args, context): Promise<ToolResult> {
        const names = validateNames(args);
        if (!names) return { status: 'error', error: 'names must be a non-empty array of strings' };
        if (!context.conversationStore) {
          return { status: 'error', error: 'conversationStore unavailable in context' };
        }
        if (!context.conversationId)
          return { status: 'error', error: 'conversationId unavailable in context' };

        const selections = context.participant.middleware ?? [];
        const activations = names.map((name) => ({
          name,
          instanceId: selections.find(
            (instance) =>
              instance.type === 'builtin:skills' &&
              instance.enabled !== false &&
              Array.isArray(instance.config.skills) &&
              instance.config.skills.includes(name),
          )?.id,
        }));
        const unavailable = activations
          .filter(({ instanceId }) => !instanceId)
          .map(({ name }) => name);
        if (unavailable.length) {
          return {
            status: 'error',
            error: `Skills are not enabled for participant ${context.participant.id}: ${unavailable.join(', ')}`,
          };
        }

        const skills = await Promise.all(
          names.map(async (name) => {
            const record = registry.get(name);
            const instructions = await registry.readInstructions(name);
            if (!record || instructions === undefined) return undefined;
            return {
              name: record.name,
              baseDirectory: record.baseDirectory,
              instructions,
              resources: await listResources(record),
            };
          }),
        );
        const missing = names.filter((_, index) => skills[index] === undefined);
        if (missing.length) {
          return {
            status: 'error',
            error: `Skills are not enabled for participant ${context.participant.id}: ${missing.join(', ')}`,
          };
        }

        await context.conversationStore.mutate(context.conversationId, (conversation) => {
          const state = conversation.middlewareState?.[context.participant.id] ?? {};
          const updates = new Map<string, string[]>();
          for (const activation of activations) {
            const existing =
              updates.get(activation.instanceId!) ?? activated(state[activation.instanceId!]);
            if (!existing.includes(activation.name)) existing.push(activation.name);
            updates.set(activation.instanceId!, existing);
          }
          const participantState = { ...state };
          for (const [instanceId, names] of updates) {
            participantState[instanceId] = { ...stateObject(state[instanceId]), activated: names };
          }
          return {
            ...conversation,
            middlewareState: {
              ...conversation.middlewareState,
              [context.participant.id]: participantState,
            },
          };
        });

        return {
          status: 'success',
          data: { skills, activations: activations as Array<{ name: string; instanceId: string }> },
        };
      },
    },
  };
}

function validateNames(args: unknown): string[] | undefined {
  if (
    typeof args !== 'object' ||
    args === null ||
    !Array.isArray((args as { names?: unknown }).names)
  ) {
    return undefined;
  }
  const input = (args as { names: unknown[] }).names;
  if (!input.length || !input.every((name) => typeof name === 'string' && name.length > 0))
    return undefined;
  return [...new Set(input as string[])];
}

function activated(state: JSONValue | undefined): string[] {
  const value = stateObject(state).activated;
  return Array.isArray(value) && value.every((name) => typeof name === 'string') ? [...value] : [];
}

function stateObject(state: JSONValue | undefined): Record<string, JSONValue> {
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

async function listResources(skill: SkillRecord): Promise<string[]> {
  let boundary: string;
  try {
    boundary = await realpath(skill.baseDirectory);
  } catch {
    return [];
  }
  const resources: string[] = [];
  const resourcePaths = new Set<string>();
  const visited = new Set<string>();
  let directories = 0;
  let entryCount = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (
      resources.length >= MAX_RESOURCES ||
      directories >= MAX_RESOURCE_DIRECTORIES ||
      depth > MAX_RESOURCE_DEPTH ||
      visited.has(directory)
    ) {
      return;
    }
    visited.add(directory);
    directories++;
    const entries = await readDirectoryEntries(directory);
    if (!entries) return;
    for (const entry of entries) {
      if (resources.length >= MAX_RESOURCES || entryCount >= MAX_RESOURCE_ENTRIES) return;
      entryCount++;
      const path = join(directory, entry.name);
      let target: string;
      try {
        target = await realpath(path);
      } catch {
        continue;
      }
      if (!contained(boundary, target)) continue;
      try {
        const details = await stat(target);
        if (details.isDirectory()) await walk(target, depth + 1);
        else if (details.isFile() && entry.name !== 'SKILL.md' && (await regularFile(target))) {
          const resource = relative(boundary, target).split(sep).join('/');
          if (!resourcePaths.has(resource)) {
            resourcePaths.add(resource);
            resources.push(resource);
          }
        }
      } catch {
        // Discovery is best-effort; unsafe or transient entries are omitted.
      }
    }
  }

  await walk(boundary, 0);
  return resources;
}

async function readDirectoryEntries(directory: string) {
  let handle: Dir | undefined;
  try {
    handle = await opendir(directory);
    const entries: Dirent[] = [];
    while (entries.length <= MAX_RESOURCE_ENTRIES_PER_DIRECTORY) {
      const entry = await handle.read();
      if (!entry) {
        return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      }
      entries.push(entry);
    }
    // Skipping oversized directories keeps the bounded streaming read deterministic.
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function redactAbsolutePaths(message: string): string {
  return message.replace(/(?:[A-Za-z]:[\\/]|\/(?=\S))[^\r\n]*/g, '<redacted>');
}

async function regularFile(path: string): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return (await file.stat()).isFile();
  } finally {
    await file.close();
  }
}

function contained(boundary: string, path: string): boolean {
  const normalized = resolve(path);
  return normalized === boundary || normalized.startsWith(`${boundary}${sep}`);
}
