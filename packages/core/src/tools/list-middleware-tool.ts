import type {
  MiddlewareDefinitionSummary,
  MiddlewareDiagnostic,
  ToolResult,
} from '@legion-collective/types';
import type { Tool } from './Tool.js';

export interface ListMiddlewareToolDependencies {
  definitions: readonly MiddlewareDefinitionSummary[];
  diagnostics: readonly MiddlewareDiagnostic[];
}

export function createListMiddlewareTool(deps: ListMiddlewareToolDependencies): Tool {
  const definitions = deps.definitions.map((definition) => ({
    type: definition.type,
    displayName: definition.displayName,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    defaultFailureMode: definition.defaultFailureMode,
    configSchema: structuredClone(definition.configSchema),
    source: definition.source,
  }));
  const diagnostics = deps.diagnostics.map((diagnostic) => ({
    type: diagnostic.type,
    source: diagnostic.source,
    status: diagnostic.status,
    ...(diagnostic.error === undefined ? {} : { error: diagnostic.error }),
    configurationErrors: diagnostic.configurationErrors.map((configurationError) => ({
      participantId: configurationError.participantId,
      instanceId: configurationError.instanceId,
      errors: [...configurationError.errors],
    })),
  }));
  return {
    name: 'list_middleware',
    description: 'List available middleware definitions and safe startup diagnostics.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(): Promise<ToolResult> {
      return { status: 'success', data: structuredClone({ definitions, diagnostics }) };
    },
  };
}
