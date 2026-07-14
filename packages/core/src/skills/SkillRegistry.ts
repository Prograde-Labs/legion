import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';

export type SkillScope = 'project' | 'user';

export interface SkillRecord {
  name: string;
  description: string;
  scope: SkillScope;
  location: string;
  baseDirectory: string;
}

export interface SkillDiagnostic {
  severity: 'warning' | 'error';
  code: 'invalid_frontmatter' | 'empty_instructions' | 'unsupported_frontmatter' | 'read_error';
  location: string;
  message: string;
}

interface ParsedSkill {
  record: SkillRecord;
  instructions: string;
}

const SUPPORTED_KEYS = new Set(['name', 'description']);
// Limit skill instructions to 1 MiB to bound discovery memory use.
const MAX_SKILL_FILE_BYTES = 1024 * 1024;

export class SkillRegistry {
  private constructor(
    private readonly effective: Map<string, ParsedSkill>,
    private readonly diagnosticEntries: SkillDiagnostic[],
  ) {}

  static async discover(workspaceRoot: string, homeRoot: string): Promise<SkillRegistry> {
    const diagnostics: SkillDiagnostic[] = [];
    const effective = new Map<string, ParsedSkill>();
    const roots: Array<{ root: string; scope: SkillScope; ownerRoot: string }> = [
      { root: join(homeRoot, '.agents', 'skills'), scope: 'user', ownerRoot: homeRoot },
      {
        root: join(workspaceRoot, '.agents', 'skills'),
        scope: 'project',
        ownerRoot: workspaceRoot,
      },
    ];

    for (const source of roots) {
      const discovery = await findSkillFiles(source.root, source.ownerRoot);
      diagnostics.push(...discovery.diagnostics);
      for (const location of discovery.files) {
        const parsed = await parseSkill(location, source.scope);
        diagnostics.push(...parsed.diagnostics);
        if (parsed.skill) effective.set(parsed.skill.record.name, parsed.skill);
      }
    }

    return new SkillRegistry(effective, diagnostics);
  }

  list(): SkillRecord[] {
    return [...this.effective.values()]
      .map(({ record }) => record)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  get(name: string): SkillRecord | undefined {
    return this.effective.get(name)?.record;
  }

  diagnostics(): SkillDiagnostic[] {
    return [...this.diagnosticEntries];
  }

  async readInstructions(name: string): Promise<string | undefined> {
    return this.effective.get(name)?.instructions;
  }
}

async function findSkillFiles(
  root: string,
  ownerRoot: string,
): Promise<{ files: string[]; diagnostics: SkillDiagnostic[] }> {
  const found: string[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  let boundary: string;
  try {
    boundary = resolve(await realpath(ownerRoot), '.agents', 'skills');
  } catch (error) {
    return { files: found, diagnostics: [readError(root, error)] };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (isMissing(error)) return { files: found, diagnostics };
    return { files: found, diagnostics: [readError(root, error)] };
  }

  if (canonicalRoot !== boundary) {
    return {
      files: found,
      diagnostics: [readError(root, 'Skill root escapes its allowed boundary')],
    };
  }

  const visited = new Set<string>();

  async function walk(directory: string): Promise<void> {
    if (visited.has(directory)) return;
    visited.add(directory);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) diagnostics.push(readError(directory, error));
      return;
    }

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(directory, entry.name);
      let target: string;
      try {
        target = await realpath(path);
      } catch (error) {
        if (!isMissing(error)) diagnostics.push(readError(path, error));
        continue;
      }

      if (!isContained(boundary, target)) {
        diagnostics.push(readError(path, 'Skill path escapes its allowed boundary'));
        continue;
      }

      try {
        const targetStats = await stat(target);
        if (targetStats.isDirectory()) await walk(target);
        else if (targetStats.isFile() && entry.name === 'SKILL.md') found.push(target);
      } catch (error) {
        if (!isMissing(error)) diagnostics.push(readError(path, error));
      }
    }
  }

  await walk(canonicalRoot);
  return { files: found, diagnostics };
}

async function parseSkill(
  location: string,
  scope: SkillScope,
): Promise<{ skill?: ParsedSkill; diagnostics: SkillDiagnostic[] }> {
  let source: string;
  try {
    const fileStats = await stat(location);
    if (fileStats.size > MAX_SKILL_FILE_BYTES) {
      return {
        diagnostics: [readError(location, `Skill file exceeds ${MAX_SKILL_FILE_BYTES} byte limit`)],
      };
    }
    source = await readFile(location, 'utf8');
  } catch (error) {
    return {
      diagnostics: [readError(location, error)],
    };
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) return invalid(location, 'Missing YAML frontmatter block');

  const document = parseDocument(match[1]);
  if (document.errors.length > 0) return invalid(location, document.errors[0].message);

  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    return invalid(location, String(error));
  }
  if (!isObject(value) || typeof value.name !== 'string' || typeof value.description !== 'string') {
    return invalid(location, 'Frontmatter requires string name and description');
  }

  const name = value.name.trim();
  const description = value.description.trim();
  if (!name || !description) return invalid(location, 'Skill name and description cannot be empty');

  const instructions = match[2].trim();
  if (!instructions) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'empty_instructions',
          location,
          message: 'Skill instructions are empty',
        },
      ],
    };
  }

  const extra = Object.keys(value).filter((key) => !SUPPORTED_KEYS.has(key));
  const diagnostics: SkillDiagnostic[] = extra.length
    ? [
        {
          severity: 'warning',
          code: 'unsupported_frontmatter',
          location,
          message: `Ignored frontmatter keys: ${extra.join(', ')}`,
        },
      ]
    : [];

  return {
    diagnostics,
    skill: {
      record: { name, description, scope, location, baseDirectory: resolve(location, '..') },
      instructions,
    },
  };
}

function invalid(location: string, message: string): { diagnostics: SkillDiagnostic[] } {
  return { diagnostics: [{ severity: 'error', code: 'invalid_frontmatter', location, message }] };
}

function readError(location: string, error: unknown): SkillDiagnostic {
  return { severity: 'error', code: 'read_error', location, message: String(error) };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isContained(boundary: string, path: string): boolean {
  return path === boundary || path.startsWith(`${boundary}${sep}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
