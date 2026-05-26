import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

import { cancelActiveReview } from './review-cancel.mjs';
import { stopFollowUpJobWithWorkerCancel } from './follow-up-stop.mjs';
import { isPgidAlive } from './process-group-identity.mjs';
import { openReviewStateDb } from './review-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEFAULT_EXIT_WAIT_MS = 5_000;
const DEFAULT_EXIT_POLL_MS = 250;
const REVIEW_BENIGN_UNSIGNALLED_ERRORS = new Set([
  'missing-reviewer-process-group',
  'process-group-not-found',
]);
const FOLLOW_UP_BENIGN_UNSIGNALLED_ERRORS = new Set([
  'missing-worker-process-handle',
  'process-group-not-found',
  'worker-no-longer-spawned',
]);

function parseArgs(argv) {
  const args = [...argv];
  let signal = 'SIGTERM';
  let waitMs = DEFAULT_EXIT_WAIT_MS;
  const reasonParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--signal') {
      signal = args[index + 1] || signal;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--signal=')) {
      signal = arg.slice('--signal='.length);
      continue;
    }
    if (arg === '--wait-ms') {
      waitMs = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--wait-ms=')) {
      waitMs = Number(arg.slice('--wait-ms='.length));
      continue;
    }
    reasonParts.push(arg);
  }
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error('Usage: node src/adversarial-hard-shutdown.mjs [--signal SIGTERM] [--wait-ms N] [reason]');
  }
  return {
    signal,
    waitMs,
    reason: reasonParts.join(' ').trim() || 'Operator requested adversarial-review hard shutdown.',
  };
}

function listActiveReviewRows(db) {
  return db.prepare(
    `SELECT repo, pr_number
       FROM reviewed_prs
      WHERE review_status = 'reviewing'
      ORDER BY last_attempted_at ASC, id ASC`
  ).all();
}

function listInProgressFollowUpJobPaths(rootDir = ROOT) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'in-progress');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

async function waitForProcessGroupExit(target, {
  waitMs = DEFAULT_EXIT_WAIT_MS,
  pollMs = DEFAULT_EXIT_POLL_MS,
  processKill = process.kill,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  if (target?.kind !== 'process-group' || !Number.isInteger(target.id)) {
    return { checked: false, exited: null };
  }
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    if (!isPgidAlive(target.id, processKill)) {
      return { checked: true, exited: true, target };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.max(1, pollMs));
  } while (true);
  return { checked: true, exited: false, target };
}

function isUnsignalledTeardownFailure(cancellation, benignErrors) {
  if (!cancellation || cancellation.signalled) return false;
  return !benignErrors.has(cancellation.error);
}

async function hardShutdownInFlightWorkers({
  rootDir = ROOT,
  requestedAt = new Date().toISOString(),
  requestedBy = process.env.USER || process.env.LOGNAME || 'operator',
  reason = 'Operator requested adversarial-review hard shutdown.',
  signal = 'SIGTERM',
  waitMs = DEFAULT_EXIT_WAIT_MS,
  db: dbOverride = null,
  cancelActiveReviewImpl = cancelActiveReview,
  stopFollowUpJobImpl = stopFollowUpJobWithWorkerCancel,
  listFollowUpJobPathsImpl = listInProgressFollowUpJobPaths,
  waitForProcessGroupExitImpl = waitForProcessGroupExit,
} = {}) {
  const db = dbOverride || openReviewStateDb(rootDir);
  const reviews = [];
  const followUps = [];
  try {
    for (const row of listActiveReviewRows(db)) {
      try {
        const cancellation = await cancelActiveReviewImpl({
          rootDir,
          db,
          repo: row.repo,
          prNumber: row.pr_number,
          requestedAt,
          requestedBy,
          reason: `Hard shutdown: ${reason}`,
          signal,
        });
        const reviewerExit = cancellation.signalled
          ? await waitForProcessGroupExitImpl(cancellation.target, { waitMs })
          : { checked: false, exited: null };
        reviews.push({
          repo: row.repo,
          prNumber: row.pr_number,
          cancellation,
          workerExit: reviewerExit,
        });
      } catch (err) {
        reviews.push({
          repo: row.repo,
          prNumber: row.pr_number,
          cancellation: {
            signalled: false,
            error: err?.message || String(err),
          },
          workerExit: { checked: false, exited: null },
        });
      }
    }

    for (const jobPath of listFollowUpJobPathsImpl(rootDir)) {
      try {
        const stopped = await stopFollowUpJobImpl({
          rootDir,
          jobPath,
          requestedAt,
          requestedBy,
          reason: `Hard shutdown: ${reason}`,
          signal,
          cancelWorker: true,
        });
        followUps.push({
          jobPath,
          jobId: stopped.job?.jobId || basename(jobPath, '.json'),
          stopped,
        });
      } catch (err) {
        followUps.push({
          jobPath,
          jobId: basename(jobPath, '.json'),
          stopped: {
            jobPath,
            cancellation: {
              signalled: false,
              error: err?.message || String(err),
            },
            workerExit: { checked: false, exited: null },
          },
        });
      }
    }
  } finally {
    if (!dbOverride) db.close();
  }

  const reviewFailures = reviews.filter((entry) => (
    isUnsignalledTeardownFailure(entry.cancellation, REVIEW_BENIGN_UNSIGNALLED_ERRORS) ||
    (entry.workerExit?.checked && entry.workerExit.exited === false)
  ));
  const followUpFailures = followUps.filter((entry) => (
    entry.stopped?.cancellation &&
    (
      isUnsignalledTeardownFailure(entry.stopped.cancellation, FOLLOW_UP_BENIGN_UNSIGNALLED_ERRORS) ||
      (entry.stopped.workerExit?.checked && entry.stopped.workerExit.exited === false)
    )
  ));

  return {
    requestedAt,
    requestedBy,
    reason,
    signal,
    reviews,
    followUps,
    ok: reviewFailures.length === 0 && followUpFailures.length === 0,
  };
}

async function main() {
  try {
    const { signal, waitMs, reason } = parseArgs(process.argv.slice(2));
    const result = await hardShutdownInFlightWorkers({
      rootDir: ROOT,
      signal,
      waitMs,
      reason,
    });
    console.log(
      `[adversarial-hard-shutdown] reviews=${result.reviews.length} ` +
      `followUps=${result.followUps.length} ok=${result.ok}`
    );
    for (const review of result.reviews) {
      console.log(
        `[adversarial-hard-shutdown] review ${review.repo}#${review.prNumber} ` +
        `signalled=${review.cancellation.signalled} exited=${review.workerExit.exited}`
      );
    }
    for (const followUp of result.followUps) {
      console.log(
        `[adversarial-hard-shutdown] follow-up ${followUp.jobId} ` +
        `stopped=${followUp.stopped.jobPath} signalled=${followUp.stopped.cancellation?.signalled ?? 'n/a'}`
      );
    }
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error(`[adversarial-hard-shutdown] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  hardShutdownInFlightWorkers,
  listActiveReviewRows,
  listInProgressFollowUpJobPaths,
  parseArgs,
  waitForProcessGroupExit,
};
