import { requeueFollowUpJobForNextRound } from './follow-up-jobs.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import { inspectRemediationCiRegression } from './remediation-ci-regression.mjs';
import { formatCiCheckList } from './ci-check-format.mjs';
import { REREVIEW_CI_BLOCKED_STATUS } from './review-statuses.mjs';

const DEFAULT_CI_BLOCKED_REREVIEW_RECHECK_MS = 5 * 60 * 1000;
const CI_BLOCKED_REREVIEW_RECHECK_ENV = 'ADVERSARIAL_REREVIEW_CI_BLOCKED_RECHECK_MS';

function buildRereviewCiRegressionReason({ repo, prNumber, ciGate }) {
  return `Remediation for ${repo}#${prNumber} introduced or left failed CI on the current PR head before re-review: ${formatCiCheckList(ciGate?.failedChecks)}. Requeueing so the next remediation worker fixes CI before re-review.`;
}

function buildRereviewCiBlockedFailureMessage({ repo, prNumber, ciGate }) {
  return `[ci-regression-no-job] Re-review for ${repo}#${prNumber} is parked because the current PR head has failed external CI and no follow-up job exists to requeue: ${formatCiCheckList(ciGate?.failedChecks)}. Push a fix or requeue remediation; the watcher will re-arm once the head changes or CI turns green.`;
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
    const latest = latestJobFinder(rootDir, { repo, prNumber });
    if (!latest?.jobPath) {
      log.warn?.(
        `[watcher] Refusing re-review for ${repo}#${prNumber}: failed external CI ` +
          `(${formatCiCheckList(ciGate.failedChecks)}) but no follow-up job exists to requeue.`
      );
      return {
        proceed: false,
        reason: 'ci-regression-no-job',
        ciGate,
        parkReview: true,
        parkReviewStatus: REREVIEW_CI_BLOCKED_STATUS,
        failureMessage: buildRereviewCiBlockedFailureMessage({ repo, prNumber, ciGate }),
      };
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
      return {
        proceed: false,
        reason: nextStatus === 'stopped'
          ? 'ci-regression-stopped'
          : 'ci-regression-not-requeued',
        ciGate,
        jobPath: requeued?.jobPath || latest.jobPath,
        job: requeued?.job || latest.job || null,
      };
    } catch (err) {
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
