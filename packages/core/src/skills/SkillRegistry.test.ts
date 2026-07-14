import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from './SkillRegistry.js';

describe('SkillRegistry', () => {
  let workspaceRoot: string;
  let homeRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'legion-skills-workspace-'));
    homeRoot = await mkdtemp(join(tmpdir(), 'legion-skills-home-'));
  });

  afterEach(async () => {
    await Promise.all([
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(homeRoot, { recursive: true, force: true }),
    ]);
  });

  async function skill(root: string, directory: string, body: string): Promise<void> {
    const path = join(root, directory);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), body, 'utf8');
  }

  it('discovers nested skills and project scope overrides user scope by frontmatter name', async () => {
    await skill(
      join(homeRoot, '.agents', 'skills'),
      'user-copy',
      '---\nname: deploy\ndescription: User deployment\n---\nUser instructions',
    );
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'nested/project-copy',
      '---\nname: deploy\ndescription: Project deployment\n---\nProject instructions',
    );

    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);

    expect(registry.list()).toEqual([
      expect.objectContaining({
        name: 'deploy',
        description: 'Project deployment',
        scope: 'project',
        baseDirectory: join(workspaceRoot, '.agents', 'skills', 'nested', 'project-copy'),
      }),
    ]);
    await expect(registry.readInstructions('deploy')).resolves.toBe('Project instructions');
  });

  it('skips unusable files and records lenient diagnostics', async () => {
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'missing-name',
      '---\ndescription: x\n---\nBody',
    );
    await skill(join(workspaceRoot, '.agents', 'skills'), 'bad-yaml', '---\nname: [\n---\nBody');
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'empty-body',
      '---\nname: empty\ndescription: Empty\n---\n',
    );

    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);

    expect(registry.list()).toEqual([]);
    expect(registry.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_frontmatter',
          location: expect.stringContaining('missing-name'),
        }),
        expect.objectContaining({
          code: 'invalid_frontmatter',
          location: expect.stringContaining('bad-yaml'),
        }),
        expect.objectContaining({
          code: 'empty_instructions',
          location: expect.stringContaining('empty-body'),
        }),
      ]),
    );
  });

  it('retains valid skill plus warning for unsupported frontmatter values', async () => {
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'review',
      '---\nname: review\ndescription: Review code\nmetadata:\n  owner: team\n---\nRead diffs carefully.',
    );

    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);

    expect(registry.get('review')?.description).toBe('Review code');
    expect(registry.diagnostics()).toContainEqual(
      expect.objectContaining({ code: 'unsupported_frontmatter', severity: 'warning' }),
    );
  });

  it('lists skills in locale-independent lexical order', async () => {
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'lowercase',
      '---\nname: alpha\ndescription: Lowercase name\n---\nInstructions',
    );
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'uppercase',
      '---\nname: Beta\ndescription: Uppercase name\n---\nInstructions',
    );

    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);

    expect(registry.list().map(({ name }) => name)).toEqual(['Beta', 'alpha']);
  });

  it('uses code-unit directory order to resolve same-scope duplicates', async () => {
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'alpha',
      '---\nname: deploy\ndescription: Alpha deployment\n---\nAlpha instructions',
    );
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'Beta',
      '---\nname: deploy\ndescription: Beta deployment\n---\nBeta instructions',
    );

    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);

    expect(registry.get('deploy')?.description).toBe('Alpha deployment');
  });

  it('continues discovery when YAML aliases exhaust toJS limits', async () => {
    const aliases = Array.from({ length: 200 }, () => '*value').join(', ');
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'alias-limit',
      `---\nvalue: &value x\nname: deploy\ndescription: [${aliases}]\n---\nInstructions`,
    );
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'valid',
      '---\nname: review\ndescription: Review code\n---\nInstructions',
    );

    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);

    expect(registry.get('review')?.description).toBe('Review code');
    expect(registry.diagnostics()).toContainEqual(
      expect.objectContaining({
        code: 'invalid_frontmatter',
        location: expect.stringContaining('alias-limit'),
      }),
    );
  });

  it('silently ignores missing roots but diagnoses inaccessible roots', async () => {
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'valid',
      '---\nname: review\ndescription: Review code\n---\nInstructions',
    );

    expect((await SkillRegistry.discover(workspaceRoot, homeRoot)).diagnostics()).toEqual([]);

    const userSkills = join(homeRoot, '.agents', 'skills');
    await mkdir(join(homeRoot, '.agents'), { recursive: true });
    await writeFile(userSkills, 'not a directory', 'utf8');

    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);

    expect(registry.get('review')?.description).toBe('Review code');
    expect(registry.diagnostics()).toContainEqual(
      expect.objectContaining({ code: 'read_error', location: userSkills }),
    );
  });

  it('skips skill roots and files that symlink outside their boundary', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'legion-skills-outside-'));
    try {
      await skill(
        outsideRoot,
        'root-escape',
        '---\nname: root-escape\ndescription: Outside root\n---\nInstructions',
      );
      await skill(
        join(workspaceRoot, '.agents', 'skills'),
        'valid',
        '---\nname: review\ndescription: Review code\n---\nInstructions',
      );
      await mkdir(join(homeRoot, '.agents'), { recursive: true });
      await symlink(outsideRoot, join(homeRoot, '.agents', 'skills'), 'dir');
      await mkdir(join(workspaceRoot, '.agents', 'skills', 'escaped'), { recursive: true });
      await symlink(
        join(outsideRoot, 'root-escape', 'SKILL.md'),
        join(workspaceRoot, '.agents', 'skills', 'escaped', 'SKILL.md'),
        'file',
      );

      const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);

      expect(registry.get('review')?.description).toBe('Review code');
      expect(registry.get('root-escape')).toBeUndefined();
      expect(registry.diagnostics()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'read_error',
            location: join(homeRoot, '.agents', 'skills'),
          }),
          expect.objectContaining({
            code: 'read_error',
            location: join(workspaceRoot, '.agents', 'skills', 'escaped', 'SKILL.md'),
          }),
        ]),
      );
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects oversized skill files without stopping discovery', async () => {
    await skill(join(workspaceRoot, '.agents', 'skills'), 'too-large', 'x'.repeat(1024 * 1024 + 1));
    await skill(
      join(workspaceRoot, '.agents', 'skills'),
      'valid',
      '---\nname: review\ndescription: Review code\n---\nInstructions',
    );

    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);

    expect(registry.get('review')?.description).toBe('Review code');
    expect(registry.diagnostics()).toContainEqual(
      expect.objectContaining({
        code: 'read_error',
        location: expect.stringContaining('too-large'),
      }),
    );
  });
});
