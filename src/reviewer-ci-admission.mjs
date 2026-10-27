import { createFollowUpJob, requeueFollowUpJobForNextRound, resolveRoundBudgetForJob, summarizePRRemediationLedger } from './follow-up-jobs.mjs';
import { addCiRegressionFinding } from './ci-regression-finding.mjs';
import { observeClosureWait } from './ama/closure-wait.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import { inspectRemediationCiRegression } from './remediation-ci-regression.mjs';
import { formatCiCheckList } from './ci-check-format.mjs';
import { REREVIEW_CI_BLOCKED_STATUS } from './review-statuses.mjs';
import { isCompletedFinalRemediationJob, scanArchivedStoppedFollowUpJobs } from './comment-only-final-round.mjs';
import { RECOVERY_SOURCE_PATH } from './comment-only-recovery-record.mjs';
import { recoverCancelledChecks, recoverInfrastructureChecks } from './ci-recovery.mjs';

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
  'ci-regression-hammer-owned': 'the completed final remediation round handed ownership to the hammer',
  // The requeue re-stops a job at its round cap (or a no-progress round).
  'ci-regression-stopped': 'no remediation round is left to requeue',
});

// Durable park messages accepted by closer rescue after the dispatch flag is lost.
export const CI_BLOCKED_HAMMER_RESCUE_PREFIXES = Object.freeze(
  ['ci-regression-stopped', 'ci-regression-hammer-owned'].map(reason => `[${reason}]`),
);

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
  createJobImpl = createFollowUpJob,
  summarizeLedgerImpl = summarizePRRemediationLedger,
  readOperatorLabelImpl,
  readPRHeadImpl,
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

  if (state === 'infrastructure') {
    try {
      await recoverInfrastructureChecks({ rootDir, repo, prNumber, headSha: ciGate.headSha,
        failedChecks: ciGate.failedChecks, pendingChecks: ciGate.pendingChecks, execFileImpl, env, deliverAlertImpl });
    } catch (error) { log.warn?.(`[watcher] Infrastructure CI recovery unavailable: ${error.message}`); }
    return { proceed: false, reason: 'ci-infrastructure', ciGate };
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
    const reason = buildRereviewCiRegressionReason({ repo, prNumber, ciGate });
    const blockOwnerless = async (result, detail) => {
      const stop = result.job?.remediationPlan?.stop?.code || result.job?.status || 'no-job';
      const plan = result.job?.remediationPlan;
      const budget = Number(plan?.maxRounds) > 0 && Number(plan?.currentRound) >= Number(plan.maxRounds)
        ? `; round-budget-exhausted (${plan.currentRound}/${plan.maxRounds})` : '';
      const blocker = `ci-regression-ownerless: ${stop}${budget}: ${detail}`;
      log.warn?.(JSON.stringify({ event: 'ama.closure_blocker', repo, pr: prNumber,
        headSha: ciGate.headSha, reason: blocker }));
      let page;
      try {
        page = await observeClosureWait({ rootDir, repo, prNumber, headSha: ciGate.headSha || reviewerHeadSha,
          reason: `${blocker}. Failed external CI: ${formatCiCheckList(ciGate.failedChecks)}. Remediation cannot own this unreviewed head; operator action is required.`,
          immediate: true, waitClass: 'ci-regression-ownerless',
          ...(deliverAlertImpl ? { pageImpl: deliverAlertImpl } : {}) });
      } catch (error) {
        log.warn?.(`[watcher] CI-regression closure blocker page failed: ${error.message}`);
        page = { error: error.message };
      }
      return { ...result, closureBlocker: blocker, needsOperator: true, page,
        // Keep admission retryable when transport failed, including cap stops.
        ...(page?.error ? { parkReview: false, hammerOwner: false } : {}) };
    };
    const createCurrentHeadJob = async () => {
      try {
        const ledger = summarizeLedgerImpl(rootDir, { repo, prNumber });
        if (!Number.isSafeInteger(ledger.completedRoundsForPR) || ledger.completedRoundsForPR < 0) {
          throw new Error('PR-wide remediation round accounting is unavailable');
        }
        const { roundBudget, riskClass } = resolveRoundBudgetForJob({ riskClass: ledger.latestRiskClass,
          remediationPlan: { maxRounds: ledger.latestMaxRounds } }, { rootDir });
        if (ledger.completedRoundsForPR >= roundBudget) {
          return blockOwnerless(ciBlockedHammerOwnerResult({ repo, prNumber, ciGate, reason: 'ci-regression-no-job' }),
            `round-budget-exhausted (${ledger.completedRoundsForPR}/${roundBudget})`);
        }
        if (!ciGate.headSha) throw new Error('current CI head is unavailable');
        const created = createJobImpl({ rootDir, repo, prNumber, revisionRef: ciGate.headSha,
          reviewPostedAt: now(), reviewerModel: 'codex', readPRHeadImpl,
          reviewBody: addCiRegressionFinding('## Verdict\nRequest changes\n', reason),
          priorCompletedRounds: ledger.completedRoundsForPR, maxRemediationRounds: roundBudget, riskClass });
        if (created?.job?.status === 'pending') return { proceed: false, reason: 'ci-regression-created', ciGate, ...created };
        // A concurrent admission may already have queued the exact same work.
        if (created?.duplicateOf && ['pending', 'in_progress'].includes(created.duplicateOf.status)) {
          return { proceed: false, reason: 'ci-regression-remediation-active', ciGate, ...created };
        }
        throw new Error('fresh current-head remediation was not queued');
      } catch (error) {
        return blockOwnerless({ proceed: false, reason: 'ci-regression-requeue-failed', ciGate }, error.message);
      }
    };
    let latest;
    try {
      latest = latestJobFinder(rootDir, { repo, prNumber });
      if (!latest) {
        // Archival retains a stop's authority; it cannot mint a fresh job that
        // forgets the required label, prior findings or spent rounds.
        const archived = scanArchivedStoppedFollowUpJobs(rootDir, repo, prNumber, log)
          .sort((a, b) => String(a.stoppedAt || a.createdAt || '').localeCompare(String(b.stoppedAt || b.createdAt || ''))).at(-1);
        if (archived) latest = { job: archived, jobPath: archived[RECOVERY_SOURCE_PATH] };
      }
    } catch (error) {
      return blockOwnerless({ proceed: false, reason: 'ci-regression-requeue-failed', ciGate },
        `follow-up state is unreadable: ${error.message}`);
    }
    if (!latest?.jobPath) {
      log.warn?.(
        `[watcher] Refusing re-review for ${repo}#${prNumber}: failed external CI ` +
          `(${formatCiCheckList(ciGate.failedChecks)}) but no follow-up job exists to requeue.`
      );
      return createCurrentHeadJob();
    }

    // Preserve the completed round's start/result edge for the hammer's proof.
    if (isCompletedFinalRemediationJob(latest.job)) {
      return ciBlockedHammerOwnerResult({
        repo, prNumber, ciGate, reason: 'ci-regression-hammer-owned',
        jobPath: latest.jobPath, job: latest.job,
      });
    }

    // Automatic CI admission must not reopen a no-progress hand-off. Explicit
    // operator retriggers retain their separate stopped-job allowlist.
    if (latest.job?.status === 'stopped' && latest.job?.remediationPlan?.stop?.code === 'no-progress') {
      return blockOwnerless(ciBlockedHammerOwnerResult({
        repo, prNumber, ciGate, reason: 'ci-regression-stopped',
        jobPath: latest.jobPath, job: latest.job,
      }), 'automatic requeue cannot reopen a no-progress handoff');
    }

    try {
      const requeued = requeueImpl({
        rootDir,
        jobPath: latest.jobPath,
        requestedAt: now(),
        requestedBy: 'watcher-ci-admission',
        reason,
        revisionRef: reviewerHeadSha || ciGate.headSha || null,
        stopMetadata: { ciRegression: true },
        ciRegressionFinding: reason,
        readOperatorLabelImpl,
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
        return blockOwnerless(ciBlockedHammerOwnerResult({ repo, prNumber, ciGate, reason: 'ci-regression-stopped', ...jobFields }), 'requeue stopped without a remediation owner');
      }
      // Already active work owns remediation; do not page it as ownerless.
      if (['in_progress', 'inProgress', 'pending'].includes(latest.job?.status)) {
        return { proceed: false, reason: 'ci-regression-remediation-active', ciGate, ...jobFields };
      }
      return blockOwnerless({ proceed: false, reason: 'ci-regression-not-requeued', ciGate, ...jobFields }, 'requeue produced no active remediation job');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        log.warn?.(
          `[watcher] Refusing re-review for ${repo}#${prNumber}: failed external CI ` +
            `(${formatCiCheckList(ciGate.failedChecks)}) but the stopped follow-up job no longer exists. ` +
            'Nothing remains to requeue.'
        );
        // Preserve the observed stop/budget contract when a record disappears
        // after discovery; absence is not permission to start a fresh budget.
        return blockOwnerless({ proceed: false, reason: 'ci-regression-requeue-failed', ciGate,
          jobPath: latest.jobPath, job: latest.job }, 'follow-up record disappeared during requeue');
      }
      log.warn?.(
        `[watcher] Refusing re-review for ${repo}#${prNumber}: failed external CI ` +
          `(${formatCiCheckList(ciGate.failedChecks)}) and requeue failed: ${err?.message || err}`
      );
      if (['in_progress', 'inProgress', 'pending'].includes(latest.job?.status)) {
        return { proceed: false, reason: 'ci-regression-remediation-active', ciGate, jobPath: latest.jobPath, job: latest.job };
      }
      return blockOwnerless({
        proceed: false,
        reason: 'ci-regression-requeue-failed',
        ciGate,
        jobPath: latest.jobPath,
        job: latest.job,
        error: err?.message || String(err),
      }, err?.message || String(err));
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
