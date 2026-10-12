#!/usr/bin/env node
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { fetchHammerHeadRange } from '../src/ama/hammer-head-validation.mjs';
const [repo, reviewedHead, currentHead, baseArg, prUrl] = process.argv.slice(2);
if (!repo || !reviewedHead || !currentHead || !baseArg || (baseArg === '--pr' && !prUrl)) {
  throw new Error('usage: hammer-head-context REPO REVIEWED HEAD BASE | REPO REVIEWED HEAD --pr PR_URL');
}
// Keep PR-base discovery inside the same bounded, classified retry path as ancestry reads.
const baseRef = baseArg === '--pr' ? (await execGhWithRetry({
  args: ['pr', 'view', prUrl, '--json', 'baseRefName', '--jq', '.baseRefName'], timeoutMs: 15000,
})).stdout.trim() : baseArg;
if (!baseRef) throw new Error('hammer PR base is missing');
const range = await fetchHammerHeadRange({ repo, reviewedHead, currentHead, baseRef,
  get: async path => JSON.parse((await execGhWithRetry({ args: ['api', path], timeoutMs: 15000 })).stdout) });
if (!range) {
  process.stderr.write('hammer head contains unverified or incomplete fleet ancestry\n');
  process.exit(65);
}
process.stdout.write(`${JSON.stringify(range)}\n`);
