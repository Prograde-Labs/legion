import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegionProcess } from './LegionProcess.js';

const LIVE = Boolean(process.env['LEGION_INTEGRATION']);

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

  it('respects LEGION_WORKSPACE env var', async () => {
    const envWorkspace = workspaceRoot;
    process_ = await (async () => {
      const origEnv = process.env['LEGION_WORKSPACE'];
      process.env['LEGION_WORKSPACE'] = envWorkspace;
      const lp = await LegionProcess.start(envWorkspace);
      process.env['LEGION_WORKSPACE'] = origEnv ?? '';
      return lp;
    })();
    const participants = process_.collective.listActive();
    expect(participants.length).toBeGreaterThan(0);
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

    // Extract password from logged output
    const passwordLine = logged.find((l) => l.includes('Bootstrap operator password:'));
    expect(passwordLine).toBeDefined();
    const password = passwordLine!.match(/password:\s+([^\s│]+)/)?.[1];
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
