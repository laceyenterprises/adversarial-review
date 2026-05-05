import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getReviewRow,
  openReviewStateDb,
  ensureReviewStateSchema,
  requestReviewRereview,
} from './review-state.mjs';
import { bumpRemediationBudget, findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import {
  EX_DATAERR,
  EX_USAGE,
  appendOperatorMutationAuditRow,
  assertNoIdempotencyMismatch,
  findOperatorMutationAuditRow,
  resolveIdempotencyKey,
} from './operator-mutation-audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

const USAGE = `\
Usage:
  node src/retrigger-review.mjs --repo <owner/repo> --pr <number> --reason "..."
                                [--bump-budget <N> | --no-bump-budget]
                                [--idempotency-key <key>]
                                [--root-dir <path>] [--hq-root <path>]
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
        'bump-budget': { type: 'string' },
        'no-bump-budget': { type: 'boolean', default: false },
        'idempotency-key': { type: 'string' },
        'root-dir': { type: 'string' },
        'hq-root': { type: 'string' },
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

  const pr = Number.parseInt(parsed.values.pr, 10);
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new UsageError(`--pr must be a positive integer (got: ${parsed.values.pr})`);
  }

  const reasonSources = ['reason', 'reason-file', 'reason-stdin'].filter(
    (key) => parsed.values[key] !== undefined && parsed.values[key] !== false
  );
  if (reasonSources.length !== 1) {
    throw new UsageError('pass exactly one of --reason, --reason-file, or --reason-stdin');
  }

  if (parsed.values['no-bump-budget'] && parsed.values['bump-budget'] !== undefined) {
    throw new UsageError('--bump-budget and --no-bump-budget are mutually exclusive');
  }

  const bumpBudgetRaw = parsed.values['bump-budget'] ?? '1';
  const bumpBudget = Number.parseInt(String(bumpBudgetRaw), 10);
  if (!parsed.values['no-bump-budget'] && (!Number.isInteger(bumpBudget) || bumpBudget <= 0)) {
    throw new UsageError(`--bump-budget must be a positive integer (got: ${bumpBudgetRaw})`);
  }

  return {
    values: {
      ...parsed.values,
      pr,
      bumpBudget,
    },
    reasonSource: reasonSources[0],
  };
}

function readReasonFromSource(values, reasonSource, { stdinReader = readStdinSync } = {}) {
  if (reasonSource === 'reason') return values.reason;
  if (reasonSource === 'reason-file') return readFileSync(values['reason-file'], 'utf8');
  return stdinReader();
}

function readStdinSync() {
  return readFileSync(0, 'utf8');
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

function refuseReasonForReviewRow(reviewRow) {
  if (!reviewRow) return 'review-row-missing';
  if (reviewRow.pr_state !== 'open') return 'pr-not-open';
  if (['pending', 'reviewing', 'malformed'].includes(reviewRow.review_status)) {
    return reviewRow.review_status;
  }
  return null;
}

function makeAuditRow({
  ts,
  repo,
  pr,
  reason,
  operator,
  priorMaxRounds,
  newMaxRounds,
  jobKey,
  idempotencyKey,
  outcome,
}) {
  return {
    ts,
    verb: 'hq.adversarial.retrigger-review',
    repo,
    pr,
    reason,
    operator,
    priorMaxRounds,
    newMaxRounds,
    jobKey,
    idempotencyKey,
    outcome,
  };
}

function emit(stream, message, quiet) {
  if (!quiet) stream.write(message);
}

function main(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  stdinReader = readStdinSync,
  readReviewRow = readReviewRowSafely,
  rereview = requestReviewRereview,
  latestJobFinder = findLatestFollowUpJob,
  bumpBudgetImpl = bumpRemediationBudget,
  findAuditRow = findOperatorMutationAuditRow,
  appendAuditRow = appendOperatorMutationAuditRow,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return EX_USAGE;
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
    return EX_USAGE;
  }
  if (!reason || !reason.trim()) {
    stderr.write('error: --reason is required and must not be empty\n');
    return EX_USAGE;
  }

  const rootDir = values['root-dir'] ? resolve(values['root-dir']) : DEFAULT_ROOT_DIR;
  const hqRoot = values['hq-root'] ? resolve(values['hq-root']) : rootDir;
  const ts = new Date().toISOString();
  const operator = process.env.HQ_OPERATOR || process.env.USER || 'unknown';
  const { requestFingerprint, idempotencyKey } = resolveIdempotencyKey({
    verb: 'hq.adversarial.retrigger-review',
    repo: values.repo,
    pr: values.pr,
    reason,
    idempotencyKey: values['idempotency-key'],
  });

  try {
    const existingRow = findAuditRow(hqRoot, idempotencyKey);
    assertNoIdempotencyMismatch(existingRow, requestFingerprint);
    if (existingRow) {
      emit(stdout, `${JSON.stringify(existingRow)}\n`, values.quiet);
      return 0;
    }
  } catch (err) {
    stderr.write(`error: ${err.message}\n`);
    return err.exitCode || EX_DATAERR;
  }

  let reviewRow;
  try {
    reviewRow = readReviewRow({ rootDir, repo: values.repo, prNumber: values.pr });
  } catch (err) {
    stderr.write(`error: could not read review state: ${err.message}\n`);
    return EX_DATAERR;
  }

  const latestJob = latestJobFinder(rootDir, { repo: values.repo, prNumber: values.pr });
  const baseAudit = {
    ts,
    repo: values.repo,
    pr: values.pr,
    reason,
    operator,
    jobKey: latestJob?.job?.jobId || null,
    idempotencyKey,
  };

  const refusalReason = refuseReasonForReviewRow(reviewRow);
  if (refusalReason) {
    const row = makeAuditRow({
      ...baseAudit,
      priorMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
      newMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
      outcome: 'refused:not-eligible',
    });
    appendAuditRow(hqRoot, row);
    stderr.write(`refused:not-eligible: ${values.repo}#${values.pr} (${refusalReason})\n`);
    return 2;
  }

  let budgetResult = null;
  if (!values['no-bump-budget'] && latestJob) {
    try {
      budgetResult = bumpBudgetImpl({
        rootDir,
        repo: values.repo,
        prNumber: values.pr,
        bumpBudget: values.bumpBudget,
        auditEntry: {
          ts,
          verb: 'hq.adversarial.retrigger-review',
          reason,
          requestFingerprint,
          idempotencyKey,
          auditRow: null,
        },
      });
    } catch (err) {
      stderr.write(`error: ${err.message}\n`);
      return err.code === 'IDEMPOTENCY_KEY_MISMATCH' ? EX_DATAERR : EX_DATAERR;
    }

    if (!budgetResult.bumped && budgetResult.reason === 'job-active') {
      const row = makeAuditRow({
        ...baseAudit,
        priorMaxRounds: latestJob.job.remediationPlan?.maxRounds ?? null,
        newMaxRounds: latestJob.job.remediationPlan?.maxRounds ?? null,
        outcome: 'refused:job-active',
      });
      appendAuditRow(hqRoot, row);
      stderr.write(`refused:job-active: ${values.repo}#${values.pr}\n`);
      return 2;
    }
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
    return EX_DATAERR;
  }

  if (!result.triggered && result.status !== 'already-pending') {
    const row = makeAuditRow({
      ...baseAudit,
      priorMaxRounds: budgetResult?.priorMaxRounds ?? latestJob?.job?.remediationPlan?.maxRounds ?? null,
      newMaxRounds: budgetResult?.newMaxRounds ?? latestJob?.job?.remediationPlan?.maxRounds ?? null,
      outcome: 'refused:not-eligible',
    });
    appendAuditRow(hqRoot, row);
    stderr.write(`refused:not-eligible: ${values.repo}#${values.pr} (${result.reason})\n`);
    return 2;
  }

  const row = makeAuditRow({
    ...baseAudit,
    priorMaxRounds: budgetResult?.priorMaxRounds ?? latestJob?.job?.remediationPlan?.maxRounds ?? null,
    newMaxRounds: budgetResult?.newMaxRounds ?? latestJob?.job?.remediationPlan?.maxRounds ?? null,
    outcome: 'bumped',
  });
  appendAuditRow(hqRoot, row);
  emit(stdout, `${JSON.stringify(row)}\n`, values.quiet);
  return 0;
}

export { UsageError, USAGE, main, parseArgs, readReasonFromSource, readReviewRowSafely };

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
