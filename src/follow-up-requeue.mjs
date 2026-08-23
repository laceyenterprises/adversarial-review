import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { requeueFollowUpJobForNextRound } from './follow-up-jobs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function resolveTerminalJobPath(rootDir, jobPathArg) {
  const candidate = isAbsolute(jobPathArg) ? resolve(jobPathArg) : resolve(rootDir, jobPathArg);
  // `stopped` belongs here alongside `completed`/`failed`. The library this CLI
  // wraps already decides what may be requeued: `requeueFollowUpJobForNextRound`
  // refuses a stopped job unless its stop code is in RETRIGGERABLE_STOP_CODES,
  // and `review-settled` is deliberately in that set — its own comment says "an
  // explicit operator retrigger label/CLI call means 'address the remaining
  // non-blocking flags'".
  //
  // Excluding the directory here made that unreachable through the CLI, which is
  // the only path an operator has. On 2026-08-22 that left ~10 PRs sitting at
  // `stopped:review-settled` with no way to reclassify them after the
  // non-blocking settled-clean deadlock fix (#883) landed: that fix corrects
  // future classifications, but jobs already written to disk need a requeue to
  // pick it up. The guard duplicated a decision the library makes better, and
  // got it wrong.
  const allowedPrefixes = [
    resolve(rootDir, 'data', 'follow-up-jobs', 'completed'),
    resolve(rootDir, 'data', 'follow-up-jobs', 'failed'),
    resolve(rootDir, 'data', 'follow-up-jobs', 'stopped'),
  ];

  const isAllowed = allowedPrefixes.some((prefix) => {
    const rel = relative(prefix, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });

  if (!isAllowed || !candidate.endsWith('.json')) {
    throw new Error(
      'Job path must point to a completed, failed, or stopped follow-up job JSON '
      + 'under data/follow-up-jobs/'
    );
  }

  return candidate;
}

function parseArgs(argv) {
  const [jobPathArg, ...rest] = argv;
  if (!jobPathArg) {
    throw new Error('Usage: node src/follow-up-requeue.mjs <job-path> [reason]');
  }

  return {
    jobPath: resolveTerminalJobPath(ROOT, jobPathArg),
    reason: rest.join(' ').trim() || 'Additional remediation round requested.',
  };
}

function main() {
  try {
    const { jobPath, reason } = parseArgs(process.argv.slice(2));
    const result = requeueFollowUpJobForNextRound({
      rootDir: ROOT,
      jobPath,
      reason,
    });
    console.log(`[follow-up-requeue] ${result.job.jobId}: ${result.job.status} -> ${result.jobPath}`);
  } catch (err) {
    console.error(`[follow-up-requeue] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  parseArgs,
  resolveTerminalJobPath,
};
