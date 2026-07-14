import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});
