// ARGUSDRAIN-01 item 4 — retire the backlog safely, before the drain starts.
//
// 1,519 jobs sat pending when the drain was built, for 387 PRs, the oldest
// from 2026-08-26 (agent-os#7326). Most of those PRs have long since merged or
// closed, or moved to a newer head. Reviewing them would spend a model call per
// dead tree and post findings on PRs nobody is looking at.
//
// So before the drain claims anything (and again on an interval), this pass
// closes every pending job that is no longer a live question, with an explicit
// `superseded` result that names why:
//
//   pr-merged-or-closed   the PR is not in the repository's open-PR list.
//   head-superseded       the PR is open, at a different head.
//
// The open-PR list is read LIVE from GitHub, one paginated listing per repo,
// never from the reviews.db lifecycle mirror, which has served merged PRs as
// open before. A repo whose listing fails, or might be truncated, retires
// NOTHING: uncertainty never retires a job. A job whose PR is open at exactly
// the job's head is live and is left alone. The drain re-checks liveness at
// claim time anyway, so a head that moves after this listing is still caught.
//
// The same pass also:
//   - returns claims orphaned by a watcher restart (in-progress, not running
//     in this process, older than the claim lease) to pending;
//   - reopens the legacy `route-for-review` completions (the pre-drain
//     semver-major parking, e.g. #1171 and #1172) whose head is still live, so
//     the drain gives them the review they were routed to.
//
// The inverse (a retired job whose PR reopens at the same head) is revived by
// the route, which only runs for open PRs (`reviveSupersededArgusJob`).

import {
  completeArgusJob,
  listArgusJobs,
  returnArgusJobToPending,
} from './argus-security-queue.mjs';
import { ARGUS_SUPERSEDED_VERDICT } from './argus-security-verdict.mjs';
import { ARGUS_REVIEW_RESULT_SOURCE } from './argus-security-review.mjs';
import { execGhWithRetry } from './gh-cli.mjs';

// Longer than the review child's 45-minute backstop, so a live claim is never
// taken back from a review that is still running in another process.
export const ARGUS_CLAIM_LEASE_MS = 60 * 60 * 1000;
export const ARGUS_BACKLOG_RETIREMENT_INTERVAL_MS = 30 * 60 * 1000;
export const ARGUS_OPEN_PR_LIST_LIMIT = 1000;
// Completed history grows without bound; only recent completions can be a
// legacy parking whose PR is still open.
const COMPLETED_SCAN_LIMIT = 500;

function normalizeRepoKey(repo) {
  return String(repo || '').trim().toLowerCase();
}

function isLegacyRouteForReviewCompletion(job) {
  const autoadjudication = job?.result?.autoadjudication;
  return job?.status === 'completed'
    && !job?.result?.source
    && autoadjudication?.decision === 'route-for-review'
    // A bump the adjudicator approved but could not merge (CI red, head moved)
    // was withheld, not routed: a security review would not change that.
    && !String(autoadjudication?.reason || '').startsWith('merge-withheld-');
}

/**
 * Production lister: the open PRs of one repo and their heads, live.
 * @returns {Promise<{heads: Map<number, string>, complete: boolean}>}
 */
export function createGhOpenPullHeadsLister({
  env = process.env,
  execGhWithRetryImpl = execGhWithRetry,
  limit = ARGUS_OPEN_PR_LIST_LIMIT,
  logger = console,
} = {}) {
  return async (repo) => {
    const { stdout } = await execGhWithRetryImpl({
      args: ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', 'number,headRefOid'],
      env,
      timeoutMs: 120_000,
      log: logger,
    });
    const rows = JSON.parse(String(stdout || '[]'));
    const heads = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const number = Number(row?.number);
      const head = String(row?.headRefOid || '').trim().toLowerCase();
      if (Number.isInteger(number) && head) heads.set(number, head);
    }
    // A listing that filled its limit may have stopped short, and a PR it cut
    // off would read as closed. Report it as incomplete so nothing is retired.
    return { heads, complete: rows.length < limit };
  };
}

function supersededResult({ reason, observedHeadSha, retiredAt }) {
  return {
    schemaVersion: 1,
    kind: 'argus-security-result',
    source: ARGUS_REVIEW_RESULT_SOURCE,
    verdict: ARGUS_SUPERSEDED_VERDICT,
    summary: `Argus retired this job without a review: ${reason}.`,
    supersededReason: reason,
    observedHeadSha: observedHeadSha || null,
    retiredBy: 'backlog-retirement',
    findings: [],
    completedAt: retiredAt,
  };
}

function tolerateVanished(fn) {
  try {
    return fn();
  } catch (err) {
    // Claimed, completed or retired by someone else since the listing: the job
    // moved on, which is exactly what this pass wanted.
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * One retirement pass.
 *
 * @param {object}   opts
 * @param {Function} opts.listOpenPullHeads  async (repo) => {heads, complete}.
 * @param {string[]} [opts.runningJobIds]    claims live in this process.
 * @returns {Promise<object>} counts and per-repo detail, for the log and the
 *   drain status file.
 */
export async function retireArgusBacklog({
  rootDir,
  listOpenPullHeads,
  runningJobIds = [],
  claimLeaseMs = ARGUS_CLAIM_LEASE_MS,
  nowMs = Date.now(),
  logger = console,
} = {}) {
  const retiredAt = new Date(nowMs).toISOString();
  const pending = listArgusJobs(rootDir, { bucket: 'pending', limit: Number.POSITIVE_INFINITY });
  const completed = listArgusJobs(rootDir, { bucket: 'completed', limit: COMPLETED_SCAN_LIMIT })
    .filter(({ job }) => isLegacyRouteForReviewCompletion(job));
  const summary = {
    observedAt: retiredAt,
    pendingBefore: pending.length,
    retired: 0,
    retiredByReason: { 'pr-merged-or-closed': 0, 'head-superseded': 0 },
    liveHeads: 0,
    oldestLiveHead: null,
    requeued: 0,
    reclaimed: 0,
    skippedRepos: [],
  };

  const repos = new Map();
  for (const { job } of [...pending, ...completed]) {
    if (job?.repo) repos.set(normalizeRepoKey(job.repo), job.repo);
  }
  const openHeadsByRepo = new Map();
  for (const [key, repo] of repos) {
    try {
      const listing = await listOpenPullHeads(repo);
      if (!listing?.complete) {
        summary.skippedRepos.push({ repo, reason: 'open-pr-listing-may-be-truncated' });
        continue;
      }
      openHeadsByRepo.set(key, listing.heads);
    } catch (err) {
      summary.skippedRepos.push({ repo, reason: `open-pr-listing-failed: ${String(err?.message || err).slice(0, 200)}` });
    }
  }

  for (const { job, jobPath } of pending) {
    const heads = openHeadsByRepo.get(normalizeRepoKey(job?.repo));
    if (!heads) continue;
    const liveHead = heads.get(Number(job.prNumber)) || null;
    if (liveHead && liveHead === String(job.headSha).toLowerCase()) {
      summary.liveHeads += 1;
      const enqueuedMs = Date.parse(String(job.enqueuedAt || ''));
      if (Number.isFinite(enqueuedMs) && (!summary.oldestLiveHead || enqueuedMs < Date.parse(summary.oldestLiveHead.enqueuedAt))) {
        summary.oldestLiveHead = { jobId: job.jobId, repo: job.repo, prNumber: job.prNumber, enqueuedAt: job.enqueuedAt };
      }
      continue;
    }
    const reason = liveHead ? 'head-superseded' : 'pr-merged-or-closed';
    const done = tolerateVanished(() => completeArgusJob({
      rootDir,
      jobPath,
      completedAt: retiredAt,
      result: supersededResult({ reason, observedHeadSha: liveHead, retiredAt }),
      job,
    }));
    if (done) {
      summary.retired += 1;
      summary.retiredByReason[reason] += 1;
    }
  }

  for (const { job, jobPath } of completed) {
    const heads = openHeadsByRepo.get(normalizeRepoKey(job?.repo));
    if (!heads || heads.get(Number(job.prNumber)) !== String(job.headSha).toLowerCase()) continue;
    const autoadjudication = job.result.autoadjudication;
    const reopened = tolerateVanished(() => returnArgusJobToPending({
      rootDir,
      jobPath,
      job,
      patch: {
        priorResult: job.result,
        routedForReview: {
          schemaVersion: 1,
          source: 'dependency-bot-autoadjudication',
          decision: 'route-for-review',
          reason: autoadjudication.reason || null,
          inputs: autoadjudication.inputs || null,
          routedAt: autoadjudication.completedAt || job.completedAt || null,
          requeuedFrom: 'legacy-route-for-review-completion',
          requeuedAt: retiredAt,
        },
      },
    }));
    if (reopened) {
      summary.requeued += 1;
      summary.liveHeads += 1;
    }
  }

  const running = new Set(runningJobIds);
  for (const { job, jobPath } of listArgusJobs(rootDir, { bucket: 'inProgress', limit: Number.POSITIVE_INFINITY })) {
    if (running.has(job?.jobId)) continue;
    const claimedMs = Date.parse(String(job?.claimedAt || ''));
    if (Number.isFinite(claimedMs) && nowMs - claimedMs < claimLeaseMs) continue;
    const drain = job?.drain && typeof job.drain === 'object' ? job.drain : {};
    const released = tolerateVanished(() => returnArgusJobToPending({
      rootDir,
      jobPath,
      job,
      patch: { drain: { ...drain, lastError: `stale claim from ${job?.claimedAt || 'unknown'} recovered`, notBefore: null } },
    }));
    if (released) summary.reclaimed += 1;
  }

  logger?.log?.(
    `[argus-drain] backlog retirement: retired=${summary.retired} `
      + `(pr-merged-or-closed=${summary.retiredByReason['pr-merged-or-closed']} `
      + `head-superseded=${summary.retiredByReason['head-superseded']}) `
      + `live_heads=${summary.liveHeads} requeued_routed=${summary.requeued} reclaimed_claims=${summary.reclaimed}`
      + (summary.skippedRepos.length ? ` skipped_repos=${summary.skippedRepos.map((entry) => `${entry.repo}(${entry.reason})`).join(',')}` : ''),
  );
  return summary;
}
