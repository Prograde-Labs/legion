import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MiddlewareModuleConfig } from '@legion/types';
import { LegionError } from '../errors/LegionError.js';
import { loadWorkspaceMiddleware } from './loadWorkspaceMiddleware.js';
import { MiddlewareRegistry } from './MiddlewareRegistry.js';

const definitionSource = (type: string): string => `
export default {
  type: ${JSON.stringify(type)},
  displayName: 'Test Middleware',
  defaultFailureMode: 'closed',
  configSchema: { type: 'object' },
  hooks: {},
};
`;

describe('loadWorkspaceMiddleware', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'legion-middleware-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('loads a default-exported module relative to the workspace root', async () => {
    await writeFile(join(workspaceRoot, 'audit.mjs'), definitionSource('audit'), 'utf8');
    const registry = new MiddlewareRegistry();

    const diagnostics = await loadWorkspaceMiddleware(
      workspaceRoot,
      [{ id: 'audit', module: 'audit.mjs' }],
      registry,
    );

    expect(registry.get('audit')).toMatchObject({ type: 'audit', displayName: 'Test Middleware' });
    expect(registry.list()).toEqual([
      expect.objectContaining({ type: 'audit', source: 'workspace:audit.mjs' }),
    ]);
    expect(diagnostics).toEqual([
      {
        type: 'audit',
        source: 'workspace:audit.mjs',
        status: 'loaded',
        configurationErrors: [],
      },
    ]);
  });

  it('loads a valid nested module', async () => {
    await mkdir(join(workspaceRoot, 'middleware', 'nested'), { recursive: true });
    await writeFile(
      join(workspaceRoot, 'middleware', 'nested', 'audit.mjs'),
      definitionSource('audit'),
      'utf8',
    );

    await expect(
      loadWorkspaceMiddleware(
        workspaceRoot,
        [{ id: 'audit', module: 'middleware/nested/audit.mjs' }],
        new MiddlewareRegistry(),
      ),
    ).resolves.toEqual([expect.objectContaining({ type: 'audit', status: 'loaded' })]);
  });

  it('wraps a missing module as a startup load failure', async () => {
    await expectLoadFailure(
      loadWorkspaceMiddleware(
        workspaceRoot,
        [{ id: 'missing', module: 'missing.mjs' }],
        new MiddlewareRegistry(),
      ),
      /Failed to load middleware.*missing.*missing\.mjs/i,
    );
  });

  it('rejects a configured id that differs from the exported type', async () => {
    await writeFile(join(workspaceRoot, 'audit.mjs'), definitionSource('exported-audit'), 'utf8');

    await expectLoadFailure(
      loadWorkspaceMiddleware(
        workspaceRoot,
        [{ id: 'configured-audit', module: 'audit.mjs' }],
        new MiddlewareRegistry(),
      ),
      /configured-audit.*exported-audit|exported-audit.*configured-audit/i,
    );
  });

  it.each([
    ['no default export', `export const middleware = { type: 'audit' };`],
    ['non-object default export', `export default 'audit';`],
    [
      'invalid definition',
      `export default { type: 'audit', displayName: 'Audit', defaultFailureMode: 'closed', configSchema: { type: 'object' } };`,
    ],
  ])('fails closed for %s', async (_name, source) => {
    await writeFile(join(workspaceRoot, 'audit.mjs'), source, 'utf8');

    await expectLoadFailure(
      loadWorkspaceMiddleware(
        workspaceRoot,
        [{ id: 'audit', module: 'audit.mjs' }],
        new MiddlewareRegistry(),
      ),
      /Failed to load middleware.*audit/i,
    );
  });

  it('fails closed for duplicate exported types in configuration order', async () => {
    await writeFile(join(workspaceRoot, 'first.mjs'), definitionSource('audit'), 'utf8');
    await writeFile(join(workspaceRoot, 'second.mjs'), definitionSource('audit'), 'utf8');
    const registry = new MiddlewareRegistry();

    await expectLoadFailure(
      loadWorkspaceMiddleware(
        workspaceRoot,
        [
          { id: 'audit', module: 'first.mjs' },
          { id: 'audit', module: 'second.mjs' },
        ],
        registry,
      ),
      /already registered/i,
    );
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.source).toBe('workspace:first.mjs');
  });

  it.each([
    ['absolute path', (outside: string) => outside],
    ['parent traversal', () => '../outside.mjs'],
  ])('rejects %s before import', async (_name, configuredModule) => {
    const outside = join(workspaceRoot, '..', `outside-${Date.now()}-${Math.random()}.mjs`);
    const marker = join(workspaceRoot, 'imported');
    await writeFile(
      outside,
      `await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(marker)}, 'yes')); export default {};`,
      'utf8',
    );

    try {
      await expectLoadFailure(
        loadWorkspaceMiddleware(
          workspaceRoot,
          [{ id: 'escape', module: configuredModule(outside) }],
          new MiddlewareRegistry(),
        ),
        /workspace|relative|outside/i,
      );
      await expect(writeFile(marker, 'not imported', { flag: 'wx' })).resolves.toBeUndefined();
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('rejects a symlink escape before import', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'legion-middleware-outside-'));
    const marker = join(workspaceRoot, 'imported');
    await writeFile(
      join(outsideRoot, 'escape.mjs'),
      `await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(marker)}, 'yes')); export default {};`,
      'utf8',
    );
    await symlink(outsideRoot, join(workspaceRoot, 'linked'), 'dir');

    try {
      await expectLoadFailure(
        loadWorkspaceMiddleware(
          workspaceRoot,
          [{ id: 'escape', module: 'linked/escape.mjs' }],
          new MiddlewareRegistry(),
        ),
        /workspace|outside/i,
      );
      await expect(writeFile(marker, 'not imported', { flag: 'wx' })).resolves.toBeUndefined();
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing id', { module: 'audit.mjs' }],
    ['empty id', { id: ' ', module: 'audit.mjs' }],
    ['missing module', { id: 'audit' }],
    ['empty module', { id: 'audit', module: '' }],
  ])('rejects invalid module config with %s', async (_name, config) => {
    await expectLoadFailure(
      loadWorkspaceMiddleware(
        workspaceRoot,
        [config as MiddlewareModuleConfig],
        new MiddlewareRegistry(),
      ),
      /Failed to load middleware/i,
    );
  });

  it('does not invoke accessors while validating module config or exported type', async () => {
    await writeFile(
      join(workspaceRoot, 'audit.mjs'),
      `
        globalThis.__legionMiddlewareGetterInvoked = false;
        export default {
          get type() {
            globalThis.__legionMiddlewareGetterInvoked = true;
            return 'audit';
          },
        };
      `,
      'utf8',
    );
    let configGetterInvoked = false;
    const accessorConfig = Object.defineProperty({ id: 'audit' }, 'module', {
      enumerable: true,
      get() {
        configGetterInvoked = true;
        return 'audit.mjs';
      },
    }) as MiddlewareModuleConfig;

    await expectLoadFailure(
      loadWorkspaceMiddleware(workspaceRoot, [accessorConfig], new MiddlewareRegistry()),
      /Failed to load middleware/i,
    );
    expect(configGetterInvoked).toBe(false);

    await expectLoadFailure(
      loadWorkspaceMiddleware(
        workspaceRoot,
        [{ id: 'audit', module: 'audit.mjs' }],
        new MiddlewareRegistry(),
      ),
      /Failed to load middleware/i,
    );
    expect(
      (globalThis as typeof globalThis & { __legionMiddlewareGetterInvoked?: boolean })
        .__legionMiddlewareGetterInvoked,
    ).toBe(false);
    delete (globalThis as typeof globalThis & { __legionMiddlewareGetterInvoked?: boolean })
      .__legionMiddlewareGetterInvoked;
  });
});

async function expectLoadFailure(promise: Promise<unknown>, message: RegExp): Promise<void> {
  await expect(promise).rejects.toMatchObject<Partial<LegionError>>({
    code: 'MIDDLEWARE_LOAD_FAILED',
    message: expect.stringMatching(message),
  });
}
