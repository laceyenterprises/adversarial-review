import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requeueFollowUpJobForNextRound } from './follow-up-jobs.mjs';
import { bumpRemediationBudget, findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import {
  EX_DATAERR,
  appendOperatorMutationAuditRow,
  assertNoIdempotencyMismatch,
  findOperatorMutationAuditRow,
  isCommittedOperatorMutationOutcome,
  resolveIdempotencyKey,
} from './operator-mutation-audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');
const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;
const EXIT_REASON_INPUT = 3;
const EXIT_RUNTIME = 4;

const USAGE = `\
Usage:
  node src/retrigger-remediation.mjs --repo <owner/repo> --pr <number> --reason "..."
                                     [options]

Required:
  --repo <owner/repo>            Repository slug
  --pr <number>                  Pull request number
  One of:
    --reason "..."               Inline operator reason
    --reason-file <path>         Read reason text from file
    --reason-stdin               Read reason text from stdin

Optional:
  --bump-budget <N>              Increase follow-up maxRounds before requeueing (default: 1)
  --idempotency-key <key>        Stable replay key for retry-safe operator calls
  --root-dir <path>              Tool root containing data/follow-up-jobs/
  --audit-root-dir <path>        Root that owns data/operator-mutations/
  --quiet                        Suppress JSON success output
  -h, --help                     Show this help text

Exit codes:
  0 success (requeued and budget updated, or idempotent replay of a prior success)
  1 blocked / refused (no eligible terminal job, active job, or requeue refused)
  2 usage error
  3 reason input error (--reason-file/--reason-stdin unreadable or empty reason)
  4 runtime error
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
        'idempotency-key': { type: 'string' },
        'root-dir': { type: 'string' },
        'audit-root-dir': { type: 'string' },
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
  const bumpBudgetRaw = parsed.values['bump-budget'] ?? '1';
  const bumpBudget = Number.parseInt(String(bumpBudgetRaw), 10);
  if (!Number.isInteger(bumpBudget) || bumpBudget <= 0) {
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

function remediationEligibility(job) {
  if (!job) return { ok: false, outcome: 'refused:no-job', detail: 'no-job' };
  if (job.status === 'pending' || job.status === 'inProgress') {
    return { ok: false, outcome: 'refused:job-active', detail: job.status };
  }
  if (job.status === 'completed' && job?.reReview?.requested !== true) {
    return { ok: false, outcome: 'refused:not-eligible', detail: 'completed-without-rereview-request' };
  }
  if (job.status === 'stopped') {
    const stopCode = job?.remediationPlan?.stop?.code || null;
    if (!['max-rounds-reached', 'round-budget-exhausted'].includes(stopCode)) {
      return { ok: false, outcome: 'refused:not-eligible', detail: `stopped:${stopCode || 'unknown'}` };
    }
  }
  if (!['completed', 'failed', 'stopped'].includes(job.status)) {
    return { ok: false, outcome: 'refused:not-eligible', detail: job.status };
  }
  return { ok: true, outcome: 'bumped', detail: job.status };
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
    verb: 'hq.adversarial.retrigger-remediation',
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

function appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr }) {
  try {
    appendAuditRow(auditRootDir, row);
    return true;
  } catch (err) {
    stderr.write(`error: could not append operator mutation audit row: ${err.message}\n`);
    return false;
  }
}

function appendIdempotencyMismatchAudit({
  appendAuditRow,
  auditRootDir,
  baseAudit,
  stderr,
}) {
  const row = makeAuditRow({
    ...baseAudit,
    priorMaxRounds: null,
    newMaxRounds: null,
    jobKey: null,
    outcome: 'refused:idempotency-mismatch',
  });
  if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
    return false;
  }
  stderr.write(`refused:idempotency-mismatch: ${baseAudit.repo}#${baseAudit.pr}\n`);
  return true;
}

function resolveAuditRootDir(values, rootDir) {
  if (values['hq-root']) {
    throw new UsageError('--hq-root is no longer supported; use --audit-root-dir');
  }
  const auditRootDir = values['audit-root-dir'] ? resolve(values['audit-root-dir']) : null;
  return auditRootDir || rootDir;
}

function main(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  stdinReader = readStdinSync,
  latestJobFinder = findLatestFollowUpJob,
  bumpBudgetImpl = bumpRemediationBudget,
  requeueImpl = requeueFollowUpJobForNextRound,
  findAuditRow = findOperatorMutationAuditRow,
  appendAuditRow = appendOperatorMutationAuditRow,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return EXIT_USAGE;
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
    return EXIT_REASON_INPUT;
  }
  if (!reason || !reason.trim()) {
    stderr.write('error: --reason is required and must not be empty\n');
    return EXIT_REASON_INPUT;
  }

  const rootDir = values['root-dir'] ? resolve(values['root-dir']) : DEFAULT_ROOT_DIR;
  let auditRootDir;
  try {
    auditRootDir = resolveAuditRootDir(values, rootDir);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const ts = new Date().toISOString();
  const operator = process.env.HQ_OPERATOR || process.env.USER || 'unknown';
  const baseAudit = {
    ts,
    repo: values.repo,
    pr: values.pr,
    reason,
    operator,
    idempotencyKey: null,
  };
  const { requestFingerprint, idempotencyKey } = resolveIdempotencyKey({
    verb: 'hq.adversarial.retrigger-remediation',
    repo: values.repo,
    pr: values.pr,
    reason,
    idempotencyKey: values['idempotency-key'],
  });
  baseAudit.idempotencyKey = idempotencyKey;

  try {
    const existingRow = findAuditRow(auditRootDir, idempotencyKey);
    assertNoIdempotencyMismatch(existingRow, requestFingerprint);
    if (existingRow && isCommittedOperatorMutationOutcome(existingRow.outcome)) {
      emit(stdout, `${JSON.stringify(existingRow)}\n`, values.quiet);
      return 0;
    }
  } catch (err) {
    if (err?.exitCode === EX_DATAERR || err?.code === 'IDEMPOTENCY_KEY_MISMATCH') {
      if (!appendIdempotencyMismatchAudit({
        appendAuditRow,
        auditRootDir,
        baseAudit,
        stderr,
      })) {
        return EXIT_RUNTIME;
      }
      return EXIT_USAGE;
    }
    stderr.write(`error: ${err.message}\n`);
    return EXIT_RUNTIME;
  }

  const latest = latestJobFinder(rootDir, { repo: values.repo, prNumber: values.pr });
  if (latest?.job && ['pending', 'inProgress'].includes(latest.job.status)) {
    let activeReplay = null;
    try {
      activeReplay = bumpBudgetImpl({
        rootDir,
        repo: values.repo,
        prNumber: values.pr,
        bumpBudget: values.bumpBudget,
        auditEntry: {
          ts,
          verb: 'hq.adversarial.retrigger-remediation',
          reason,
          requestFingerprint,
          idempotencyKey,
          auditRow: null,
        },
      });
    } catch (err) {
      if (err?.code === 'IDEMPOTENCY_KEY_MISMATCH') {
        if (!appendIdempotencyMismatchAudit({
          appendAuditRow,
          auditRootDir,
          baseAudit,
          stderr,
        })) {
          return EXIT_RUNTIME;
        }
        return EXIT_USAGE;
      }
      stderr.write(`error: ${err.message}\n`);
      return EXIT_RUNTIME;
    }

    if (activeReplay?.idempotent && activeReplay.job?.status === 'pending') {
      const row = makeAuditRow({
        ...baseAudit,
        priorMaxRounds: activeReplay.priorMaxRounds,
        newMaxRounds: activeReplay.newMaxRounds,
        jobKey: activeReplay.job?.jobId || latest.job.jobId,
        outcome: 'bumped',
      });
      if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
        return EXIT_RUNTIME;
      }
      emit(stdout, `${JSON.stringify(row)}\n`, values.quiet);
      return 0;
    }

    const row = makeAuditRow({
      ...baseAudit,
      priorMaxRounds: latest.job.remediationPlan?.maxRounds ?? null,
      newMaxRounds: latest.job.remediationPlan?.maxRounds ?? null,
      jobKey: latest.job.jobId || null,
      outcome: 'refused:job-active',
    });
    if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
      return EXIT_RUNTIME;
    }
    stderr.write(`refused:job-active: ${values.repo}#${values.pr} (${latest.job.status})\n`);
    return EXIT_BLOCKED;
  }

  const eligibility = remediationEligibility(latest?.job || null);
  if (!eligibility.ok) {
    const row = makeAuditRow({
      ...baseAudit,
      priorMaxRounds: latest?.job?.remediationPlan?.maxRounds ?? null,
      newMaxRounds: latest?.job?.remediationPlan?.maxRounds ?? null,
      jobKey: latest?.job?.jobId || null,
      outcome: eligibility.outcome,
    });
    if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
      return EXIT_RUNTIME;
    }
    stderr.write(`${eligibility.outcome}: ${values.repo}#${values.pr} (${eligibility.detail})\n`);
    return EXIT_BLOCKED;
  }

  let budgetResult;
  try {
    budgetResult = bumpBudgetImpl({
      rootDir,
      repo: values.repo,
      prNumber: values.pr,
      bumpBudget: values.bumpBudget,
      auditEntry: {
        ts,
        verb: 'hq.adversarial.retrigger-remediation',
        reason,
        requestFingerprint,
        idempotencyKey,
        auditRow: null,
      },
    });
  } catch (err) {
    if (err?.code === 'IDEMPOTENCY_KEY_MISMATCH') {
      if (!appendIdempotencyMismatchAudit({
        appendAuditRow,
        auditRootDir,
        baseAudit,
        stderr,
      })) {
        return EXIT_RUNTIME;
      }
      return EXIT_USAGE;
    }
    stderr.write(`error: ${err.message}\n`);
    return EXIT_RUNTIME;
  }

  if (!budgetResult.bumped) {
    const outcome = budgetResult.reason === 'job-active'
      ? 'refused:job-active'
      : 'refused:no-job';
    const row = makeAuditRow({
      ...baseAudit,
      priorMaxRounds: latest?.job?.remediationPlan?.maxRounds ?? null,
      newMaxRounds: latest?.job?.remediationPlan?.maxRounds ?? null,
      jobKey: latest?.job?.jobId || null,
      outcome,
    });
    if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
      return EXIT_RUNTIME;
    }
    stderr.write(`${outcome}: ${values.repo}#${values.pr}\n`);
    return EXIT_BLOCKED;
  }

  let requeueResult;
  try {
    requeueResult = requeueImpl({
      rootDir,
      jobPath: budgetResult.jobPath,
      requestedAt: ts,
      requestedBy: operator,
      reason,
    });
  } catch (err) {
    const row = makeAuditRow({
      ...baseAudit,
      priorMaxRounds: budgetResult.priorMaxRounds,
      newMaxRounds: budgetResult.newMaxRounds,
      jobKey: budgetResult.job?.jobId || latest?.job?.jobId || null,
      outcome: 'refused:requeue-failed',
    });
    if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
      return EXIT_RUNTIME;
    }
    stderr.write(`refused:requeue-failed: ${values.repo}#${values.pr} (${err.message})\n`);
    return EXIT_BLOCKED;
  }

  if (requeueResult.job.status !== 'pending') {
    const row = makeAuditRow({
      ...baseAudit,
      priorMaxRounds: budgetResult.priorMaxRounds,
      newMaxRounds: budgetResult.newMaxRounds,
      jobKey: requeueResult.job.jobId,
      outcome: 'refused:requeue-failed',
    });
    if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
      return EXIT_RUNTIME;
    }
    stderr.write(`refused:requeue-failed: ${values.repo}#${values.pr} (requeue did not produce pending)\n`);
    return EXIT_BLOCKED;
  }

  const row = makeAuditRow({
    ...baseAudit,
    priorMaxRounds: budgetResult.priorMaxRounds,
    newMaxRounds: budgetResult.newMaxRounds,
    jobKey: requeueResult.job.jobId,
    outcome: 'bumped',
  });
  if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
    return EXIT_RUNTIME;
  }
  emit(stdout, `${JSON.stringify(row)}\n`, values.quiet);
  return 0;
}

export { UsageError, USAGE, main, parseArgs, readReasonFromSource };

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
