import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  forceResetReviewToPending,
  getReviewRow,
  openReviewStateDb,
  ensureReviewStateSchema,
  requestReviewRereview,
} from './review-state.mjs';
import { isActiveFollowUpJobStatus } from './follow-up-jobs.mjs';
import { bumpRemediationBudget, findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import {
  EX_DATAERR,
  appendOperatorMutationAuditRow,
  assertNoIdempotencyMismatch,
  findOperatorMutationAuditRow,
  isCommittedOperatorMutationOutcome,
  resolveIdempotencyKey,
} from './operator-mutation-audit.mjs';
import { buildCodePrSubjectIdentity } from './identity-shapes.mjs';
import { normalizeOperatorRetriggerReason } from './retrigger-review-reason.mjs';
import { stopFollowUpJobWithWorkerCancel } from './follow-up-stop.mjs';
import { cancelActiveReview } from './review-cancel.mjs';
import { isPgidAlive } from './process-group-identity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');
const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;
const EXIT_REASON_INPUT = 3;
const EXIT_RUNTIME = 4;
const ACTIVE_REVIEW_CANCEL_WAIT_MS = 5_000;
const ACTIVE_REVIEW_CANCEL_POLL_MS = 250;

const USAGE = `\
Usage:
  node src/retrigger-review.mjs --repo <owner/repo> --pr <number> --reason "..."
                                [options]

Required:
  --repo <owner/repo>            Repository slug
  --pr <number>                  Pull request number
  One of:
    --reason "..."               Inline operator reason
    --reason-file <path>         Read reason text from file
    --reason-stdin               Read reason text from stdin

Optional:
  --bump-budget <N>              Increase follow-up maxRounds before retriggering (default: 1)
  --no-bump-budget               Retrigger review without changing remediation budget
  --idempotency-key <key>        Stable replay key for retry-safe operator calls
  --allow-failed-reset           Permit manual reset of failed / failed-orphan review rows
  --exact-head-now               Safe operator recovery for "review this exact head now"
  --cancel-active-review         In --exact-head-now mode, cancel an active reviewer before reset
  --allow-active-review-reset    In --exact-head-now mode, force-reset an active reviewer row without cancellation
  --root-dir <path>              Tool root containing data/reviews.db
  --audit-root-dir <path>        Root that owns data/operator-mutations/
  --quiet                        Suppress JSON success output
  -h, --help                     Show this help text

Exit codes:
  0 success (review re-armed, already pending, or idempotent replay of a prior success)
  1 blocked / refused (review row missing, PR closed, active review, failed row without override, or active job)
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
        'no-bump-budget': { type: 'boolean', default: false },
        'idempotency-key': { type: 'string' },
        'root-dir': { type: 'string' },
        'audit-root-dir': { type: 'string' },
        'hq-root': { type: 'string' },
        'allow-failed-reset': { type: 'boolean', default: false },
        'exact-head-now': { type: 'boolean', default: false },
        'cancel-active-review': { type: 'boolean', default: false },
        'allow-active-review-reset': { type: 'boolean', default: false },
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
  if (parsed.values['cancel-active-review'] && parsed.values['allow-active-review-reset']) {
    throw new UsageError('--cancel-active-review and --allow-active-review-reset are mutually exclusive');
  }
  if (
    (parsed.values['cancel-active-review'] || parsed.values['allow-active-review-reset'])
    && !parsed.values['exact-head-now']
  ) {
    throw new UsageError('--cancel-active-review and --allow-active-review-reset require --exact-head-now');
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

function resolveAuditRootDir(values, rootDir) {
  if (values['hq-root']) {
    throw new UsageError('--hq-root is no longer supported; use --audit-root-dir');
  }
  const auditRootDir = values['audit-root-dir'] ? resolve(values['audit-root-dir']) : null;
  return auditRootDir || rootDir;
}

function refuseReasonForReviewRow(reviewRow, { allowFailedReset = false } = {}) {
  if (!reviewRow) return 'review-row-missing';
  if (reviewRow.pr_state !== 'open') return 'pr-not-open';
  switch (reviewRow.review_status) {
    case 'pending':
    case 'posted':
      return null;
    case 'failed':
      return allowFailedReset ? null : 'failed';
    case 'failed-orphan':
      return allowFailedReset ? null : 'failed-orphan';
    case 'reviewing':
    case 'malformed':
      return reviewRow.review_status;
    default:
      return `unknown-status:${reviewRow.review_status ?? 'missing'}`;
  }
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
  exactHeadNow = false,
  staleFollowUpStopped = false,
  activeReviewReset = null,
}) {
  const subjectIdentity = buildCodePrSubjectIdentity({ repo, prNumber: pr });
  return {
    ts,
    verb: 'hq.adversarial.retrigger-review',
    repo,
    pr,
    domainId: subjectIdentity.domainId,
    subjectExternalId: subjectIdentity.subjectExternalId,
    revisionRef: subjectIdentity.revisionRef,
    reason,
    operator,
    priorMaxRounds,
    newMaxRounds,
    jobKey,
    idempotencyKey,
    outcome,
    exactHeadNow,
    staleFollowUpStopped,
    activeReviewReset,
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

function buildReviewAuditOutcome({ reviewStatus, budgetResult, bumpRequested, latestJob }) {
  const reviewPrefix = reviewStatus === 'already-pending' ? 'already-pending' : 'triggered';
  if (budgetResult?.bumped) return `${reviewPrefix}+bumped`;
  if (bumpRequested && !latestJob) return `${reviewPrefix}:no-job`;
  return reviewPrefix;
}

function writeReviewRefusal(stderr, { repo, pr, refusalReason }) {
  if (refusalReason === 'reviewing') {
    stderr.write(
      [
        `refused:not-eligible: ${repo}#${pr} (reviewing)`,
        'A reviewer subprocess is currently in flight; resetting now would queue a second reviewer and risk a duplicate GitHub review.',
        'Recovery path:',
        '1. Re-run with --exact-head-now --cancel-active-review to cancel and reset in one audited step.',
        '2. If the reviewer is already gone and only the row is stale, re-run with --exact-head-now --allow-active-review-reset.',
        '',
      ].join('\n')
    );
    return;
  }

  if (refusalReason === 'failed') {
    stderr.write(
      [
        `refused:not-eligible: ${repo}#${pr} (failed)`,
        'The watcher already retries failed review rows automatically.',
        'Resetting now would clear failed_at and failure_message before an operator can inspect the diagnostic evidence.',
        'Re-run with --allow-failed-reset only after reviewing the failure.',
        '',
      ].join('\n')
    );
    return;
  }

  stderr.write(`refused:not-eligible: ${repo}#${pr} (${refusalReason})\n`);
}

function resolveReviewHead(reviewRow) {
  const revisionRef = String(reviewRow?.revision_ref || '').trim();
  if (revisionRef) return revisionRef;
  const reviewerHeadSha = String(reviewRow?.reviewer_head_sha || '').trim();
  return reviewerHeadSha || null;
}

function isStaleActiveFollowUpJob(latestJob, reviewHead) {
  if (!latestJob?.job || !isActiveFollowUpJobStatus(latestJob.job.status)) return false;
  const jobHead = String(latestJob.job.revisionRef || '').trim();
  return Boolean(jobHead && reviewHead && jobHead !== reviewHead);
}

async function waitForReviewerExit(cancelResult, {
  waitMs = ACTIVE_REVIEW_CANCEL_WAIT_MS,
  pollMs = ACTIVE_REVIEW_CANCEL_POLL_MS,
  processKill = process.kill,
  sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }),
} = {}) {
  const pgid = Number(cancelResult?.target?.id);
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return { checked: false, exited: cancelResult?.error === 'process-group-not-found' };
  }

  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    if (!isPgidAlive(pgid, processKill)) {
      return { checked: true, exited: true, pgid };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.max(1, pollMs));
  } while (true);

  return { checked: true, exited: false, pgid };
}

async function main(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  stdinReader = readStdinSync,
  readReviewRow = readReviewRowSafely,
  rereview = requestReviewRereview,
  forceResetReview = forceResetReviewToPending,
  latestJobFinder = findLatestFollowUpJob,
  bumpBudgetImpl = bumpRemediationBudget,
  findAuditRow = findOperatorMutationAuditRow,
  appendAuditRow = appendOperatorMutationAuditRow,
  stopFollowUpJobImpl = stopFollowUpJobWithWorkerCancel,
  cancelActiveReviewImpl = cancelActiveReview,
  waitForReviewerExitImpl = waitForReviewerExit,
  isPgidAliveImpl = isPgidAlive,
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
  reason = normalizeOperatorRetriggerReason(reason);

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
    jobKey: null,
    idempotencyKey: null,
  };
  const { requestFingerprint, idempotencyKey } = resolveIdempotencyKey({
    verb: 'hq.adversarial.retrigger-review',
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
      const row = makeAuditRow({
        ...baseAudit,
        priorMaxRounds: null,
        newMaxRounds: null,
        outcome: 'refused:idempotency-mismatch',
        exactHeadNow: values['exact-head-now'],
      });
      if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
        return EXIT_RUNTIME;
      }
      stderr.write(`refused:idempotency-mismatch: ${values.repo}#${values.pr}\n`);
      return EXIT_USAGE;
    }
    stderr.write(`error: ${err.message}\n`);
    return EXIT_RUNTIME;
  }

  let reviewRow;
  try {
    reviewRow = readReviewRow({ rootDir, repo: values.repo, prNumber: values.pr });
  } catch (err) {
    stderr.write(`error: could not read review state: ${err.message}\n`);
    return EXIT_RUNTIME;
  }

  let latestJob = latestJobFinder(rootDir, { repo: values.repo, prNumber: values.pr });
  baseAudit.jobKey = latestJob?.job?.jobId || null;
  let staleFollowUpStopped = false;
  let activeReviewReset = null;

  if (values['exact-head-now'] && isStaleActiveFollowUpJob(latestJob, resolveReviewHead(reviewRow))) {
    try {
      await stopFollowUpJobImpl({
        rootDir,
        jobPath: latestJob.jobPath,
        requestedAt: ts,
        requestedBy: operator,
        reason: `Superseded by operator exact-head re-review request for ${resolveReviewHead(reviewRow)}.`,
        cancelWorker: latestJob.job.status === 'in_progress',
      });
    } catch (err) {
      stderr.write(`error: could not stop stale follow-up job: ${err.message}\n`);
      return EXIT_RUNTIME;
    }
    staleFollowUpStopped = true;
    latestJob = latestJobFinder(rootDir, { repo: values.repo, prNumber: values.pr });
    baseAudit.jobKey = latestJob?.job?.jobId || null;
  }

  if (values['exact-head-now'] && reviewRow?.review_status === 'reviewing') {
    if (values['cancel-active-review']) {
      let cancelResult;
      try {
        cancelResult = await cancelActiveReviewImpl({
          rootDir,
          repo: values.repo,
          prNumber: values.pr,
          requestedAt: ts,
          requestedBy: operator,
          reason: `Cancelled for exact-head re-review recovery. ${reason}`,
        });
      } catch (err) {
        stderr.write(`error: could not cancel active review: ${err.message}\n`);
        return EXIT_RUNTIME;
      }

      if (!cancelResult.signalled && cancelResult.error !== 'process-group-not-found') {
        const row = makeAuditRow({
          ...baseAudit,
          priorMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
          newMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
          outcome: 'refused:active-review-cancel-failed',
          exactHeadNow: true,
          staleFollowUpStopped,
          activeReviewReset: 'cancel-failed',
        });
        if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
          return EXIT_RUNTIME;
        }
        stderr.write(`refused:active-review-cancel-failed: ${values.repo}#${values.pr} (${cancelResult.error || 'unknown'})\n`);
        return EXIT_BLOCKED;
      }

      let exitResult;
      try {
        exitResult = await waitForReviewerExitImpl(cancelResult);
      } catch (err) {
        stderr.write(`error: could not confirm active reviewer exit: ${err.message}\n`);
        return EXIT_RUNTIME;
      }
      if (exitResult.checked && exitResult.exited === false) {
        const row = makeAuditRow({
          ...baseAudit,
          priorMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
          newMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
          outcome: 'refused:active-review-still-running',
          exactHeadNow: true,
          staleFollowUpStopped,
          activeReviewReset: 'cancel-timeout',
        });
        if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
          return EXIT_RUNTIME;
        }
        stderr.write(`refused:active-review-still-running: ${values.repo}#${values.pr}\n`);
        return EXIT_BLOCKED;
      }

      let resetResult;
      try {
        resetResult = forceResetReview({
          rootDir,
          repo: values.repo,
          prNumber: values.pr,
          requestedAt: ts,
          reason,
          expectedReviewStatus: 'reviewing',
          expectedReviewerSessionUuid: reviewRow.reviewer_session_uuid || null,
          expectedReviewerPgid: Number.isInteger(Number(reviewRow.reviewer_pgid))
            ? Number(reviewRow.reviewer_pgid)
            : null,
        });
        if (!resetResult.reset) {
          const refreshed = readReviewRow({ rootDir, repo: values.repo, prNumber: values.pr });
          if (refreshed?.review_status === 'pending') {
            resetResult = { reset: true, reviewRow: refreshed };
          } else if (['failed', 'failed-orphan'].includes(refreshed?.review_status)) {
            resetResult = forceResetReview({
              rootDir,
              repo: values.repo,
              prNumber: values.pr,
              requestedAt: ts,
              reason,
              expectedReviewStatus: refreshed.review_status,
              expectedReviewerSessionUuid: refreshed.reviewer_session_uuid || null,
              expectedReviewerPgid: Number.isInteger(Number(refreshed.reviewer_pgid))
                ? Number(refreshed.reviewer_pgid)
                : null,
            });
          }
        }
      } catch (err) {
        stderr.write(`error: could not reset cancelled active review: ${err.message}\n`);
        return EXIT_RUNTIME;
      }
      if (!resetResult.reset) {
        stderr.write(`error: active review reset lost its guard for ${values.repo}#${values.pr}\n`);
        return EXIT_RUNTIME;
      }
      reviewRow = resetResult.reviewRow;
      activeReviewReset = 'cancelled';
    } else if (values['allow-active-review-reset']) {
      const reviewerPgid = Number(reviewRow.reviewer_pgid);
      if (Number.isInteger(reviewerPgid) && reviewerPgid > 0) {
        let reviewerAlive;
        try {
          reviewerAlive = isPgidAliveImpl(reviewerPgid);
        } catch (err) {
          stderr.write(`error: could not probe active reviewer process group: ${err.message}\n`);
          return EXIT_RUNTIME;
        }
        if (reviewerAlive) {
          const row = makeAuditRow({
            ...baseAudit,
            priorMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
            newMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
            outcome: 'refused:active-review-still-running',
            exactHeadNow: true,
            staleFollowUpStopped,
            activeReviewReset: 'allow-refused-live',
          });
          if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
            return EXIT_RUNTIME;
          }
          stderr.write(`refused:active-review-still-running: ${values.repo}#${values.pr}\n`);
          return EXIT_BLOCKED;
        }
      }
      let resetResult;
      try {
        resetResult = forceResetReview({
          rootDir,
          repo: values.repo,
          prNumber: values.pr,
          requestedAt: ts,
          reason,
          expectedReviewStatus: 'reviewing',
          expectedReviewerSessionUuid: reviewRow.reviewer_session_uuid || null,
          expectedReviewerPgid: Number.isInteger(reviewerPgid) ? reviewerPgid : null,
        });
      } catch (err) {
        stderr.write(`error: could not reset stale active review: ${err.message}\n`);
        return EXIT_RUNTIME;
      }
      if (!resetResult.reset) {
        stderr.write(`error: active review override reset lost its guard for ${values.repo}#${values.pr}\n`);
        return EXIT_RUNTIME;
      }
      reviewRow = resetResult.reviewRow;
      activeReviewReset = 'allowed';
    }
  }

  const refusalReason = refuseReasonForReviewRow(reviewRow, {
    allowFailedReset: values['allow-failed-reset'],
  });
  if (refusalReason) {
    const row = makeAuditRow({
      ...baseAudit,
      priorMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
      newMaxRounds: latestJob?.job?.remediationPlan?.maxRounds ?? null,
      outcome: 'refused:not-eligible',
      exactHeadNow: values['exact-head-now'],
      staleFollowUpStopped,
      activeReviewReset,
    });
    if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
      return EXIT_RUNTIME;
    }
    writeReviewRefusal(stderr, { repo: values.repo, pr: values.pr, refusalReason });
    return EXIT_BLOCKED;
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
      return EXIT_RUNTIME;
    }

    if (!budgetResult.bumped && budgetResult.reason === 'job-active') {
      const row = makeAuditRow({
        ...baseAudit,
        priorMaxRounds: latestJob.job.remediationPlan?.maxRounds ?? null,
        newMaxRounds: latestJob.job.remediationPlan?.maxRounds ?? null,
        outcome: 'refused:job-active',
        exactHeadNow: values['exact-head-now'],
        staleFollowUpStopped,
        activeReviewReset,
      });
      if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
        return EXIT_RUNTIME;
      }
      stderr.write(`refused:job-active: ${values.repo}#${values.pr}\n`);
      return EXIT_BLOCKED;
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
    return EXIT_RUNTIME;
  }

  if (!result.triggered && result.status !== 'already-pending') {
    const row = makeAuditRow({
      ...baseAudit,
      priorMaxRounds: budgetResult?.priorMaxRounds ?? latestJob?.job?.remediationPlan?.maxRounds ?? null,
      newMaxRounds: budgetResult?.newMaxRounds ?? latestJob?.job?.remediationPlan?.maxRounds ?? null,
      outcome: 'refused:not-eligible',
      exactHeadNow: values['exact-head-now'],
      staleFollowUpStopped,
      activeReviewReset,
    });
    if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
      return EXIT_RUNTIME;
    }
    stderr.write(`refused:not-eligible: ${values.repo}#${values.pr} (${result.reason})\n`);
    return EXIT_BLOCKED;
  }

  const row = makeAuditRow({
    ...baseAudit,
    priorMaxRounds: budgetResult?.priorMaxRounds ?? latestJob?.job?.remediationPlan?.maxRounds ?? null,
    newMaxRounds: budgetResult?.newMaxRounds ?? latestJob?.job?.remediationPlan?.maxRounds ?? null,
    outcome: buildReviewAuditOutcome({
      reviewStatus: result.status,
      budgetResult,
      bumpRequested: !values['no-bump-budget'],
      latestJob,
    }),
    exactHeadNow: values['exact-head-now'],
    staleFollowUpStopped,
    activeReviewReset,
  });
  if (!appendTerminalAuditRow({ appendAuditRow, auditRootDir, row, stderr })) {
    return EXIT_RUNTIME;
  }
  emit(stdout, `${JSON.stringify(row)}\n`, values.quiet);
  return 0;
}

export {
  UsageError,
  USAGE,
  main,
  normalizeOperatorRetriggerReason,
  parseArgs,
  readReasonFromSource,
  readReviewRowSafely,
  resolveReviewHead,
  isStaleActiveFollowUpJob,
  waitForReviewerExit,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(EXIT_RUNTIME);
  });
}
