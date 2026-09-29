import { readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getFollowUpJobDir, writeFollowUpJob } from './follow-up-jobs.mjs';
import { DEFAULT_REMEDIATOR_ENV } from './remediation-dispatch-mode.mjs';
import { MAX_QUOTA_HOLD_WINDOW_MS } from './remediation-quota-evidence.mjs';

// A claimed job that never reached the worker runtime must be budget neutral.
// This covers both config errors and a shutdown during workspace preparation.
export function requeueClaimedFollowUpJobBeforeSpawn({
  rootDir, jobPath, requeuedAt = new Date().toISOString(), error = null,
}) {
  const currentJob = JSON.parse(readFileSync(jobPath, 'utf8'));
  const currentPlan = currentJob.remediationPlan || {};
  const currentRound = Number(currentPlan.currentRound || 0);
  const rounds = Array.isArray(currentPlan.rounds) ? [...currentPlan.rounds] : [];
  const lastRound = rounds.at(-1);
  let nextCurrentRound = currentRound;
  if (lastRound && Number(lastRound.round) === currentRound && lastRound.state === 'claimed') {
    rounds.pop();
    nextCurrentRound = Math.max(0, currentRound - 1);
  }
  const nextJob = {
    ...currentJob,
    status: 'pending',
    pendingAt: requeuedAt,
    claimedAt: null,
    claimedBy: null,
    remediationWorker: null,
    failure: null,
    ...(error ? { lastConfigValidationFailure: {
      code: 'config-validation-failure',
      key: error.configKey || DEFAULT_REMEDIATOR_ENV,
      message: error.message,
      recoverable: true,
      recordedAt: requeuedAt,
    } } : {}),
    remediationPlan: { ...currentPlan, currentRound: nextCurrentRound, rounds, nextAction: null },
  };
  writeFollowUpJob(jobPath, nextJob);
  const pendingPath = join(getFollowUpJobDir(rootDir, 'pending'), basename(jobPath));
  renameSync(jobPath, pendingPath);
  return { job: nextJob, jobPath: pendingPath };
}

// REMFALLBACK-01 item 3: the claim resolved the routed remediator as capped and
// no declared fallback class can take the job (or its reset is due inside one
// hold window). Respawning it is a guaranteed failure, so the claim goes back to
// pending budget-neutral, like any pre-spawn requeue, and holds until the cap
// can have cleared. It is recorded as a quota hold on the capped class, so the
// claim gate's live revalidation still releases it on recovery; `noRespawn`
// makes that release wait for a good probe newer than this hold.
export function holdClaimedJobForCappedRemediator({
  rootDir, jobPath, heldAt, routing, delayedPendingPaths = null, log = console,
}) {
  const requeued = requeueClaimedFollowUpJobBeforeSpawn({ rootDir, jobPath, requeuedAt: heldAt });
  const plan = requeued.job.remediationPlan || {};
  const heldRound = Number(plan.currentRound || 0) + 1;
  const passedOver = (routing.skipped || [])
    .map(({ workerClass, reason }) => `${workerClass} ${reason}`)
    .join(', ') || 'none declared';
  const resets = routing.resetAt ? `, resets ${routing.resetAt}` : '';
  const cause = routing.reason === 'primary-resets-within-hold-window'
    ? `${routing.workerClass} resets inside the hold window${resets}`
    : `${routing.workerClass} capped (${routing.capSource}${resets}); fallback: ${passedOver}`;
  const retryReason = `Remediator ${cause}. Holding without respawning until ${routing.holdUntil}; the next claim re-resolves the class.`;
  const job = {
    ...requeued.job,
    remediationPlan: {
      ...plan,
      retryAfter: routing.holdUntil,
      nextAction: {
        type: 'consume-pending-round',
        round: heldRound,
        operatorVisibility: 'explicit',
        requestedAt: heldAt,
        requestedBy: 'system',
        reason: retryReason,
      },
      retryHistory: [
        ...(plan.retryHistory || []),
        {
          round: heldRound,
          transientRetry: Number(plan.transientRetries || 0),
          requeuedAt: heldAt,
          retryAfter: routing.holdUntil,
          retryReason,
          retryMetadata: {
            code: 'quota-exhausted',
            harness: routing.workerClass,
            workerClass: routing.workerClass,
            model: routing.model || null,
            resetAt: routing.resetAt || null,
            providerResetAt: routing.resetAt || null,
            source: 'remediator-fallback-resolution',
            capSource: routing.capSource || null,
            fallbackReason: routing.reason,
            skipped: routing.skipped || [],
            noRespawn: true,
            maxUnvalidatedHoldMs: MAX_QUOTA_HOLD_WINDOW_MS,
          },
          worker: null,
        },
      ],
    },
  };
  writeFollowUpJob(requeued.jobPath, job);
  // Not claimable again in this drain, whatever the revalidator's cache says.
  delayedPendingPaths?.add?.(requeued.jobPath);
  // Deliberately not the `quota-exhausted (<harness>) ... [provider-reported]`
  // shape: no provider was contacted, so the fleet hold counter must not count it.
  log?.log?.(
    `[follow-up-remediation] Held ${job.repo}#${job.prNumber} -> remediator-capped-hold ` +
      `(${cause}) until ${routing.holdUntil}; not respawning the capped remediator`
  );
  return { consumed: false, reason: 'remediator-capped-hold', job, jobPath: requeued.jobPath };
}
