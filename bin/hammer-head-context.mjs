#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { fetchHammerHeadRange, readCompletedRemediationRounds } from '../src/ama/hammer-head-validation.mjs';
const [repo, reviewedHead, currentHead, baseArg, prUrl] = process.argv.slice(2);
if (!repo || !reviewedHead || !currentHead || !baseArg || (baseArg === '--pr' && !prUrl)) {
  throw new Error('usage: hammer-head-context REPO REVIEWED HEAD BASE | REPO REVIEWED HEAD --pr PR_URL');
}
const prNumber = process.env.HAM_PR_NUMBER || (baseArg === '--pr' ? prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1] : undefined);
// Keep PR-base discovery inside the same bounded, classified retry path as ancestry reads.
const baseRef = process.env.HAM_BASE_HEAD ? (baseArg === '--pr' ? 'main' : baseArg) : baseArg === '--pr' ? (await execGhWithRetry({
  args: ['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.base.ref'], timeoutMs: 15000,
})).stdout.trim() : baseArg;
if (!baseRef) throw new Error('hammer PR base is missing');
if (process.env.HAM_BASE_HEAD && process.env.HAM_BASE_HEAD !== reviewedHead && !prNumber) {
  throw new Error('hammer PR number is missing; supply a PR URL or HAM_PR_NUMBER');
}
// Discover the actual live PR base only for the new content proof. Existing
// reviewed-start/App-chain fast paths retain their zero-extra-read contract.
const loadRebaseBase = async () => {
  const pr = JSON.parse((await execGhWithRetry({ args: ['api', `repos/${repo}/pulls/${prNumber}`], timeoutMs: 15000 })).stdout);
  return pr?.head?.sha === currentHead && /^[a-f0-9]{40}$/.test(pr?.base?.sha || '') ? { sha: pr.base.sha } : null;
};
const loadRebaseCoverage = async ({ base, head }) => {
  if (![reviewedHead, head, base].every(sha => /^[a-f0-9]{40}$/.test(sha))) return null;
  const { proveReviewedRebase } = await import('../src/ama/reviewed-rebase.mjs');
  const execute = promisify(execFile);
  const git = async args => (await execute('git', args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const generatedHelper = fileURLToPath(new URL('./verify-rebase-generated.py', import.meta.url));
  let generatedFiles = [];
  try {
    generatedFiles = JSON.parse((await execute('python3', [generatedHelper, repo, 'policy'], { timeout: 15000 })).stdout);
    if (!Array.isArray(generatedFiles)) generatedFiles = [];
  } catch { /* No installed policy: only whole-patch equivalence is available. */ }
  for (const sha of [reviewedHead, base]) {
    try { await git(['cat-file', '-e', `${sha}^{commit}`]); }
    catch { try { await git(['fetch', '--no-tags', 'origin', sha]); } catch { return null; } }
  }
  const verifyGenerated = async (sha, paths) => {
    try {
      return (await execute('python3', [generatedHelper, repo, 'verify', sha, ...paths],
        { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim() === 'verified';
    } catch { return false; }
  };
  return proveReviewedRebase({ reviewedHead, head, base, git, generatedFiles, verifyGenerated });
};
const loadComments = async () => {
  const comments = [];
  for (let page = 1; process.env.HAM_BASE_HEAD && process.env.HAM_BASE_HEAD !== reviewedHead; page++) {
    const batch = JSON.parse((await execGhWithRetry({ args: ['api',
      `repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`], timeoutMs: 15000 })).stdout);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
};
const loadTimelinePage = async cursor => {
  const [owner, name] = repo.split('/');
  const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      timelineItems(first: 100, after: $cursor, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
        nodes { __typename ... on HeadRefForcePushedEvent {
          actor { __typename login } beforeCommit { oid } afterCommit { oid }
        } } pageInfo { hasNextPage endCursor }
      }
    } }
  }`;
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`,
    '-f', `name=${name}`, '-F', `number=${prNumber}`];
  if (typeof cursor === 'string' && cursor) args.push('-f', `cursor=${cursor}`);
  const response = JSON.parse((await execGhWithRetry({ args, timeoutMs: 15000 })).stdout);
  if (response.errors) return null;
  return response.data?.repository?.pullRequest?.timelineItems;
};
// Use GitHub's Link cursor rather than inventing page numbers for activity.
const loadActivityPage = async path => {
  const { stdout } = await execGhWithRetry({ args: ['api', '--include', path], timeoutMs: 15000 });
  const boundary = stdout.search(/\r?\n\r?\n/);
  if (boundary < 0) return null;
  const headers = stdout.slice(0, boundary);
  const body = stdout.slice(boundary).trim();
  const link = Array.from(headers.matchAll(/^link:[ \t]*(.*)$/gim), match => match[1]).join(', ');
  const nextUrl = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  const next = nextUrl ? new URL(nextUrl) : null;
  if (next && !next.pathname.endsWith('/activity')) return null;
  return { nodes: JSON.parse(body), next: next ? `${next.pathname.replace(/^\//, '')}${next.search}` : null };
};
const range = await fetchHammerHeadRange({ loadRebaseBase, loadRebaseCoverage, repo, reviewedHead, currentHead, baseRef, loadComments, loadTimelinePage, loadActivityPage, prNumber, hammerBaseHead: process.env.HAM_BASE_HEAD,
  remediationRounds: await readCompletedRemediationRounds(process.env.HAM_ROOT_DIR, repo, prNumber),
  get: async path => JSON.parse((await execGhWithRetry({ args: ['api', path], timeoutMs: 15000 })).stdout) });
if (!range) {
  process.stderr.write('hammer starting base or responsibility range could not be proven\n');
  process.exit(65);
}
process.stdout.write(`${JSON.stringify(range)}\n`);
