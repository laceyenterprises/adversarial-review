import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requeueFollowUpJobForNextRound } from './follow-up-jobs.mjs';
import { bumpRemediationBudget, findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import {
  EX_DATAERR,
  EX_USAGE,
  appendOperatorMutationAuditRow,
  assertNoIdempotencyMismatch,
  findOperatorMutationAuditRow,
  isCommittedOperatorMutationOutcome,
  resolveIdempotencyKey,
} from './operator-mutation-audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

const USAGE = `\
Usage:
  node src/retrigger-remediation.mjs --repo <owner/repo> --pr <number> --reason "..."
                                     [--bump-budget <N>]
                                     [--idempotency-key <key>]
                                     [--root-dir <path>] [--audit-root-dir <path>]
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

function resolveAuditRootDir(values, rootDir) {
  const auditRootDir = values['audit-root-dir'] ? resolve(values['audit-root-dir']) : null;
  const legacyAuditRootDir = values['hq-root'] ? resolve(values['hq-root']) : null;
  if (auditRootDir && legacyAuditRootDir && auditRootDir !== legacyAuditRootDir) {
    throw new UsageError('--audit-root-dir and --hq-root must point to the same path when both are provided');
  }
  return auditRootDir || legacyAuditRootDir || rootDir;
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
  let auditRootDir;
  try {
    auditRootDir = resolveAuditRootDir(values, rootDir);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return EX_USAGE;
  }
  const ts = new Date().toISOString();
  const operator = process.env.HQ_OPERATOR || process.env.USER || 'unknown';
  const { requestFingerprint, idempotencyKey } = resolveIdempotencyKey({
    verb: 'hq.adversarial.retrigger-remediation',
    repo: values.repo,
    pr: values.pr,
    reason,
    idempotencyKey: values['idempotency-key'],
  });

  try {
    const existingRow = findAuditRow(auditRootDir, idempotencyKey);
    assertNoIdempotencyMismatch(existingRow, requestFingerprint);
    if (existingRow && isCommittedOperatorMutationOutcome(existingRow.outcome)) {
      emit(stdout, `${JSON.stringify(existingRow)}\n`, values.quiet);
      return 0;
    }
  } catch (err) {
    stderr.write(`error: ${err.message}\n`);
    return err.exitCode || EX_DATAERR;
  }

  const latest = latestJobFinder(rootDir, { repo: values.repo, prNumber: values.pr });
  const eligibility = remediationEligibility(latest?.job || null);
  if (!eligibility.ok) {
    const row = makeAuditRow({
      ts,
      repo: values.repo,
      pr: values.pr,
      reason,
      operator,
      priorMaxRounds: latest?.job?.remediationPlan?.maxRounds ?? null,
      newMaxRounds: latest?.job?.remediationPlan?.maxRounds ?? null,
      jobKey: latest?.job?.jobId || null,
      idempotencyKey,
      outcome: eligibility.outcome,
    });
    appendAuditRow(auditRootDir, row);
    stderr.write(`${eligibility.outcome}: ${values.repo}#${values.pr} (${eligibility.detail})\n`);
    return 2;
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
    stderr.write(`error: ${err.message}\n`);
    return err.code === 'IDEMPOTENCY_KEY_MISMATCH' ? EX_DATAERR : EX_DATAERR;
  }

  if (!budgetResult.bumped) {
    const outcome = budgetResult.reason === 'job-active'
      ? 'refused:job-active'
      : 'refused:no-job';
    const row = makeAuditRow({
      ts,
      repo: values.repo,
      pr: values.pr,
      reason,
      operator,
      priorMaxRounds: latest?.job?.remediationPlan?.maxRounds ?? null,
      newMaxRounds: latest?.job?.remediationPlan?.maxRounds ?? null,
      jobKey: latest?.job?.jobId || null,
      idempotencyKey,
      outcome,
    });
    appendAuditRow(auditRootDir, row);
    stderr.write(`${outcome}: ${values.repo}#${values.pr}\n`);
    return 2;
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
      ts,
      repo: values.repo,
      pr: values.pr,
      reason,
      operator,
      priorMaxRounds: budgetResult.priorMaxRounds,
      newMaxRounds: budgetResult.newMaxRounds,
      jobKey: budgetResult.job?.jobId || latest?.job?.jobId || null,
      idempotencyKey,
      outcome: 'refused:not-eligible',
    });
    appendAuditRow(auditRootDir, row);
    stderr.write(`refused:not-eligible: ${values.repo}#${values.pr} (${err.message})\n`);
    return 2;
  }

  if (requeueResult.job.status !== 'pending') {
    const row = makeAuditRow({
      ts,
      repo: values.repo,
      pr: values.pr,
      reason,
      operator,
      priorMaxRounds: budgetResult.priorMaxRounds,
      newMaxRounds: budgetResult.newMaxRounds,
      jobKey: requeueResult.job.jobId,
      idempotencyKey,
      outcome: 'refused:not-eligible',
    });
    appendAuditRow(auditRootDir, row);
    stderr.write(`refused:not-eligible: ${values.repo}#${values.pr} (requeue did not produce pending)\n`);
    return 2;
  }

  const row = makeAuditRow({
    ts,
    repo: values.repo,
    pr: values.pr,
    reason,
    operator,
    priorMaxRounds: budgetResult.priorMaxRounds,
    newMaxRounds: budgetResult.newMaxRounds,
    jobKey: requeueResult.job.jobId,
    idempotencyKey,
    outcome: 'bumped',
  });
  appendAuditRow(auditRootDir, row);
  emit(stdout, `${JSON.stringify(row)}\n`, values.quiet);
  return 0;
}

export { UsageError, USAGE, main, parseArgs, readReasonFromSource };

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
