import type {
  JSONSchema,
  ToolPolicy,
  ToolResult,
  AgentConfig,
  ModelConfig,
  MessageData,
} from '@legion/types';
import { editMessage, getActiveChain } from '../conversation/conversation-ops.js';
import type { Tool, ToolContext, ToolRegistryLike } from './Tool.js';
import type { Collective } from '../collective/Collective.js';
import type { Storage } from '../storage/Storage.js';
import type { CredentialStore } from '../credentials/CredentialStore.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import { UsageQuery } from '../usage/UsageQuery.js';
import type { GroupBy, UsageFilter } from '../usage/usage-types.js';

function requireCollective(context: ToolContext): NonNullable<ToolContext['collective']> {
  if (!context.collective) throw new Error('collective unavailable in context');
  return context.collective;
}

function sanitizeModelConfig(model: ModelConfig): ModelConfig {
  const sanitized: ModelConfig = { model: model.model };
  if (model.temperature !== undefined) sanitized.temperature = model.temperature;
  if (model.maxTokens !== undefined) sanitized.maxTokens = model.maxTokens;
  return sanitized;
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
      model: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
      tools: {
        type: 'object',
        description:
          'Map of tool name to policy (auto or requires_approval). Absent tools are hidden from the agent.',
      },
      maxIterations: { type: 'number' },
    },
    required: ['id', 'name', 'systemPrompt', 'model'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { id, name, systemPrompt, model, tools, maxIterations } = args as {
      id: string;
      name: string;
      systemPrompt: string;
      model: ModelConfig;
      tools?: Record<string, ToolPolicy>;
      maxIterations?: number;
    };
    try {
      const collective = requireCollective(context);
      const config: AgentConfig = {
        id,
        name,
        type: 'agent',
        tools: tools ?? {},
        systemPrompt,
        model: sanitizeModelConfig(model),
        maxIterations: maxIterations ?? 20,
        status: 'active',
      };
      await collective.add(config);
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

export const getParticipantTool: Tool = {
  name: 'get_participant',
  description: 'Get a single participant full configuration by id.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
    },
    required: ['id'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { id } = args as { id: string };
    try {
      const participant = requireCollective(context).get(id);
      if (!participant) {
        return { status: 'error', error: `Participant not found: ${id}` };
      }
      return { status: 'success', data: participant };
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
      policy: { type: 'string', enum: ['auto', 'requires_approval'] },
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

export const removeToolPolicyTool: Tool = {
  name: 'remove_tool_policy',
  description:
    "Remove a tool from a participant's tools map, hiding it from the LLM. " +
    'The tool will no longer be visible or callable by the participant.',
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      tool: { type: 'string' },
    },
    required: ['participantId', 'tool'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { participantId, tool } = args as { participantId: string; tool: string };
    try {
      const collective = requireCollective(context);
      const participant = collective.getOrThrow(participantId);
      const tools = { ...participant.tools };
      delete tools[tool];
      await collective.update(participantId, { tools });
      return { status: 'success', data: { participantId, tool } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

type MessageWithAlternates = MessageData & {
  alternates?: Array<{ id: string; content: string; timestamp: string }>;
};

function withAlternates(conversationMessages: Record<string, MessageData>, chain: MessageData[]) {
  const activeIds = new Set(chain.map((m) => m.id));
  return chain.map((message): MessageWithAlternates => {
    const alternates = Object.values(conversationMessages)
      .filter((candidate) => candidate.id !== message.id)
      .filter((candidate) => candidate.parentId === message.parentId)
      .filter((candidate) => !activeIds.has(candidate.id))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((candidate) => ({
        id: candidate.id,
        content: candidate.content,
        timestamp: candidate.timestamp,
      }));

    return alternates.length > 0 ? { ...message, alternates } : message;
  });
}

export const editMessageTool: Tool = {
  name: 'edit_message',
  description: 'Edit an existing message by creating a new branch node.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' },
      messageId: { type: 'string' },
      newContent: { type: 'string' },
    },
    required: ['conversationId', 'messageId', 'newContent'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { conversationId, messageId, newContent } = args as {
      conversationId: string;
      messageId: string;
      newContent: string;
    };
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    try {
      const conversation = await context.conversationStore.load(conversationId);
      if (!conversation)
        return { status: 'error', error: `Conversation not found: ${conversationId}` };
      const updated = editMessage(conversation, messageId, newContent);
      await context.conversationStore.save(updated);
      return {
        status: 'success',
        data: {
          newMessageId: updated.activeBranchHead,
          activeBranchHead: updated.activeBranchHead,
        },
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const getConversationTool: Tool = {
  name: 'get_conversation',
  description: 'Load a conversation, its active message chain, and any sub-threads.',
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
    const chain = getActiveChain(conversation);

    // Find sub-threads (child conversations linked to this one)
    const subThreadList = await context.conversationStore.listByParent(conversationId);
    const subThreads: Record<string, unknown> = {};
    for (const st of subThreadList) {
      if (st.parentToolCallId) {
        subThreads[st.parentToolCallId] = {
          id: st.id,
          title: st.title,
          messages: getActiveChain(st),
          parentConversationId: st.parentConversationId,
          parentToolCallId: st.parentToolCallId,
        };
      }
    }

    return {
      status: 'success',
      data: {
        id: conversation.id,
        title: conversation.title,
        messages: withAlternates(conversation.messages, chain),
        parentConversationId: conversation.parentConversationId,
        parentToolCallId: conversation.parentToolCallId,
        subThreads,
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
  description:
    'Update an existing agent — name, model, system prompt, max iterations, tool policies.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
      name: { type: 'string' },
      model: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
      systemPrompt: { type: 'string' },
      maxIterations: { type: 'number' },
      tools: {
        type: 'object',
        description:
          'Full replacement tools map. Omit to keep existing. Pass {} to clear all tool access.',
      },
    },
    required: ['id'],
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    const { id, name, model, systemPrompt, maxIterations, tools } = args as {
      id: string;
      name?: string;
      model?: ModelConfig | string;
      systemPrompt?: string;
      maxIterations?: number;
      tools?: Record<string, ToolPolicy>;
    };
    try {
      const collective = requireCollective(context);
      const existing = collective.get(id);
      if (!existing) return { status: 'error', error: `Agent not found: ${id}` };
      if (existing.type !== 'agent')
        return { status: 'error', error: `Participant ${id} is not an agent` };

      const agent = existing as AgentConfig;
      const updatedModel: ModelConfig =
        typeof model === 'string'
          ? sanitizeModelConfig({
              model,
              temperature: agent.model.temperature,
              maxTokens: agent.model.maxTokens,
            })
          : sanitizeModelConfig(model ?? agent.model);

      await collective.update(id, {
        name: name ?? agent.name,
        model: updatedModel,
        systemPrompt: systemPrompt ?? agent.systemPrompt,
        maxIterations: maxIterations ?? agent.maxIterations,
        tools: tools ?? agent.tools,
      });

      return { status: 'success', data: collective.getOrThrow(id) };
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
  description:
    'List conversations. Pass participantId to filter to conversations involving that participant.',
  parameters: {
    type: 'object',
    properties: {
      participantId: {
        type: 'string',
        description: 'Only return conversations where this participant is a sender or recipient.',
      },
      since: {
        type: 'string',
        description: 'ISO 8601 timestamp — only return conversations updated after this time.',
      },
    },
  },
  async execute(
    args: { participantId?: string; since?: string },
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      const conversations = await context.conversationStore!.list({
        participantId: args.participantId,
        since: args.since,
      });
      return { status: 'success', data: { conversations } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const deleteConversationTool: Tool = {
  name: 'delete_conversation',
  description:
    'Permanently delete a conversation and any nested sub-threads (agent-to-agent delegations).',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation to delete.',
      },
    },
    required: ['conversationId'],
  },
  async execute(args: { conversationId: string }, context: ToolContext): Promise<ToolResult> {
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    const { conversationId } = args;
    try {
      await context.conversationStore.delete(conversationId);
      return { status: 'success', data: { deleted: true } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const queryUsageTool: Tool = {
  name: 'query_usage',
  description: 'Query token usage and cost across conversations. Returns aggregated totals.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'Scope to one conversation.' },
      participantId: {
        type: 'string',
        description: 'Scope to conversations involving this participant.',
      },
      modelId: { type: 'string', description: 'Filter to a specific model.' },
      providerId: { type: 'string', description: 'Filter to a specific provider.' },
      since: { type: 'string', description: 'ISO 8601 — only messages after this time.' },
      until: { type: 'string', description: 'ISO 8601 — only messages before this time.' },
      groupBy: {
        type: 'string',
        enum: ['model', 'participant', 'conversation', 'day'],
        description: 'Group results by this dimension. Default: totals only.',
      },
    },
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    try {
      const filter: UsageFilter = {
        conversationId: (args as { conversationId?: string }).conversationId,
        participantId: (args as { participantId?: string }).participantId,
        modelId: (args as { modelId?: string }).modelId,
        providerId: (args as { providerId?: string }).providerId,
        since: (args as { since?: string }).since,
        until: (args as { until?: string }).until,
      };
      const groupBy = (args as { groupBy?: GroupBy }).groupBy;
      const query = new UsageQuery(context.conversationStore);
      const report = await query.query({ ...filter, groupBy });
      return { status: 'success', data: report };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const listModelsTool: Tool = {
  name: 'list_models',
  description: 'List available models with their current pricing rates.',
  parameters: { type: 'object', properties: {}, required: [] } as JSONSchema,
  async execute(_args, context: ToolContext): Promise<ToolResult> {
    try {
      const collective = requireCollective(context);
      const providers = collective.list().filter((p) => (p.type as string) === 'provider');
      const models: Array<{ id: string; providerId: string; name?: string }> = [];
      for (const p of providers) {
        if (p.id) {
          models.push({ id: p.id, providerId: p.id, name: p.name });
        }
      }
      return { status: 'success', data: models };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const managementTools: Tool[] = [
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  setToolPolicyTool,
  removeToolPolicyTool,
  editMessageTool,
  getConversationTool,
  setCredentialTool,
  modifyAgentTool,
  listToolsTool,
  listConversationsTool,
  deleteConversationTool,
  queryUsageTool,
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
