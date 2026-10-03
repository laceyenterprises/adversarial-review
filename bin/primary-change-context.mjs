#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fetchPrimaryChange } from '../src/ama/primary-change.mjs';
const [repo, prNumber, headSha] = process.argv.slice(2);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(prNumber || '') || !/^[0-9a-f]{40}$/i.test(headSha || '')) {
  process.stderr.write('usage: primary-change-context.mjs owner/repo pr head-sha\n');
  process.exit(64);
}
const evidence = await fetchPrimaryChange({ repo, prNumber, headSha, get: (path) => {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('GitHub primary-change read failed');
  return JSON.parse(result.stdout);
} });
process.stdout.write(`${JSON.stringify(evidence)}\n`);
