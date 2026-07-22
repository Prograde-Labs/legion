import { MiddlewareRegistry } from '../MiddlewareRegistry.js';
import type { SkillRegistry } from '../../skills/SkillRegistry.js';
import type { ConversationStore } from '../../conversation/ConversationStore.js';
import { registerBuiltinMiddleware } from './index.js';

describe('built-in middleware registration', () => {
  it('registers three definitions and four tools exactly once', () => {
    const middlewareRegistry = new MiddlewareRegistry();
    const skillRegistry = {
      list: () => [],
      diagnostics: () => [],
      get: () => undefined,
    } as unknown as SkillRegistry;
    const result = registerBuiltinMiddleware({
      middlewareRegistry,
      skillRegistry,
      conversationStore: { load: vi.fn() } as unknown as ConversationStore,
      getModelMetadata: async () => undefined,
    });
    expect(
      ['builtin:skills', 'builtin:auto-compaction', 'builtin:conversation-naming'].map(
        (type) => middlewareRegistry.get(type)?.type,
      ),
    ).toEqual(['builtin:skills', 'builtin:auto-compaction', 'builtin:conversation-naming']);
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'list_skills',
      'load_skills',
      'compact_conversation',
      'generate_conversation_title',
    ]);
  });

  it('documents every config schema property with a title and description', () => {
    const middlewareRegistry = new MiddlewareRegistry();
    const skillRegistry = {
      list: () => [],
      diagnostics: () => [],
      get: () => undefined,
    } as unknown as SkillRegistry;
    registerBuiltinMiddleware({
      middlewareRegistry,
      skillRegistry,
      conversationStore: { load: vi.fn() } as unknown as ConversationStore,
      getModelMetadata: async () => undefined,
    });
    for (const type of [
      'builtin:skills',
      'builtin:auto-compaction',
      'builtin:conversation-naming',
    ]) {
      const properties = middlewareRegistry.get(type)?.configSchema.properties ?? {};
      for (const [name, node] of Object.entries(properties)) {
        const field = node as { title?: unknown; description?: unknown };
        expect(typeof field.title, `${type}.${name} title`).toBe('string');
        expect(typeof field.description, `${type}.${name} description`).toBe('string');
      }
    }
  });

  it('declares explicit empty properties on no-argument tool schemas', () => {
    const middlewareRegistry = new MiddlewareRegistry();
    const skillRegistry = {
      list: () => [],
      diagnostics: () => [],
      get: () => undefined,
    } as unknown as SkillRegistry;
    const result = registerBuiltinMiddleware({
      middlewareRegistry,
      skillRegistry,
      conversationStore: { load: vi.fn() } as unknown as ConversationStore,
      getModelMetadata: async () => undefined,
    });
    const listSkills = result.tools.find((tool) => tool.name === 'list_skills')!;
    expect(listSkills.parameters.properties).toEqual({});
  });
});
