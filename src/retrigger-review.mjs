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

import { requestReviewRereview } from './review-state.mjs';

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
  --quiet                 Suppress informational stdout; only the exit code matters.
  -h, --help              Show this help.

Exit codes:
  0  triggered or already-pending (a review will run / is already queued)
  1  blocked (review row missing, PR not open, or malformed-title-terminal)
  2  usage error (missing/invalid args)
  3  I/O error (e.g. --reason-file path unreadable)
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

  return {
    values: {
      ...parsed.values,
      pr: prNumber,
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

function main(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  stdinReader = readStdinSync,
  rereview = requestReviewRereview,
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

  const result = rereview({
    rootDir,
    repo: values.repo,
    prNumber: values.pr,
    reason,
  });

  const target = `${values.repo}#${values.pr}`;

  if (result.triggered) {
    emit(values.quiet, stdout,
      `triggered: ${target} — review_status reset to 'pending'\n` +
      `  rereview_requested_at: ${result.reviewRow.rereview_requested_at}\n` +
      `  watcher will pick this up on its next poll\n`);
    return 0;
  }

  if (result.status === 'already-pending') {
    emit(values.quiet, stdout,
      `already-pending: ${target} is already queued for review; no change\n`);
    return 0;
  }

  // result.status === 'blocked' — surface the reason on stderr (this is
  // an error-side outcome regardless of --quiet, since it indicates the
  // requested action did not happen).
  stderr.write(`blocked (${result.reason}): ${target} cannot be retriggered\n`);
  return 1;
}

export { parseArgs, readReasonFromSource, main, UsageError, USAGE };

// Module-vs-CLI guard: only run main() when invoked as a script, so the
// test file can `import { main, ... }` without triggering execution.
if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = main(process.argv.slice(2));
  process.exit(exitCode);
}
