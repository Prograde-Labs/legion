#!/usr/bin/env node
import { LegionProcess } from '../dist/LegionProcess.js';

const workspaceRoot = process.env.LEGION_WORKSPACE ?? process.argv[2] ?? process.cwd();

console.log(`Starting Legion runtime in: ${workspaceRoot}`);

const lp = await LegionProcess.start(workspaceRoot);

async function shutdown() {
  console.log('\nShutting down...');
  await lp.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
