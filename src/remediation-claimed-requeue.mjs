import { readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getFollowUpJobDir, writeFollowUpJob } from './follow-up-jobs.mjs';
import { DEFAULT_REMEDIATOR_ENV } from './remediation-dispatch-mode.mjs';

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
