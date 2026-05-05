import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { writeFileAtomic, writeFileAtomicExclusive } from './atomic-write.mjs';
import {
  FOLLOW_UP_JOB_DIRS,
  ROUND_BUDGET_BY_RISK_CLASS,
  getFollowUpJobDir,
  readFollowUpJob,
  writeFollowUpJob,
} from './follow-up-jobs.mjs';

const DEFAULT_RISK_CLASS = 'medium';
const DEFAULT_FILE_MODE = 0o640;

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function defaultIdempotencyKey({ verb, repo, pr, reason }) {
  return sha256(`${verb}:${repo}:${pr}:${reason}`);
}

function requestFingerprint({ verb, repo, pr, reason, bumpBudget, bumpBudgetEnabled }) {
  return sha256(JSON.stringify({
    verb,
    repo,
    pr,
    reason,
    bumpBudget,
    bumpBudgetEnabled,
  }));
}

function operatorMutationsDir(auditRootDir) {
  return resolve(auditRootDir, 'data', 'operator-mutations');
}

function monthStamp(ts = new Date().toISOString()) {
  return String(ts).slice(0, 7);
}

function sanitizeKey(value) {
  return encodeURIComponent(String(value)).replace(/%/g, '_');
}

function auditLogPath(auditRootDir, ts, idempotencyKey) {
  return join(
    operatorMutationsDir(auditRootDir),
    'audit',
    monthStamp(ts),
    `${sanitizeKey(idempotencyKey)}.json`
  );
}

function idempotencyRecordPath(auditRootDir, idempotencyKey) {
  return join(
    operatorMutationsDir(auditRootDir),
    'idempotency',
    `${sanitizeKey(idempotencyKey)}.json`
  );
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readIdempotencyRecord(auditRootDir, idempotencyKey) {
  return readJsonFile(idempotencyRecordPath(auditRootDir, idempotencyKey));
}

function writeJsonFile(filePath, payload, { exclusive = false } = {}) {
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  if (exclusive) {
    writeFileAtomicExclusive(filePath, content, { mode: DEFAULT_FILE_MODE });
    return;
  }
  writeFileAtomic(filePath, content, { mode: DEFAULT_FILE_MODE });
}

function beginIdempotentMutation(auditRootDir, {
  ts,
  idempotencyKey,
  requestFingerprint: fingerprint,
  forceReplay = false,
}) {
  const recordPath = idempotencyRecordPath(auditRootDir, idempotencyKey);
  const nextRecord = {
    idempotencyKey,
    requestFingerprint: fingerprint,
    status: 'in-flight',
    startedAt: ts,
    updatedAt: ts,
    auditRow: null,
  };

  try {
    writeJsonFile(recordPath, nextRecord, { exclusive: true });
    return { state: 'started', recordPath };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  const existing = readIdempotencyRecord(auditRootDir, idempotencyKey);
  if (!existing) {
    throw new Error(`Idempotency record exists but is unreadable for key ${idempotencyKey}`);
  }
  if (existing.requestFingerprint !== fingerprint) {
    const err = new Error('IDEMPOTENCY_KEY_MISMATCH');
    err.code = 'IDEMPOTENCY_KEY_MISMATCH';
    throw err;
  }
  if (existing.status === 'committed') {
    return {
      state: 'replay',
      recordPath,
      auditRow: existing.auditRow || null,
    };
  }
  if (!forceReplay) {
    const err = new Error('IDEMPOTENCY_KEY_IN_FLIGHT');
    err.code = 'IDEMPOTENCY_KEY_IN_FLIGHT';
    throw err;
  }

  writeJsonFile(recordPath, {
    ...existing,
    status: 'in-flight',
    updatedAt: ts,
  });
  return { state: 'started', recordPath, forceReplay: true };
}

function recordIdempotentMutation(auditRootDir, {
  ts,
  idempotencyKey,
  requestFingerprint: fingerprint,
  auditRow,
}) {
  const recordPath = idempotencyRecordPath(auditRootDir, idempotencyKey);
  const existing = readIdempotencyRecord(auditRootDir, idempotencyKey);
  if (existing && existing.requestFingerprint !== fingerprint) {
    const err = new Error('IDEMPOTENCY_KEY_MISMATCH');
    err.code = 'IDEMPOTENCY_KEY_MISMATCH';
    throw err;
  }
  writeJsonFile(recordPath, {
    ...(existing || {}),
    idempotencyKey,
    requestFingerprint: fingerprint,
    status: 'committed',
    startedAt: existing?.startedAt || ts,
    updatedAt: ts,
    auditRow,
  });
}

function ensureIdempotency(auditRootDir, {
  idempotencyKey,
  requestFingerprint: fingerprint,
}) {
  const existing = readIdempotencyRecord(auditRootDir, idempotencyKey);
  if (!existing) return null;
  if (existing.requestFingerprint !== fingerprint) {
    const err = new Error('IDEMPOTENCY_KEY_MISMATCH');
    err.code = 'IDEMPOTENCY_KEY_MISMATCH';
    throw err;
  }
  if (existing.status === 'committed') {
    return existing.auditRow || null;
  }
  const err = new Error('IDEMPOTENCY_KEY_IN_FLIGHT');
  err.code = 'IDEMPOTENCY_KEY_IN_FLIGHT';
  throw err;
}

function emitOperatorMutationAudit(auditRootDir, auditRow) {
  writeJsonFile(auditLogPath(auditRootDir, auditRow.ts, auditRow.idempotencyKey), auditRow);
}

function appendJobOperatorAudit(jobPath, auditRow, { requestFingerprint: fingerprint }) {
  const job = readFollowUpJob(jobPath);
  const history = Array.isArray(job.operatorRetriggerAudit) ? job.operatorRetriggerAudit : [];
  job.operatorRetriggerAudit = history.concat({
    ...auditRow,
    requestFingerprint: fingerprint,
  });
  writeFollowUpJob(jobPath, job);
  return { job, jobPath };
}

function comparableJobTimestamp(job) {
  return job.completedAt
    || job.failedAt
    || job.stoppedAt
    || job.claimedAt
    || job.pendingAt
    || job.createdAt
    || null;
}

function latestFollowUpJobForPr(rootDir, { repo, pr, prNumber }) {
  const targetRepo = String(repo ?? '');
  const targetPr = Number(pr ?? prNumber);
  if (!targetRepo || !Number.isFinite(targetPr)) {
    return null;
  }

  let latest = null;
  let latestTs = null;

  for (const key of Object.keys(FOLLOW_UP_JOB_DIRS)) {
    const dir = getFollowUpJobDir(rootDir, key);
    if (!existsSync(dir)) continue;

    let names;
    try {
      names = readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort();
    } catch {
      continue;
    }

    for (const name of names) {
      const jobPath = join(dir, name);
      let job;
      try {
        job = readFollowUpJob(jobPath);
      } catch {
        continue;
      }
      if (job.repo !== targetRepo || Number(job.prNumber) !== targetPr) continue;

      const ts = comparableJobTimestamp(job);
      const jobId = String(job.jobId || '');
      const latestJobId = String(latest?.job?.jobId || '');
      if (
        !latest
        || (ts && (!latestTs || ts > latestTs || (ts === latestTs && jobId > latestJobId)))
        || (!ts && !latestTs && jobId > latestJobId)
      ) {
        latest = { job, jobPath, jobKey: key };
        latestTs = ts;
      }
    }
  }

  return latest;
}

function findLatestJobForPR(rootDir, { repo, prNumber }) {
  return latestFollowUpJobForPr(rootDir, { repo, prNumber });
}

function currentMaxRounds(job) {
  const value = Number(job?.remediationPlan?.maxRounds);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function defaultMaxRounds(job) {
  return ROUND_BUDGET_BY_RISK_CLASS[String(job?.riskClass ?? '').trim().toLowerCase()]
    || ROUND_BUDGET_BY_RISK_CLASS[DEFAULT_RISK_CLASS];
}

function bumpRemediationBudget({
  rootDir,
  repo,
  pr,
  prNumber,
  bumpBy = 1,
  latestJobRecord = latestFollowUpJobForPr(rootDir, { repo, pr: pr ?? prNumber }),
}) {
  if (!Number.isInteger(bumpBy) || bumpBy <= 0) {
    return { bumped: false, reason: 'invalid-bump-by', bumpBy };
  }
  if (!latestJobRecord) {
    return { bumped: false, reason: 'no-job-found' };
  }

  const { jobPath, jobKey } = latestJobRecord;
  const job = readFollowUpJob(jobPath);
  if (job.status === 'pending' || job.status === 'in_progress') {
    return { bumped: false, reason: 'job-active', job, jobPath };
  }

  const priorMaxRounds = currentMaxRounds(job) || defaultMaxRounds(job);
  const newMaxRounds = priorMaxRounds + bumpBy;
  const nextJob = {
    ...job,
    recommendedFollowUpAction: {
      ...(job.recommendedFollowUpAction || {}),
      maxRounds: newMaxRounds,
    },
    remediationPlan: {
      ...(job.remediationPlan || {}),
      maxRounds: newMaxRounds,
    },
  };
  writeFollowUpJob(jobPath, nextJob);
  return {
    bumped: true,
    job: nextJob,
    jobPath,
    jobKey,
    priorMaxRounds,
    newMaxRounds,
    bumpBy,
  };
}

export {
  appendJobOperatorAudit,
  beginIdempotentMutation,
  bumpRemediationBudget,
  currentMaxRounds,
  defaultIdempotencyKey,
  emitOperatorMutationAudit,
  ensureIdempotency,
  findLatestJobForPR,
  latestFollowUpJobForPr,
  operatorMutationsDir,
  recordIdempotentMutation,
  requestFingerprint,
};
