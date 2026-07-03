import type { CredentialInfo, ProviderConfig, ToolResult } from '@legion/types';
import type { Storage, Tool, ProviderStore } from '@legion/core';

interface RuntimeToolDeps {
  storage: Storage;
  providerStore: ProviderStore;
  credStore: { set(key: string, value: string): Promise<void>; list(): Promise<string[]> };
}

export function createRuntimeTools(deps: RuntimeToolDeps): Tool[] {
  const { storage, providerStore, credStore } = deps;

  return [
    {
      name: 'list_providers',
      description: 'List all configured LLM provider instances.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          const configs = await providerStore.list();
          return { status: 'success', data: configs };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'configure_provider',
      description: 'Create or update a provider instance.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['openai-compatible', 'anthropic', 'copilot', 'codex'] },
          baseUrl: { type: 'string' },
          defaultModel: { type: 'string' },
          credentialKey: { type: 'string' },
        },
        required: ['name', 'type', 'defaultModel'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as ProviderConfig;
          await providerStore.save(args);
          return { status: 'success', data: args };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'list_credentials',
      description: 'List credential key names and metadata. Values are never returned.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => {
        try {
          const keys = await storage.list('credential-meta/');
          const infos = await Promise.all(keys.map((k) => storage.readJson<CredentialInfo>(`credential-meta/${k}`)));
          return { status: 'success', data: infos.filter(Boolean) };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      name: 'set_credential_with_meta',
      description: 'Set a named credential and update its metadata record.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          usedBy: { type: 'array', items: { type: 'string' } },
        },
        required: ['key', 'value'],
      },
      execute: async (rawArgs: unknown): Promise<ToolResult> => {
        try {
          const args = rawArgs as { key: string; value: string; usedBy?: string[] };
          await credStore.set(args.key, args.value);
          const masked = '••••' + args.value.slice(-4);
          await storage.writeJson(`credential-meta/${args.key}.json`, {
            key: args.key,
            maskedValue: masked,
            usedBy: args.usedBy ?? [],
            updatedAt: Date.now(),
          } satisfies CredentialInfo);
          return { status: 'success', data: { key: args.key } };
        } catch (err) {
          return { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ] satisfies Tool[];
}
