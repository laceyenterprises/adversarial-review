import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ROUND_BUDGET_BY_RISK_CLASS,
  getFollowUpJobDir,
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
    const dir = getFollowUpJobDir(rootDir, key);
    if (!existsSync(dir)) continue;

    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
      const jobPath = join(dir, name);
      let job;
      try {
        job = readFollowUpJob(jobPath);
      } catch (err) {
        console.error(
          `[operator-retrigger] Skipping unreadable follow-up job while scanning ${key} for ` +
            `${repo}#${prNumber}: ${jobPath} (${err?.message || err})`
        );
        continue;
      }
      if (job.repo !== repo || Number(job.prNumber) !== Number(prNumber)) {
        continue;
      }
      if (!latest || latestJobTimestamp(job) > latestJobTimestamp(latest.job)) {
        latest = { job, jobPath };
      }
    }
  }
  return latest;
}

function normalizeRiskClass(riskClass) {
  const normalized = String(riskClass ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROUND_BUDGET_BY_RISK_CLASS, normalized)
    ? normalized
    : 'medium';
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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
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

  if (!isPositiveInteger(bumpBudget)) {
    return { bumped: false, reason: 'invalid-bump-by', jobPath, job: currentJob };
  }
  if (!isNonEmptyString(auditEntry?.reason)) {
    return { bumped: false, reason: 'invalid-reason', jobPath, job: currentJob };
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

  if (currentJob.status === 'pending' || currentJob.status === 'inProgress') {
    return { bumped: false, reason: 'job-active', jobPath, job: currentJob };
  }

  const fallbackRiskClass = normalizeRiskClass(currentJob?.riskClass);
  const defaultMaxRounds = ROUND_BUDGET_BY_RISK_CLASS[fallbackRiskClass] || ROUND_BUDGET_BY_RISK_CLASS.medium;
  const priorMaxRounds = Number(currentJob?.remediationPlan?.maxRounds ?? defaultMaxRounds);
  const newMaxRounds = priorMaxRounds + Number(bumpBudget);
  if (!isPositiveInteger(newMaxRounds)) {
    throw new Error(`Invalid remediation budget result: ${newMaxRounds}`);
  }
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
