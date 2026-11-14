#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// npm exec supplies the pinned pnpm on PATH for this entire process tree,
// including repository scripts that invoke pnpm themselves. The enclosing
// hammer runBounded owns the timeout and process-group cleanup.
const commands = JSON.parse(process.argv[2]);
if (process.env.HAM_PNPM_VALIDATION_STARTED_FILE) {
  writeFileSync(process.env.HAM_PNPM_VALIDATION_STARTED_FILE, '', { flag: 'wx', mode: 0o600 });
}
for (const args of commands) {
  console.log(`+ pnpm run ${args.join(' ')}`);
  const result = spawnSync('pnpm', ['run', ...args], { stdio: 'inherit' });
  if (result.error || result.signal || result.status !== 0) {
    process.exitCode = (result.status === 78 ? 1 : result.status) || 1;
    break;
  }
}
