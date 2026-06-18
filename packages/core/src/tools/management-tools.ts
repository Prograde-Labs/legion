import type { JSONSchema, ToolPolicy, ToolResult, AgentConfig, ModelConfig, ConversationSummary, ConversationData, MessageData } from '@legion/types';
import { getActiveChain } from '../conversation/conversation-ops.js';
import type { Tool, ToolContext, ToolRegistryLike } from './Tool.js';
import type { Collective } from '../collective/Collective.js';
import type { Storage } from '../storage/Storage.js';
import type { CredentialStore } from '../credentials/CredentialStore.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';

function requireCollective(context: ToolContext): NonNullable<ToolContext['collective']> {
  if (!context.collective) throw new Error('collective unavailable in context');
  return context.collective;
}

export const createAgentTool: Tool = {
  name: 'create_agent',
  description: 'Create a new agent participant in the collective.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      systemPrompt: { type: 'string' },
      model: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } },
      tools: { type: 'object' },
    },
    required: ['id', 'name', 'systemPrompt', 'model'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { id, name, systemPrompt, model, tools } = args as {
      id: string;
      name: string;
      systemPrompt: string;
      model: ModelConfig;
      tools?: Record<string, ToolPolicy>;
    };
    const config: AgentConfig = {
      id,
      name,
      type: 'agent',
      tools: tools ?? {},
      systemPrompt,
      model,
      maxIterations: 20,
      providerId: typeof model === 'string' ? 'default' : (model.provider ?? 'default'),
      status: 'active',
    };
    try {
      const collective = requireCollective(context);
      await collective.add(config);
      const agentStorage = collective.storageForWriting;
      const providerId = typeof model === 'string' ? 'default' : (model.provider ?? 'default');
      if (agentStorage) {
        await agentStorage.writeJson(`agents/${id}.json`, {
          name: id,
          model: typeof model === 'string' ? model : (model.model ?? 'gpt-4o'),
          systemPrompt: systemPrompt ?? '',
          maxIterations: 20,
          providerId,
        });
      }
      return { status: 'success', data: { id } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const retireAgentTool: Tool = {
  name: 'retire_agent',
  description: 'Retire a participant by id.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { id } = args as { id: string };
    try {
      await requireCollective(context).retire(id);
      return { status: 'success', data: { id } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const listParticipantsTool: Tool = {
  name: 'list_participants',
  description: 'List participants in the collective.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, context): Promise<ToolResult> {
    try {
      const list = requireCollective(context)
        .list()
        .map((p) => ({ id: p.id, name: p.name, type: p.type, status: p.status ?? 'active' }));
      return { status: 'success', data: list };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const setToolPolicyTool: Tool = {
  name: 'set_tool_policy',
  description: "Set a participant's policy for a specific tool.",
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      tool: { type: 'string' },
      policy: { type: 'string', enum: ['auto', 'deny', 'requires_approval'] },
    },
    required: ['participantId', 'tool', 'policy'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { participantId, tool, policy } = args as {
      participantId: string;
      tool: string;
      policy: ToolPolicy;
    };
    try {
      const collective = requireCollective(context);
      const participant = collective.getOrThrow(participantId);
      const tools = { ...participant.tools, [tool]: policy };
      await collective.update(participantId, { tools });
      return { status: 'success', data: { participantId, tool, policy } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const getConversationTool: Tool = {
  name: 'get_conversation',
  description: 'Load a conversation and its active message chain.',
  parameters: {
    type: 'object',
    properties: { conversationId: { type: 'string' } },
    required: ['conversationId'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { conversationId } = args as { conversationId: string };
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    const conversation = await context.conversationStore.load(conversationId);
    if (!conversation)
      return { status: 'error', error: `Conversation not found: ${conversationId}` };
    return {
      status: 'success',
      data: {
        id: conversation.id,
        title: conversation.title,
        messages: getActiveChain(conversation),
      },
    };
  },
};

export const setCredentialTool: Tool = {
  name: 'set_credential',
  description: "Set (hash and store) a participant's authentication secret.",
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      secret: { type: 'string' },
    },
    required: ['participantId', 'secret'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { participantId, secret } = args as { participantId: string; secret: string };
    if (!context.credentialStore) {
      return { status: 'error', error: 'credentialStore unavailable in context' };
    }
    try {
      await context.credentialStore.setCredential(participantId, secret);
      return { status: 'success', data: { participantId } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const modifyAgentTool: Tool = {
  name: 'modify_agent',
  description: 'Update an existing agent — name, model, system prompt, max iterations.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
      name: { type: 'string' },
      model: { type: 'string' },
      systemPrompt: { type: 'string' },
      maxIterations: { type: 'number' },
      providerId: { type: 'string' },
    },
    required: ['id'],
  },
  async execute(rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
    const args = rawArgs as Partial<AgentConfig> & { id: string };
    try {
      const collective = requireCollective(context);
      const storage = collective.storageForWriting;
      if (!storage) return { status: 'error', error: 'Storage unavailable' };
      const existing = await storage.readJson<AgentConfig>(`agents/${args.id}.json`);
      if (!existing) return { status: 'error', error: `Agent config not found for ${args.id}` };
      const updatedModel: ModelConfig = typeof args.model === 'string'
        ? { provider: existing.providerId, model: args.model }
        : (args.model ?? existing.model);
      const updated: AgentConfig = {
        ...existing,
        name: args.name ?? existing.name,
        model: updatedModel,
        systemPrompt: args.systemPrompt ?? existing.systemPrompt,
        maxIterations: args.maxIterations ?? existing.maxIterations,
        providerId: args.providerId ?? existing.providerId,
      };
      if (args.name !== undefined) collective.modify(args.id, { name: args.name });
      await storage.writeJson(`agents/${args.id}.json`, updated);
      return { status: 'success', data: collective.getOrThrow(args.id) };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const listToolsTool: Tool = {
  name: 'list_tools',
  description: 'List all tool names registered in the ToolRegistry.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
    const toolRegistry = context.toolRegistry;
    if (!toolRegistry) return { status: 'error', error: 'toolRegistry unavailable' };
    return { status: 'success', data: toolRegistry.listAll() };
  },
};

export const listConversationsTool: Tool = {
  name: 'list_conversations',
  description: 'List conversation summaries.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
    const storage = context.storage;
    if (!storage) return { status: 'error', error: 'storage unavailable' };
    const keys = await storage.list('conversations/');
    const conversations = await Promise.all(
      keys.map((k: string) => storage.readJson<ConversationData>(`conversations/${k}`)),
    );
    const summaries: ConversationSummary[] = conversations.filter((c): c is ConversationData => Boolean(c)).map((c) => {
      const participantIds = Array.from(new Set(
        Object.values(c.messages ?? {}).map((m: MessageData) => m.senderId),
      ));
      return {
        id: c.id,
        participantIds,
        status: 'active',
        messageCount: Object.keys(c.messages ?? {}).length,
        createdAt: new Date(c.createdAt).getTime(),
        updatedAt: new Date(c.updatedAt).getTime(),
      };
    });
    return { status: 'success', data: summaries };
  },
};

export const managementTools: Tool[] = [
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  setToolPolicyTool,
  getConversationTool,
  setCredentialTool,
  modifyAgentTool,
  listToolsTool,
  listConversationsTool,
];

export function createManagementTools(deps: {
  collective: Collective;
  storage: Storage;
  toolRegistry: ToolRegistryLike;
  credentialStore?: CredentialStore;
  conversationStore?: ConversationStore;
}): Tool[] {
  const context = {
    participant: { id: 'operator', name: 'operator', type: 'operator' } as any,
    collective: deps.collective,
    storage: deps.storage,
    toolRegistry: deps.toolRegistry,
    credentialStore: deps.credentialStore,
    conversationStore: deps.conversationStore,
    workspaceRoot: '/tmp',
  } as unknown as ToolContext;

  return managementTools.map((tool) => ({
    ...tool,
    execute: (args: unknown) => tool.execute(args, context),
  }));
}
