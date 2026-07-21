import type { MiddlewareDefinition, ProviderModel } from '@legion/types';
import type { MiddlewareRegistry } from '../MiddlewareRegistry.js';
import type { SkillRegistry } from '../../skills/SkillRegistry.js';
import type { ConversationStore } from '../../conversation/ConversationStore.js';
import type { Tool } from '../../tools/Tool.js';
import { createSkillTools } from '../../tools/skill-tools.js';
import { createAutomationTools } from '../../tools/automation-tools.js';
import { createSkillsMiddleware } from './skills.js';
import { createAutoCompactionMiddleware } from './auto-compaction.js';
import { createConversationNamingMiddleware } from './conversation-naming.js';

export function registerBuiltinMiddleware(input: {
  middlewareRegistry: MiddlewareRegistry;
  skillRegistry: SkillRegistry;
  conversationStore: ConversationStore;
  getModelMetadata(modelId: string): Promise<Pick<ProviderModel, 'contextWindow'> | undefined>;
}): { tools: Tool[] } {
  const definitions: Array<{ definition: MiddlewareDefinition; source: string }> = [
    {
      definition: createSkillsMiddleware(input.skillRegistry) as MiddlewareDefinition,
      source: 'builtin:core',
    },
    {
      definition: createAutoCompactionMiddleware({
        conversationStore: input.conversationStore,
        getModelMetadata: input.getModelMetadata,
      }) as MiddlewareDefinition,
      source: 'builtin:core',
    },
    {
      definition: createConversationNamingMiddleware(
        input.conversationStore,
      ) as MiddlewareDefinition,
      source: 'builtin:core',
    },
  ];
  input.middlewareRegistry.registerBatch(definitions);
  const skills = createSkillTools(input.skillRegistry);
  const automation = createAutomationTools();
  return {
    tools: [
      skills.listSkills,
      skills.loadSkills,
      automation.compactConversation,
      automation.generateConversationTitle,
    ],
  };
}

export * from './skills.js';
export * from './auto-compaction.js';
export * from './conversation-naming.js';
