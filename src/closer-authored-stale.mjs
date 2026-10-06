// STALECLOSER-03: ONE eligibility rule for a closer-authored stale head.
//
// A head is closer-authored-stale when the PR head moved past the reviewed head
// only through the closer's own commits (`Closed-By: hammer` trailer). The
// reviewed verdict may then be carried forward to the closer head -- but only
// through `closerAuthoredStaleEligible`, which the AMA closer, the hammer wake,
// the orphan watchdog and agent-os `merge-agent rescue` all call. Rescue can no
// longer recommend `dispatch-closer` for a head the closer would refuse.
//
// Imports from head-closer-commit-suppression stay inside the export set the
// watcher fixtures stub (`fixture:head-closer-commit-suppression`).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  fetchHeadCloserVerifiedCommit,
  getHeadCloserCommitSuppression,
} from './head-closer-commit-suppression.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

export const CLOSER_AUTHORED_STALE_WAKE_REASON = 'closer-authored-stale-head-eligible';
export const CLOSER_AUTHORED_STALE_DECISIONS = Object.freeze({
  ELIGIBLE: 'eligible',
  RETRY: 'retry',
  NOT_ELIGIBLE: 'not-eligible',
  REREVIEW: 'rereview-exact-head',
  NOT_APPLICABLE: 'not-applicable',
});
const CLOSER_AUTHORED_STALE_AUDIT_SCHEMA_VERSION = 1;
const SETTLED_SUCCESS = 'settled-success';

function sha(value) {
  return String(value || '').trim();
}

/**
 * Commit-graph half of the rule. Walks first-parent from `currentHead` through
 * single-parent closer-trailer commits until it reaches an anchor: the reviewed
 * head itself, or a comment-only final-round push recorded for that reviewed
 * head (COMMENTCLOSE-01 already carries the reviewed verdict to that push).
 * Any non-closer commit (a worker push, a rebased worker commit, a merge) on
 * the way stops the walk: the head needs exact-head re-review.
 *
 * Probe failures propagate; callers fail closed.
 */
export async function proveCloserAuthoredStaleHead({
  reviewedHead,
  currentHead,
  anchorHeads = [],
  maxCommits = 8,
  suppressionImpl = getHeadCloserCommitSuppression,
  fetchCommitImpl = fetchHeadCloserVerifiedCommit,
  ...options
} = {}) {
  const reviewed = sha(reviewedHead);
  const current = sha(currentHead);
  const base = { proven: false, reviewedHead: reviewed || null, currentHead: current || null,
    anchorHead: null, closerCommits: [] };
  if (!reviewed || !current) return { ...base, reason: 'head-unknown' };
  if (reviewed === current) return { ...base, reason: 'not-stale' };
  const anchors = new Set([reviewed, ...anchorHeads.map(sha).filter(Boolean)]);
  if (anchors.has(current)) return { ...base, reason: 'not-stale' };
  const closerCommits = [];
  const seen = new Set();
  let head = current;
  while (!anchors.has(head)) {
    if (closerCommits.length >= maxCommits) return { ...base, closerCommits, reason: 'closer-chain-too-long' };
    if (!head || seen.has(head)) return { ...base, closerCommits, reason: 'closer-chain-broken' };
    seen.add(head);
    const proof = await suppressionImpl({ ...options, headSha: head });
    if (proof?.suppressed !== true || proof.reason !== 'closer-commit-trailer') {
      return { ...base, closerCommits, nonCloserCommit: head, reason: 'non-closer-commit-after-reviewed-head' };
    }
    const commit = await fetchCommitImpl({ ...options, headSha: head });
    if (commit?.sha !== head || !commit.parentSha) return { ...base, closerCommits, reason: 'closer-chain-broken' };
    if (commit.parentCount != null && commit.parentCount !== 1) {
      return { ...base, closerCommits, nonCloserCommit: head, reason: 'merge-commit-in-closer-chain' };
    }
    closerCommits.push(head);
    head = commit.parentSha;
  }
  return { ...base, proven: true, anchorHead: head, closerCommits, reason: 'closer-commits-only' };
}

/**
 * The predicate. Pure: every input is already resolved by the caller.
 *
 * - `headProof` from `proveCloserAuthoredStaleHead`;
 * - `verdict`, `blockingFindingState`, `blockingFindingCount` of the CARRIED
 *   (reviewed-head) verdict;
 * - `checksConclusion`: `classifyCheckRollup` of the EXACT current head;
 * - `mergeability`: `closureGateMergeability` of the current head.
 *
 * Decisions: `eligible`; `retry` when the only misses are transient (exact-head
 * CI PENDING, mergeability UNKNOWN) -- wait and re-evaluate, never stop;
 * `not-eligible` for a hard miss (red/unknown CI, blockers, unsettled verdict);
 * `rereview-exact-head` when a non-closer commit sits after the reviewed head;
 * `not-applicable` when the head is not stale at all.
 */
export function closerAuthoredStaleEligible({
  headProof,
  verdict,
  blockingFindingState,
  blockingFindingCount,
  checksConclusion,
  mergeability,
} = {}) {
  const { ELIGIBLE, RETRY, NOT_ELIGIBLE, REREVIEW, NOT_APPLICABLE } = CLOSER_AUTHORED_STALE_DECISIONS;
  const headSummary = {
    reviewedHead: headProof?.reviewedHead || null,
    currentHead: headProof?.currentHead || null,
    anchorHead: headProof?.anchorHead || null,
    closerCommits: Array.isArray(headProof?.closerCommits) ? headProof.closerCommits : [],
  };
  if (headProof?.proven !== true) {
    // A live review on the closer head makes it an ordinary reviewed head.
    const notStale = ['not-stale', 'closer-head-reviewed'].includes(headProof?.reason);
    return { eligible: false, carryForward: false, transient: false, ...headSummary,
      decision: notStale ? NOT_APPLICABLE : REREVIEW,
      reasons: [headProof?.reason || 'closer-authored-proof-missing'] };
  }
  const hard = [];
  const transient = [];
  if (String(verdict || '') !== SETTLED_SUCCESS) hard.push('verdict-not-settled-success');
  const blockingState = String(blockingFindingState || 'unknown').trim().toLowerCase();
  const blockingCount = Number(blockingFindingCount);
  if (blockingState === 'unknown' || !Number.isFinite(blockingCount)) hard.push('blocking-findings-unknown');
  else if (blockingCount > 0 || blockingState === 'present') hard.push('blocking-findings-present');
  // The carried verdict is usable evidence once it is settled and clean; CI and
  // mergeability then decide only WHEN the closer may act on it.
  const carryForward = hard.length === 0;
  const checks = String(checksConclusion || '').trim().toUpperCase();
  if (checks === 'PENDING') transient.push('ci-pending');
  else if (checks !== 'SUCCESS') hard.push(checks ? 'ci-not-green' : 'ci-unknown');
  const merge = String(mergeability || '').trim().toUpperCase();
  if (!merge || merge === 'UNKNOWN') transient.push('pr-mergeability-unknown');
  if (hard.length) {
    return { eligible: false, carryForward, transient: false, ...headSummary,
      decision: NOT_ELIGIBLE, reasons: [...hard, ...transient] };
  }
  if (transient.length) {
    return { eligible: false, carryForward, transient: true, ...headSummary,
      decision: RETRY, reasons: transient };
  }
  return { eligible: true, carryForward, transient: false, ...headSummary, decision: ELIGIBLE, reasons: [] };
}

export function closerAuthoredStaleAuditPath(rootDir, { repo, prNumber, headSha } = {}) {
  const slug = String(repo || '').replace(/[^A-Za-z0-9._-]+/g, '__');
  return join(rootDir, 'data', 'closer-authored-stale', `${slug}-pr-${Number(prNumber)}-${sha(headSha)}.json`);
}

/**
 * Audit the carried-forward verdict once per closer head (`overwrite: false`):
 * which reviewed verdict now authorizes which closer commits. Best-effort; an
 * audit failure never changes the closure decision.
 */
export function writeCloserAuthoredStaleAudit(rootDir, {
  repo, prNumber, eligibility, verdict, blockingFindingCount, nonBlockingFindingCount,
  observedAt = new Date().toISOString(), logger = console,
} = {}) {
  const headSha = sha(eligibility?.currentHead);
  if (!rootDir || !repo || !Number.isInteger(Number(prNumber)) || !headSha || eligibility?.eligible !== true) {
    return { written: false, reason: 'not-eligible' };
  }
  const path = closerAuthoredStaleAuditPath(rootDir, { repo, prNumber, headSha });
  try {
    mkdirSync(join(rootDir, 'data', 'closer-authored-stale'), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify({
      schemaVersion: CLOSER_AUTHORED_STALE_AUDIT_SCHEMA_VERSION,
      event: 'closer_authored_stale_verdict_carried_forward',
      repo,
      prNumber: Number(prNumber),
      headSha,
      reviewedHead: eligibility.reviewedHead,
      anchorHead: eligibility.anchorHead,
      closerCommits: eligibility.closerCommits,
      carriedVerdict: verdict || null,
      blockingFindingCount: Number(blockingFindingCount ?? 0),
      nonBlockingFindingCount: Number(nonBlockingFindingCount ?? 0),
      observedAt,
    }, null, 2)}\n`, { overwrite: false });
    logger?.log?.(`[watcher] closer-authored stale head ${repo}#${prNumber}@${headSha.slice(0, 12)} `
      + `carries reviewed verdict from ${String(eligibility.reviewedHead || '').slice(0, 12)}`);
    return { written: true, path };
  } catch (err) {
    if (err?.code === 'EEXIST') return { written: false, reason: 'already-audited', path };
    logger?.warn?.(`[watcher] closer-authored stale audit failed for ${repo}#${prNumber}: ${err?.message || err}`);
    return { written: false, reason: 'audit-write-failed', path };
  }
}
