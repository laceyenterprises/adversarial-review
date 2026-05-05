// retrigger-remediation.mjs — manual operator CLI to bump remediation
// round-budget for a PR by N (default 1) without re-arming first-pass review.
//
// Use case: a PR has converged review (reviewer is satisfied or close) but
// the round-budget gate has fired ("completed remediation rounds N/N exhaust
// the medium risk-class budget") and the operator wants ONE more cycle —
// without redoing first-pass review.
//
// If you want a full reset (re-review AND budget bump), use retrigger-review.
// retrigger-review now bumps budget by default; this script is the narrower
// budget-only operation.
//
// Mechanism: rewrites the latest follow-up job's `remediationPlan.maxRounds`
// + appends an audit row in `operatorRetriggerAudit[]`. The watcher's
// `summarizePRRemediationLedger` reads `latestMaxRounds` from this same
// field, so the next pass sees the higher cap and re-arms.

import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bumpRemediationBudget } from './operator-retrigger-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

const USAGE = `\
retrigger-remediation — bump per-PR remediation round-budget without re-arming first-pass review

Usage:
  node src/retrigger-remediation.mjs --repo <owner/repo> --pr <number> --reason "..."
  node src/retrigger-remediation.mjs --repo <owner/repo> --pr <number> --reason-file <path>
  node src/retrigger-remediation.mjs --repo <owner/repo> --pr <number> --reason-stdin < reason.md

Required:
  --repo <owner/repo>     Repository the PR lives in (e.g. laceyenterprises/agent-os).
  --pr <number>           PR number.
  Exactly one of:
    --reason "..."        Reason text inline.
    --reason-file <path>  Read reason from a file.
    --reason-stdin        Read reason from stdin.

Optional:
  --bump-by <N>           How many rounds to bump (default: 1).
  --root-dir <path>       Adversarial-review tool root (default: this script's parent).
  --quiet                 Suppress informational stdout; only the exit code matters.
  -h, --help              Show this help.

Exit codes:
  0  bumped (remediation budget increased; watcher will re-arm on next poll
     if first-pass review is also pending)
  1  no-op (no prior follow-up job exists for this PR — operator must
     retrigger review first; the resulting cycle creates the first job)
  2  usage error (missing/invalid args)
  3  reason-input I/O error (e.g. --reason-file path unreadable)
  4  runtime error (could not write the job; the failure message is printed
     to stderr without a stack trace)
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
        'bump-by': { type: 'string' },
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
    (key) => parsed.values[key] !== undefined && parsed.values[key] !== false,
  );
  if (reasonSources.length === 0) {
    throw new UsageError('one of --reason, --reason-file, or --reason-stdin is required');
  }
  if (reasonSources.length > 1) {
    throw new UsageError(
      `pass exactly one of --reason / --reason-file / --reason-stdin (got: ${reasonSources.join(', ')})`,
    );
  }

  let bumpBy = 1;
  if (parsed.values['bump-by'] !== undefined) {
    const n = Number.parseInt(parsed.values['bump-by'], 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== parsed.values['bump-by'].trim()) {
      throw new UsageError(`--bump-by must be a positive integer (got: ${parsed.values['bump-by']})`);
    }
    bumpBy = n;
  }

  return {
    values: {
      ...parsed.values,
      pr: prNumber,
      bumpBy,
    },
    reasonSource: reasonSources[0],
  };
}

function readReasonFromSource(values, reasonSource, { stdinReader = readStdinSync } = {}) {
  if (reasonSource === 'reason') return values.reason;
  if (reasonSource === 'reason-file') {
    return readFileSync(values['reason-file'], 'utf-8');
  }
  return stdinReader();
}

function readStdinSync() {
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

  let result;
  try {
    result = bumpBudget({
      rootDir,
      repo: values.repo,
      prNumber: values.pr,
      bumpBy: values.bumpBy,
      reason: `retrigger-remediation: ${reason.trim()}`,
      by: 'operator-cli',
    });
  } catch (err) {
    stderr.write(`error: budget bump failed: ${err.message}\n`);
    return 4;
  }

  if (result.bumped) {
    emit(values.quiet, stdout,
      `bumped: ${target} — remediation maxRounds ${result.priorMaxRounds} → ${result.newMaxRounds}\n` +
      `  job: ${result.jobPath}\n` +
      `  watcher will re-arm on its next poll if first-pass review is still pending\n`);
    return 0;
  }

  if (result.reason === 'no-job-found') {
    stderr.write(
      `no-op: no prior follow-up job exists for ${target}.\n` +
      `  Run \`retrigger-review\` first — the resulting remediation cycle creates\n` +
      `  the first job, and a future bump can land on that.\n`,
    );
    return 1;
  }

  stderr.write(`error: ${result.reason || 'unknown'}\n`);
  return 4;
}

export { parseArgs, readReasonFromSource, main, UsageError, USAGE };

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = main(process.argv.slice(2));
  process.exit(exitCode);
}
