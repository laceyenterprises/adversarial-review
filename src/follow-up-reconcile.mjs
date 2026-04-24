import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listFollowUpJobsInDir,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
} from './follow-up-jobs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    if (err?.code === 'ESRCH') return false;
    throw err;
  }
}

function readCompletionArtifact(rootDir, job) {
  const outputPath = job?.remediationWorker?.outputPath;
  if (!outputPath) {
    return '';
  }

  const absolutePath = join(rootDir, outputPath);
  if (!existsSync(absolutePath)) {
    return '';
  }

  return readFileSync(absolutePath, 'utf8').trim();
}

function buildCompletionPreview(text, limit = 240) {
  const normalized = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function reconcileFollowUpJob({
  rootDir = ROOT,
  jobPath,
  now = () => new Date().toISOString(),
  isProcessAliveImpl = isProcessAlive,
}) {
  const entry = listFollowUpJobsInDir(rootDir, 'inProgress').find((item) => item.jobPath === jobPath);
  if (!entry?.job) {
    throw new Error(`In-progress follow-up job not found: ${jobPath}`);
  }
  const { job } = entry;

  if (job?.remediationWorker?.state !== 'spawned') {
    return { reconciled: false, reason: 'worker-not-spawned', job, jobPath };
  }

  if (isProcessAliveImpl(job.remediationWorker.processId)) {
    return { reconciled: false, reason: 'worker-still-running', job, jobPath };
  }

  const completionText = readCompletionArtifact(rootDir, job);
  if (completionText) {
    const completed = markFollowUpJobCompleted({
      rootDir,
      jobPath,
      finishedAt: now(),
      completionPreview: buildCompletionPreview(completionText),
    });
    return { reconciled: true, outcome: 'completed', ...completed };
  }

  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath,
    failedAt: now(),
    failureCode: 'artifact-missing-completion',
    error: new Error('Worker exited without a non-empty completion artifact'),
  });
  return { reconciled: true, outcome: 'failed', ...failed };
}

function reconcileInProgressFollowUpJobs({
  rootDir = ROOT,
  now = () => new Date().toISOString(),
  isProcessAliveImpl = isProcessAlive,
} = {}) {
  return listFollowUpJobsInDir(rootDir, 'inProgress').map(({ jobPath }) => (
    reconcileFollowUpJob({
      rootDir,
      jobPath,
      now,
      isProcessAliveImpl,
    })
  ));
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
  isProcessAlive,
  reconcileFollowUpJob,
  reconcileInProgressFollowUpJobs,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
