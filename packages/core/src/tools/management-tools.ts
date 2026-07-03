import type { JSONSchema, ToolPolicy, ToolResult, AgentConfig, ModelConfig } from '@legion/types';
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

/** Map UI policy vocabulary to runtime ToolPolicy. */
function normalizePolicy(p: string): ToolPolicy {
  if (p === 'allow') return 'auto';
  if (p === 'require-approval') return 'requires_approval';
  return p as ToolPolicy;
}

/** Compose the full tools map from defaultPolicy + per-tool overrides. */
function composeTools(
  defaultPolicy: string | undefined,
  toolPolicies: Record<string, string> | undefined,
  allToolNames: string[],
  existing?: Record<string, ToolPolicy>,
): Record<string, ToolPolicy> {
  const dp = normalizePolicy(defaultPolicy ?? 'auto');
  const overrides: Record<string, ToolPolicy> = {};
  if (toolPolicies) {
    for (const [tool, policy] of Object.entries(toolPolicies)) {
      overrides[tool] = normalizePolicy(policy);
    }
  }
  const tools: Record<string, ToolPolicy> = {};
  const names = new Set([...allToolNames, ...Object.keys(overrides), ...(existing ? Object.keys(existing) : [])]);
  for (const name of names) {
    tools[name] = overrides[name] ?? existing?.[name] ?? dp;
  }
  return tools;
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
      defaultPolicy: { type: 'string', enum: ['auto', 'allow', 'requires_approval', 'require-approval', 'deny'] },
      toolPolicies: { type: 'object' },
      tools: { type: 'object' },
    },
    required: ['id', 'name', 'systemPrompt', 'model'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { id, name, systemPrompt, model, defaultPolicy, toolPolicies, tools } = args as {
      id: string;
      name: string;
      systemPrompt: string;
      model: ModelConfig;
      defaultPolicy?: string;
      toolPolicies?: Record<string, string>;
      tools?: Record<string, ToolPolicy>;
    };
    try {
      const collective = requireCollective(context);
      const allToolNames = context.toolRegistry.listAll();
      const composedTools = tools ?? composeTools(defaultPolicy, toolPolicies, allToolNames);
      const config: AgentConfig = {
        id,
        name,
        type: 'agent',
        tools: composedTools,
        systemPrompt,
        model,
        maxIterations: 20,
        providerId: model.provider ?? 'default',
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
        messages: getActiveChain(conversation),
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
  description: 'Update an existing agent — name, model, system prompt, max iterations, tool policies.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
      name: { type: 'string' },
      model: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } },
      systemPrompt: { type: 'string' },
      maxIterations: { type: 'number' },
      defaultPolicy: { type: 'string', enum: ['auto', 'allow', 'requires_approval', 'require-approval', 'deny'] },
      toolPolicies: { type: 'object' },
    },
    required: ['id'],
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    const { id, name, model, systemPrompt, maxIterations, defaultPolicy, toolPolicies } = args as {
      id: string;
      name?: string;
      model?: ModelConfig | string;
      systemPrompt?: string;
      maxIterations?: number;
      defaultPolicy?: string;
      toolPolicies?: Record<string, string>;
    };
    try {
      const collective = requireCollective(context);
      const existing = collective.get(id);
      if (!existing) return { status: 'error', error: `Agent not found: ${id}` };
      if (existing.type !== 'agent') return { status: 'error', error: `Participant ${id} is not an agent` };

      const agent = existing as AgentConfig;
      // Handle both string (legacy) and object (ModelConfig) model arg
      const updatedModel: ModelConfig = typeof model === 'string'
        ? { provider: agent.model.provider, model }
        : (model ?? agent.model);
      const allToolNames = context.toolRegistry.listAll();
      const composedTools = (defaultPolicy || toolPolicies)
        ? composeTools(defaultPolicy, toolPolicies, allToolNames, defaultPolicy ? undefined : agent.tools)
        : agent.tools;

      await collective.update(id, {
        name: name ?? agent.name,
        model: updatedModel,
        providerId: updatedModel.provider ?? 'default',
        systemPrompt: systemPrompt ?? agent.systemPrompt,
        maxIterations: maxIterations ?? agent.maxIterations,
        tools: composedTools,
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
  description: 'List conversations. Pass participantId to filter to conversations involving that participant.',
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
  async execute(args: { participantId?: string; since?: string }, context: ToolContext): Promise<ToolResult> {
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
  description: 'Permanently delete a conversation and any nested sub-threads (agent-to-agent delegations).',
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

export const managementTools: Tool[] = [
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getParticipantTool,
  setToolPolicyTool,
  getConversationTool,
  setCredentialTool,
  modifyAgentTool,
  listToolsTool,
  listConversationsTool,
  deleteConversationTool,
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
