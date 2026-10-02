import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationData, ParticipantConfig } from '@legion-collective/types';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import { SkillRegistry } from '../skills/SkillRegistry.js';
import { createSkillTools } from './skill-tools.js';

describe('createSkillTools', () => {
  let workspaceRoot: string;
  let homeRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'legion-skill-tools-workspace-'));
    homeRoot = await mkdtemp(join(tmpdir(), 'legion-skill-tools-home-'));
  });

  afterEach(async () => {
    await Promise.all([
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(homeRoot, { recursive: true, force: true }),
    ]);
  });

  async function addSkill(name: string, instructions = 'Follow instructions.'): Promise<string> {
    const directory = join(workspaceRoot, '.agents', 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} description\n---\n${instructions}`,
    );
    return directory;
  }

  function participant(middleware: ParticipantConfig['middleware']): ParticipantConfig {
    return {
      id: 'agent',
      name: 'Agent',
      type: 'agent',
      tools: {},
      model: { provider: 'test', model: 'test' },
      systemPrompt: '',
      maxIterations: 1,
      middleware,
    };
  }

  function conversation(): ConversationData {
    return {
      id: 'conversation',
      schemaVersion: '2.0',
      createdAt: '',
      updatedAt: '',
      activeBranchHead: '',
      messages: {},
    };
  }

  function store(data: ConversationData): ConversationStore {
    return {
      create: async () => data,
      load: async () => data,
      mutate: async (_id, callback) => {
        const before = structuredClone(data);
        Object.assign(data, await callback(data));
        return { before, after: data, changed: true };
      },
      appendMessage: async () => undefined,
      updateMessage: async () => undefined,
      updateHead: async () => undefined,
      list: async () => [],
      listByParent: async () => [],
      delete: async () => undefined,
      exists: async () => true,
    };
  }

  it('lists public skill metadata and redacts diagnostic locations', async () => {
    await addSkill('review');
    const invalidDirectory = join(workspaceRoot, '.agents', 'skills', 'invalid');
    await mkdir(invalidDirectory);
    await writeFile(join(invalidDirectory, 'SKILL.md'), 'not a skill');
    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);
    const { listSkills } = createSkillTools(registry);

    const result = await listSkills.execute({}, {} as never);

    expect(result).toEqual({
      status: 'success',
      data: {
        skills: [{ name: 'review', description: 'review description', scope: 'project' }],
        diagnostics: [
          expect.objectContaining({
            severity: 'error',
            code: 'invalid_frontmatter',
            location: '<redacted>',
          }),
        ],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(workspaceRoot);
    expect(serialized).not.toContain(homeRoot);
  });

  it('redacts absolute and UNC paths from diagnostic messages', async () => {
    const registry = {
      list: () => [],
      diagnostics: () => [
        {
          severity: 'error',
          code: 'read_error',
          location: workspaceRoot,
          message: `Failed to read ${workspaceRoot} private/secret/SKILL.md`,
        },
      ],
    } as unknown as SkillRegistry;
    const { listSkills } = createSkillTools(registry);

    const result = await listSkills.execute({}, {} as never);

    expect(result).toEqual({
      status: 'success',
      data: {
        skills: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'read_error',
            location: '<redacted>',
            message: 'Failed to read <redacted>',
          },
        ],
      },
    });

    const uncRegistry = {
      list: () => [],
      diagnostics: () => [
        {
          severity: 'error',
          code: 'read_error',
          location: '\\\\server\\share\\skills',
          message: 'Failed to read \\\\server\\share\\skills\\SKILL.md',
        },
      ],
    } as unknown as SkillRegistry;

    await expect(
      createSkillTools(uncRegistry).listSkills.execute({}, {} as never),
    ).resolves.toEqual({
      status: 'success',
      data: {
        skills: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'read_error',
            location: '<redacted>',
            message: 'Failed to read <redacted>',
          },
        ],
      },
    });
  });

  it('loads deduplicated selected skills, resources, and first matching activations', async () => {
    const reviewDirectory = await addSkill('review');
    const deployDirectory = await addSkill('deploy');
    await mkdir(join(reviewDirectory, 'references'));
    await writeFile(join(reviewDirectory, 'README.md'), 'readme');
    await writeFile(join(reviewDirectory, 'references', 'guide.md'), 'guide');
    const outside = await mkdtemp(join(tmpdir(), 'legion-skill-tools-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(join(outside, 'secret.txt'), join(reviewDirectory, 'escape.txt'));
      const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);
      const { loadSkills } = createSkillTools(registry);
      const data = conversation();
      data.middlewareState = {
        agent: {
          first: { activated: ['existing'], metadata: 'preserved' },
          other: { untouched: true },
        },
      };

      const result = await loadSkills.execute({ names: ['review', 'deploy', 'review'] }, {
        participant: participant([
          { id: 'first', type: 'builtin:skills', config: { skills: ['review'] } },
          { id: 'second', type: 'builtin:skills', config: { skills: ['review', 'deploy'] } },
        ]),
        conversationId: data.id,
        conversationStore: store(data),
      } as never);

      expect(result).toEqual({
        status: 'success',
        data: {
          skills: [
            {
              name: 'review',
              baseDirectory: reviewDirectory,
              instructions: 'Follow instructions.',
              resources: ['README.md', 'references/guide.md'],
            },
            {
              name: 'deploy',
              baseDirectory: deployDirectory,
              instructions: 'Follow instructions.',
              resources: [],
            },
          ],
          activations: [
            { name: 'review', instanceId: 'first' },
            { name: 'deploy', instanceId: 'second' },
          ],
        },
      });
      expect(data.middlewareState).toEqual({
        agent: {
          first: { activated: ['existing', 'review'], metadata: 'preserved' },
          second: { activated: ['deploy'] },
          other: { untouched: true },
        },
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects discovered skills not selected by enabled skill middleware', async () => {
    await addSkill('review');
    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);
    const { loadSkills } = createSkillTools(registry);

    await expect(
      loadSkills.execute({ names: ['review'] }, {
        participant: participant([
          {
            id: 'disabled',
            type: 'builtin:skills',
            enabled: false,
            config: { skills: ['review'] },
          },
        ]),
        conversationId: 'conversation',
        conversationStore: store(conversation()),
      } as never),
    ).resolves.toEqual({
      status: 'error',
      error: 'Skills are not enabled for participant agent: review',
    });
  });

  it('bounds resource traversal depth and entries', async () => {
    const reviewDirectory = await addSkill('review');
    let nested = reviewDirectory;
    for (let index = 0; index < 40; index++) {
      nested = join(nested, `000-nested-${index}`);
      await mkdir(nested);
    }
    await writeFile(join(nested, 'deep.txt'), 'too deep');
    const deepResource = `${nested.slice(reviewDirectory.length + 1)}/deep.txt`;
    for (let index = 0; index < 1100; index++) {
      await mkdir(join(reviewDirectory, `entry-${String(index).padStart(4, '0')}`));
    }
    await writeFile(join(reviewDirectory, 'z-last.txt'), 'too late');
    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);
    const { loadSkills } = createSkillTools(registry);

    const result = await loadSkills.execute({ names: ['review'] }, {
      participant: participant([
        { id: 'skills', type: 'builtin:skills', config: { skills: ['review'] } },
      ]),
      conversationId: 'conversation',
      conversationStore: store(conversation()),
    } as never);

    expect(result).toEqual({
      status: 'success',
      data: {
        skills: [
          expect.objectContaining({
            resources: expect.not.arrayContaining([deepResource]),
          }),
        ],
        activations: [{ name: 'review', instanceId: 'skills' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('z-last.txt');
  });

  it('validates names and requires conversation persistence', async () => {
    await addSkill('review');
    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);
    const { loadSkills } = createSkillTools(registry);
    const context = {
      participant: participant([
        { id: 'skills', type: 'builtin:skills', config: { skills: ['review'] } },
      ]),
      conversationId: 'conversation',
    };

    await expect(loadSkills.execute({ names: [] }, context as never)).resolves.toEqual({
      status: 'error',
      error: 'names must be a non-empty array of strings',
    });
    await expect(loadSkills.execute({ names: ['review'] }, context as never)).resolves.toEqual({
      status: 'error',
      error: 'conversationStore unavailable in context',
    });
  });
});
