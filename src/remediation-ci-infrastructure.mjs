import { join } from 'node:path';
import { withFollowUpJobLock } from './follow-up-job-write.mjs';
import { readFollowUpJob, writeFollowUpJob, requeueInProgressFollowUpJobForRetry,
  listFollowUpJobsInDir, releaseInfrastructureCiStop } from './follow-up-jobs.mjs';
import { infrastructureOnlyFailures, recordedCiFailures, CI_INFRASTRUCTURE_STOP_REASONS, enrichCiInfrastructureEvidence, checksExecutedAgain, hasMissingActionsEvidence } from './ci-infrastructure.mjs';

export const CI_INFRASTRUCTURE_RECHECK_MS = 5 * 60_000;

// Keep the worker's artifacts and the same round while waiting. Each poll is
// bounded; after one hour the visible wait is parked, with cheap later probes.
export function holdRemediationForCiInfrastructure({ rootDir, jobPath, ciGate, now }) {
  return withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
    const job = readFollowUpJob(jobPath);
    if (job.status !== 'in_progress' || ciGate?.state !== 'infrastructure'
      || !(infrastructureOnlyFailures(ciGate.failedChecks) || ciGate.infrastructureEvidencePending)) return null;
    if (!ciGate.headSha) return null;
    const firstObservedAt = job.ciInfrastructureWait?.firstObservedAt || now;
    job.ciInfrastructureWait = { reason: 'ci-infrastructure', headSha: ciGate.headSha,
      firstObservedAt, deadline: new Date(Date.parse(firstObservedAt) + 60 * 60_000).toISOString(),
      nextProbeAt: new Date(Date.parse(now) + CI_INFRASTRUCTURE_RECHECK_MS).toISOString(),
      parked: Date.parse(now) - Date.parse(firstObservedAt) >= 60 * 60_000,
      evidencePending: !infrastructureOnlyFailures(ciGate.failedChecks), failedChecks: ciGate.failedChecks };
    writeFollowUpJob(jobPath, job);
    return { action: 'active', reason: 'ci-infrastructure', job, jobPath };
  });
}

export async function resumeCiInfrastructureRound({ rootDir, jobPath, ciGate, now, execFileImpl }) {
  const observed = readFollowUpJob(jobPath);
  const oldFailures = observed.ciInfrastructureWait?.failedChecks || [];
  const evidence = await enrichCiInfrastructureEvidence({ rollup: oldFailures, repo: observed.repo,
    headSha: observed.ciInfrastructureWait?.headSha, execFileImpl });
  return withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
    const job = readFollowUpJob(jobPath);
    const wait = job.ciInfrastructureWait;
    if (JSON.stringify(wait?.failedChecks) !== JSON.stringify(oldFailures)) return null;
    if (job.status !== 'in_progress' || !wait || ciGate.headSha !== wait.headSha
      || !(ciGate.state === 'green' && checksExecutedAgain(ciGate.rollup, wait.failedChecks)
        || ciGate.state === 'failed' && ciGate.failedChecks.some(check =>
          Array.isArray(check.steps) && check.steps.some(step =>
            String(step.conclusion || '').toLowerCase() !== 'skipped'
            && (step.started_at || step.startedAt || step.conclusion))))) return null;
    if (!infrastructureOnlyFailures(evidence)) {
      if (hasMissingActionsEvidence(evidence, job.repo)) return null;
      delete job.ciInfrastructureWait;
      writeFollowUpJob(jobPath, job);
      return { action: 'continue', job, jobPath };
    }
    const result = requeueInProgressFollowUpJobForRetry({ rootDir, jobPath, requeuedAt: now,
      retryAfterOverride: now, retryReason: 'CI executed again; infrastructure-only round refunded.',
      allowDirectWorkerRetry: true, chargeRetryBudget: false,
      retryMetadata: { code: 'ci-infrastructure-refund', reason: 'checks-executed-again',
        headSha: wait.headSha, failedChecks: evidence } });
    result.job.revisionRef = wait.headSha;
    delete result.job.ciInfrastructureWait;
    writeFollowUpJob(result.jobPath, result.job);
    return { action: 'requeued', reason: 'ci-infrastructure-refund', ...result };
  });
}

export function deferCiInfrastructureProbe({ rootDir, jobPath, now }) {
  return withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
    const job = readFollowUpJob(jobPath);
    if (job.status !== 'in_progress' || !job.ciInfrastructureWait) return;
    job.ciInfrastructureWait.nextProbeAt = new Date(Date.parse(now) + CI_INFRASTRUCTURE_RECHECK_MS).toISOString();
    job.ciInfrastructureWait.parked = Date.parse(now) >= Date.parse(job.ciInfrastructureWait.deadline);
    writeFollowUpJob(jobPath, job);
  });
}

// Called with fresh current-head evidence before reading budgets. Historical
// failures may use the same single bounded evidence read; narrative is not proof.
export async function recoverInfrastructureCiStops({ rootDir, repo, prNumber, headSha, ciGate, now, execFileImpl }) {
  if (!headSha || ciGate?.headSha !== headSha || ciGate.state !== 'green') return [];
  const recovered = [];
  for (const key of ['stopped', 'failed']) {
    for (const { job, jobPath } of listFollowUpJobsInDir(rootDir, key, { repo, prNumber }).slice(0, 20)) {
      const code = job.remediationPlan?.stop?.code || job.failure?.code;
      const head = job.failure?.ciGate?.headSha || job.failure?.ciRegression?.headSha || job.ciGate?.headSha
        || job.completion?.workerPushedHeadSha || job.revisionRef;
      if (head !== headSha || ![...CI_INFRASTRUCTURE_STOP_REASONS, 'max-rounds-reached'].includes(code)
        || (job.failure?.code && !CI_INFRASTRUCTURE_STOP_REASONS.has(job.failure.code))) continue;
      const recordedFailures = recordedCiFailures(job);
      const failedChecks = await enrichCiInfrastructureEvidence({ rollup: recordedFailures, repo, headSha, execFileImpl });
      if (!infrastructureOnlyFailures(failedChecks) || !checksExecutedAgain(ciGate.rollup, failedChecks)) continue;
      const result = releaseInfrastructureCiStop({ rootDir, jobPath, headSha, now,
        recordedFailures, failedChecks });
      if (result) recovered.push(result);
    }
  }
  return recovered;
}
