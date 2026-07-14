import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationData, ParticipantConfig } from '@legion/types';
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

  it('lists effective skills with registry diagnostics', async () => {
    await addSkill('review');
    const registry = await SkillRegistry.discover(workspaceRoot, homeRoot);
    const { listSkills } = createSkillTools(registry);

    await expect(listSkills.execute({}, {} as never)).resolves.toEqual({
      status: 'success',
      data: { skills: registry.list(), diagnostics: registry.diagnostics() },
    });
  });

  it('loads deduplicated selected skills, resources, and first matching activations', async () => {
    const reviewDirectory = await addSkill('review');
    await addSkill('deploy');
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
            expect.objectContaining({
              name: 'review',
              instructions: 'Follow instructions.',
              resources: ['README.md', 'references/guide.md'],
            }),
            expect.objectContaining({
              name: 'deploy',
              instructions: 'Follow instructions.',
              resources: [],
            }),
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
