import type { FullConfig } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProvider, type MockProvider } from './mock-provider/server.js';
import { CONN_INFO_FILE } from './fixtures/index.js';

const SERVER_PORT = 4000;
const BOOTSTRAP_PASSWORD = 'legion-e2e-test';

const _dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(_dirname, '../..');

async function waitForUrl(url: string, maxMs: number, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + maxMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

export default async function globalSetup(
  _config: FullConfig,
): Promise<() => Promise<void>> {
  // 1. Create temp workspace dir
  const workspaceDir = await mkdtemp(join(tmpdir(), 'legion-e2e-'));

  // 2. Start mock LLM provider in-process (port 4001)
  const mockProvider: MockProvider = await startMockProvider(4001);
  console.log('[e2e setup] Mock LLM provider listening on :4001');

  // 3. Spawn Legion server as child process (port 4000)
  const legionServer: ChildProcess = spawn(
    'node',
    [join(REPO_ROOT, 'packages/runtime/bin/legion.js')],
    {
      env: {
        ...process.env,
        LEGION_BOOTSTRAP_PASSWORD: BOOTSTRAP_PASSWORD,
        LEGION_WORKSPACE: workspaceDir,
        PORT: String(SERVER_PORT),
      },
      stdio: 'pipe',
    },
  );

  legionServer.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[legion] ${d.toString()}`);
  });

  // 4. Wait for health endpoint (max 15s)
  await waitForUrl(`http://127.0.0.1:${SERVER_PORT}/api/health`, 15_000);
  console.log(`[e2e setup] Legion server ready on :${SERVER_PORT}`);

  // 5. Write connection info for fixtures
  const connInfo = {
    serverUrl: `http://127.0.0.1:${SERVER_PORT}`,
    mockProviderUrl: `http://127.0.0.1:4001`,
    password: BOOTSTRAP_PASSWORD,
  };
  await writeFile(CONN_INFO_FILE, JSON.stringify(connInfo, null, 2));

  // Return teardown function (Playwright calls this after all tests)
  return async function teardown(): Promise<void> {
    legionServer.kill('SIGTERM');
    await mockProvider.stop();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(CONN_INFO_FILE, { force: true });
    console.log('[e2e teardown] Complete.');
  };
}
