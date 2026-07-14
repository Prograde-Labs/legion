import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

export class SkillRegistry {
  private constructor(
    private readonly effective: Map<string, ParsedSkill>,
    private readonly diagnosticEntries: SkillDiagnostic[],
  ) {}

  static async discover(workspaceRoot: string, homeRoot: string): Promise<SkillRegistry> {
    const diagnostics: SkillDiagnostic[] = [];
    const effective = new Map<string, ParsedSkill>();
    const roots: Array<{ root: string; scope: SkillScope }> = [
      { root: join(homeRoot, '.agents', 'skills'), scope: 'user' },
      { root: join(workspaceRoot, '.agents', 'skills'), scope: 'project' },
    ];

    for (const source of roots) {
      for (const location of await findSkillFiles(source.root)) {
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
      .sort((a, b) => a.name.localeCompare(b.name));
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

async function findSkillFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === 'SKILL.md') found.push(resolve(path));
    }
  }

  await walk(root);
  return found;
}

async function parseSkill(
  location: string,
  scope: SkillScope,
): Promise<{ skill?: ParsedSkill; diagnostics: SkillDiagnostic[] }> {
  let source: string;
  try {
    source = await readFile(location, 'utf8');
  } catch (error) {
    return {
      diagnostics: [{ severity: 'error', code: 'read_error', location, message: String(error) }],
    };
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) return invalid(location, 'Missing YAML frontmatter block');

  const document = parseDocument(match[1]);
  if (document.errors.length > 0) return invalid(location, document.errors[0].message);

  const value = document.toJS() as unknown;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
