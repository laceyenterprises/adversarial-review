#!/usr/bin/env node
import { guardStackedBase } from '../src/ama/stacked-base.mjs';

const [rootDir, repo, prNumber] = process.argv.slice(2);
if (!rootDir || !/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(prNumber || '')) {
  process.stderr.write('Usage: stacked-base-check ROOT_DIR OWNER/REPO PR\n');
  process.exitCode = 64;
} else {
  const hold = await guardStackedBase({ rootDir, repo, prNumber: Number(prNumber) });
  if (hold) { process.stderr.write(`${hold.reason}\n`); process.exitCode = 20; }
}
