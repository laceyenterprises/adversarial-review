#!/usr/bin/env node
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { fetchHammerHeadRange, readCompletedRemediationRounds } from '../src/ama/hammer-head-validation.mjs';
const [repo, reviewedHead, currentHead, baseArg, prUrl] = process.argv.slice(2);
if (!repo || !reviewedHead || !currentHead || !baseArg || (baseArg === '--pr' && !prUrl)) {
  throw new Error('usage: hammer-head-context REPO REVIEWED HEAD BASE | REPO REVIEWED HEAD --pr PR_URL');
}
// Keep PR-base discovery inside the same bounded, classified retry path as ancestry reads.
const baseRef = process.env.HAM_BASE_HEAD ? (baseArg === '--pr' ? 'main' : baseArg) : baseArg === '--pr' ? (await execGhWithRetry({
  args: ['pr', 'view', prUrl, '--json', 'baseRefName', '--jq', '.baseRefName'], timeoutMs: 15000,
})).stdout.trim() : baseArg;
if (!baseRef) throw new Error('hammer PR base is missing');
const comments = [];
const prNumber = process.env.HAM_PR_NUMBER || (baseArg === '--pr' ? prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1] : undefined);
if (process.env.HAM_BASE_HEAD && process.env.HAM_BASE_HEAD !== reviewedHead && !prNumber) {
  throw new Error('hammer PR number is missing; supply a PR URL or HAM_PR_NUMBER');
}
for (let page = 1; process.env.HAM_BASE_HEAD && process.env.HAM_BASE_HEAD !== reviewedHead; page++) {
  const batch = JSON.parse((await execGhWithRetry({ args: ['api',
    `repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`], timeoutMs: 15000 })).stdout);
  comments.push(...batch);
  if (batch.length < 100) break;
}
const range = await fetchHammerHeadRange({ repo, reviewedHead, currentHead, baseRef, comments, hammerBaseHead: process.env.HAM_BASE_HEAD,
  remediationRounds: readCompletedRemediationRounds(process.env.HAM_ROOT_DIR, repo, prNumber),
  get: async path => JSON.parse((await execGhWithRetry({ args: ['api', path], timeoutMs: 15000 })).stdout) });
if (!range) {
  process.stderr.write('hammer starting base or responsibility range could not be proven\n');
  process.exit(65);
}
process.stdout.write(`${JSON.stringify(range)}\n`);
