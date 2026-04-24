import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFollowUpJobsInDir } from './follow-up-jobs.mjs';
import {
  reconcileFollowUpJob as reconcileFollowUpJobImpl,
  reconcileInProgressFollowUpJobs as reconcileInProgressFollowUpJobsImpl,
} from './follow-up-remediation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function buildCompletionPreview(text, limit = 240) {
  const normalized = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function mapReconcileResult(result) {
  if (result.action === 'completed' || result.action === 'failed') {
    return {
      reconciled: true,
      outcome: result.action,
      job: result.job,
      jobPath: result.jobPath,
    };
  }

  const reasonMap = {
    active: 'worker-still-running',
    skipped: 'worker-not-spawned',
  };

  return {
    reconciled: false,
    reason: reasonMap[result.action] || result.reason,
    job: result.job,
    jobPath: result.jobPath,
  };
}

function reconcileFollowUpJob({
  rootDir = ROOT,
  jobPath,
  now = () => new Date().toISOString(),
  isProcessAliveImpl,
}) {
  const entry = listFollowUpJobsInDir(rootDir, 'inProgress').find((item) => item.jobPath === jobPath);
  if (!entry?.job) {
    throw new Error(`In-progress follow-up job not found: ${jobPath}`);
  }

  const result = reconcileFollowUpJobImpl({
    rootDir,
    job: entry.job,
    jobPath,
    now,
    isWorkerRunning: isProcessAliveImpl,
  });

  return mapReconcileResult(result);
}

function reconcileInProgressFollowUpJobs({
  rootDir = ROOT,
  now = () => new Date().toISOString(),
  isProcessAliveImpl,
} = {}) {
  const result = reconcileInProgressFollowUpJobsImpl({
    rootDir,
    now,
    isWorkerRunning: isProcessAliveImpl,
  });

  return result.results.map(mapReconcileResult);
}

function main() {
  try {
    const results = reconcileInProgressFollowUpJobs();
    if (results.length === 0) {
      console.log('[follow-up-reconcile] No in-progress follow-up jobs found.');
      return;
    }

    for (const result of results) {
      if (!result.reconciled) {
        console.log(`[follow-up-reconcile] ${result.job.jobId}: ${result.reason}`);
        continue;
      }

      console.log(`[follow-up-reconcile] ${result.job.jobId}: ${result.outcome} -> ${result.jobPath}`);
    }
  } catch (err) {
    console.error('[follow-up-reconcile] Failed to reconcile follow-up jobs:', err.message);
    process.exit(1);
  }
}

export {
  buildCompletionPreview,
  reconcileFollowUpJob,
  reconcileInProgressFollowUpJobs,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
