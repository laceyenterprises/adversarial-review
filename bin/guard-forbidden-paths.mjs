#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { loadGuardForbiddenPaths, resolveGuardForbiddenNonBlocking } from '../src/guard-forbidden-paths.mjs';
import { guardedPackPathsInText, livePackPolicyProtects, loadLivePackPolicy } from '../src/live-pack-cross-edit.mjs';

const [repo, prNumber, reviewFile, strict = 'true'] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(prNumber || '') || !reviewFile || !['true', 'false'].includes(strict)) {
  process.stderr.write('usage: guard-forbidden-paths OWNER/REPO PR REVIEW_FILE [true|false]\n');
  process.exit(64);
}
try {
  const { stdout } = await execGhWithRetry({ args: ['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.base.sha'], timeoutMs: 15_000 });
  const baseRef = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(baseRef)) throw new Error('PR base SHA is missing or malformed');
  const reviewText = readFileSync(reviewFile, 'utf8');
  const guards = await loadGuardForbiddenPaths({ repo, baseRef });
  // REMEDIATIONLIVEPLAN-01: read liveness only for packs the review cites; a
  // failed read protects every live-pack path (failClosed).
  const packPaths = guardedPackPathsInText(reviewText);
  let livePack = { failClosed: false, packs: [] };
  if (packPaths.length) {
    // The head ref only identifies packs that are new at the base.
    const head = await execGhWithRetry({ args: ['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.head.sha'], timeoutMs: 15_000 })
      .then(({ stdout: sha }) => sha.trim(), () => '');
    livePack = await loadLivePackPolicy({ repo, baseRef, headRef: /^[a-f0-9]{40}$/.test(head) ? head : '', paths: packPaths });
  }
  const policy = resolveGuardForbiddenNonBlocking(reviewText, guards, {
    strictNonBlockingRemediation: strict === 'true', livePackProtects: path => livePackPolicyProtects(livePack, path),
  });
  process.stdout.write(`${JSON.stringify({ baseRef, guards, livePack, ...policy }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`guard policy read failed; findings remain unresolved and every live-pack plan, spec and prompt path stays protected: ${error?.message || error}\n`);
  process.exitCode = 1;
}
