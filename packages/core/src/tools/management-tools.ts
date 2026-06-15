import type { JSONSchema, ToolPolicy, ToolResult, AgentConfig, ModelConfig } from '@legion/types';
import { getActiveChain } from '../conversation/conversation-ops.js';
import type { Tool, ToolContext } from './Tool.js';

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
      model: { type: 'object' },
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
      status: 'active',
    };
    try {
      await requireCollective(context).add(config);
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

export const managementTools: Tool[] = [
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  setToolPolicyTool,
  getConversationTool,
  setCredentialTool,
];
