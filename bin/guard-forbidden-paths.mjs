#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { loadGuardForbiddenPaths, resolveGuardForbiddenNonBlocking } from '../src/guard-forbidden-paths.mjs';

const [repo, prNumber, reviewFile, strict = 'true'] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(prNumber || '') || !reviewFile || !['true', 'false'].includes(strict)) {
  process.stderr.write('usage: guard-forbidden-paths OWNER/REPO PR REVIEW_FILE [true|false]\n');
  process.exit(64);
}
try {
  const { stdout } = await execGhWithRetry({ args: ['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.base.sha'], timeoutMs: 15_000 });
  const baseRef = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(baseRef)) throw new Error('PR base SHA is missing or malformed');
  const guards = await loadGuardForbiddenPaths({ repo, baseRef });
  const policy = resolveGuardForbiddenNonBlocking(readFileSync(reviewFile, 'utf8'), guards, { strictNonBlockingRemediation: strict === 'true' });
  process.stdout.write(`${JSON.stringify({ baseRef, guards, ...policy }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`guard policy read failed; findings remain unresolved: ${error?.message || error}\n`);
  process.exitCode = 1;
}
