import type { JSONSchema, ToolResult } from '@legion-collective/types';
import type { Tool } from './Tool.js';
import type { SecretStore } from '../secrets/SecretStore.js';

export const setSecretTool: Tool = {
  name: 'set_secret',
  description:
    "Set a named secret for a participant (e.g. 'telegram-bot/<bot-username>' → bot token). Stored encrypted at rest; values are write-only — never readable back through tools.",
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      key: { type: 'string', description: "Secret name, e.g. 'telegram-bot/my_bot'" },
      secret: { type: 'string' },
    },
    required: ['participantId', 'key', 'secret'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { participantId, key, secret } = args as {
      participantId: string;
      key: string;
      secret: string;
    };
    const store = context.secretStore as SecretStore | undefined;
    if (!store) return { status: 'error', error: 'secretStore unavailable in context' };
    try {
      await store.setSecret(participantId, key, secret);
      return { status: 'success', data: { participantId, key } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const listSecretsTool: Tool = {
  name: 'list_secrets',
  description: 'List the secret KEY NAMES held for a participant. Values are never returned.',
  parameters: {
    type: 'object',
    properties: { participantId: { type: 'string' } },
    required: ['participantId'],
  } as JSONSchema,
  async execute(args, context): Promise<ToolResult> {
    const { participantId } = args as { participantId: string };
    const store = context.secretStore as SecretStore | undefined;
    if (!store) return { status: 'error', error: 'secretStore unavailable in context' };
    try {
      const keys = await store.listKeys(participantId);
      return { status: 'success', data: { participantId, keys } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
