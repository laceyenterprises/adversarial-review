// retrigger-review.mjs — manual operator CLI to re-queue a previously-reviewed
// PR for adversarial review.
//
// Why this exists: the watcher polls on `review_status`, not on
// `rereview_requested_at`. Operators who edited the database directly to
// "trigger a rereview" by setting only `rereview_requested_at` produced a
// silent no-op — the watcher's polling loop (src/watcher.mjs) skips rows
// whose `review_status` is `'posted'` or `'malformed'`. The canonical
// transition (`requestReviewRereview` in src/review-state.mjs) atomically
// resets `review_status` to `'pending'`, clears `posted_at` / `failed_at` /
// `failure_message`, and records the rereview metadata. This script is the
// thin CLI wrapper around that helper, so manual retriggers stop being
// error-prone hand-written SQL.

import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureReviewStateSchema,
  getReviewRow,
  openReviewStateDb,
  requestReviewRereview,
} from './review-state.mjs';
import { bumpRemediationBudget } from './operator-retrigger-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

const USAGE = `\
retrigger-review — re-queue a previously-reviewed PR for adversarial review

Usage:
  node src/retrigger-review.mjs --repo <owner/repo> --pr <number> --reason "..."
  node src/retrigger-review.mjs --repo <owner/repo> --pr <number> --reason-file <path>
  node src/retrigger-review.mjs --repo <owner/repo> --pr <number> --reason-stdin < reason.md

Required:
  --repo <owner/repo>     Repository the PR lives in (e.g. laceyenterprises/agent-os).
  --pr <number>           PR number.
  Exactly one of:
    --reason "..."        Reason text inline.
    --reason-file <path>  Read reason from a file.
    --reason-stdin        Read reason from stdin.

Optional:
  --root-dir <path>       Adversarial-review tool root (default: this script's parent).
  --bump-budget <N>       Also bump the latest follow-up job's remediation
                          maxRounds by N (default: 1) so the watcher's
                          round-budget gate re-arms for one fresh remediation
                          cycle. Operator default — re-review without a
                          budget bump produces a deny:budget-exhausted on
                          the first finding, which is rarely what you want.
  --no-bump-budget        Opt out of the budget bump. Use when you want a
                          surgical re-review (e.g., reviewer just panicked
                          on transient infra; you want it to retry without
                          stretching the budget envelope).
  --allow-failed-reset    Permit retriggering a row whose review_status is 'failed'.
                          Refused by default because the watcher already retries
                          'failed' rows automatically, and the reset clears
                          failed_at + failure_message — i.e. the diagnostic
                          evidence — before anyone has read it. Pass this flag
                          only when you have reviewed the failure and explicitly
                          want a clean rerun.
  --quiet                 Suppress informational stdout; only the exit code matters.
  -h, --help              Show this help.

Exit codes:
  0  triggered or already-pending (a review will run / is already queued)
  1  blocked (review row missing, PR not open, malformed-title-terminal,
     review_status='reviewing' (in-flight reviewer subprocess), or
     review_status='failed' without --allow-failed-reset)
  2  usage error (missing/invalid args)
  3  reason-input I/O error (e.g. --reason-file path unreadable)
  4  runtime / database error (could not open or write reviews.db; the failure
     message is printed to stderr without a stack trace)
`;

class UsageError extends Error {}

function parseArgs(argv) {
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: argv,
      options: {
        repo: { type: 'string' },
        pr: { type: 'string' },
        reason: { type: 'string' },
        'reason-file': { type: 'string' },
        'reason-stdin': { type: 'boolean', default: false },
        'root-dir': { type: 'string' },
        'bump-budget': { type: 'string' },
        'no-bump-budget': { type: 'boolean', default: false },
        'allow-failed-reset': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err.message);
  }

  if (parsed.values.help) return { values: parsed.values };

  if (!parsed.values.repo || !parsed.values.pr) {
    throw new UsageError('--repo and --pr are required');
  }

  const prNumber = Number.parseInt(parsed.values.pr, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0 || String(prNumber) !== parsed.values.pr.trim()) {
    throw new UsageError(`--pr must be a positive integer (got: ${parsed.values.pr})`);
  }

  const reasonSources = ['reason', 'reason-file', 'reason-stdin'].filter(
    (key) => parsed.values[key] !== undefined && parsed.values[key] !== false
  );
  if (reasonSources.length === 0) {
    throw new UsageError('one of --reason, --reason-file, or --reason-stdin is required');
  }
  if (reasonSources.length > 1) {
    throw new UsageError(
      `pass exactly one of --reason / --reason-file / --reason-stdin (got: ${reasonSources.join(', ')})`
    );
  }

  if (parsed.values['bump-budget'] !== undefined && parsed.values['no-bump-budget']) {
    throw new UsageError('--bump-budget and --no-bump-budget are mutually exclusive');
  }

  let bumpBudget = 1; // operator default: bump by 1
  if (parsed.values['no-bump-budget']) {
    bumpBudget = 0;
  } else if (parsed.values['bump-budget'] !== undefined) {
    const n = Number.parseInt(parsed.values['bump-budget'], 10);
    if (!Number.isInteger(n) || n < 0 || String(n) !== parsed.values['bump-budget'].trim()) {
      throw new UsageError(`--bump-budget must be a non-negative integer (got: ${parsed.values['bump-budget']})`);
    }
    bumpBudget = n;
  }

  return {
    values: {
      ...parsed.values,
      pr: prNumber,
      bumpBudget,
    },
    reasonSource: reasonSources[0],
  };
}

function readReasonFromSource(values, reasonSource, { stdinReader = readStdinSync } = {}) {
  if (reasonSource === 'reason') return values.reason;
  if (reasonSource === 'reason-file') {
    return readFileSync(values['reason-file'], 'utf-8');
  }
  // reason-stdin
  return stdinReader();
}

function readStdinSync() {
  // fd 0 is stdin. readFileSync on an fd reads to EOF; this is the same
  // pattern used elsewhere in the Node ecosystem for "read all of stdin."
  return readFileSync(0, 'utf-8');
}

function emit(quiet, stream, msg) {
  if (quiet) return;
  stream.write(msg);
}

function readReviewRowSafely({ rootDir, repo, prNumber }) {
  // Open + close inside this helper so the connection lifecycle stays
  // local. Schema is ensured before reading because tests (and a
  // freshly-created tool root) may produce a brand-new DB.
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return getReviewRow(db, { repo, prNumber });
  } finally {
    db.close();
  }
}

function main(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  stdinReader = readStdinSync,
  rereview = requestReviewRereview,
  readReviewRow = readReviewRowSafely,
  bumpBudget = bumpRemediationBudget,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`error: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  const { values, reasonSource } = parsed;

  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }

  let reason;
  try {
    reason = readReasonFromSource(values, reasonSource, { stdinReader });
  } catch (err) {
    stderr.write(`error: could not read reason: ${err.message}\n`);
    return 3;
  }
  if (!reason || !reason.trim()) {
    stderr.write('error: reason is empty after reading\n');
    return 3;
  }

  const rootDir = values['root-dir']
    ? resolve(values['root-dir'])
    : DEFAULT_ROOT_DIR;

  const target = `${values.repo}#${values.pr}`;

  // Eligibility gate (PR #13 review blocking #2): the lower-level
  // `requestReviewRereview` accepts any non-pending, non-malformed,
  // PR-open row — including review_status='failed'. The watcher already
  // retries 'failed' rows automatically, and the reset clears failed_at
  // + failure_message. Running this CLI on 'failed' is therefore both
  // unnecessary and destructive (erases the diagnostic evidence). Refuse
  // by default; require explicit --allow-failed-reset to override.
  //
  // Wrapped in try/catch (PR #13 review blocking #1): any operational
  // failure here (bad --root-dir, unreadable DB file, permission issue,
  // lock timeout) becomes a controlled exit-4 instead of a Node stack
  // trace. The CLI is for manual recovery — recovery tooling cannot
  // assume the DB is healthy.
  let reviewRow;
  try {
    reviewRow = readReviewRow({ rootDir, repo: values.repo, prNumber: values.pr });
  } catch (err) {
    stderr.write(`error: could not read review state: ${err.message}\n`);
    return 4;
  }

  if (reviewRow && reviewRow.review_status === 'failed' && !values['allow-failed-reset']) {
    stderr.write(
      `blocked (failed-status-needs-explicit-allow): ${target} is in 'failed' state.\n` +
      `  The watcher already retries 'failed' rows automatically.\n` +
      `  Resetting it would clear failed_at + failure_message (the diagnostic\n` +
      `  evidence) before anyone has read it. If you have reviewed the failure\n` +
      `  and explicitly want a clean rerun, pass --allow-failed-reset.\n`
    );
    return 1;
  }

  // 'reviewing' is the watcher's durable in-flight claim — there is an
  // active reviewer subprocess for this PR right now. Allowing this
  // CLI to flip it back to 'pending' would let the next poll spawn a
  // second reviewer for the same PR and post a duplicate review.
  // Refuse loudly with a recovery path (no override flag — if you
  // truly need to clear the claim, restart the watcher and let
  // reconcileOrphanedReviewing turn the row into 'failed-orphan',
  // then verify GitHub and re-run this command on the orphan row).
  if (reviewRow && reviewRow.review_status === 'reviewing') {
    stderr.write(
      `blocked (review-in-flight): ${target} is in 'reviewing' state.\n` +
      `  A reviewer subprocess is currently in flight for this PR.\n` +
      `  Resetting now would queue a second reviewer and post a duplicate\n` +
      `  GitHub review. Recovery path:\n` +
      `    1. Wait for the in-flight review to finish (the row will move\n` +
      `       to 'posted' or 'failed' on its own).\n` +
      `    2. If the watcher has died and the row is genuinely stuck,\n` +
      `       restart the watcher; reconcileOrphanedReviewing will mark\n` +
      `       the row 'failed-orphan'. Verify the PR on GitHub for an\n` +
      `       already-posted review, then rerun this command on the\n` +
      `       'failed-orphan' row to clear it.\n`
    );
    return 1;
  }

  let result;
  try {
    result = rereview({
      rootDir,
      repo: values.repo,
      prNumber: values.pr,
      reason,
    });
  } catch (err) {
    stderr.write(`error: rereview failed: ${err.message}\n`);
    return 4;
  }

  // Per-PR remediation budget bump. Operator default: bump by 1 so the
  // re-arm of first-pass review is not immediately throttled by an
  // already-exhausted round-budget gate (the LAC-439 / round-1-only bind
  // for medium-risk PRs). Skipped when --no-bump-budget or --bump-budget=0.
  let bumpResult = null;
  if (values.bumpBudget > 0 && (result.triggered || result.status === 'already-pending')) {
    try {
      bumpResult = bumpBudget({
        rootDir,
        repo: values.repo,
        prNumber: values.pr,
        bumpBy: values.bumpBudget,
        reason: `retrigger-review: ${reason.trim()}`,
        by: 'operator-cli',
      });
    } catch (err) {
      // Budget bump is best-effort. The re-review has already been re-armed;
      // log and continue rather than blocking the whole operation. Operator
      // can run retrigger-remediation separately if they want to retry.
      stderr.write(`warning: budget bump failed: ${err.message}\n`);
    }
  }

  if (result.triggered) {
    emit(values.quiet, stdout,
      `triggered: ${target} — review_status reset to 'pending'\n` +
      `  rereview_requested_at: ${result.reviewRow.rereview_requested_at}\n` +
      `  watcher will pick this up on its next poll\n`);
    if (bumpResult) {
      if (bumpResult.bumped) {
        emit(values.quiet, stdout,
          `  remediation budget bumped: maxRounds ${bumpResult.priorMaxRounds} → ${bumpResult.newMaxRounds}\n` +
          `  (latest follow-up job: ${bumpResult.jobPath})\n`);
      } else if (bumpResult.reason === 'no-job-found') {
        emit(values.quiet, stdout,
          `  remediation budget bump: no-op (no prior follow-up job for this PR)\n`);
      } else {
        emit(values.quiet, stdout,
          `  remediation budget bump: skipped (${bumpResult.reason})\n`);
      }
    }
    return 0;
  }

  if (result.status === 'already-pending') {
    emit(values.quiet, stdout,
      `already-pending: ${target} is already queued for review; no change\n`);
    if (bumpResult && bumpResult.bumped) {
      emit(values.quiet, stdout,
        `  remediation budget bumped anyway: maxRounds ${bumpResult.priorMaxRounds} → ${bumpResult.newMaxRounds}\n`);
    }
    return 0;
  }

  // result.status === 'blocked' — surface the reason on stderr (this is
  // an error-side outcome regardless of --quiet, since it indicates the
  // requested action did not happen).
  stderr.write(`blocked (${result.reason}): ${target} cannot be retriggered\n`);
  return 1;
}

export { parseArgs, readReasonFromSource, readReviewRowSafely, main, UsageError, USAGE };

// Module-vs-CLI guard: only run main() when invoked as a script, so the
// test file can `import { main, ... }` without triggering execution.
if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = main(process.argv.slice(2));
  process.exit(exitCode);
}
