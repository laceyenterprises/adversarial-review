import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { readFollowUpJob } from './follow-up-jobs.mjs';
import { isPgidAlive, verifyPgidIdentity } from './process-group-identity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VALID_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']);

function resolveFollowUpJobPath(rootDir, jobPathArg) {
  const candidate = isAbsolute(jobPathArg) ? resolve(jobPathArg) : resolve(rootDir, jobPathArg);
  const inProgressPath = resolve(rootDir, 'data', 'follow-up-jobs', 'in-progress');
  if (!existsSync(inProgressPath)) {
    throw new Error('Job path must point to an in-progress follow-up job JSON under data/follow-up-jobs/');
  }
  const inProgressDir = realpathSync.native?.(inProgressPath)
    ?? realpathSync(inProgressPath);

  if (!existsSync(candidate)) {
    throw new Error('Job path must point to an in-progress follow-up job JSON under data/follow-up-jobs/');
  }

  if (lstatSync(candidate).isSymbolicLink()) {
    throw new Error('Job path must not be a symbolic link.');
  }

  const resolvedCandidate = realpathSync.native?.(candidate) ?? realpathSync(candidate);
  const rel = relative(inProgressDir, resolvedCandidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !resolvedCandidate.endsWith('.json')) {
    throw new Error('Job path must point to an in-progress follow-up job JSON under data/follow-up-jobs/');
  }

  return resolvedCandidate;
}

function parseSignal(value) {
  const signal = String(value || 'SIGTERM').trim().toUpperCase();
  if (!VALID_SIGNALS.has(signal)) {
    throw new Error(`Unsupported signal ${JSON.stringify(value)}. Supported: ${[...VALID_SIGNALS].join(', ')}`);
  }
  return signal;
}

function parseArgs(argv) {
  const args = [...argv];
  let signal = 'SIGTERM';
  const passthrough = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--signal') {
      signal = parseSignal(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--signal=')) {
      signal = parseSignal(arg.slice('--signal='.length));
      continue;
    }
    passthrough.push(arg);
  }

  const [jobPathArg, ...reasonParts] = passthrough;
  if (!jobPathArg) {
    throw new Error('Usage: node src/follow-up-worker-cancel.mjs [--signal SIGTERM] <in-progress-job-path> [reason]');
  }

  return {
    jobPathArg,
    signal,
    reason: reasonParts.join(' ').trim() || 'Operator requested worker cancellation.',
  };
}

function numericId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function workerCancelHandle(job) {
  const worker = job?.remediationWorker || {};
  const processGroupId = numericId(worker.processGroupId ?? worker.processId);
  const processId = numericId(worker.processId);
  return {
    processGroupId,
    processId,
    spawnedAt: worker.spawnedAt || null,
    worker,
  };
}

async function sendWorkerSignal({
  processGroupId,
  processId,
  spawnedAt,
  signal,
  processKill = process.kill,
  execFileImpl,
} = {}) {
  if (!processGroupId && !processId) {
    return { signalled: false, target: null, error: 'missing-worker-process-handle' };
  }
  if (processGroupId === process.pid || processId === process.pid) {
    return { signalled: false, target: null, error: 'refusing-to-signal-current-process' };
  }
  const targetPgid = processGroupId || processId;
  if (!isPgidAlive(targetPgid, processKill)) {
    return { signalled: false, target: { kind: 'process-group', id: targetPgid }, error: 'process-group-not-found' };
  }
  const identity = await verifyPgidIdentity(targetPgid, spawnedAt, { execFileImpl });
  if (!identity.match) {
    return {
      signalled: false,
      target: { kind: 'process-group', id: targetPgid },
      error: 'identity-unconfirmed',
      identity,
    };
  }
  try {
    processKill(-targetPgid, signal);
    return { signalled: true, target: { kind: 'process-group', id: targetPgid }, error: null, identity };
  } catch (err) {
    if (err?.code === 'ESRCH') {
      return { signalled: false, target: { kind: 'process-group', id: targetPgid }, error: 'process-group-not-found' };
    }
    return { signalled: false, target: { kind: 'process-group', id: targetPgid }, error: err?.message || String(err) };
  }
}

function sanitizePathSegment(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180) || 'unknown';
}

function cancellationReceiptPath(rootDir, job, requestedAt, attempt = 0) {
  const safeJob = sanitizePathSegment(job?.jobId || 'unknown-job');
  const safeTs = sanitizePathSegment(requestedAt);
  const suffix = attempt ? `.${attempt}` : '';
  return join(rootDir, 'data', 'follow-up-jobs', 'worker-cancellations', `${safeJob}-${safeTs}${suffix}.json`);
}

function writeCancellationReceipt(rootDir, receipt) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const filePath = cancellationReceiptPath(rootDir, receipt.job, receipt.requestedAt, attempt);
    try {
      writeFileAtomic(filePath, `${JSON.stringify(receipt, null, 2)}\n`, { overwrite: false });
      return filePath;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Unable to allocate worker-cancellation receipt for ${receipt.job?.jobId || '<unknown>'}`);
}

async function cancelFollowUpWorker({
  rootDir = ROOT,
  jobPath,
  requestedAt = new Date().toISOString(),
  requestedBy = process.env.USER || process.env.LOGNAME || 'operator',
  reason = 'Operator requested worker cancellation.',
  signal = 'SIGTERM',
  processKill = process.kill,
  execFileImpl,
} = {}) {
  const job = readFollowUpJob(jobPath);
  if (job.status !== 'in_progress') {
    throw new Error(`Cannot cancel worker for follow-up job ${job.jobId} from status ${job.status}`);
  }
  if (job?.remediationWorker?.state !== 'spawned') {
    throw new Error(`Cannot cancel worker for follow-up job ${job.jobId}: remediationWorker.state is not spawned`);
  }

  const handle = workerCancelHandle(job);
  const signalResult = await sendWorkerSignal({
    processGroupId: handle.processGroupId,
    processId: handle.processId,
    spawnedAt: handle.spawnedAt,
    signal: parseSignal(signal),
    processKill,
    execFileImpl,
  });
  const receipt = {
    kind: 'adversarial-review-follow-up-worker-cancellation',
    schemaVersion: 1,
    requestedAt,
    requestedBy,
    reason,
    signal: parseSignal(signal),
    job: {
      jobId: job.jobId,
      repo: job.repo,
      prNumber: job.prNumber,
      status: job.status,
      jobPath,
    },
    worker: {
      model: handle.worker.model || null,
      state: handle.worker.state || null,
      processId: handle.processId,
      processGroupId: handle.processGroupId,
      workspaceDir: handle.worker.workspaceDir || job.workspaceDir || null,
      outputPath: handle.worker.outputPath || null,
      logPath: handle.worker.logPath || null,
    },
    result: signalResult,
  };
  const receiptPath = writeCancellationReceipt(rootDir, receipt);
  return {
    ...signalResult,
    receipt,
    receiptPath,
  };
}

async function main() {
  try {
    const { jobPathArg, signal, reason } = parseArgs(process.argv.slice(2));
    const jobPath = resolveFollowUpJobPath(ROOT, jobPathArg);
    const result = await cancelFollowUpWorker({
      rootDir: ROOT,
      jobPath,
      signal,
      reason,
    });
    const target = result.target ? `${result.target.kind}:${result.target.id}` : 'none';
    console.log(`[follow-up-worker-cancel] signalled=${result.signalled} target=${target} receipt=${result.receiptPath}`);
    if (!result.signalled) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[follow-up-worker-cancel] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  cancelFollowUpWorker,
  parseArgs,
  parseSignal,
  resolveFollowUpJobPath,
  sendWorkerSignal,
  workerCancelHandle,
};
