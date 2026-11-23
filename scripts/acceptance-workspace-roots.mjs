import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const REPO = process.cwd();
const PORT = 4310;
const PROVIDER_PORT = 4311;
const PASSWORD = 'acceptance-password';

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`PASS: ${message}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function textChunks(text) {
  return [
    { choices: [{ delta: { content: text }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
}

function toolChunks(id, name, args) {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
}

function startProvider() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const request = JSON.parse(body);
      const messages = request.messages ?? [];
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const toolMessage = [...messages].reverse().find((message) => message.role === 'tool');

      if (system.includes('SCENARIO=LIST_ROOT')) {
        if (toolMessage) {
          sse(res, textChunks(`ROOT_CONTENT=${toolMessage.content}`));
        } else {
          sse(res, toolChunks('list-root', 'file_list', { path: '.' }));
        }
        return;
      }
      if (system.includes('SCENARIO=FORWARD')) {
        if (toolMessage) {
          sse(res, textChunks(`FORWARDED=${toolMessage.content}`));
        } else {
          sse(
            res,
            toolChunks('forward', 'communicate', { to: 'agent-b', message: 'list your root' }),
          );
        }
        return;
      }
      sse(res, textChunks('NO_SCENARIO'));
    });
  });
  return new Promise((resolveStart) => {
    server.listen(PROVIDER_PORT, '127.0.0.1', () => resolveStart(server));
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function login(name, password) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`login ${name}: ${JSON.stringify(json)}`);
  return json.token;
}

async function rawCall(token, tool, args) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/execute?stream=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool, args }),
  });
  const json = await res.json();
  return json.result;
}

async function call(token, tool, args) {
  const result = await rawCall(token, tool, args);
  if (result?.status !== 'success') {
    throw new Error(`${tool}: ${JSON.stringify(result)}`);
  }
  return result.data;
}

const root = await mkdtemp(join(tmpdir(), 'legion-acceptance-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const roots = join(workspace, 'roots');
const dirs = {
  a: join(roots, 'a'),
  b: join(roots, 'b'),
  default: join(roots, 'default'),
};

let provider;
let legion;

try {
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  await mkdir(join(dirs.a, 'sub'), { recursive: true });
  await mkdir(join(dirs.a, 'allowed'), { recursive: true });
  await writeFile(join(dirs.a, 'root-a.txt'), 'A');
  await writeFile(join(dirs.a, 'other.txt'), 'other');
  await writeFile(join(dirs.a, 'allowed', 'ok.txt'), 'ok');
  await writeFile(join(dirs.b, 'root-b.txt'), 'B');
  await writeFile(join(dirs.default, 'default.txt'), 'D');

  await mkdir(join(home, '.config', 'legion', 'providers'), { recursive: true });
  await writeFile(
    join(home, '.config', 'legion', 'providers', 'Mock.json'),
    JSON.stringify({
      name: 'Mock',
      type: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
      apiKey: 'x',
      priority: 1,
    }),
  );
  await writeFile(
    join(home, '.config', 'legion', 'config.json'),
    JSON.stringify({ routing: { models: { 'mock-model': ['Mock'] } } }),
  );
  await mkdir(join(workspace, '.legion'), { recursive: true });
  await writeFile(
    join(workspace, '.legion', 'config.json'),
    JSON.stringify({ version: '2', workspaceRoot: 'roots/default' }),
  );

  provider = await startProvider();
  legion = spawn('node', [join(REPO, 'packages/runtime/bin/legion.js')], {
    env: {
      ...process.env,
      HOME: home,
      LEGION_WORKSPACE: workspace,
      PORT: String(PORT),
      LEGION_BOOTSTRAP_PASSWORD: PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  legion.stdout.on('data', (data) => process.stdout.write(`[legion] ${data}`));
  legion.stderr.on('data', (data) => process.stderr.write(`[legion] ${data}`));

  await waitFor(`http://127.0.0.1:${PORT}/api/health`, 20_000);
  const operator = await login('Operator', PASSWORD);

  await call(operator, 'create_agent', {
    id: 'agent-a',
    name: 'Agent A',
    systemPrompt: 'SCENARIO=FORWARD',
    model: { model: 'mock-model' },
    tools: {
      communicate: 'auto',
      file_list: 'auto',
      file_read: 'auto',
      execute_command: 'auto',
    },
    workspaceRoot: dirs.a,
  });
  await call(operator, 'create_agent', {
    id: 'agent-b',
    name: 'Agent B',
    systemPrompt: 'SCENARIO=LIST_ROOT',
    model: { model: 'mock-model' },
    tools: { file_list: 'auto' },
    workspaceRoot: 'roots/b',
  });
  await call(operator, 'create_agent', {
    id: 'agent-c',
    name: 'Agent C',
    systemPrompt: 'SCENARIO=LIST_ROOT',
    model: { model: 'mock-model' },
    tools: { file_list: 'auto' },
  });

  assert(
    await exists(join(workspace, '.legion', 'collective', 'participants', 'agent-a.json')),
    'participant storage stays under the launch root .legion',
  );
  assert(
    !(await exists(join(dirs.a, '.legion'))),
    'participant root does not relocate .legion storage',
  );

  await call(operator, 'set_credential', { participantId: 'agent-a', secret: PASSWORD });
  await call(operator, 'set_credential', { participantId: 'agent-b', secret: PASSWORD });
  await call(operator, 'set_credential', { participantId: 'agent-c', secret: PASSWORD });

  const a = await login('Agent A', PASSWORD);
  const b = await login('Agent B', PASSWORD);
  const c = await login('Agent C', PASSWORD);

  const aFiles = await call(a, 'file_list', { path: '.' });
  assert(aFiles.includes('root-a.txt'), 'agent A lists its own root');
  assert(!aFiles.includes('root-b.txt'), 'agent A does not see agent B files');

  const bFiles = await call(b, 'file_list', { path: '.' });
  assert(bFiles.includes('root-b.txt'), 'agent B lists its own relative root');
  assert(!bFiles.includes('root-a.txt'), 'agent B does not see agent A files');

  const cFiles = await call(c, 'file_list', { path: '.' });
  assert(cFiles.includes('default.txt'), 'agent C inherits WorkspaceConfig.workspaceRoot');

  const inside = await call(a, 'file_read', { path: join(dirs.a, 'root-a.txt') });
  assert(inside === 'A', 'absolute path inside the participant root is readable');

  const outside = await rawCall(a, 'file_read', { path: join(dirs.b, 'root-b.txt') });
  assert(
    outside.status === 'error' && /outside/i.test(outside.error),
    'absolute path outside is rejected',
  );

  const traversal = await rawCall(a, 'file_read', { path: '../b/root-b.txt' });
  assert(
    traversal.status === 'error' && /outside|invalid path/i.test(traversal.error),
    '.. escape is rejected',
  );

  const realA = await realpath(dirs.a);
  const realB = await realpath(dirs.b);
  const realSub = await realpath(join(dirs.a, 'sub'));

  const pwd = await call(a, 'execute_command', { command: 'pwd' });
  assert(pwd.stdout.trim() === realA, 'execute_command defaults to the participant root');

  const pwdRelative = await call(a, 'execute_command', { command: 'pwd', cwd: 'sub' });
  assert(pwdRelative.stdout.trim() === realSub, 'relative cwd resolves under the participant root');

  const pwdAbsolute = await call(a, 'execute_command', { command: 'pwd', cwd: dirs.b });
  assert(pwdAbsolute.stdout.trim() === realB, 'absolute cwd is used as-is');

  const processDir = join(workspace, '.legion', 'processes');
  assert(await exists(processDir), 'process logs stay under the launch root .legion');
  const processEntries = await readdir(processDir);
  assert(processEntries.length > 0, 'process log directories are created under .legion/processes');

  await call(operator, 'modify_agent', {
    id: 'agent-a',
    tools: {
      communicate: 'auto',
      file_list: 'auto',
      execute_command: 'auto',
      file_read: { policy: 'auto', scope: { path: { pathPrefix: 'allowed' } } },
    },
  });
  const scopedOk = await call(a, 'file_read', { path: 'allowed/ok.txt' });
  assert(scopedOk === 'ok', 'pathPrefix scope resolves under the participant root');
  const scopedBad = await rawCall(a, 'file_read', { path: 'other.txt' });
  assert(
    scopedBad.status === 'error' && /argument scope violation/.test(scopedBad.error),
    'pathPrefix scope rejects paths outside the participant root',
  );

  const forwarded = await call(a, 'communicate', { to: 'agent-b', message: 'go' });
  const forwardedText = JSON.stringify(forwarded);
  assert(forwardedText.includes('root-b.txt'), 'cross-agent message uses the recipient root');
  assert(
    !forwardedText.includes('root-a.txt'),
    'cross-agent message does not leak the sender root',
  );

  console.log('ACCEPTANCE PASS');
} finally {
  if (legion) {
    if (legion.exitCode === null && legion.signalCode === null) {
      legion.kill('SIGTERM');
      await new Promise((resolveExit) => legion.once('exit', resolveExit));
    }
  }
  if (provider) {
    await new Promise((resolveClose) => provider.close(resolveClose));
  }
  await rm(root, { recursive: true, force: true });
}
