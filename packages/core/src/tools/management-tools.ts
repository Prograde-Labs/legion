import type {
  JSONSchema,
  ToolPolicy,
  ToolResult,
  AgentConfig,
  ConversationData,
  ConversationMutation,
  ModelConfig,
  MessageData,
  JSONValue,
  MiddlewareInstanceConfig,
} from '@legion/types';
import {
  compactRange,
  editMessage,
  getActiveChain,
  pruneMessage,
} from '../conversation/conversation-ops.js';
import type { Tool, ToolContext, ToolRegistryLike } from './Tool.js';
import type { Collective } from '../collective/Collective.js';
import type { Storage } from '../storage/Storage.js';
import type { CredentialStore } from '../credentials/CredentialStore.js';
import type { ConversationStore } from '../conversation/ConversationStore.js';
import {
  applyConversationMutation,
  getConversationStatus,
  resolveConversationTitle,
} from '../conversation/conversation-metadata.js';
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotDenseArray(value: unknown[]): unknown[] | undefined {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return undefined;
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string') return undefined;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      return undefined;
    }
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return undefined;
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

export function isJSONValue(value: unknown, ancestors = new WeakSet<object>()): value is JSONValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const snapshot = snapshotDenseArray(value);
      return snapshot !== undefined && snapshot.every((item) => isJSONValue(item, ancestors));
    }
    if (!isPlainObject(value)) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !isJSONValue(descriptor.value, ancestors)) {
        return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function validateMiddleware(value: unknown): MiddlewareInstanceConfig[] {
  if (!Array.isArray(value)) throw new Error('middleware must be an array');
  const entries = snapshotDenseArray(value);
  if (!entries) throw new Error('middleware must be a dense array without extra properties');
  const ids = new Set<string>();
  const normalized: MiddlewareInstanceConfig[] = [];
  const allowedKeys = new Set(['id', 'type', 'enabled', 'failureMode', 'config']);
  for (const [index, entry] of entries.entries()) {
    if (!isPlainObject(entry)) throw new Error(`middleware[${index}] must be a plain object`);
    const snapshot = new Map<PropertyKey, unknown>();
    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        throw new Error(`middleware[${index}] contains an unknown property`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error(`middleware[${index}].${key} must be a data property`);
      }
      snapshot.set(key, descriptor.value);
    }
    for (const key of ['id', 'type', 'config']) {
      if (!snapshot.has(key)) {
        throw new Error(`middleware[${index}].${key} must be an own property`);
      }
    }
    const id = snapshot.get('id');
    const type = snapshot.get('type');
    const enabled = snapshot.get('enabled');
    const failureMode = snapshot.get('failureMode');
    const config = snapshot.get('config');
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`middleware[${index}].id must be a non-empty string`);
    }
    if (ids.has(id)) throw new Error(`duplicate middleware instance id: ${id}`);
    ids.add(id);
    if (typeof type !== 'string' || type.trim().length === 0) {
      throw new Error(`middleware[${index}].type must be a non-empty string`);
    }
    if (snapshot.has('enabled') && typeof enabled !== 'boolean') {
      throw new Error(`middleware[${index}].enabled must be a boolean when provided`);
    }
    if (snapshot.has('failureMode') && failureMode !== 'open' && failureMode !== 'closed') {
      throw new Error(`middleware[${index}].failureMode must be open or closed when provided`);
    }
    if (!isPlainObject(config) || !isJSONValue(config)) {
      throw new Error(`middleware[${index}].config must be a JSON-safe object`);
    }
    const instance: MiddlewareInstanceConfig = {
      id,
      type,
      config: structuredClone(config) as Record<string, JSONValue>,
    };
    if (snapshot.has('enabled')) instance.enabled = enabled as boolean;
    if (snapshot.has('failureMode')) instance.failureMode = failureMode as 'open' | 'closed';
    normalized.push(instance);
  }
  return normalized;
}

async function validateEnabledMiddleware(
  middleware: MiddlewareInstanceConfig[],
  context: ToolContext,
): Promise<MiddlewareInstanceConfig[]> {
  const enabled = structuredClone(middleware.filter((instance) => instance.enabled !== false));
  if (enabled.length > 0) {
    if (!context.middlewareValidator) {
      throw new Error('middleware configuration validator unavailable');
    }
    await context.middlewareValidator.validate(enabled);
  }
  return structuredClone(middleware);
}

const middlewareSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, pattern: '\\S' },
      type: { type: 'string', minLength: 1, pattern: '\\S' },
      enabled: { type: 'boolean' },
      failureMode: { type: 'string', enum: ['open', 'closed'] },
      config: { type: 'object' },
    },
    required: ['id', 'type', 'config'],
    additionalProperties: false,
  },
} as const;

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
      middleware: middlewareSchema,
    },
    required: ['id', 'name', 'systemPrompt', 'model'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { id, name, systemPrompt, model, tools, maxIterations, middleware } = args as {
      id: string;
      name: string;
      systemPrompt: string;
      model: ModelConfig;
      tools?: Record<string, ToolPolicy>;
      maxIterations?: number;
      middleware?: unknown;
    };
    try {
      if (middleware !== undefined && !Array.isArray(middleware)) {
        throw new Error('middleware must be an array when provided');
      }
      const collective = requireCollective(context);
      const validatedMiddleware =
        middleware === undefined
          ? undefined
          : await validateEnabledMiddleware(validateMiddleware(middleware), context);
      const config: AgentConfig = {
        id,
        name,
        type: 'agent',
        tools: tools ?? {},
        systemPrompt,
        model: sanitizeModelConfig(model),
        maxIterations: maxIterations ?? 20,
        status: 'active',
        ...(validatedMiddleware === undefined
          ? {}
          : { middleware: validatedMiddleware, middlewareRevision: 0 }),
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
        .map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          status: p.status ?? 'active',
          middleware: structuredClone(p.middleware ?? []),
          middlewareRevision: p.middlewareRevision ?? 0,
        }));
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

export const setParticipantMiddlewareTool: Tool = {
  name: 'set_participant_middleware',
  description: "Replace a participant's ordered middleware configuration.",
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      middleware: middlewareSchema,
    },
    required: ['participantId', 'middleware'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const input = isPlainObject(args) ? args : {};
    if (typeof input.participantId !== 'string') {
      return { status: 'error', error: 'participantId must be a string' };
    }
    if (!Array.isArray(input.middleware)) {
      return { status: 'error', error: 'middleware must be an array' };
    }
    try {
      const middleware = await validateEnabledMiddleware(
        validateMiddleware(input.middleware),
        context,
      );
      const participant = await requireCollective(context).replaceMiddleware(
        input.participantId,
        middleware,
      );
      return {
        status: 'success',
        data: {
          participantId: participant.id,
          middleware: structuredClone(participant.middleware ?? []),
          revision: participant.middlewareRevision,
        },
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

type MessageWithAlternates = MessageData & {
  alternates?: Array<{ id: string; content: string; timestamp: string; status: string }>;
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
        status: candidate.status,
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
    const input = args as { conversationId?: unknown; messageId?: unknown; newContent?: unknown };
    if (
      typeof input.conversationId !== 'string' ||
      typeof input.messageId !== 'string' ||
      typeof input.newContent !== 'string'
    ) {
      return {
        status: 'error',
        error: 'conversationId, messageId, and newContent must be strings',
      };
    }
    const { conversationId, messageId, newContent } = input;
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    try {
      const { after: updated } = await context.conversationStore.mutate(
        conversationId,
        (conversation) => editMessage(conversation, messageId, newContent),
      );
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

export function switchConversationBranch(
  conversation: ConversationData,
  messageId: string,
): ConversationData {
  const target = conversation.messages[messageId];
  if (!target) throw new Error(`Message not found: ${messageId}`);

  const messages: Record<string, MessageData> = { ...conversation.messages };
  const summary = Object.values(messages).find(
    (message) => message.type === 'summary' && message.compacts?.includes(messageId),
  );

  if (target.status === 'compacted' && summary?.compacts?.length) {
    for (const id of summary.compacts) {
      messages[id] = { ...messages[id], status: 'active' };
    }
    messages[summary.id] = { ...summary, status: 'superseded', supersededBy: messageId };
    const lastCompactedId = summary.compacts[summary.compacts.length - 1];
    for (const message of Object.values(messages)) {
      if (message.parentId === summary.id) {
        messages[message.id] = { ...message, parentId: lastCompactedId };
      }
    }
    const head =
      conversation.activeBranchHead === summary.id
        ? lastCompactedId
        : conversation.activeBranchHead;
    return {
      ...conversation,
      updatedAt: new Date().toISOString(),
      activeBranchHead: head,
      messages,
    };
  }

  const activeSibling = Object.values(messages).find(
    (message) =>
      message.id !== messageId &&
      message.parentId === target.parentId &&
      message.status === 'active',
  );
  if (activeSibling) {
    messages[activeSibling.id] = {
      ...activeSibling,
      status: 'superseded',
      supersededBy: messageId,
    };
  }
  messages[messageId] = { ...target, status: 'active' };

  let head = messageId;
  for (;;) {
    const child = Object.values(messages).find(
      (message) => message.parentId === head && message.status === 'active',
    );
    if (!child) break;
    head = child.id;
  }

  return { ...conversation, updatedAt: new Date().toISOString(), activeBranchHead: head, messages };
}

export const switchBranchTool: Tool = {
  name: 'switch_branch',
  description: 'Switch the active conversation branch to a sibling message.',
  parameters: {
    type: 'object',
    properties: { conversationId: { type: 'string' }, messageId: { type: 'string' } },
    required: ['conversationId', 'messageId'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const input = args as { conversationId?: unknown; messageId?: unknown };
    if (typeof input.conversationId !== 'string' || typeof input.messageId !== 'string') {
      return { status: 'error', error: 'conversationId and messageId must be strings' };
    }
    const { conversationId, messageId } = input;
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    try {
      const { after: updated } = await context.conversationStore.mutate(
        conversationId,
        (conversation) => switchConversationBranch(conversation, messageId),
      );
      return { status: 'success', data: { activeBranchHead: updated.activeBranchHead } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const pruneMessageTool: Tool = {
  name: 'prune_message',
  description: 'Prune a message from the active conversation chain.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' },
      messageId: { type: 'string' },
    },
    required: ['conversationId', 'messageId'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const input = args as { conversationId?: unknown; messageId?: unknown };
    if (typeof input.conversationId !== 'string' || typeof input.messageId !== 'string') {
      return { status: 'error', error: 'conversationId and messageId must be strings' };
    }
    const { conversationId, messageId } = input;
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    try {
      const { after: updated } = await context.conversationStore.mutate(
        conversationId,
        (conversation) => pruneMessage(conversation, messageId, context.participant.id),
      );
      return { status: 'success', data: { activeBranchHead: updated.activeBranchHead } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const DEFAULT_SUMMARY_INSTRUCTION =
  'Summarize the following conversation segment concisely. Capture the main topics discussed, key information exchanged, any decisions or conclusions reached, and the current state of any ongoing discussion or work. Write clearly and be complete enough that the conversation can continue naturally from this summary without the original messages.';

export const compactConversationTool: Tool = {
  name: 'compact_conversation',
  description: 'Compact a range of messages into an agent-generated summary.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' },
      messageIds: { type: 'array', items: { type: 'string' } },
      agentId: { type: 'string' },
      instruction: { type: 'string' },
    },
    required: ['conversationId', 'messageIds', 'agentId'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const input = args as {
      conversationId?: unknown;
      messageIds?: unknown;
      agentId?: unknown;
      instruction?: unknown;
    };
    if (
      typeof input.conversationId !== 'string' ||
      !Array.isArray(input.messageIds) ||
      input.messageIds.length === 0 ||
      !input.messageIds.every((id) => typeof id === 'string') ||
      typeof input.agentId !== 'string' ||
      input.agentId.length === 0 ||
      (input.instruction !== undefined && typeof input.instruction !== 'string')
    ) {
      return {
        status: 'error',
        error:
          'conversationId must be a string, messageIds must be a non-empty string array, agentId must be a string, and instruction must be a string when provided',
      };
    }
    const { conversationId, messageIds, agentId, instruction } = input as {
      conversationId: string;
      messageIds: string[];
      agentId: string;
      instruction?: string;
    };
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    if (!context.messageRouter) {
      return { status: 'error', error: 'messageRouter unavailable in context' };
    }
    try {
      const conversation = await context.conversationStore.load(conversationId);
      if (!conversation) {
        return { status: 'error', error: `Conversation not found: ${conversationId}` };
      }
      const observedHead = conversation.activeBranchHead;
      const targetMessages = messageIds.map((id) => {
        const message = conversation.messages[id];
        if (!message) throw new Error(`Message not found: ${id}`);
        return message;
      });
      const transcript = targetMessages
        .map((message) => {
          // Label summary nodes distinctly so the compacting agent knows it is
          // working with an already-summarised block rather than a raw turn.
          if (message.type === 'summary') {
            return `[summary of earlier messages]: ${message.content}`;
          }
          return `${message.role}: ${message.content}`;
        })
        .join('\n');
      const prompt = `${instruction ?? DEFAULT_SUMMARY_INSTRUCTION}\n\n${transcript}`;
      const summary = await context.messageRouter.send({
        senderId: context.participant.id,
        recipientId: agentId,
        message: prompt,
        replyTo: undefined,
        context,
      });
      if (summary.status === 'error') {
        return { status: 'error', error: summary.error ?? 'Summary failed' };
      }
      if (!summary.response) {
        return { status: 'error', error: 'Summary agent returned no response' };
      }
      const summaryContent = summary.response;
      const mutation = await context.conversationStore.mutate(
        conversationId,
        (current) => compactRange(current, messageIds, summaryContent),
        { expectedActiveBranchHead: observedHead },
      );
      const beforeIds = new Set(Object.keys(mutation.before.messages));
      const summaryNode = Object.values(mutation.after.messages).find(
        (message) => message.type === 'summary' && !beforeIds.has(message.id),
      );
      return {
        status: 'success',
        data: {
          summaryMessageId: summaryNode?.id,
          activeBranchHead: mutation.after.activeBranchHead,
        },
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const generateTool: Tool = {
  name: 'generate',
  description: 'Trigger an agent response from the current active conversation branch.',
  parameters: {
    type: 'object',
    properties: { conversationId: { type: 'string' }, agentId: { type: 'string' } },
    required: ['conversationId', 'agentId'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const input = args as { conversationId?: unknown; agentId?: unknown };
    if (typeof input.conversationId !== 'string' || typeof input.agentId !== 'string') {
      return { status: 'error', error: 'conversationId and agentId must be strings' };
    }
    const { conversationId, agentId } = input;
    if (!context.messageRouter) {
      return { status: 'error', error: 'messageRouter unavailable in context' };
    }
    try {
      const participant = requireCollective(context).get(agentId);
      if (!participant) return { status: 'error', error: `Participant not found: ${agentId}` };
      if (participant.type !== 'agent') {
        return { status: 'error', error: `Participant ${agentId} is not an agent` };
      }
      const result = await context.messageRouter.generate(conversationId, agentId, context);
      if (result.status === 'error') {
        return { status: 'error', error: result.error ?? 'Generate failed' };
      }
      return { status: 'success', data: { status: 'success' } };
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
          title: resolveConversationTitle(st, context.participant.id),
          sharedTitle: st.title,
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
        title: resolveConversationTitle(conversation, context.participant.id),
        sharedTitle: conversation.title,
        titles: conversation.titles,
        status: getConversationStatus(conversation),
        tags: conversation.tags ?? [],
        origin: conversation.origin,
        middlewareState: conversation.middlewareState,
        messages: withAlternates(conversation.messages, chain),
        parentConversationId: conversation.parentConversationId,
        parentToolCallId: conversation.parentToolCallId,
        subThreads,
      },
    };
  },
};

export const modifyConversationTool: Tool = {
  name: 'modify_conversation',
  description: 'Update conversation title, lifecycle status, or tags.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' },
      title: { type: 'string' },
      titleScope: { type: 'string', enum: ['shared', 'participant'] },
      titleMode: { type: 'string', enum: ['replace', 'first_write_wins'] },
      status: { type: 'string', enum: ['active', 'archived'] },
      addTags: { type: 'array', items: { type: 'string' } },
      removeTags: { type: 'array', items: { type: 'string' } },
    },
    required: ['conversationId'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const input =
      typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    const titleScope = input.titleScope ?? 'shared';
    const titleMode = input.titleMode ?? 'replace';
    const stringArray = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === 'string');
    if (
      typeof input.conversationId !== 'string' ||
      (input.title !== undefined && typeof input.title !== 'string') ||
      (titleScope !== 'shared' && titleScope !== 'participant') ||
      (titleMode !== 'replace' && titleMode !== 'first_write_wins') ||
      (input.status !== undefined && input.status !== 'active' && input.status !== 'archived') ||
      (input.addTags !== undefined && !stringArray(input.addTags)) ||
      (input.removeTags !== undefined && !stringArray(input.removeTags))
    ) {
      return {
        status: 'error',
        error:
          'Invalid modify_conversation arguments: conversationId and title must be strings; titleScope, titleMode, status, addTags, and removeTags must use supported values',
      };
    }
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }

    const mutation: ConversationMutation = {
      titleMode,
      status: input.status as ConversationMutation['status'],
      addTags: input.addTags as string[] | undefined,
      removeTags: input.removeTags as string[] | undefined,
    };
    if (typeof input.title === 'string') {
      mutation.title = {
        scope: titleScope,
        participantId: titleScope === 'participant' ? context.participant.id : undefined,
        value: input.title,
      };
    }

    try {
      const result = await context.conversationStore.mutate(input.conversationId, (conversation) =>
        applyConversationMutation(conversation, mutation),
      );
      const conversation = result.after;
      return {
        status: 'success',
        data: {
          id: conversation.id,
          title: resolveConversationTitle(conversation, context.participant.id),
          sharedTitle: conversation.title,
          titles: conversation.titles,
          status: getConversationStatus(conversation),
          tags: conversation.tags ?? [],
          origin: conversation.origin,
        },
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
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
      status: { type: 'string', enum: ['active', 'archived', 'all'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
  } as JSONSchema,
  async execute(args, context: ToolContext): Promise<ToolResult> {
    const input =
      typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    if (
      (input.participantId !== undefined && typeof input.participantId !== 'string') ||
      (input.since !== undefined && typeof input.since !== 'string') ||
      (input.status !== undefined &&
        input.status !== 'active' &&
        input.status !== 'archived' &&
        input.status !== 'all') ||
      (input.tags !== undefined &&
        (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === 'string')))
    ) {
      return {
        status: 'error',
        error:
          'Invalid list_conversations arguments: participantId and since must be strings; status and tags must use supported values',
      };
    }
    if (!context.conversationStore) {
      return { status: 'error', error: 'conversationStore unavailable in context' };
    }
    try {
      const conversations = await context.conversationStore.list({
        participantId: input.participantId as string | undefined,
        since: input.since as string | undefined,
        status: input.status as 'active' | 'archived' | 'all' | undefined,
        tags: input.tags as string[] | undefined,
        viewerParticipantId: context.participant.id,
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
  setParticipantMiddlewareTool,
  editMessageTool,
  pruneMessageTool,
  compactConversationTool,
  generateTool,
  switchBranchTool,
  getConversationTool,
  modifyConversationTool,
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
