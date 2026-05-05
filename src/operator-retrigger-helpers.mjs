import {
  ROUND_BUDGET_BY_RISK_CLASS,
  listFollowUpJobsInDir,
  readFollowUpJob,
  writeFollowUpJob,
} from './follow-up-jobs.mjs';

const FOLLOW_UP_STATUS_KEYS = ['pending', 'inProgress', 'completed', 'failed', 'stopped'];

function latestJobTimestamp(job) {
  return job?.completedAt
    || job?.failedAt
    || job?.stoppedAt
    || job?.claimedAt
    || job?.createdAt
    || '';
}

function appendOperatorRetriggerAudit(job, auditEntry) {
  const entries = Array.isArray(job?.operatorRetriggerAudit)
    ? job.operatorRetriggerAudit
    : [];

  return {
    ...job,
    operatorRetriggerAudit: [...entries, auditEntry],
  };
}

function findOperatorAuditEntry(job, idempotencyKey) {
  const entries = Array.isArray(job?.operatorRetriggerAudit)
    ? job.operatorRetriggerAudit
    : [];
  return entries.find((entry) => entry?.idempotencyKey === idempotencyKey) || null;
}

function findLatestFollowUpJob(rootDir, { repo, prNumber }) {
  let latest = null;
  for (const key of FOLLOW_UP_STATUS_KEYS) {
    for (const entry of listFollowUpJobsInDir(rootDir, key)) {
      if (entry.job.repo !== repo || Number(entry.job.prNumber) !== Number(prNumber)) {
        continue;
      }
      if (!latest || latestJobTimestamp(entry.job) > latestJobTimestamp(latest.job)) {
        latest = entry;
      }
    }
  }
  return latest;
}

function buildJobScopedIdempotentResult(existingEntry, jobPath) {
  return {
    bumped: true,
    idempotent: true,
    reason: 'idempotent',
    jobPath,
    job: readFollowUpJob(jobPath),
    auditRow: existingEntry.auditRow,
    priorMaxRounds: existingEntry.priorMaxRounds,
    newMaxRounds: existingEntry.newMaxRounds,
  };
}

function bumpRemediationBudget({
  rootDir,
  repo,
  prNumber,
  bumpBudget = 1,
  auditEntry,
}) {
  const latest = findLatestFollowUpJob(rootDir, { repo, prNumber });
  if (!latest) {
    return { bumped: false, reason: 'no-job' };
  }

  const { jobPath } = latest;
  const currentJob = readFollowUpJob(jobPath);

  if (currentJob.status === 'pending' || currentJob.status === 'inProgress') {
    return { bumped: false, reason: 'job-active', jobPath, job: currentJob };
  }

  const existingEntry = findOperatorAuditEntry(currentJob, auditEntry.idempotencyKey);
  if (existingEntry) {
    if (existingEntry.requestFingerprint !== auditEntry.requestFingerprint) {
      const err = new Error('IDEMPOTENCY_KEY_MISMATCH');
      err.code = 'IDEMPOTENCY_KEY_MISMATCH';
      throw err;
    }
    return buildJobScopedIdempotentResult(existingEntry, jobPath);
  }

  const fallbackRiskClass = currentJob?.riskClass || 'medium';
  const defaultMaxRounds = ROUND_BUDGET_BY_RISK_CLASS[fallbackRiskClass] || ROUND_BUDGET_BY_RISK_CLASS.medium;
  const priorMaxRounds = Number(currentJob?.remediationPlan?.maxRounds ?? defaultMaxRounds);
  const newMaxRounds = priorMaxRounds + Number(bumpBudget);
  const nextAuditEntry = {
    ...auditEntry,
    priorMaxRounds,
    newMaxRounds,
  };
  const nextJob = appendOperatorRetriggerAudit({
    ...currentJob,
    remediationPlan: {
      ...currentJob.remediationPlan,
      maxRounds: newMaxRounds,
    },
    recommendedFollowUpAction: currentJob.recommendedFollowUpAction
      ? {
          ...currentJob.recommendedFollowUpAction,
          maxRounds: newMaxRounds,
        }
      : currentJob.recommendedFollowUpAction,
  }, nextAuditEntry);

  writeFollowUpJob(jobPath, nextJob);
  return {
    bumped: true,
    idempotent: false,
    reason: 'bumped',
    jobPath,
    job: nextJob,
    auditRow: auditEntry.auditRow,
    priorMaxRounds,
    newMaxRounds,
  };
}

export {
  appendOperatorRetriggerAudit,
  bumpRemediationBudget,
  findLatestFollowUpJob,
};
