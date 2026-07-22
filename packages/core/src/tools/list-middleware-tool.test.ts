import type { MiddlewareDefinitionSummary, MiddlewareDiagnostic } from '@legion/types';
import { createListMiddlewareTool } from './list-middleware-tool.js';

describe('createListMiddlewareTool', () => {
  it('returns detached middleware metadata and safe diagnostics', async () => {
    const definitions: MiddlewareDefinitionSummary[] = [
      {
        type: 'audit',
        displayName: 'Audit',
        description: 'Records activity',
        defaultFailureMode: 'open',
        configSchema: { type: 'object', properties: { token: { type: 'string' } } },
        source: 'workspace:middleware/audit.mjs',
      },
    ];
    const diagnostics: MiddlewareDiagnostic[] = [
      {
        type: 'audit',
        source: 'workspace:middleware/audit.mjs',
        status: 'loaded',
        configurationErrors: [
          { participantId: 'agent', instanceId: 'audit-1', errors: ['/ enabled is required'] },
        ],
      },
    ];
    const tool = createListMiddlewareTool({ definitions, diagnostics });

    const result = await tool.execute({}, {} as never);

    expect(result).toEqual({ status: 'success', data: { definitions, diagnostics } });
    (result as { data: { definitions: MiddlewareDefinitionSummary[] } }).data.definitions[0].type =
      'changed';
    expect(definitions[0].type).toBe('audit');
  });

  it('does not expose unrecognized diagnostic fields', async () => {
    const tool = createListMiddlewareTool({
      definitions: [],
      diagnostics: [
        {
          type: 'audit',
          source: 'workspace:audit.mjs',
          status: 'error',
          configurationErrors: [],
          config: { token: 'secret-value' },
        } as unknown as MiddlewareDiagnostic,
      ],
    });

    const result = await tool.execute({}, {} as never);

    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
});
