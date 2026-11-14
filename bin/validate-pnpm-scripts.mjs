#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

// npm exec supplies the pinned pnpm on PATH for this entire process tree,
// including repository scripts that invoke pnpm themselves. The enclosing
// hammer runBounded owns the timeout and process-group cleanup.
const commands = JSON.parse(process.argv[2]);
for (const args of commands) {
  console.log(`+ pnpm run ${args.join(' ')}`);
  const result = spawnSync('pnpm', ['run', ...args], { stdio: 'inherit' });
  if (result.error || result.signal || result.status !== 0) {
    process.exitCode = result.status || 1;
    break;
  }
}
