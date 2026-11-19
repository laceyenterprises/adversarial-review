import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fsExt from 'fs-ext';
import { readAmaAuditEntry } from './audit.mjs';
import { controllerLaunchId } from './hammer-controller.mjs';
import { exactHammerValidation } from './hammer-head-validation.mjs';
import { hamAuditCommentAuthorMatches } from './ham-provenance.mjs';
import { inspectMergeLease } from './merge-lease.mjs';
import { filterGitHubBody } from '../github-outbound-body.mjs';

const sha = /^[a-f0-9]{40}$/;
const closedBy = 'Closed-By: hammer (adversarial-pipe-mode)';
const heading = '✅ Closed by Hammer';
const route = 'Hammer route: verified validated head';
const auditMarker = '<!-- hq:ham-terminal-remediation:audit -->';

function readOutcome(fd, launchRequestId, runId) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > 4096) throw new Error('merge-proof-invalid');
  let proof;
  try { proof = JSON.parse(readFileSync(fd, 'utf8')); }
  catch { throw new Error('merge-proof-invalid'); }
  if (proof?.schemaVersion !== 1 || proof.launchRequestId !== launchRequestId || proof.runId !== runId
    || proof.outcome !== 'merged' || proof.proof !== 'github-exact-head-own-merge'
    || !sha.test(proof.headSha || '') || !sha.test(proof.mergeCommitSha || '')
    || typeof proof.mergedAt !== 'string' || !Number.isFinite(Date.parse(proof.mergedAt))) {
    throw new Error('merge-proof-invalid');
  }
  return proof;
}

function closingAttempt(audit, { repo, prNumber, proof }) {
  if (audit?.repo !== repo || audit.prNumber !== prNumber || audit.headSha !== proof.headSha
    || audit.status !== 'succeeded' || !Array.isArray(audit.attempts)) return null;
  return audit.attempts.findLast(attempt => attempt?.launchRequestId === proof.launchRequestId
    && attempt.outcome === 'succeeded' && attempt.reason === 'merged'
    && attempt.attemptPhase === 'hammer-gh-pr-merge' && attempt.validatedHead === proof.headSha
    && attempt.mergeCommitSha === proof.mergeCommitSha && attempt.mergedAt === proof.mergedAt
    && attempt.preMergeEligible === true && attempt.eligibilityTrace?.eligible === true
    && attempt.githubGate?.ok === true && attempt.githubGate.expectedHead === proof.headSha
    && attempt.githubGate.liveHead === proof.headSha);
}

const lines = body => body.split(/\r?\n/).map(line => line.trim());
const lineValue = value => typeof value === 'string' && value.trim()
  ? value.replace(/[\r\n]+/g, ' ').trim() : 'unrecorded';

function recordedDocCurrency(comments, headSha) {
  const values = new Set(comments.filter(comment => exactHammerValidation(comment, headSha)
    && lines(comment.body).includes(auditMarker))
    .flatMap(comment => lines(comment.body).filter(line => line.startsWith('Doc-currency: '))));
  return values.size === 1 ? [...values][0] : 'Doc-currency: unrecorded';
}

function closingBody({ marker, attempt, proof, comments }) {
  const checks = lineValue(attempt.remoteCiStatus);
  return [
    marker, '', heading, '', route,
    `Validated head: ${proof.headSha}`,
    `Merge commit: ${proof.mergeCommitSha}`,
    `Merged at: ${proof.mergedAt}`,
    `Merge method: ${lineValue(attempt.mergeMethod)}`,
    'Merge lease: no longer held by this PR on its base lane',
    `Rebased onto base: ${lineValue(attempt.rebasedOntoBase)}`,
    `Rebase attempts: ${Number.isSafeInteger(attempt.rebaseAttempts) ? attempt.rebaseAttempts : 'unrecorded'}`,
    `Exact-head GitHub gate and HAM predicate: passed (${checks})`,
    `Local validation: ${lineValue(attempt.localCiStatus)}`,
    `Remediated findings: ${lineValue(attempt.remediatedFindings)}`,
    `Failing tests fixed: ${lineValue(attempt.failingTestsFixed)}`,
    recordedDocCurrency(comments, proof.headSha), '', closedBy,
  ].join('\n');
}

function alreadyPosted(comment, marker, mergeSha) {
  if (!hamAuditCommentAuthorMatches(comment.user?.login)) return false;
  const bodyLines = lines(comment.body);
  return bodyLines.includes(marker) || (
    (bodyLines.some(line => /^(?:#+\s*)?✅ Closed by Hammer\b/i.test(line)) || bodyLines.includes(route))
    && bodyLines.includes(closedBy) && comment.body.includes(mergeSha));
}

// There is one writer per run and merge. A retry always rereads GitHub first,
// including after an ambiguous delivery. Lock the existing immutable proof
// inode so no new local delivery record depends on scratch or worker teardown.
export async function deliverHammerClosingComment({ repo, prNumber, hqRoot, rootDir, env }, {
  github, readAudit = readAmaAuditEntry, inspectLease = inspectMergeLease,
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error('invalid-pr-target');
  }
  const launchRequestId = controllerLaunchId(env);
  const runId = env.HQ_WORKER_RUN_ID;
  if (!/^wrun_[A-Za-z0-9-]+$/.test(runId || '')) throw new Error('run-identity-unavailable');

  const path = join(hqRoot, 'dispatch', launchRequestId, 'hammer-progress', runId, 'outcome.json');
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error('merge-proof-unavailable'); }
  try {
    const proof = readOutcome(fd, launchRequestId, runId);
    try { fsExt.flockSync(fd, 'exnb'); }
    catch { throw new Error('closing-comment-delivery-lock-unavailable'); }

    const audit = readAudit(hqRoot, repo, prNumber, proof.headSha);
    const attempt = closingAttempt(audit, { repo, prNumber, proof });
    if (!attempt) throw new Error('merge-audit-unconfirmed');
    const live = await github(['api', `repos/${repo}/pulls/${prNumber}`]);
    if (live?.number !== prNumber || live.state !== 'closed' || live.merged !== true
      || live.head?.sha !== proof.headSha || live.merge_commit_sha !== proof.mergeCommitSha
      || live.merged_at !== proof.mergedAt || typeof live.base?.ref !== 'string' || !live.base.ref) {
      throw new Error('live-merge-unconfirmed');
    }
    const lease = inspectLease({ rootDir, repo, base: live.base.ref });
    if (lease?.holder !== null && (!Number.isSafeInteger(lease?.holder?.holderPr)
      || lease.holder.holderPr === prNumber)) throw new Error('merge-lease-release-unconfirmed');

    const endpoint = `repos/${repo}/issues/${prNumber}/comments`;
    const pages = await github(['api', '--paginate', '--slurp', endpoint]);
    if (!Array.isArray(pages) || pages.length === 0 || !pages.every(page => Array.isArray(page)
      && page.every(comment => Number.isSafeInteger(comment?.id) && typeof comment.body === 'string'))) {
      throw new Error('closing-comments-unreadable');
    }
    const comments = pages.flat();
    const marker = `<!-- hq:ham-closing:${proof.headSha}:${proof.mergeCommitSha} -->`;
    if (comments.some(comment => alreadyPosted(comment, marker, proof.mergeCommitSha))) {
      return { outcome: 'already-posted', headSha: proof.headSha, mergeCommitSha: proof.mergeCommitSha };
    }
    const identity = await github(['api', 'graphql', '-f', 'query={ viewer { login } }']);
    if (!hamAuditCommentAuthorMatches(identity?.data?.viewer?.login)) {
      throw new Error('closing-comment-author-unconfirmed');
    }
    const body = filterGitHubBody(closingBody({ marker, attempt, proof, comments }), {
      repo, reviewerHeadSha: proof.headSha, rootDir,
    });
    const posted = await github(['api', '--method', 'POST', endpoint, '-f', `body=${body}`]);
    if (!Number.isSafeInteger(posted?.id) || !hamAuditCommentAuthorMatches(posted.user?.login)
      || typeof posted.body !== 'string' || !lines(posted.body).includes(marker)) {
      throw new Error('closing-comment-delivery-unconfirmed');
    }
    return { outcome: 'posted', headSha: proof.headSha, mergeCommitSha: proof.mergeCommitSha };
  } finally { closeSync(fd); }
}
