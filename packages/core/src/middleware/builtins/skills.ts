import type { MiddlewareDefinition } from '@legion-collective/types';
import type { SkillRegistry } from '../../skills/SkillRegistry.js';

export interface SkillsConfig {
  skills: string[];
}

export interface SkillsState {
  activated: string[];
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function activated(state: unknown): string[] {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return [];
  const value = (state as { activated?: unknown }).activated;
  return Array.isArray(value) && value.every((name) => typeof name === 'string') ? value : [];
}

export function createSkillsMiddleware(
  registry: SkillRegistry,
): MiddlewareDefinition<SkillsConfig> {
  return {
    type: 'builtin:skills',
    displayName: 'Skills',
    description: 'Makes selected discovered skills available to an agent.',
    defaultFailureMode: 'closed',
    configSchema: {
      type: 'object',
      properties: {
        skills: {
          type: 'array',
          items: { type: 'string' },
          uniqueItems: true,
          title: 'Skills',
          description:
            'Names of discovered skills this participant may load on demand with the load_skills tool.',
        },
      },
      required: ['skills'],
      additionalProperties: false,
    },
    hooks: {
      async buildSystemPrompt(context) {
        const selected = context.config.skills
          .map((name) => registry.get(name))
          .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);
        if (!selected.length) return { kind: 'continue' };

        const selectedNames = new Set(selected.map((skill) => skill.name));
        const active = await Promise.all(
          activated(context.getState())
            .filter((name) => selectedNames.has(name))
            .map(async (name) => {
              try {
                const skill = registry.get(name);
                const instructions = await registry.readInstructions(name);
                if (!skill || instructions === undefined) return undefined;
                return `<active_skill name="${escapeXml(skill.name)}" base_directory="${escapeXml(skill.baseDirectory)}">${escapeXml(instructions)}</active_skill>`;
              } catch {
                return undefined;
              }
            }),
        );
        const catalog = selected
          .map(
            (skill) =>
              `<skill name="${escapeXml(skill.name)}">${escapeXml(skill.description)}</skill>`,
          )
          .join('\n');
        const restored = active.filter((skill): skill is string => skill !== undefined).join('\n');

        return {
          kind: 'continue',
          change: {
            operation: 'append',
            content: `\n\nUse the load_skills tool to activate relevant skills before starting work.\n<available_skills>\n${catalog}\n</available_skills>${restored ? `\n${restored}` : ''}`,
          },
        };
      },
    },
  };
}
