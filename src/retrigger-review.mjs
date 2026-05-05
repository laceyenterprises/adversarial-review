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
import {
  appendJobOperatorAudit,
  beginIdempotentMutation,
  bumpRemediationBudget,
  currentMaxRounds,
  defaultIdempotencyKey,
  emitOperatorMutationAudit,
  ensureIdempotency,
  latestFollowUpJobForPr,
  recordIdempotentMutation,
  requestFingerprint,
} from './operator-retrigger-helpers.mjs';

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
  --audit-root-dir <path> Base directory for durable operator mutation records
                          (default: --root-dir, stored under data/operator-mutations/).
  --operator <ref>        Operator identity written to the audit row.
  --bump-budget <N>       Also bump the latest follow-up job's remediation
                          maxRounds by N (default: 1) so the watcher's
                          round-budget gate re-arms for one fresh remediation
                          cycle.
  --no-bump-budget        Opt out of the budget bump.
  --idempotency-key <key> Override the default sha256(verb:repo:pr:reason) key.
  --force-replay          Re-open an in-flight idempotency record after a
                          crash/interrupted operator run.
  --allow-failed-reset    Permit retriggering a row whose review_status is 'failed'.
  --quiet                 Suppress informational stdout; only the exit code matters.
  -h, --help              Show this help.

Exit codes:
  0  triggered or already-pending (a review will run / is already queued)
  1  blocked (review row missing, PR not open, malformed-title-terminal,
     review_status='reviewing', review_status='failed' without
     --allow-failed-reset, or an in-flight idempotency record)
  2  usage error (missing/invalid args)
  3  reason-input I/O error (e.g. --reason-file path unreadable)
  4  runtime / database error (could not open or write state; the failure
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
        'audit-root-dir': { type: 'string' },
        operator: { type: 'string' },
        'bump-budget': { type: 'string' },
        'no-bump-budget': { type: 'boolean', default: false },
        'idempotency-key': { type: 'string' },
        'force-replay': { type: 'boolean', default: false },
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

  let bumpBudget = 1;
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

function readStdinSync() {
  return readFileSync(0, 'utf-8');
}

function readReasonFromSource(values, reasonSource, { stdinReader = readStdinSync } = {}) {
  if (reasonSource === 'reason') return values.reason;
  if (reasonSource === 'reason-file') return readFileSync(values['reason-file'], 'utf-8');
  return stdinReader();
}

function readReviewRowSafely({ rootDir, repo, prNumber }) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return getReviewRow(db, { repo, prNumber });
  } finally {
    db.close();
  }
}

function emit(quiet, stream, msg) {
  if (!quiet) stream.write(msg);
}

function handleIdempotencyPrecheck({ stdout, stderr, quiet, target, auditRootDir, values, ts, fingerprint, verb, reason }) {
  const idempotencyKey = values['idempotency-key'] || defaultIdempotencyKey({
    verb,
    repo: values.repo,
    pr: values.pr,
    reason,
  });
  try {
    const priorAuditRow = ensureIdempotency(auditRootDir, {
      ts,
      idempotencyKey,
      requestFingerprint: fingerprint,
    });
    if (priorAuditRow) {
      emit(quiet, stdout, `replayed: ${target} (${priorAuditRow.outcome})\n`);
      return { replayed: true, idempotencyKey };
    }
  } catch (err) {
    if (err.code === 'IDEMPOTENCY_KEY_IN_FLIGHT') {
      stderr.write(`blocked (idempotency-in-flight): ${target} already has an unfinished operator mutation for this key\n`);
      return { blocked: true, rc: 1, idempotencyKey };
    }
    if (err.code === 'IDEMPOTENCY_KEY_MISMATCH') {
      stderr.write(`blocked (idempotency-key-mismatch): ${target} reused an idempotency key for a different request\n`);
      return { blocked: true, rc: 1, idempotencyKey };
    }
    throw err;
  }
  return { idempotencyKey };
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
  if (!reason?.trim()) {
    stderr.write('error: reason is empty after reading\n');
    return 3;
  }

  const rootDir = values['root-dir'] ? resolve(values['root-dir']) : DEFAULT_ROOT_DIR;
  const auditRootDir = values['audit-root-dir'] ? resolve(values['audit-root-dir']) : rootDir;
  const target = `${values.repo}#${values.pr}`;
  const ts = new Date().toISOString();
  const verb = 'hq.adversarial.retrigger-review';
  const fingerprint = requestFingerprint({
    verb,
    repo: values.repo,
    pr: values.pr,
    reason,
    bumpBudget: values.bumpBudget,
    bumpBudgetEnabled: values.bumpBudget > 0,
  });

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
      `  Resetting it would clear failed_at + failure_message before anyone has read it.\n`
    );
    return 1;
  }
  if (reviewRow && reviewRow.review_status === 'reviewing') {
    stderr.write(
      `blocked (review-in-flight): ${target} is in 'reviewing' state.\n` +
      `  Wait for the in-flight reviewer to finish before retriggering.\n`
    );
    return 1;
  }

  const precheck = handleIdempotencyPrecheck({
    stdout,
    stderr,
    quiet: values.quiet,
    target,
    auditRootDir,
    values,
    ts,
    fingerprint,
    verb,
    reason,
  });
  if (precheck.replayed) return 0;
  if (precheck.blocked) return precheck.rc;

  try {
    beginIdempotentMutation(auditRootDir, {
      ts,
      idempotencyKey: precheck.idempotencyKey,
      requestFingerprint: fingerprint,
      forceReplay: values['force-replay'],
    });
  } catch (err) {
    if (err.code === 'IDEMPOTENCY_KEY_IN_FLIGHT') {
      stderr.write(`blocked (idempotency-in-flight): ${target} already has an unfinished operator mutation for this key\n`);
      return 1;
    }
    if (err.code === 'IDEMPOTENCY_KEY_MISMATCH') {
      stderr.write(`blocked (idempotency-key-mismatch): ${target} reused an idempotency key for a different request\n`);
      return 1;
    }
    stderr.write(`error: could not open idempotency record: ${err.message}\n`);
    return 4;
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

  let bumpResult = null;
  let latestJobRecord = null;
  if (values.bumpBudget > 0 && (result.triggered || result.status === 'already-pending')) {
    latestJobRecord = latestFollowUpJobForPr(rootDir, { repo: values.repo, pr: values.pr });
    try {
      bumpResult = bumpBudget({
        rootDir,
        repo: values.repo,
        prNumber: values.pr,
        bumpBy: values.bumpBudget,
        latestJobRecord,
      });
    } catch (err) {
      stderr.write(`error: budget bump failed: ${err.message}\n`);
      return 4;
    }
  }

  if (result.status !== 'already-pending' && !result.triggered) {
    stderr.write(`blocked (${result.reason}): ${target} cannot be retriggered\n`);
    return 1;
  }

  let priorMaxRounds = latestJobRecord ? currentMaxRounds(latestJobRecord.job) : null;
  let newMaxRounds = priorMaxRounds;
  let jobPath = latestJobRecord?.jobPath || null;
  let jobKey = latestJobRecord?.job?.jobId || null;
  if (bumpResult?.bumped) {
    priorMaxRounds = bumpResult.priorMaxRounds;
    newMaxRounds = bumpResult.newMaxRounds;
    jobPath = bumpResult.jobPath;
    jobKey = bumpResult.job.jobId;
  }

  const auditRow = {
    ts,
    verb,
    repo: values.repo,
    pr: values.pr,
    reason: reason.trim(),
    operator: values.operator || 'operator',
    priorMaxRounds,
    newMaxRounds,
    jobKey,
    idempotencyKey: precheck.idempotencyKey,
    outcome: result.triggered ? 'triggered' : 'already-pending',
  };

  try {
    if (jobPath) {
      appendJobOperatorAudit(jobPath, auditRow, { requestFingerprint: fingerprint });
    }
    emitOperatorMutationAudit(auditRootDir, auditRow);
    recordIdempotentMutation(auditRootDir, {
      ts,
      idempotencyKey: precheck.idempotencyKey,
      requestFingerprint: fingerprint,
      auditRow,
    });
  } catch (err) {
    stderr.write(`error: could not record operator audit: ${err.message}\n`);
    return 4;
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
        emit(values.quiet, stdout, '  remediation budget bump: no-op (no prior follow-up job for this PR)\n');
      } else {
        emit(values.quiet, stdout, `  remediation budget bump: skipped (${bumpResult.reason})\n`);
      }
    }
    return 0;
  }

  emit(values.quiet, stdout, `already-pending: ${target} is already queued for review; no change\n`);
  if (bumpResult?.bumped) {
    emit(values.quiet, stdout, `  remediation budget bumped anyway: maxRounds ${bumpResult.priorMaxRounds} → ${bumpResult.newMaxRounds}\n`);
  }
  return 0;
}

export {
  main,
  parseArgs,
  readReasonFromSource,
  readReviewRowSafely,
  UsageError,
  USAGE,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
