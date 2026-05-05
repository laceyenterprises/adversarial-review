import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requeueFollowUpJobForNextRound } from './follow-up-jobs.mjs';
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
retrigger-remediation — force one off-cycle remediation round for a PR

Usage:
  node src/retrigger-remediation.mjs --repo <owner/repo> --pr <number> --reason "..."
  node src/retrigger-remediation.mjs --repo <owner/repo> --pr <number> --reason-file <path>
  node src/retrigger-remediation.mjs --repo <owner/repo> --pr <number> --reason-stdin < reason.md

Required:
  --repo <owner/repo>     Repository the PR lives in.
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
  --bump-budget <N>       Increment remediationPlan.maxRounds by N (default: 1).
  --no-bump-budget        Requeue without changing remediationPlan.maxRounds.
  --idempotency-key <key> Override the default sha256(verb:repo:pr:reason) key.
  --force-replay          Re-open an in-flight idempotency record after a
                          crash/interrupted operator run.
  --quiet                 Suppress informational stdout.
  -h, --help              Show this help.

Exit codes:
  0  requeued or replayed
  1  blocked (no follow-up job, ineligible job state, or an in-flight
     idempotency record)
  2  usage error (missing/invalid args)
  3  reason-input I/O error (e.g. --reason-file path unreadable)
  4  runtime error (could not write queue/audit state)
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

function emit(quiet, stream, msg) {
  if (!quiet) stream.write(msg);
}

function evaluateEligibility(job) {
  if (!job) {
    return { eligible: false, code: 'no-job', detail: 'no follow-up job exists for this PR' };
  }
  if (job.status === 'pending' || job.status === 'in_progress') {
    return { eligible: false, code: 'job-active', detail: `latest job ${job.jobId} is ${job.status}` };
  }
  if (job.status === 'failed') {
    return { eligible: true };
  }
  if (job.status === 'completed') {
    if (job?.reReview?.requested === true) {
      return { eligible: true };
    }
    return { eligible: false, code: 'completed-no-rereview', detail: `latest job ${job.jobId} completed without a durable rereview request` };
  }
  if (job.status === 'stopped') {
    const stopCode = String(job?.remediationPlan?.stop?.code || '');
    if (['max-rounds-reached', 'round-budget-exhausted'].includes(stopCode)) {
      return { eligible: true };
    }
    return { eligible: false, code: 'stopped-not-requeueable', detail: `latest job ${job.jobId} is stopped:${stopCode || 'unknown'}` };
  }
  return { eligible: false, code: 'not-eligible', detail: `latest job ${job.jobId} is ${job.status}` };
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

function main(argv, { stdout = process.stdout, stderr = process.stderr, stdinReader = readStdinSync } = {}) {
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
  const verb = 'hq.adversarial.retrigger-remediation';
  const fingerprint = requestFingerprint({
    verb,
    repo: values.repo,
    pr: values.pr,
    reason,
    bumpBudget: values.bumpBudget,
    bumpBudgetEnabled: values.bumpBudget > 0,
  });

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

  const latest = latestFollowUpJobForPr(rootDir, { repo: values.repo, pr: values.pr });
  const eligibility = evaluateEligibility(latest?.job || null);
  if (!eligibility.eligible) {
    stderr.write(`blocked (${eligibility.code}): ${target} ${eligibility.detail}\n`);
    return 1;
  }

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

  let bumped = {
    bumped: false,
    priorMaxRounds: currentMaxRounds(latest.job),
    newMaxRounds: currentMaxRounds(latest.job),
    jobPath: latest.jobPath,
    job: latest.job,
  };
  try {
    if (values.bumpBudget > 0) {
      bumped = bumpRemediationBudget({
        rootDir,
        repo: values.repo,
        prNumber: values.pr,
        bumpBy: values.bumpBudget,
        latestJobRecord: latest,
      });
      if (!bumped.bumped) {
        stderr.write(`blocked (${bumped.reason}): ${target} could not bump the remediation budget\n`);
        return 1;
      }
    }
    const requeued = requeueFollowUpJobForNextRound({
      rootDir,
      jobPath: bumped.jobPath || latest.jobPath,
      requestedAt: ts,
      requestedBy: values.operator || 'operator',
      reason: reason.trim(),
    });
    const auditRow = {
      ts,
      verb,
      repo: values.repo,
      pr: values.pr,
      reason: reason.trim(),
      operator: values.operator || 'operator',
      priorMaxRounds: bumped.priorMaxRounds,
      newMaxRounds: currentMaxRounds(requeued.job),
      jobKey: requeued.job.jobId,
      idempotencyKey: precheck.idempotencyKey,
      outcome: 'requeued',
    };
    appendJobOperatorAudit(requeued.jobPath, auditRow, { requestFingerprint: fingerprint });
    emitOperatorMutationAudit(auditRootDir, auditRow);
    recordIdempotentMutation(auditRootDir, {
      ts,
      idempotencyKey: precheck.idempotencyKey,
      requestFingerprint: fingerprint,
      auditRow,
    });

    emit(values.quiet, stdout,
      `requeued: ${target} -> ${requeued.job.status}\n` +
      `  maxRounds: ${auditRow.priorMaxRounds ?? 'unchanged'} -> ${auditRow.newMaxRounds ?? 'unchanged'}\n`);
    return 0;
  } catch (err) {
    stderr.write(`error: remediation retrigger failed: ${err.message}\n`);
    return 4;
  }
}

export {
  main,
  parseArgs,
  readReasonFromSource,
  UsageError,
  USAGE,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
