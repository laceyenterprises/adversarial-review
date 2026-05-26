import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readFollowUpJob, stopFollowUpJob } from './follow-up-jobs.mjs';
import { cancelFollowUpWorker } from './follow-up-worker-cancel.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function resolveFollowUpJobPath(rootDir, jobPathArg) {
  const candidate = isAbsolute(jobPathArg) ? resolve(jobPathArg) : resolve(rootDir, jobPathArg);
  const allowedPrefixes = [
    resolve(rootDir, 'data', 'follow-up-jobs', 'pending'),
    resolve(rootDir, 'data', 'follow-up-jobs', 'in-progress'),
    resolve(rootDir, 'data', 'follow-up-jobs', 'completed'),
    resolve(rootDir, 'data', 'follow-up-jobs', 'failed'),
  ].map((prefix) => realpathSync.native?.(prefix) ?? realpathSync(prefix));

  if (!existsSync(candidate)) {
    throw new Error('Job path must point to a pending, in-progress, completed, or failed follow-up job JSON under data/follow-up-jobs/');
  }

  if (lstatSync(candidate).isSymbolicLink()) {
    throw new Error('Job path must not be a symbolic link.');
  }

  const resolvedCandidate = realpathSync.native?.(candidate) ?? realpathSync(candidate);

  const isAllowed = allowedPrefixes.some((prefix) => {
    const rel = relative(prefix, resolvedCandidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });

  if (!isAllowed || !resolvedCandidate.endsWith('.json')) {
    throw new Error('Job path must point to a pending, in-progress, completed, or failed follow-up job JSON under data/follow-up-jobs/');
  }

  return resolvedCandidate;
}

function parseArgs(argv) {
  const args = [...argv];
  let signal = 'SIGTERM';
  let cancelWorker = true;
  const passthrough = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--signal') {
      signal = String(args[index + 1] || '').trim() || 'SIGTERM';
      index += 1;
      continue;
    }
    if (arg?.startsWith('--signal=')) {
      signal = String(arg.slice('--signal='.length)).trim() || 'SIGTERM';
      continue;
    }
    if (arg === '--no-cancel-worker') {
      cancelWorker = false;
      continue;
    }
    passthrough.push(arg);
  }

  const [jobPathArg, ...rest] = passthrough;
  if (!jobPathArg) {
    throw new Error('Usage: node src/follow-up-stop.mjs [--signal SIGTERM] [--no-cancel-worker] <job-path> [reason]');
  }

  return {
    jobPath: resolveFollowUpJobPath(ROOT, jobPathArg),
    reason: rest.join(' ').trim() || 'Operator requested stop.',
    signal,
    cancelWorker,
  };
}

function shouldCancelSpawnedWorker(job) {
  return job?.status === 'in_progress' && job?.remediationWorker?.state === 'spawned';
}

async function stopFollowUpJobWithWorkerCancel({
  rootDir = ROOT,
  jobPath,
  reason = 'Operator requested stop.',
  requestedAt = new Date().toISOString(),
  requestedBy = process.env.USER || process.env.LOGNAME || 'operator',
  signal = 'SIGTERM',
  cancelWorker = true,
  cancelFollowUpWorkerImpl = cancelFollowUpWorker,
} = {}) {
  const job = readFollowUpJob(jobPath);
  let cancellation = null;

  if (cancelWorker && shouldCancelSpawnedWorker(job)) {
    cancellation = await cancelFollowUpWorkerImpl({
      rootDir,
      jobPath,
      requestedAt,
      requestedBy,
      reason: `Stopping follow-up job: ${reason}`,
      signal,
    });
    if (!cancellation.signalled && cancellation.error !== 'process-group-not-found') {
      throw new Error(
        `Refusing to stop in-progress follow-up job ${job.jobId}: worker cancellation failed (${cancellation.error || 'unknown-error'})`
      );
    }
  }

  const stopped = stopFollowUpJob({
    rootDir,
    jobPath,
    requestedAt,
    requestedBy,
    reason,
  });
  return {
    ...stopped,
    cancellation,
  };
}

async function main() {
  try {
    const { jobPath, reason, signal, cancelWorker } = parseArgs(process.argv.slice(2));
    const result = await stopFollowUpJobWithWorkerCancel({
      rootDir: ROOT,
      jobPath,
      reason,
      signal,
      cancelWorker,
    });
    const cancelSuffix = result.cancellation
      ? ` workerSignalled=${result.cancellation.signalled} receipt=${result.cancellation.receiptPath}`
      : '';
    console.log(`[follow-up-stop] ${result.job.jobId}: ${result.job.status} -> ${result.jobPath}${cancelSuffix}`);
  } catch (err) {
    console.error(`[follow-up-stop] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  parseArgs,
  resolveFollowUpJobPath,
  shouldCancelSpawnedWorker,
  stopFollowUpJobWithWorkerCancel,
};
