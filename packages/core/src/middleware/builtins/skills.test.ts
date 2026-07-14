import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemPromptContext } from '@legion/types';
import { SkillRegistry } from '../../skills/SkillRegistry.js';
import { createSkillsMiddleware, type SkillsConfig } from './skills.js';

describe('createSkillsMiddleware', () => {
  let workspaceRoot: string;
  let homeRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'legion-skills-middleware-workspace-'));
    homeRoot = await mkdtemp(join(tmpdir(), 'legion-skills-middleware-home-'));
  });

  afterEach(async () => {
    await Promise.all([
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(homeRoot, { recursive: true, force: true }),
    ]);
  });

  async function addSkill(
    name: string,
    description: string,
    instructions: string,
  ): Promise<string> {
    const directory = join(workspaceRoot, '.agents', 'skills', `skill-${name.length}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${instructions}`,
    );
    return directory;
  }

  function context(config: SkillsConfig, state?: unknown): SystemPromptContext<SkillsConfig> {
    return {
      config,
      getState: () => state as never,
    } as SystemPromptContext<SkillsConfig>;
  }

  it('appends selected discovered skill catalog with XML escaping', async () => {
    await addSkill('review<&', 'Review <code> & report', 'Instructions');
    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);
    const definition = createSkillsMiddleware(registry);

    const result = await definition.hooks.buildSystemPrompt!(
      context({ skills: ['review<&', 'missing'] }),
    );

    expect(definition).toMatchObject({
      type: 'builtin:skills',
      defaultFailureMode: 'closed',
      configSchema: {
        type: 'object',
        required: ['skills'],
        additionalProperties: false,
        properties: { skills: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
      },
    });
    expect(result).toEqual({
      kind: 'continue',
      change: {
        operation: 'append',
        content: expect.stringContaining(
          '<skill name="review&lt;&amp;">Review &lt;code&gt; &amp; report</skill>',
        ),
      },
    });
    expect(result).toMatchObject({
      change: { content: expect.stringContaining('<available_skills>') },
    });
    expect((result as { change: { content: string } }).change.content).not.toContain('missing');
  });

  it('does not inject a catalog when no selected skills resolve', async () => {
    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);
    const definition = createSkillsMiddleware(registry);

    await expect(
      definition.hooks.buildSystemPrompt!(context({ skills: ['missing'] })),
    ).resolves.toEqual({
      kind: 'continue',
    });
  });

  it('restores selected activated skill instructions after compaction', async () => {
    const directory = await addSkill('review', 'Review code', 'Read every changed line.');
    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);
    const definition = createSkillsMiddleware(registry);

    const result = await definition.hooks.buildSystemPrompt!(
      context({ skills: ['review'] }, { activated: ['review', 'removed'] }),
    );

    expect(result).toMatchObject({
      kind: 'continue',
      change: {
        operation: 'append',
        content: expect.stringContaining(
          `<active_skill name="review" base_directory="${directory}">Read every changed line.</active_skill>`,
        ),
      },
    });
    expect((result as { change: { content: string } }).change.content).not.toContain('removed');
  });
});
