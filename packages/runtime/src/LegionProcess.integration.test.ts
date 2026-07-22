import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegionProcess } from './LegionProcess.js';

const LIVE = Boolean(process.env['LEGION_INTEGRATION']);

describe('LegionProcess config and runtime tools', () => {
  let workspaceRoot: string;
  let homeRoot: string;
  let process_: LegionProcess | undefined;
  let originalHome: string | undefined;
  let originalBootstrapPassword: string | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'legion-process-workspace-'));
    homeRoot = await mkdtemp(join(tmpdir(), 'legion-process-home-'));
    originalHome = process.env['HOME'];
    originalBootstrapPassword = process.env['LEGION_BOOTSTRAP_PASSWORD'];
    process.env['HOME'] = homeRoot;
    process.env['LEGION_BOOTSTRAP_PASSWORD'] = 'test-password';
  });

  afterEach(async () => {
    await process_?.stop();
    process_ = undefined;
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (originalBootstrapPassword === undefined) delete process.env['LEGION_BOOTSTRAP_PASSWORD'];
    else process.env['LEGION_BOOTSTRAP_PASSWORD'] = originalBootstrapPassword;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
  });

  async function writeMiddlewareWorkspace(): Promise<void> {
    await mkdir(join(workspaceRoot, '.legion'), { recursive: true });
    await writeFile(
      join(workspaceRoot, 'audit.mjs'),
      `export default {
  type: 'audit',
  displayName: 'Audit',
  defaultFailureMode: 'open',
  configSchema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
  hooks: {},
};`,
    );
    await writeFile(
      join(workspaceRoot, '.legion', 'config.json'),
      JSON.stringify({
        version: '2',
        server: { port: 0, host: '127.0.0.1' },
        middlewareModules: [{ id: 'audit', module: 'audit.mjs' }],
      }),
    );
  }

  async function restartWithMiddleware(middleware: unknown): Promise<void> {
    process_ = await LegionProcess.start(workspaceRoot);
    await process_.collective.update('operator', { middleware: middleware as never });
    await process_.stop();
    process_ = undefined;
  }

  it('loads workspace middleware modules and exposes safe diagnostics', async () => {
    await writeMiddlewareWorkspace();

    process_ = await LegionProcess.start(workspaceRoot);

    expect(process_.middlewareRegistry.get('audit')).toMatchObject({ type: 'audit' });
    expect(process_.middlewareDiagnostics).toEqual([
      expect.objectContaining({ type: 'audit', status: 'loaded', configurationErrors: [] }),
    ]);
    expect(process_.collective.getOrThrow('operator').tools.list_middleware).toBe('auto');
  });

  it('discovers project skills and registers built-in middleware tools', async () => {
    await mkdir(join(workspaceRoot, '.legion'), { recursive: true });
    await writeFile(
      join(workspaceRoot, '.legion', 'config.json'),
      JSON.stringify({ version: '2', server: { port: 0, host: '127.0.0.1' } }),
    );
    const skillDirectory = join(workspaceRoot, '.agents', 'skills', 'workspace-review');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: workspace-review\ndescription: Review this workspace\n---\nInspect diffs.',
    );

    process_ = await LegionProcess.start(workspaceRoot);

    expect(process_.middlewareRegistry.get('builtin:skills')?.type).toBe('builtin:skills');
    expect(process_.middlewareRegistry.get('builtin:auto-compaction')?.type).toBe(
      'builtin:auto-compaction',
    );
    expect(process_.middlewareRegistry.get('builtin:conversation-naming')?.type).toBe(
      'builtin:conversation-naming',
    );
    expect(process_.toolRegistry.listAll()).toEqual(
      expect.arrayContaining([
        'list_skills',
        'load_skills',
        'compact_conversation',
        'generate_conversation_title',
      ]),
    );
    expect(process_.skillRegistry.get('workspace-review')?.scope).toBe('project');
    expect(
      process_.collective.list().find((participant) => participant.operator)?.tools['list_skills'],
    ).toBe('auto');
  });

  it('rejects enabled middleware with an unavailable type', async () => {
    await writeMiddlewareWorkspace();
    await restartWithMiddleware([{ id: 'missing-1', type: 'missing', config: {} }]);

    await expect(LegionProcess.start(workspaceRoot)).rejects.toThrow(
      "Invalid middleware 'missing-1' on 'operator': Middleware type unavailable: missing",
    );
  });

  it('starts with diagnostics for disabled invalid middleware configuration', async () => {
    await writeMiddlewareWorkspace();
    await restartWithMiddleware([{ id: 'audit-1', type: 'audit', enabled: false, config: {} }]);

    process_ = await LegionProcess.start(workspaceRoot);

    expect(process_.middlewareDiagnostics[0].configurationErrors).toEqual([
      expect.objectContaining({ participantId: 'operator', instanceId: 'audit-1' }),
    ]);
  });

  it('rejects enabled middleware with invalid configuration', async () => {
    await writeMiddlewareWorkspace();
    await restartWithMiddleware([{ id: 'audit-1', type: 'audit', config: {} }]);

    await expect(LegionProcess.start(workspaceRoot)).rejects.toThrow(
      "Invalid middleware 'audit-1' on 'operator': / must have required property 'enabled'",
    );
  });

  it('rejects duplicate middleware instance ids at startup', async () => {
    await writeMiddlewareWorkspace();
    await restartWithMiddleware([
      { id: 'audit-1', type: 'audit', config: { enabled: true } },
      { id: 'audit-1', type: 'audit', config: { enabled: true } },
    ]);

    await expect(LegionProcess.start(workspaceRoot)).rejects.toThrow(
      "Invalid middleware 'audit-1' on 'operator': duplicate middleware instance id",
    );
  });

  it('loads system/local routing, gitignores local config, and saves routing through runtime tools', async () => {
    await mkdir(join(workspaceRoot, '.legion'), { recursive: true });
    await mkdir(join(homeRoot, '.config', 'legion'), { recursive: true });
    await writeFile(
      join(workspaceRoot, '.legion', 'config.json'),
      JSON.stringify({ version: '2', server: { port: 0, host: '127.0.0.1' } }),
    );
    await writeFile(
      join(workspaceRoot, '.legion', 'config.local.json'),
      JSON.stringify({ server: { port: 0 }, routing: { models: { workspaceOld: ['local'] } } }),
    );
    await writeFile(
      join(homeRoot, '.config', 'legion', 'config.json'),
      JSON.stringify({
        custom: 'keep-system-field',
        routing: { models: { systemOld: ['system'] } },
      }),
    );

    process_ = await LegionProcess.start(workspaceRoot);
    const web = process_.connectors.get('web') as unknown as {
      app: { inject: (opts: unknown) => Promise<{ statusCode: number; payload: string }> };
    };
    const login = await web.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Operator', password: 'test-password' },
    });
    expect(login.statusCode).toBe(200);
    const { token } = JSON.parse(login.payload) as { token: string };

    const initialRouting = await web.app.inject({
      method: 'POST',
      url: '/api/execute?stream=false',
      headers: { authorization: `Bearer ${token}` },
      payload: { tool: 'get_routing', args: {} },
    });
    expect(JSON.parse(initialRouting.payload).result).toEqual({
      status: 'success',
      data: {
        system: { models: { systemOld: ['system'] } },
        workspace: { models: { workspaceOld: ['local'] } },
      },
    });

    const saveWorkspace = await web.app.inject({
      method: 'POST',
      url: '/api/execute?stream=false',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tool: 'save_routing',
        args: { scope: 'workspace', routing: { models: { workspaceNew: ['local-new'] } } },
      },
    });
    expect(JSON.parse(saveWorkspace.payload).result).toEqual({
      status: 'success',
      data: { scope: 'workspace' },
    });

    const saveSystem = await web.app.inject({
      method: 'POST',
      url: '/api/execute?stream=false',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tool: 'save_routing',
        args: { scope: 'system', routing: { models: { systemNew: ['system-new'] } } },
      },
    });
    expect(JSON.parse(saveSystem.payload).result).toEqual({
      status: 'success',
      data: { scope: 'system' },
    });

    const updatedRouting = await web.app.inject({
      method: 'POST',
      url: '/api/execute?stream=false',
      headers: { authorization: `Bearer ${token}` },
      payload: { tool: 'get_routing', args: {} },
    });
    expect(JSON.parse(updatedRouting.payload).result).toEqual({
      status: 'success',
      data: {
        system: { models: { systemNew: ['system-new'] } },
        workspace: { models: { workspaceNew: ['local-new'] } },
      },
    });

    await expect(readFile(join(workspaceRoot, '.legion', '.gitignore'), 'utf8')).resolves.toContain(
      'config.local.json',
    );
    await expect(
      readFile(join(workspaceRoot, '.legion', 'config.local.json'), 'utf8'),
    ).resolves.toContain('workspaceNew');
    await expect(
      readFile(join(workspaceRoot, '.legion', 'config.local.json'), 'utf8'),
    ).resolves.toContain('"server"');
    await expect(
      readFile(join(homeRoot, '.config', 'legion', 'config.json'), 'utf8'),
    ).resolves.toContain('systemNew');
    await expect(
      readFile(join(homeRoot, '.config', 'legion', 'config.json'), 'utf8'),
    ).resolves.toContain('keep-system-field');
  });
});

describe.skipIf(!LIVE)('LegionProcess (integration)', () => {
  let workspaceRoot: string;
  let process_: LegionProcess;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'legion-process-'));
  });

  afterEach(async () => {
    await process_?.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('starts without errors and seeds the bootstrap operator', async () => {
    process_ = await LegionProcess.start(workspaceRoot);
    const participants = process_.collective.listActive();
    expect(participants.length).toBeGreaterThan(0);
    const operator = participants.find((p) => p.operator === true);
    expect(operator).toBeDefined();
  });

  it('web server responds to GET /api/health', async () => {
    process_ = await LegionProcess.start(workspaceRoot);
    // Determine the port from the server config (default 3000)
    const res = await fetch('http://127.0.0.1:3000/api/health');
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('stop() shuts down cleanly without hanging handles', async () => {
    process_ = await LegionProcess.start(workspaceRoot);
    await expect(process_.stop()).resolves.toBeUndefined();
    process_ = undefined!; // prevent double-stop in afterEach
  });

  it('LegionProcess.start() works when LEGION_WORKSPACE is set', async () => {
    // Validates that LegionProcess.start() still functions correctly when the
    // env var is present; full env-var consumption smoke test is in Task 9.
    const origEnv = process.env['LEGION_WORKSPACE'];
    try {
      process.env['LEGION_WORKSPACE'] = workspaceRoot;
      process_ = await LegionProcess.start(workspaceRoot);
      const participants = process_.collective.listActive();
      expect(participants.length).toBeGreaterThan(0);
    } finally {
      if (origEnv === undefined) {
        delete process.env['LEGION_WORKSPACE'];
      } else {
        process.env['LEGION_WORKSPACE'] = origEnv;
      }
    }
  });

  it('full flow: seed → login → execute list_participants → result', async () => {
    // Start with a custom port to avoid collisions with other integration tests.
    // Write a minimal config.json to use port 3001.
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(workspaceRoot, '.legion'), { recursive: true });
    await writeFile(
      join(workspaceRoot, '.legion', 'config.json'),
      JSON.stringify({ version: '2', server: { port: 3001, host: '127.0.0.1' } }),
    );

    // Capture bootstrap password from stdout (hacky but reliable for integration).
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '));
      origLog(...args);
    };

    process_ = await LegionProcess.start(workspaceRoot);
    console.log = origLog;

    // Extract password from current boxed bootstrap output.
    const password = logged.join('\n').match(/Password:\s+([^\s│]+)/)?.[1];
    expect(password).toBeTruthy();

    // Login
    const loginRes = await fetch('http://127.0.0.1:3001/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Operator', password }),
    });
    expect(loginRes.ok).toBe(true);
    const { token } = (await loginRes.json()) as { token: string };
    expect(token).toBeTruthy();

    // Execute list_participants
    const execRes = await fetch('http://127.0.0.1:3001/api/execute', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tool: 'list_participants', args: {} }),
    });
    expect(execRes.ok).toBe(true);
    const { result, conversationId } = (await execRes.json()) as {
      result: { status: string };
      conversationId: string;
    };
    expect(result.status).toBe('success');
    expect(typeof conversationId).toBe('string');
  });
});
