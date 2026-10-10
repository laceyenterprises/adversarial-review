import { requeueFollowUpJobForNextRound } from './follow-up-jobs.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import { inspectRemediationCiRegression } from './remediation-ci-regression.mjs';
import { formatCiCheckList } from './ci-check-format.mjs';
import { REREVIEW_CI_BLOCKED_STATUS } from './review-statuses.mjs';
import { recoverCancelledChecks } from './ci-recovery.mjs';

const DEFAULT_CI_BLOCKED_REREVIEW_RECHECK_MS = 5 * 60 * 1000;
const CI_BLOCKED_REREVIEW_RECHECK_ENV = 'ADVERSARIAL_REREVIEW_CI_BLOCKED_RECHECK_MS';

function buildRereviewCiRegressionReason({ repo, prNumber, ciGate }) {
  return `Remediation for ${repo}#${prNumber} introduced or left failed CI on the current PR head before re-review: ${formatCiCheckList(ciGate?.failedChecks)}. Requeueing so the next remediation worker fixes CI before re-review.`;
}

// CIBLOCKHAM-01: a red head with no remediation job left has exactly one owner,
// the hammer. The reviewer stays parked (reviewer admission requires green
// external CI); the watcher routes the PR to the hammer for final adjudication.
const CI_BLOCKED_PARK_CAUSES = Object.freeze({
  'ci-regression-no-job': 'no follow-up job exists to requeue',
  // The requeue re-stops a job at its round cap (or a no-progress round).
  'ci-regression-stopped': 'no remediation round is left to requeue',
});

function buildRereviewCiBlockedFailureMessage({ repo, prNumber, ciGate, reason = 'ci-regression-no-job' }) {
  const cause = CI_BLOCKED_PARK_CAUSES[reason] || CI_BLOCKED_PARK_CAUSES['ci-regression-no-job'];
  return `[${reason}] Re-review for ${repo}#${prNumber} is parked because the current PR head has failed external CI and ${cause}: ${formatCiCheckList(ciGate?.failedChecks)}. Routed to the hammer for final adjudication; reviewer admission still requires green external CI, and the watcher will re-arm once the head changes or CI turns green.`;
}

function ciBlockedHammerOwnerResult({ repo, prNumber, ciGate, reason, ...rest }) {
  return {
    proceed: false,
    reason,
    ciGate,
    ...rest,
    parkReview: true,
    parkReviewStatus: REREVIEW_CI_BLOCKED_STATUS,
    hammerOwner: true,
    failureMessage: buildRereviewCiBlockedFailureMessage({ repo, prNumber, ciGate, reason }),
  };
}

function normalizeCiAdmissionState(state) {
  const normalized = String(state || '').trim().toLowerCase();
  return normalized || 'unknown';
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveCiBlockedRereviewRecheckMs(env = process.env) {
  const raw = env?.[CI_BLOCKED_REREVIEW_RECHECK_ENV];
  const parsed = Number.parseInt(String(raw || ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_CI_BLOCKED_REREVIEW_RECHECK_MS;
}

function shouldRecheckCiBlockedRereview(reviewRow, {
  nowMs = Date.now(),
  env = process.env,
} = {}) {
  const recheckMs = resolveCiBlockedRereviewRecheckMs(env);
  const lastCheckedMs = timestampMs(reviewRow?.last_attempted_at || reviewRow?.failed_at);
  if (lastCheckedMs === null) {
    return {
      shouldRecheck: true,
      reason: 'ci-blocked-recheck-never-observed',
      recheckMs,
      elapsedMs: null,
      nextCheckAt: null,
    };
  }
  const elapsedMs = Math.max(0, Number(nowMs) - lastCheckedMs);
  if (elapsedMs >= recheckMs) {
    return {
      shouldRecheck: true,
      reason: 'ci-blocked-recheck-backoff-expired',
      recheckMs,
      elapsedMs,
      nextCheckAt: null,
    };
  }
  return {
    shouldRecheck: false,
    reason: 'ci-blocked-recheck-backoff-active',
    recheckMs,
    elapsedMs,
    nextCheckAt: new Date(lastCheckedMs + recheckMs).toISOString(),
  };
}

function ciGateHeadMoved({ ciGate, reviewerHeadSha }) {
  const gateHead = String(ciGate?.headSha || '').trim();
  const claimedHead = String(reviewerHeadSha || '').trim();
  return Boolean(gateHead && claimedHead && gateHead !== claimedHead);
}

async function guardRereviewCiBeforeReviewer({
  rootDir,
  repo,
  prNumber,
  passKind,
  reviewerHeadSha = null,
  execFileImpl,
  env = process.env,
  deliverAlertImpl,
  log = console,
  cfg = null,
  inspectCiImpl = inspectRemediationCiRegression,
  latestJobFinder = findLatestFollowUpJob,
  requeueImpl = requeueFollowUpJobForNextRound,
  now = () => new Date().toISOString(),
} = {}) {
  if (passKind !== 'rereview') {
    return { proceed: true, reason: 'not-rereview' };
  }

  const ciGate = await inspectCiImpl({
    repo,
    prNumber,
    execFileImpl,
    env,
    log,
    cfg,
  });
  const state = normalizeCiAdmissionState(ciGate?.state);

  if (ciGateHeadMoved({ ciGate, reviewerHeadSha })) {
    log.warn?.(
      `[watcher] Refusing re-review for ${repo}#${prNumber}: CI head ` +
        `${String(ciGate.headSha).slice(0, 12)} no longer matches claimed reviewer head ` +
        `${String(reviewerHeadSha).slice(0, 12)}.`
    );
    return { proceed: false, reason: 'ci-head-moved', ciGate };
  }

  if (state === 'green') {
    return { proceed: true, reason: 'ci-green', ciGate };
  }

  if (state === 'failed') {
    try {
      if (await recoverCancelledChecks({ rootDir, repo, prNumber, headSha: ciGate.headSha,
        failedChecks: ciGate.failedChecks, pendingChecks: ciGate.pendingChecks, execFileImpl, env, deliverAlertImpl })) {
        return { proceed: false, reason: 'ci-settlement-pending',
          ciGate: { ...ciGate, state: 'pending', conclusion: 'PENDING' } };
      }
    } catch (error) {
      log.warn?.(`[watcher] CI recovery unavailable for ${repo}#${prNumber}: ${error.message}`);
    }
    const latest = latestJobFinder(rootDir, { repo, prNumber });
    if (!latest?.jobPath) {
      log.warn?.(
        `[watcher] Refusing re-review for ${repo}#${prNumber}: failed external CI ` +
          `(${formatCiCheckList(ciGate.failedChecks)}) but no follow-up job exists to requeue.`
      );
      return ciBlockedHammerOwnerResult({ repo, prNumber, ciGate, reason: 'ci-regression-no-job' });
    }

    const reason = buildRereviewCiRegressionReason({ repo, prNumber, ciGate });
    try {
      const requeued = requeueImpl({
        rootDir,
        jobPath: latest.jobPath,
        requestedAt: now(),
        requestedBy: 'watcher-ci-admission',
        reason,
        revisionRef: reviewerHeadSha || ciGate.headSha || null,
        stopMetadata: { ciRegression: true },
      });
      const nextStatus = requeued?.job?.status || null;
      if (nextStatus === 'pending') {
        log.warn?.(
          `[watcher] Requeued remediation instead of spawning re-review for ${repo}#${prNumber}: ` +
            formatCiCheckList(ciGate.failedChecks)
        );
        return {
          proceed: false,
          reason: 'ci-regression-requeued',
          ciGate,
          jobPath: requeued.jobPath,
          job: requeued.job,
        };
      }
      log.warn?.(
        `[watcher] Refusing re-review for ${repo}#${prNumber}: failed external CI ` +
          `(${formatCiCheckList(ciGate.failedChecks)}) requeue produced status=${nextStatus || 'unknown'}.`
      );
      const jobFields = {
        jobPath: requeued?.jobPath || latest.jobPath,
        job: requeued?.job || latest.job || null,
      };
      if (nextStatus === 'stopped') {
        return ciBlockedHammerOwnerResult({ repo, prNumber, ciGate, reason: 'ci-regression-stopped', ...jobFields });
      }
      return { proceed: false, reason: 'ci-regression-not-requeued', ciGate, ...jobFields };
    } catch (err) {
      if (err?.code === 'ENOENT') {
        log.warn?.(
          `[watcher] Refusing re-review for ${repo}#${prNumber}: failed external CI ` +
            `(${formatCiCheckList(ciGate.failedChecks)}) but the stopped follow-up job no longer exists. ` +
            'Nothing remains to requeue.'
        );
        return ciBlockedHammerOwnerResult({ repo, prNumber, ciGate, reason: 'ci-regression-no-job' });
      }
      log.warn?.(
        `[watcher] Refusing re-review for ${repo}#${prNumber}: failed external CI ` +
          `(${formatCiCheckList(ciGate.failedChecks)}) and requeue failed: ${err?.message || err}`
      );
      return {
        proceed: false,
        reason: 'ci-regression-requeue-failed',
        ciGate,
        jobPath: latest.jobPath,
        job: latest.job,
        error: err?.message || String(err),
      };
    }
  }

  const reason = state === 'pending' ? 'ci-settlement-pending' : 'ci-settlement-unknown';
  log.log?.(
    `[watcher] Deferring re-review for ${repo}#${prNumber}: external CI state=${state} ` +
      `pending=${formatCiCheckList(ciGate?.pendingChecks)} ` +
      `error=${ciGate?.error || 'none'}`
  );
  return { proceed: false, reason, ciGate };
}

export {
  buildRereviewCiBlockedFailureMessage,
  buildRereviewCiRegressionReason,
  DEFAULT_CI_BLOCKED_REREVIEW_RECHECK_MS,
  guardRereviewCiBeforeReviewer,
  shouldRecheckCiBlockedRereview,
};
