import { isHammerOwnedHead } from './hammer-head-ownership.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// STALECLOSER-03: ONE eligibility rule for a closer-authored stale head.
//
// A head is closer-authored-stale when the PR head moved past the reviewed head
// only through daemon-owned completed remediation rounds and authenticated
// hammer App pushed or validated edges, ending with a hammer edge. The
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
  hammerAttestationChain, hammerProvenanceEdge, readCompletedRemediationRounds,
} from './ama/hammer-head-validation.mjs';
import { execGhWithRetry } from './gh-cli.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

export const CLOSER_AUTHORED_STALE_WAKE_REASON = 'closer-authored-stale-head-eligible';
export const CLOSER_AUTHORED_STALE_DECISIONS = Object.freeze({
  ELIGIBLE: 'eligible',
  RETRY: 'retry',
  NOT_ELIGIBLE: 'not-eligible',
  REREVIEW: 'rereview-exact-head',
  NOT_APPLICABLE: 'not-applicable',
  HAMMER_RESUME: 'hammer-resume',
});
const CLOSER_AUTHORED_STALE_AUDIT_SCHEMA_VERSION = 1;
const SETTLED_SUCCESS = 'settled-success';

function sha(value) {
  return String(value || '').trim();
}

/**
 * Provenance half of the shared rule. Daemon-owned completed remediation rounds
 * can bridge the reviewed SHA to an authenticated hammer App chain. The exact
 * current SHA must end with a hammer edge. Commit trailers, author fields and
 * builder/remediator anchor heads confer no merge authority.
 * Read failures propagate for bounded recovery; tests supply comment fixtures.
 *
 * CLOSERPROOF-01: once comments are read, `currentHeadHammerAttested` says
 * whether any authenticated hammer edge ends at the exact current SHA, whatever
 * its base. The retry cap keys its series to heads by this bit, so a closer push
 * keeps the series and a non-closer push (such as a rebased hammer commit) does
 * not inherit it. It is absent when no comments were read: unknown, never false.
 */
export async function proveCloserAuthoredStaleHead({
  reviewedHead, currentHead, maxCommits = 8, comments = null,
  execGhWithRetryImpl = execGhWithRetry, ...options
} = {}) {
  const reviewed = sha(reviewedHead), current = sha(currentHead);
  const base = { proven: false, reviewedHead: reviewed || null, currentHead: current || null,
    anchorHead: null, closerCommits: [] };
  if (!reviewed || !current) return { ...base, reason: 'head-unknown' };
  if (reviewed === current) return { ...base, reason: 'not-stale' };
  if (!comments) {
    comments = [];
    // An absent test collaborator is missing evidence, never live GitHub I/O.
    if (!options.repoPath || !options.prNumber || (process.env.NODE_TEST_CONTEXT
      && !options.execFileImpl && execGhWithRetryImpl === execGhWithRetry)) {
      return { ...base, reason: 'hammer-app-attestation-missing' };
    }
    for (let page = 1; ; page++) {
      const batch = JSON.parse((await execGhWithRetryImpl({ ...options,
        args: ['api', `repos/${options.repoPath}/issues/${options.prNumber}/comments?per_page=100&page=${page}`],
        timeoutMs: loadAwareTimeoutMs(15000) })).stdout);
      comments.push(...batch);
      if (batch.length < 100) break;
    }
  }
  const rounds = await readCompletedRemediationRounds(options.rootDir, options.repoPath, options.prNumber);
  const chain = hammerAttestationChain(comments, reviewed, current, rounds);
  const read = { ...base,
    currentHeadHammerAttested: comments.some(comment => hammerProvenanceEdge(comment)?.head === current) };
  if (!chain) return { ...read, reason: 'hammer-app-attestation-missing' };
  if (chain.length > maxCommits) return { ...read, reason: 'closer-chain-too-long' };
  return { ...read, proven: true, anchorHead: reviewed, closerCommits: [...chain].reverse(),
    reason: 'hammer-app-attestation-chain' };
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
 * `not-eligible` for a hard miss (red/unknown CI, resolved non-mergeable head,
 * blockers, unsettled verdict);
 * `rereview-exact-head` when a non-closer commit sits after the reviewed head;
 * `not-applicable` when the head is not stale at all.
 */
export function closerAuthoredStaleEligible({
  headProof,
  hammerHead,
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
  if (headProof?.proven !== true && isHammerOwnedHead(hammerHead, headSummary.currentHead)) {
    return { eligible: false, carryForward: false, transient: false, ...headSummary,
      decision: CLOSER_AUTHORED_STALE_DECISIONS.HAMMER_RESUME, hammerHead,
      reasons: ['hammer-owned-head'] };
  }
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
  else if (merge !== 'MERGEABLE') hard.push('pr-not-mergeable');
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
