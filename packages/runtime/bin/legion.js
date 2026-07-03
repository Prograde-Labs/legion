#!/usr/bin/env node
const dev = process.argv.includes('--dev');

// In dev mode tsx resolves .js → .ts, so src/ import works.
// In production, built dist/ files are used directly.
const { LegionProcess } = dev
  ? await import('../src/LegionProcess.js')
  : await import('../dist/LegionProcess.js');

// workspaceRoot: env var > first non-flag arg > cwd
const workspaceRoot =
  process.env.LEGION_WORKSPACE ??
  process.argv.slice(2).find((a) => !a.startsWith('-')) ??
  process.cwd();

console.log(`Starting Legion runtime in: ${workspaceRoot}${dev ? ' [dev]' : ''}`);

const lp = await LegionProcess.start(workspaceRoot, { dev });

async function shutdown() {
  console.log('\nShutting down...');
  await lp.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
