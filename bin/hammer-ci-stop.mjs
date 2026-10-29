#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recordHammerCiStop } from '../src/ama/hammer-ci-stop.mjs';

try {
  const [path] = process.argv.slice(2);
  const stop = await recordHammerCiStop({ pr: JSON.parse(readFileSync(path, 'utf8')),
    repo: process.env.HAM_REPO, prNumber: Number(process.env.HAM_PR_NUMBER),
    execFileImpl: promisify(execFile) });
  if (stop) {
    process.stdout.write(`${JSON.stringify({ noMerge: true, ...stop })}\n`);
    process.exitCode = 20;
  }
} catch {
  process.stderr.write('HAM infrastructure stop evidence unavailable\n');
  process.exitCode = 1;
}
