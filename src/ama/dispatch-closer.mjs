/**
 * AMA-03 — Adversarial Merge Authority closer dispatch path.
 *
 * The watcher's settled-success hook calls `maybeDispatchAmaCloser`
 * BEFORE the existing merge-agent dispatch. When AMA is enabled and the
 * canonical eligibility predicate from SPEC §4.2 returns `eligible:true`,
 * this module dispatches a hammer worker via `hq dispatch` and returns
 * `{ dispatched: true, lrqId, dispatchId }`. The caller skips the
 * merge-agent dispatch on that tick.
 *
 * When `cfg.enabled === false` OR the eligibility predicate fails, this
 * module is a no-op — returns `{ dispatched: false, reason }` and the
 * caller falls through to the existing merge-agent dispatch path
 * (preserved verbatim until AMA-06A/06N flips that around).
 *
 * Default-off discipline (SPEC §4.8):
 *
 *   - With no operator config, `cfg.enabled` is `false` per the
 *     AMA-01 schema defaults. The whole dispatch path is dark.
 *   - There is NO `enabled=true` fallthrough that overrides
 *     eligibility — the predicate is the only gate.
 *
 * @module ama/dispatch-closer
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeFileAtomic } from '../atomic-write.mjs';
import { ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE } from '../config-loader.mjs';
import {
  readBuildCompletionProducerEvidence,
  readBuildCompletionSignalForPr,
} from '../session-ledger-read-adapter.mjs';
import {
  beginReviewerPass,
  completeReviewerPass,
  readWorkerRunTokenUsageResult,
} from '../reviewer-pass-tokens.mjs';
import {
  amaAuditFilePath,
  amaAuditTraceRef,
  composeAmaTrailers,
  readAmaAuditEntry,
  writeAmaAuditEntry,
} from './audit.mjs';
import {
  AMA_CLOSER_LEASE_STATUS,
  acquireAmaCloserLease,
  deleteAmaCloserLease,
  readAmaCloserLease,
  updateAmaCloserLease,
} from './closer-lease.mjs';
import { isEligibleForAmaClosure } from './eligibility.mjs';
import { resolveCloserDispatchHarness } from './harness-fallback.mjs';
import {
  HAMMER_RETRY_CAP_EXHAUSTED_REASON,
  HAMMER_RETRY_CAP_LIFETIME_EXHAUSTED_REASON,
  HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE,
  HAMMER_RETRY_CAP_SUPPRESSION_STATE,
  HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
  evaluateHammerRetryCap,
  normalizeHammerLifetimeDispatchCeiling,
  markHammerRetryCapExhausted,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
} from './hammer-retry-cap.mjs';
import { deliverAlert } from '../alert-delivery.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBMODULE_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_HQ_PATH = '/Users/airlock/.local/bin/hq';
const DEFAULT_HQ_ROOT = '/Users/airlock/agent-os-hq';
const DEFAULT_PROJECT = 'adversarial-merge-authority';
const AGENT_OS_TOOLING_REPO = 'agent-os';
const ADVERSARIAL_REVIEW_REPO = 'adversarial-review';
const HAMMER_TEMPLATE_PATH = join(SUBMODULE_ROOT, 'templates', 'hammer-prompt.md');
const FINAL_HAMMER_TERMINAL_REMEDIATION_WAIVER_REASONS = new Set([
  'blocking-findings-present',
  'blocking-findings-unknown',
  'non-blocking-findings-present',
  'non-blocking-findings-unknown',
  'verdict-not-settled-success',
]);

// Auto-hammer (2026-06-19): before the remediation cycle is exhausted, route
// only the eligibility-miss reasons that a hammer TERMINAL remediation pass can
// clear on its own — strict non-blocking churn, mergeability repair, or red CI.
//
// Once the bounded remediation cycle IS exhausted, the contract changes: the
// hammer is the terminal rescue lane. It gets dispatched for any eligibility
// miss, remediates the final adversarial review comments (blocking and
// non-blocking), fixes red CI, posts the audit closeout, and then re-validates
// the exact live head fail-closed before merge. The validated strict-mode HAM
// terminal remediation is the exhausted-round adversarial-verdict merge
// authority; no fresh settled-success verdict or operator-approved override is
// required for the adversarial verdict gate.
const HAMMER_AUTO_REMEDIABLE_MISS_REASONS = new Set([
  'non-blocking-findings-present',
  'blocking-findings-present',
  'verdict-not-settled-success', // strict mode emits this alongside the above
  'pr-not-mergeable', // hammer rebases onto main / resolves the conflict, then merges
  'ci-not-green', // hammer fixes the failing required checks (green-main bar), then merges
]);
const HAMMER_ROUTE_ACTION_REASONS = new Set([
  'blocking-findings-present',
  'non-blocking-findings-present',
  'verdict-not-settled-success',
  'pr-not-mergeable',
  'ci-not-green',
]);
const HAMMER_ROUTE_STRUCTURAL_BLOCK_REASONS = new Set([
  'ama-disabled',
  'pr-not-open',
  'pr-is-draft',
  'risk-class-not-permitted',
  'branch-protection-missing-gate',
  'fast-merge-state-unsupported',
]);

export function isHammerRemediableEligibilityMiss(reasons, options = {}) {
  if (!Array.isArray(reasons) || reasons.length === 0) return false;
  if (options?.reviewCycleExhausted === true) {
    if (reasons.includes('stale-review-head') && !options?.allowStaleReviewHeadHammerResume) {
      return false;
    }
    return true;
  }
  // The hammer must have something it can actually act on: non-blocking findings
  // to remediate, a not-mergeable state (conflict / behind) to rebase+resolve, or
  // red CI to fix.
  const hasActionable =
    reasons.includes('non-blocking-findings-present') ||
    reasons.includes('blocking-findings-present') ||
    reasons.includes('pr-not-mergeable') ||
    reasons.includes('ci-not-green');
  if (!hasActionable) return false;
  // And EVERY reason must be hammer-remediable — a co-occurring blocking finding,
  // stale head, etc. means NOT auto-hammer (those go through rounds / operator).
  return reasons.every((reason) => HAMMER_AUTO_REMEDIABLE_MISS_REASONS.has(reason));
}

function hammerRouteReasonsFromTrace(verdict) {
  const reasons = [];
  const trace = verdict?.trace || {};
  const blocking = trace.verdict?.blockingFindings;
  const nonBlocking = trace.verdict?.nonBlockingFindings;
  if (blocking?.known === true && Number(blocking.count) > 0) {
    reasons.push('blocking-findings-present');
  }
  if (nonBlocking?.known === true && Number(nonBlocking.count) > 0) {
    reasons.push('non-blocking-findings-present');
  }
  if (trace.mergeability?.mergeableState && trace.mergeability.mergeableState !== 'MERGEABLE') {
    reasons.push('pr-not-mergeable');
  }
  if (trace.ciGreen?.green === false) {
    reasons.push('ci-not-green');
  }
  return reasons;
}

function isHammerRouteStructurallyBlocked(reasons) {
  if (!Array.isArray(reasons)) return false;
  return reasons.some((reason) => (
    HAMMER_ROUTE_STRUCTURAL_BLOCK_REASONS.has(reason) ||
    String(reason || '').startsWith('label-')
  ));
}

export function namedAmaNoDispatchReason(reason, reasons = []) {
  if (reason === 'not-eligible') {
    const why = Array.isArray(reasons) && reasons.length
      ? String(reasons[0] || '').trim()
      : '';
    return `not-eligible:${why || 'unknown'}`;
  }
  return reason;
}

function noAmaDispatch(result) {
  const reason = String(result?.reason || 'unknown');
  return {
    ...result,
    namedReason: result?.namedReason || namedAmaNoDispatchReason(reason, result?.reasons),
  };
}

// In-memory debounce for the exhaustion page, keyed on the stable suppression
// series (repo + PR + jobKey). The persisted `alertedAt` on the ledger is the
// cross-restart source of truth, but if the suppression WRITE persistently fails
// (disk full / permissions), `alertEmitted` never lands on disk and every tick
// would re-page — an alert storm. This process-local set suppresses the re-page
// within the long-lived follow-up daemon even when the ledger write keeps failing.
// A genuinely fresh review series (new jobKey) uses a new key and still alerts.
// A daemon restart clears it, which at most re-pages once (not a storm) and
// correctly re-surfaces a still-broken disk.
const HAMMER_RETRY_CAP_ALERTED_SERIES = new Set();

export function _resetHammerRetryCapAlertDebounceForTests() {
  HAMMER_RETRY_CAP_ALERTED_SERIES.clear();
}

/**
 * Fail loud when the per-PR hammer retry cap is exhausted.
 *
 * Emits a GBI / alert-bus operator alert naming the repo + PR + head + attempt
 * count, marks the PR suppressed (PR-scoped, anchored to the stable job key so
 * head churn can't clear it), and returns the non-dispatch result. Fail-open: if
 * the alert transport is down the suppression + log still happen and the closer
 * never crashes — the ledger records that the alert did NOT go out so a later
 * tick retries it. If instead the ledger WRITE fails, an in-memory series
 * debounce prevents the operator page from storming every tick while the disk
 * problem persists (the persist failure is logged distinctly).
 */
async function suppressHammerRetryCapExhaustion({
  rootDir,
  identity,
  repo,
  prNumber,
  jobKey,
  headSha,
  attemptCount,
  lifetime = false,
  workerClass,
  existingRecord,
  alertAlreadyEmitted,
  deliverAlertImpl,
  logger,
  now,
}) {
  const attemptTotal = Number(attemptCount || 0);
  const suppressionReason = lifetime
    ? HAMMER_RETRY_CAP_LIFETIME_EXHAUSTED_REASON
    : HAMMER_RETRY_CAP_EXHAUSTED_REASON;
  const suppressionState = lifetime
    ? HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE
    : HAMMER_RETRY_CAP_SUPPRESSION_STATE;
  const eventName = lifetime
    ? 'ama_closer.hammer_retry_cap_lifetime_exhausted'
    : 'ama_closer.hammer_retry_cap_exhausted';
  logAmaCloserDispatchEvent(logger, eventName, {
    repo,
    prNumber,
    headSha,
    jobKey,
    attemptCount: attemptTotal,
    cap: HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
    suppressionState,
    message:
      `${suppressionReason}; PR not closing — operator intervention required; `
      + 'further hammer dispatch suppressed to protect quota',
  });

  // Only page the operator ON THE TRANSITION (first exhaustion) or when a prior
  // suppressed tick failed to deliver the alert. Repeated suppressed ticks must
  // not re-page — debounced by the persisted `alertedAt` (cross-restart) AND an
  // in-memory series guard (survives a persistently-failing ledger write).
  const alertSeriesKey = `${repo}\0${prNumber}\0${jobKey || ''}`;
  let alertEmitted = alertAlreadyEmitted;
  if (
    !alertAlreadyEmitted
    && !HAMMER_RETRY_CAP_ALERTED_SERIES.has(alertSeriesKey)
    && typeof deliverAlertImpl === 'function'
  ) {
    const shortHead = String(headSha || 'unknown').slice(0, 12);
    const text =
      `Adversarial-review hammer retry cap exhausted for ${repo}#${prNumber} `
      + `(head ${shortHead}, ${attemptTotal} hammer dispatches). `
      + 'PR not closing — operator intervention required; further hammer dispatch '
      + 'suppressed to protect quota. (Re-hammer loop guard; see the 2026-07-05 '
      + '189-hammer / codex-quota-burn incident, e.g. #3116 hammered ×10.)';
    try {
      await deliverAlertImpl(text, {
        event: eventName,
        payload: {
          repo,
          prNumber,
          headSha,
          jobKey,
          attemptCount: attemptTotal,
          cap: HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
          suppressionState,
        },
      });
      alertEmitted = true;
      // Record in-process that this series has been paged, so a failing ledger
      // write below cannot cause a re-page storm on subsequent ticks.
      HAMMER_RETRY_CAP_ALERTED_SERIES.add(alertSeriesKey);
    } catch (alertErr) {
      // Fail-open: never let a down alert transport crash the closer. The
      // suppression state below still lands, and alertEmitted stays false so a
      // later tick retries the page.
      logger?.error?.(JSON.stringify({
        event: 'ama_closer.hammer_retry_cap_alert_failed',
        repo,
        prNumber,
        headSha,
        error: alertErr?.message || String(alertErr),
      }));
    }
  }

  try {
    markHammerRetryCapExhausted(rootDir, identity, {
      jobKey,
      headSha,
      attemptCount: attemptTotal,
      alertEmitted,
      lifetime,
      now,
    });
  } catch (persistErr) {
    // Even if the suppression ledger write fails we must not crash; log and fall
    // through with the non-dispatch decision. The cap still holds this tick, and
    // the in-memory series guard above stops the operator page from storming on
    // subsequent ticks while the write keeps failing — but the durable
    // suppression state did NOT land, so surface that distinctly for the operator.
    logger?.error?.(JSON.stringify({
      event: 'ama_closer.hammer_retry_cap_persist_failed',
      repo,
      prNumber,
      jobKey,
      alertEmitted,
      message:
        'hammer retry-cap suppression state failed to persist; cap held in-memory '
        + 'this process but will NOT survive a daemon restart until the ledger '
        + 'write succeeds — operator should check disk/permissions',
      error: persistErr?.message || String(persistErr),
    }));
  }

  return noAmaDispatch({
    dispatched: false,
    // skipMergeAgent keeps the watcher from falling through to a merge-agent
    // dispatch (coexistence treats this as ama-pending, not a recoverable
    // failure) — suppression must stop ALL automated dispatch, not swap lanes.
    skipMergeAgent: true,
    reason: suppressionReason,
    needsOperator: true,
    suppressionState,
    attemptCount: attemptTotal,
    alertEmitted,
    workerClass: existingRecord?.workerClass || workerClass,
    dispatchId: existingRecord?.dispatchId || existingRecord?.launchRequestId || null,
    launchRequestId: existingRecord?.launchRequestId || null,
    promptPath: existingRecord?.promptPath || null,
  });
}

function hammerCloserWorkerId(prNumber) {
  const normalized = String(prNumber || '').trim();
  if (!/^[0-9]+$/.test(normalized)) return null;
  return `hammer-ama-pr-${normalized}`;
}

async function cleanupHammerCloserWorker({
  prNumber,
  workerClass,
  existingRecord = null,
  hqPath,
  hqRoot,
  execFileImpl,
  logger = console,
  reason,
}) {
  const effectiveWorkerClass = String(existingRecord?.workerClass || workerClass || '').trim();
  if (effectiveWorkerClass !== 'hammer') return null;
  const workerId = hammerCloserWorkerId(prNumber);
  if (!workerId) return null;
  const args = ['worker', 'tear-down', workerId, '--force', '--root', hqRoot];
  for (let attempt = 0; attempt <= AMA_CLOSER_TEARDOWN_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await execFileImpl(hqPath, args, {
        env: process.env,
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
        killSignal: 'SIGTERM',
      });
      logger.info?.(JSON.stringify({
        event: 'ama_closer.hammer_worker_cleanup',
        workerId,
        reason,
        status: 'ok',
        attempts: attempt + 1,
      }));
      return { ok: true, workerId, reason, attempts: attempt + 1 };
    } catch (err) {
      const error = String(err?.stderr || err?.message || err);
      if (isWorkerTearDownNotFoundError(error)) {
        logger.info?.(JSON.stringify({
          event: 'ama_closer.hammer_worker_cleanup',
          workerId,
          reason,
          status: 'not-found',
          attempts: attempt + 1,
        }));
        return { ok: true, workerId, reason, alreadyAbsent: true, attempts: attempt + 1 };
      }
      const transient = isTransientHqDispatchError(error);
      if (transient && attempt < AMA_CLOSER_TEARDOWN_TRANSIENT_RETRY_DELAYS_MS.length) {
        logger.warn?.(JSON.stringify({
          event: 'ama_closer.hammer_worker_cleanup',
          workerId,
          reason,
          status: 'retrying',
          attempt: attempt + 1,
          error,
        }));
        await sleep(AMA_CLOSER_TEARDOWN_TRANSIENT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      logger.warn?.(JSON.stringify({
        event: 'ama_closer.hammer_worker_cleanup',
        workerId,
        reason,
        status: 'failed',
        attempts: attempt + 1,
        transient,
        error,
      }));
      return { ok: false, workerId, reason, attempts: attempt + 1, error };
    }
  }
  return { ok: false, workerId, reason, error: 'unreachable-teardown-state' };
}

function isWorkerTearDownNotFoundError(err) {
  const detail = errDetailText(err);
  if (!detail) return false;
  return detail.includes('worker not found')
    || detail.includes('worker does not exist')
    || detail.includes('no worker with id')
    || detail.includes('no such worker')
    || detail.includes('service not found')
    || detail.includes('could not find service')
    || detail.includes('not loaded')
    || detail.includes('no such process');
}

function assertHammerCleanupSucceeded(hammerCleanup) {
  if (!hammerCleanup || hammerCleanup.ok === true) return;
  throw new Error(
    `AMA hammer worker teardown failed for ${hammerCleanup.workerId || 'unknown-worker'}: ` +
    `${hammerCleanup.error || 'unknown error'}`,
  );
}

/**
 * Decide whether the HAM terminal-remediation prompt (`hammer-prompt.md`) is
 * warranted for this closure, given the eligibility verdict.
 *
 * Per AMA SPEC §1.1.1, HAM terminal remediation "may be used only after the
 * final adversarial review for a PR has blocking or non-blocking findings that
 * the HAM worker remediates directly on top of the reviewed head." The
 * terminal-remediation mandate (a non-empty HAM provenance commit plus a
 * `Remediated-Findings` audit comment) is therefore only meaningful when there
 * is actually something to remediate.
 *
 * Selecting `hammer-prompt.md` purely off `workerClass === 'hammer'` — which is
 * now the default — would hand the terminal-remediation mandate to *every*
 * unpinned AMA closure, including clean, finding-free PRs. For those there is
 * nothing to remediate, so the closer would either stall (HAM evidence cannot
 * exist) or be pushed to invent an unreviewed post-review source change just to
 * satisfy the non-empty-diff contract.
 *
 * Terminal remediation is warranted when the eligibility trace shows standing
 * findings (blocking or non-blocking) OR when a closure path explicitly waived
 * a findings gate (validated HAM terminal-remediation evidence, or
 * final-hammer review-cycle exhaustion with a relevant waived findings reason).
 * Otherwise the daemon clean route should have handled the PR before this
 * dispatch surface is reached.
 *
 * @param {{ trace?: object }} verdict — result of `isEligibleForAmaClosure`.
 * @returns {boolean}
 */
export function amaClosureNeedsTerminalRemediation(verdict) {
  const trace = verdict?.trace;
  if (!trace) {
    // Conservative fallback: with no trace we cannot prove the closure is
    // clean, so preserve the prior (workerClass-only) behavior and allow the
    // hammer mandate rather than silently downgrading a possibly-dirty close.
    return true;
  }

  const blocking = trace.verdict?.blockingFindings;
  const nonBlocking = trace.verdict?.nonBlockingFindings;
  const blockingPresent = blocking?.known === true && Number(blocking.count) > 0;
  const nonBlockingPresent = nonBlocking?.known === true && Number(nonBlocking.count) > 0;
  if (blockingPresent || nonBlockingPresent) {
    return true;
  }

  // HAM terminal-remediation evidence means a worker already remediated
  // findings, so the HAM mandate remains appropriate even if the live counts
  // now read clean.
  const hamActive = trace.hamTerminalRemediation?.active === true;
  if (hamActive) {
    return true;
  }

  // `finalHammer.active` only means the review cycle is exhausted. A clean
  // exhausted final round must not inherit the HAM remediation mandate unless
  // final-hammer actually waived a finding or unsettled-verdict gate.
  const finalHammerWaivedTerminalGate = trace.finalHammer?.active === true
    && Array.isArray(trace.finalHammer?.waived)
    && trace.finalHammer.waived.some((reason) => (
      FINAL_HAMMER_TERMINAL_REMEDIATION_WAIVER_REASONS.has(reason)
    ));
  if (finalHammerWaivedTerminalGate) {
    return true;
  }

  return false;
}

const AMA_CLOSER_DISPATCH_SCHEMA_VERSION = 1;
const AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000];
const AMA_CLOSER_TEARDOWN_TRANSIENT_RETRY_DELAYS_MS = [250, 1_000];
const AMA_CLOSER_HQ_DISPATCH_LAUNCH_WINDOW_MS = 90_000;
const AMA_CLOSER_HQ_DISPATCH_MAX_ATTEMPTS = AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS.length + 1;
const AMA_CLOSER_TOKEN_ROLLUP_POLL_DELAYS_MS = [500, 1_000, 2_000, 5_000];
const AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS = (
  AMA_CLOSER_HQ_DISPATCH_LAUNCH_WINDOW_MS * AMA_CLOSER_HQ_DISPATCH_MAX_ATTEMPTS
)
  + AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
  + (
    AMA_CLOSER_TOKEN_ROLLUP_POLL_DELAYS_MS.reduce((total, delay) => total + delay, 0)
    * AMA_CLOSER_HQ_DISPATCH_MAX_ATTEMPTS
  );
export const AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS = 30 * 60 * 1000;
const AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS = [250, 1_000, 5_000];
export const AMA_CLOSER_REDISPATCH_BOUND = 2;
const AMA_CLOSER_BRANCH_HOLDER_BLOCK_BOUND = 3;
const AMA_CLOSER_ACTIVE_STATUSES = new Set(['running', 'starting', 'blocked', 'stalled']);
const AMA_CLOSER_TERMINAL_HOLD_STATUSES = new Set(['succeeded']);
const AMA_CLOSER_RETRYABLE_STATUSES = new Set([
  'failed',
  'cancelled',
  'canceled',
  'superseded',
  'not-found',
  'unverified-terminal-success',
]);
const MERGE_CLASS_ORCHESTRATION_MODES = new Set(ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE);
const AMA_CLOSER_AUDIT_TERMINAL_OUTCOMES = new Set([
  'succeeded',
  'failed-without-merge',
  'deferred',
  'superseded',
]);

/**
 * Detect a dispatch record frozen mid-`hq dispatch` by an external SIGTERM.
 *
 * The canonical case is a main-catchup deploy bounce of the watcher landing in
 * the ~90s window of the closer's `hq dispatch` execFile (the watcher's launchd
 * `kickstart -k` SIGTERMs the whole process group). The record is written
 * `state: 'dispatching'` immediately BEFORE the launch and is only advanced to
 * `dispatched` (on success, with an lrq/dispatchId) or `dispatch-failed` (on a
 * thrown error, with `lastError`) AFTER the call returns or throws. A kill in
 * between leaves it at `dispatching` with no launchRequestId, no dispatchId, and
 * no lastError, plus a `pending` lease that is provably no longer live —
 * distinguishable from a genuine completed attempt and from a healthy watcher
 * still blocked inside the launch.
 *
 * An interruption is NOT a completed attempt: it must not consume the redispatch
 * bound. Otherwise a couple of routine deploy bounces during closer dispatch
 * wedge the PR forever — the closer never launches and the merge-agent fallback
 * is refused (observed 2026-06-14: 10 eligible PRs stuck at retryCount=2,
 * zero autonomous merges for hours).
 */
export function isInterruptedInFlightAmaCloserDispatch(record, lease = null, options = {}) {
  return hasInterruptedInFlightAmaCloserDispatchShape(record)
    && isReclaimablePendingAmaCloserLease(lease, options);
}

function hasInterruptedInFlightAmaCloserDispatchShape(record) {
  return Boolean(
    record
      && record.state === 'dispatching'
      && !record.launchRequestId
      && !record.dispatchId
      && !record.lastError,
  );
}

function parseTimeMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function isPidAlive(pid, processKillImpl = process.kill) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  try {
    processKillImpl(numericPid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    return true;
  }
}

function isReclaimablePendingAmaCloserLease(lease, { now = null, processKillImpl = process.kill } = {}) {
  if (lease?.status !== AMA_CLOSER_LEASE_STATUS.PENDING) return false;

  const pidAlive = isPidAlive(lease.watcherPid, processKillImpl);
  if (pidAlive === false) return true;

  const acquiredAtMs = parseTimeMs(lease.acquiredAt);
  const nowMs = parseTimeMs(now || new Date().toISOString());
  return acquiredAtMs !== null
    && nowMs !== null
    && nowMs - acquiredAtMs >= AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS;
}

export function isReclaimableDispatchedAmaCloserLease(lease, { now = null } = {}) {
  if (lease?.status !== AMA_CLOSER_LEASE_STATUS.DISPATCHED) return false;
  if (lease.terminalOutcome !== null && lease.terminalOutcome !== undefined) return false;

  const updatedAtMs = parseTimeMs(lease.updatedAt || lease.acquiredAt);
  const nowMs = parseTimeMs(now || new Date().toISOString());
  return updatedAtMs !== null
    && nowMs !== null
    && nowMs - updatedAtMs >= AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS;
}

function finalizeAmaCloserLeaseBestEffort({
  rootDir,
  leaseIdentity,
  terminalOutcome,
  now,
  logger,
  repo,
  prNumber,
}) {
  try {
    updateAmaCloserLease({
      rootDir,
      ...leaseIdentity,
      status: AMA_CLOSER_LEASE_STATUS.TERMINAL,
      terminalOutcome,
      now,
    });
    return true;
  } catch (err) {
    logger?.warn?.(JSON.stringify({
      event: 'ama_closer.lease_terminal_finalize_failed',
      repo,
      prNumber,
      headSha: leaseIdentity?.headSha || null,
      terminalOutcome,
      error: err?.message || String(err),
    }));
    return false;
  }
}

/**
 * @typedef {Object} DispatchResult
 * @property {boolean}  dispatched
 * @property {string=}  reason       — populated when `dispatched=false`.
 * @property {string[]=} reasons     — populated when `reason=not-eligible`.
 * @property {string=}  workerClass  — populated when `dispatched=true`.
 * @property {string=}  dispatchId   — populated when `dispatched=true`.
 * @property {string=}  launchRequestId — populated when `dispatched=true`.
 * @property {string=}  promptPath   — populated when `dispatched=true`.
 * @property {boolean=} skipMergeAgent — populated when AMA owns the
 * merge path for this tick even though no fresh launch occurred.
 */

function amaCloserDispatchDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
}

function amaCloserPromptDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-prompts');
}

function sanitizeDispatchPathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function amaCloserDispatchFilePath(rootDir, { repo, prNumber, headSha } = {}) {
  const safeRepo = sanitizeDispatchPathSegment(String(repo ?? '').replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(headSha || 'no-sha'));
  return join(
    amaCloserDispatchDir(rootDir),
    `${safeRepo}-pr-${Number(prNumber)}-${safeSha}.json`
  );
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function readAmaCloserDispatchRecord(rootDir, identity) {
  return readJsonFile(amaCloserDispatchFilePath(rootDir, identity));
}

function writeAmaCloserDispatchRecord(rootDir, identity, doc) {
  mkdirSync(amaCloserDispatchDir(rootDir), { recursive: true });
  const filePath = amaCloserDispatchFilePath(rootDir, identity);
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return filePath;
}

function logAmaCloserDispatchEvent(logger, event, fields = {}) {
  const sink = logger && typeof logger.info === 'function'
    ? logger.info.bind(logger)
    : console.log.bind(console);
  sink(JSON.stringify({ event, ...fields }));
}

// Best-effort operator alert that the closer/hammer fell back to another harness
// because its configured provider is quota-grounded. The structured
// `ama_closer.harness_fallback` audit log is the durable record; this is the
// human-facing ping. Fail OPEN: a down alert transport (missing ALERT_TO, HTTP
// error, …) must never block the merge the fallback exists to enable.
async function emitHarnessFallbackAlert({
  deliverAlertImpl,
  repo,
  prNumber,
  harness,
  logger = console,
  env = process.env,
}) {
  let deliver = deliverAlertImpl;
  if (deliver === null || deliver === undefined) {
    try {
      ({ deliverAlert: deliver } = await import('../alert-delivery.mjs'));
    } catch (err) {
      logger?.warn?.(JSON.stringify({
        event: 'ama_closer.harness_fallback_alert_skipped',
        repo,
        prNumber: prNumber == null ? null : Number(prNumber),
        reason: 'alert-transport-unavailable',
        error: String(err?.message || err),
      }));
      return { delivered: false, reason: 'alert-transport-unavailable' };
    }
  }
  const text =
    `⚠️ AMA closer harness fallback: ${repo}#${prNumber} — provider ${harness.provider} `
    + `is quota-grounded (${harness.primaryState}); dispatching the closer on `
    + `${harness.to} instead of ${harness.from}. Auto-reverts when ${harness.provider} recovers.`;
  try {
    await deliver(text, {
      event: 'ama_closer.harness_fallback',
      payload: {
        repo,
        prNumber: prNumber == null ? null : Number(prNumber),
        provider: harness.provider,
        from: harness.from,
        to: harness.to,
        primaryState: harness.primaryState,
        fallbackProvider: harness.fallbackProvider || null,
      },
      env,
    });
    return { delivered: true };
  } catch (err) {
    logger?.warn?.(JSON.stringify({
      event: 'ama_closer.harness_fallback_alert_failed',
      repo,
      prNumber: prNumber == null ? null : Number(prNumber),
      reason: 'alert-delivery-failed',
      error: String(err?.message || err),
    }));
    return { delivered: false, reason: 'alert-delivery-failed', error: String(err?.message || err) };
  }
}

function resolveMergeClassDispatchRoute({
  orchestrationMode = null,
  logger = console,
  repo = null,
  prNumber = null,
  workerClass = null,
  completionShape = null,
} = {}) {
  const normalized = orchestrationMode == null
    ? 'native'
    : String(orchestrationMode).trim().toLowerCase();
  if (!MERGE_CLASS_ORCHESTRATION_MODES.has(normalized)) {
    throw new Error(
      `[ama-closer] unsupported orchestration_mode=${JSON.stringify(orchestrationMode)} `
      + '(expected native or agentos for merge-class dispatch invariance)',
    );
  }
  const route = 'hq-dispatch';
  logAmaCloserDispatchEvent(logger, 'ama_closer.orchestration_mode_noop', {
    orchestrationMode: normalized,
    route,
    repo,
    prNumber: prNumber == null ? null : Number(prNumber),
    workerClass,
    completionShape,
  });
  return route;
}

export function updateAmaCloserDispatchRecord(rootDir, identity, mutate) {
  const existing = readAmaCloserDispatchRecord(rootDir, identity);
  const next = mutate(existing ? { ...existing } : null);
  if (!next) return existing;
  writeAmaCloserDispatchRecord(rootDir, identity, next);
  return next;
}

function errorDiagnosticLines(err) {
  return [err?.message, err?.stderr, err?.stdout]
    .filter(Boolean)
    .flatMap((value) => String(value).split('\n'))
    .map(line => line.trim())
    .filter(Boolean);
}

function buildBootstrapEligibilityReasons({ reviewState, prMetadata, verdict, dispatchContext }) {
  const reasons = [];
  if (verdict?.eligible) reasons.push('latest_review_settled_success');
  if (dispatchContext?.reviewedBy) reasons.push('reviewer_family_recorded');
  if (reviewState?.riskClass) reasons.push(`risk_class_${reviewState.riskClass}_permitted`);
  if (reviewState?.headSha && prMetadata?.headSha && reviewState.headSha === prMetadata.headSha) {
    reasons.push('head_sha_matches_review');
  }
  if (verdict?.trace?.ciGreen?.green) reasons.push('ci_all_green');
  if (Array.isArray(verdict?.trace?.blockLabels) && verdict.trace.blockLabels.length === 0) {
    reasons.push('no_blocking_labels');
  }
  const branchProtection = verdict?.trace?.branchProtection;
  if (branchProtection?.ok && branchProtection?.required === true) {
    reasons.push('configured_gate_context_required');
  } else if (branchProtection?.ok && branchProtection?.required === false) {
    reasons.push('branch_protection_requirement_waived');
  }
  return reasons;
}

function summarizeEligibilityReason(reasons) {
  const summary = Array.isArray(reasons)
    ? reasons.map(reason => String(reason || '').trim()).filter(Boolean).join(', ')
    : '';
  return summary || 'eligibility predicate satisfied';
}

function isExecTimeout(err) {
  return err?.code === 'ETIMEDOUT'
    || err?.killed === true
    || String(err?.message || '').toLowerCase().includes('timed out');
}

function errDetailText(errOrText) {
  if (typeof errOrText === 'string') return errOrText.toLowerCase();
  return [
    ['code', errOrText?.code],
    ['status', errOrText?.status],
    ['statusCode', errOrText?.statusCode],
    ['message', errOrText?.message],
    ['stderr', errOrText?.stderr],
    ['stdout', errOrText?.stdout],
  ]
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n')
    .toLowerCase();
}

// GitHub primary/secondary rate-limit + HTTP 429 + OAuth-broker 503 signals.
// These are TRANSIENT: the bot token is valid and authorized — the request was
// merely throttled (or the broker that mints the token is briefly unavailable).
// GitHub returns the *primary* rate limit as HTTP 403, so a naive 403/exit-65
// check misreads a throttle as a terminal auth failure and permanently grounds
// the AMA closer, so autonomous merges never run (observed during the macOS
// upgrade + os-restart storm that exhausted merge-agent-lacey's rate limit).
//
// This mirrors the rate-limit clauses of `_TRANSIENT_GH_ERROR_RE` in
// cwp_dispatch/dag_reconcile.py and `hq_entitlement_gh_identity_error_is_rate_limit`
// in modules/worker-pool/lib/hq-gh.sh so classification is consistent across
// the worker-pool entitlement path and this dispatch path.
export function isGithubRateLimitOrBrokerThrottle(errOrText) {
  const detail = errDetailText(errOrText);
  if (!detail) return false;
  return detail.includes('rate limit')
    || detail.includes('rate-limit')
    || detail.includes('ratelimit')
    || detail.includes('secondary rate')
    || detail.includes('abuse detection')
    || detail.includes('submitted too quickly')
    || detail.includes('retry your request')
    || detail.includes('too many requests')
    || detail.includes('http 429')
    || /\b(?:status|statuscode|status_code|code)\s*[:=]?\s*429\b/.test(detail)
    // OAuth-broker unavailability while it fetches/refreshes the bot token.
    || detail.includes('http 503')
    || detail.includes('broker fetch')
    || detail.includes('broker unavailable')
    || detail.includes('service unavailable');
}

export function isTransientHqDispatchError(err) {
  if (isExecTimeout(err)) return true;
  // A throttle / broker outage is transient, never terminal — classify it
  // first so the retry loop and retry-budget guard both treat it as retryable.
  if (isGithubRateLimitOrBrokerThrottle(err)) return true;
  const detail = errDetailText(err);
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eagain|epipe|eio)\b/.test(detail)
    || detail.includes('database is locked')
    || detail.includes('sqlite_busy')
    || detail.includes('resource temporarily unavailable')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable');
}

function isProvisionBranchHolderBlocked(errOrText) {
  const detail = typeof errOrText === 'string'
    ? errOrText
    : [
      errOrText?.code,
      errOrText?.message,
      errOrText?.stderr,
      errOrText?.stdout,
    ].filter(Boolean).join('\n');
  const normalized = detail
    .split(/\r?\n/)
    .map(line => line.toLowerCase())
    .filter(line => {
      if (line.includes('targeted worktree fallback could not find admin entry')) return false;
      if (line.includes('force-reclaimed stale own merge worktree')) return false;
      return !(line.includes('provision cleanup')
        && (
          line.includes('releasing worktree mutation lock')
          || line.includes('was incomplete; continuing')
        ));
    })
    .join('\n');
  if (!normalized) return false;
  if (/\b(branch[-_]holder[-_](blocked|collision|worktree)|worktree[-_]branch[-_]holder[-_]blocked)\b/.test(normalized)) {
    return true;
  }
  const hasWorktreeCollision = (
    normalized.includes('already used by worktree') ||
    normalized.includes('already checked out in worktree') ||
    (normalized.includes('worktree') && normalized.includes('already') && normalized.includes('branch'))
  );
  const hasBranchHolderContext = (
    normalized.includes('branch holder') ||
    normalized.includes('branch-holder') ||
    normalized.includes('git worktree holder') ||
    normalized.includes('worker provision failed') ||
    normalized.includes('refusing grace-waived git worktree holder drop') ||
    normalized.includes('holder has unrecovered local state') ||
    normalized.includes('could not be safely inspected') ||
    normalized.includes('auto-tear-down')
  );
  return hasWorktreeCollision && hasBranchHolderContext;
}

// Worktrees to reap when a hammer provision hits a branch-holder collision.
//
// The provision needs to check out the PR head branch, but git refuses because
// that branch is already checked out in another worktree. There are two holder
// classes, and BOTH must be reaped or the hammer deadlocks:
//
//   1. A prior `hammer-ama-pr-<PR>` worktree from an earlier close attempt
//      (self-cleanup). Matched by name.
//   2. The ORIGINAL coding worker's worktree (e.g. `.../workers/codex-mcmo-01/
//      agent-os`, `.../workers/claude-code-tct-04/agent-os`) that opened the PR
//      and was never torn down. This is the COMMON case and is NOT named
//      `hammer-ama-pr-*`, so the historical name-only matcher missed it —
//      leaving the block permanent (the PR never merges, so the coding worker
//      never tears down, so the branch stays held: a deadlock). Git names this
//      holder verbatim in the provision error; we reap whatever it names,
//      scoped to `<hqRoot>/workers/*/agent-os` so an unrelated path echoed
//      elsewhere in the error text is never torn down.
//
// The reaped worktree's PR content is safe on `origin` (the PR is open and under
// review), so `hq worker tear-down --force` salvages/archives any local tip and
// preserves the remote branch — the hammer then re-provisions from origin HEAD.
export function samePrHammerHolderWorktreePaths(errOrText, prNumber, hqRoot) {
  const detail = typeof errOrText === 'string'
    ? errOrText
    : [
      errOrText?.code,
      errOrText?.message,
      errOrText?.stderr,
      errOrText?.stdout,
    ].filter(Boolean).join('\n');
  const text = String(detail || '');
  const paths = [];
  const seen = new Set();
  const pushPath = (candidate) => {
    const path = String(candidate || '').trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  };
  const workersPrefix = typeof hqRoot === 'string' && hqRoot.trim()
    ? join(hqRoot, 'workers') + '/'
    : null;
  const isCanonicalWorkerWorktreePath = (candidate) => /\/workers\/[^/]+\/agent-os$/.test(candidate);
  const isReapableHolderPath = (candidate) => {
    if (!candidate || !candidate.endsWith('/agent-os')) return false;
    if (!isCanonicalWorkerWorktreePath(candidate)) return false;
    if (workersPrefix) return candidate.startsWith(workersPrefix);
    return true;
  };

  // (1) Prior hammer-ama worktrees for THIS pr.
  const normalizedPr = String(prNumber || '').trim();
  if (/^[0-9]+$/.test(normalizedPr)) {
    const escapedPr = normalizedPr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hammerPattern = new RegExp(
      `(['"]?)(/[^'"\n]*?/workers/hammer-ama-pr-${escapedPr}(?:-[^/'"\n]+)?/agent-os)\\1`,
      'g',
    );
    for (const match of text.matchAll(hammerPattern)) {
      const candidate = (match[2] ?? '').trim();
      if (isReapableHolderPath(candidate)) {
        pushPath(candidate);
      }
    }
  }

  // (2) The actual branch holder named by git, scoped to the HQ workers dir.
  const holderPatterns = [
    // fatal: '<branch>' is already used by worktree at '<PATH>'
    /already used by worktree at\s+(['"])([^'"\n]+)\1/g,
    // [hq] refusing grace-waived git worktree holder drop for branch '<b>': ...: <PATH>
    /refusing grace-waived git worktree holder drop[^\n]*?:\s*(\/[^\n'"]+\/agent-os)/g,
  ];
  for (const pattern of holderPatterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = (match[2] ?? match[1] ?? '').trim();
      if (isReapableHolderPath(candidate)) {
        pushPath(candidate);
      }
    }
  }

  return paths;
}

async function teardownSamePrHammerHolder({
  err,
  prNumber,
  hqPath,
  hqRoot,
  execFileImpl,
  logger = console,
}) {
  const worktreePaths = samePrHammerHolderWorktreePaths(err, prNumber, hqRoot);
  if (!worktreePaths.length) {
    return { attempted: false, ok: false, worktreePaths: [] };
  }

  const attempts = [];
  for (const worktreePath of worktreePaths) {
    const workerId = basename(dirname(worktreePath));
    try {
      await execFileImpl('git', [
        '-C',
        join(hqRoot, 'repos', AGENT_OS_TOOLING_REPO),
        'worktree',
        'remove',
        '--force',
        worktreePath,
      ], {
        env: process.env,
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
        killSignal: 'SIGTERM',
      });
      attempts.push({ worktreePath, action: 'git-worktree-remove', ok: true });
    } catch (removeErr) {
      attempts.push({
        worktreePath,
        action: 'git-worktree-remove',
        ok: false,
        error: String(removeErr?.stderr || removeErr?.message || removeErr),
      });
    }

    try {
      await execFileImpl(hqPath, ['worker', 'tear-down', workerId, '--force', '--root', hqRoot], {
        env: process.env,
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
        killSignal: 'SIGTERM',
      });
      attempts.push({ worktreePath, workerId, action: 'hq-worker-tear-down', ok: true });
    } catch (tearDownErr) {
      const detail = String(tearDownErr?.stderr || tearDownErr?.message || tearDownErr);
      const absent = isWorkerTearDownNotFoundError(detail);
      attempts.push({
        worktreePath,
        workerId,
        action: 'hq-worker-tear-down',
        ok: absent,
        alreadyAbsent: absent,
        error: detail,
      });
    }
  }

  const ok = attempts.every(attempt => attempt.ok);
  logger?.warn?.(JSON.stringify({
    event: 'ama_closer.same_pr_hammer_holder_teardown',
    prNumber,
    status: ok ? 'ok' : 'failed',
    worktreePaths,
    attempts,
  }));
  return { attempted: true, ok, worktreePaths, attempts };
}

export const __testables__ = Object.freeze({
  teardownSamePrHammerHolder,
});

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveHqOwner(hqRoot) {
  if (!hqRoot) return null;
  const config = readJsonFile(join(hqRoot, '.hq', 'config.json'));
  const ownerUser = String(config?.ownerUser || '').trim();
  return ownerUser || null;
}

function currentUserName() {
  try {
    return String(userInfo().username || '').trim() || null;
  } catch {
    return null;
  }
}

export function assertAmaAuditOwner({ hqRoot, ownerUser, currentUser = currentUserName() } = {}) {
  const expected = String(ownerUser || '').trim();
  if (!expected) {
    throw new Error(
      `AMA audit bootstrap refused: HQ ownerUser is unavailable for ${hqRoot || 'unknown HQ root'}`,
    );
  }
  const actual = String(currentUser || '').trim();
  if (!actual) {
    throw new Error('AMA audit bootstrap refused: current runtime user is unavailable');
  }
  if (actual !== expected) {
    throw new Error(
      `AMA audit bootstrap refused: current user '${actual}' does not match ` +
      `HQ ownerUser '${expected}' for ${hqRoot}`,
    );
  }
  return expected;
}

function hasAuthoritativeOwnerVisibility(asOwner) {
  return Boolean(String(asOwner || '').trim());
}

function isNotFoundDispatchStatusError(err) {
  if (!err) return false;
  const code = err.code ?? err.status ?? null;
  return (code === 1 || code === '1') && /no dispatch with id/i.test(String(err.stderr || ''));
}

function parseAmaCloserDispatchStatusOutput(stdout) {
  const parsed = parseAmaCloserDispatchOutput(stdout);
  const status = typeof parsed?.status === 'string'
    ? parsed.status.trim().toLowerCase()
    : null;
  return status ? { status } : null;
}

async function probeAmaCloserDispatchStatus({
  hqPath,
  launchRequestId,
  asOwner = null,
  execFileImpl = execFileAsync,
  env = {},
} = {}) {
  if (!hqPath || !launchRequestId) return null;
  const args = asOwner
    ? ['dispatch', 'status', launchRequestId, '--as-owner', asOwner]
    : ['dispatch', 'status', launchRequestId];
  for (let attempt = 0; attempt <= AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const { stdout } = await execFileImpl(hqPath, args, {
        env: { ...env },
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
      });
      const parsed = parseAmaCloserDispatchStatusOutput(stdout);
      if (parsed) return parsed;
      if (attempt < AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS.length) {
        await sleep(AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { status: 'unknown', degraded: true };
    } catch (err) {
      if (hasAuthoritativeOwnerVisibility(asOwner) && isNotFoundDispatchStatusError(err)) {
        return { status: 'not-found' };
      }
      if (isTransientHqDispatchError(err) && attempt < AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS.length) {
        await sleep(AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { status: 'unknown', degraded: true, error: err?.message || String(err) };
    }
  }
  return { status: 'unknown', degraded: true };
}

function parseAmaCloserDispatchOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  let dispatchId = null;
  let launchRequestId = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const dispatchMatch = /^dispatchId=([A-Za-z0-9_-]+)/.exec(trimmed);
    if (dispatchMatch) dispatchId = dispatchMatch[1];
    const lrqMatch = /^(?:launchRequestId|lrq)=([A-Za-z0-9_-]+)/.exec(trimmed);
    if (lrqMatch) launchRequestId = lrqMatch[1];
  }
  return (dispatchId || launchRequestId) ? { dispatchId, launchRequestId } : null;
}

function normalizeDispatchIdentifiers(payload) {
  if (!payload || typeof payload !== 'object') return { dispatchId: null, launchRequestId: null };
  return {
    dispatchId: String(payload.dispatchId || '').trim() || null,
    launchRequestId: String(payload.launchRequestId || payload.lrq || payload.dispatchId || '').trim() || null,
  };
}

function readAmaAuditTerminalOutcome(hqRoot, { repo, prNumber, headSha } = {}) {
  const status = String(readAmaAuditEntry(hqRoot, repo, prNumber, headSha)?.status || '')
    .trim()
    .toLowerCase();
  return AMA_CLOSER_AUDIT_TERMINAL_OUTCOMES.has(status) ? status : null;
}

function readMergedBuildCompletionSignal({
  repo,
  prNumber,
  headSha,
  hqRoot,
  rootDir,
  env = process.env,
  readBuildCompletionProducerEvidenceImpl = readBuildCompletionProducerEvidence,
  readBuildCompletionSignalForPrImpl = readBuildCompletionSignalForPr,
} = {}) {
  const result = readBuildCompletionSignalForPrImpl({
    repo,
    prNumber,
    signalKind: 'merged',
    hqRoot,
    rootDir,
    env,
  });
  if (!result) return { ok: false, reason: 'ledger-read-failed' };
  if (result.ok) {
    const producerHeadSha = String(result.row?.head_sha || '').trim() || null;
    const reviewedHeadSha = String(headSha || '').trim() || null;
    return {
      ...result,
      producerHeadSha,
      reviewedHeadSha,
      headShaMatchesReviewed: producerHeadSha && reviewedHeadSha ? producerHeadSha === reviewedHeadSha : null,
    };
  }
  if (isCleanMissingMergedSignal(result)) {
    const producerEvidence = readBuildCompletionProducerEvidenceImpl({
      repo,
      signalKind: 'merged',
      hqRoot,
      rootDir,
      env,
    });
    if (producerEvidence?.ok) {
      return {
        ...result,
        producerEvidence: producerEvidence.row,
        producerEvidenceTarget: producerEvidence.target || null,
      };
    }
    return {
      ...(producerEvidence || { ok: false, reason: 'missing-build-completion-producer-evidence' }),
      producerEvidence: producerEvidence || null,
      prSignal: result,
    };
  }
  return result;
}

function isCleanMissingMergedSignal(result) {
  return result?.ok === false && result.reason === 'missing-build-completion-signal';
}

function isUnknownMergedSignal(result) {
  return result?.ok === false && !isCleanMissingMergedSignal(result);
}

function retainExistingAmaCloserDispatch(existingRecord, workerClass, status) {
  return noAmaDispatch({
    dispatched: false,
    skipMergeAgent: true,
    reason: `existing-dispatch-${status || 'unknown'}`,
    workerClass: existingRecord.workerClass || workerClass,
    dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
    launchRequestId: existingRecord.launchRequestId || null,
    promptPath: existingRecord.promptPath || null,
  });
}

function closerReviewerPassStatusForDispatchStatus(status, { merged = false } = {}) {
  if (merged) return 'completed';
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'succeeded' || normalized === 'unverified-terminal-success') return 'completed';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'superseded') return 'cancelled';
  return 'failed';
}

function usageHasTokenFigure(usage) {
  if (!usage) return false;
  return usage.input !== null && usage.input !== undefined
    || usage.output !== null && usage.output !== undefined
    || usage.cacheRead !== null && usage.cacheRead !== undefined
    || usage.cacheWrite !== null && usage.cacheWrite !== undefined
    || usage.total !== null && usage.total !== undefined
    || usage.costUSD !== null && usage.costUSD !== undefined;
}

async function readCloserWorkerRunUsageAfterRollup({
  rootDir,
  hqRoot,
  workerRunId = null,
  launchRequestId = null,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  pollDelaysMs = AMA_CLOSER_TOKEN_ROLLUP_POLL_DELAYS_MS,
} = {}) {
  const attempts = [0, ...pollDelaysMs];
  for (const delayMs of attempts) {
    if (delayMs > 0) await sleep(delayMs);
    const result = readWorkerRunTokenUsageResult({
      workerRunId,
      launchRequestId,
      ledgerTarget,
      ledgerDbPath,
      env,
      rootDir,
      hqRoot,
    });
    if (!result?.ok) {
      if (result?.reason === 'missing-worker-run-row') continue;
      return null;
    }
    const usage = result.usage;
    if (usageHasTokenFigure(usage)) return usage;
  }
  return null;
}

async function recordAmaCloserReviewerPassTokens({
  rootDir,
  hqRoot,
  repo,
  prNumber,
  record,
  status,
  merged = false,
  observedAt,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  pollDelaysMs = AMA_CLOSER_TOKEN_ROLLUP_POLL_DELAYS_MS,
  logger = console,
} = {}) {
  if (!record?.launchRequestId && !record?.dispatchId) return null;
  const attemptNumber = normalizeCloserAttemptNumber(record);
  const launchRequestId = record.launchRequestId || record.dispatchId || null;
  const usage = await readCloserWorkerRunUsageAfterRollup({
    rootDir,
    hqRoot,
    workerRunId: record.workerRunId || null,
    launchRequestId,
    ledgerTarget,
    ledgerDbPath,
    env,
    pollDelaysMs,
  });
  const missingUsage = !usage;
  if (!usage) {
    logger.warn?.(
      `[ama-closer] token rollup not ready for ${repo}#${prNumber} ` +
      `attempt=${attemptNumber} launchRequestId=${launchRequestId || 'unknown'}; ` +
      'recording closer pass without token usage so dispatch state can advance'
    );
  }
  const startedAt = record.dispatchedAt || record.lastAttemptedAt || observedAt || new Date().toISOString();
  const endedAt = observedAt || record.lastObservedAt || new Date().toISOString();
  const workerRunId = usage?.workerRunId || record.workerRunId || null;
  const metadata = {
    amaCloser: true,
    headSha: record.headSha || null,
    dispatchId: record.dispatchId || null,
    launchRequestId,
    terminalStatus: status || null,
    merged,
    ...(missingUsage ? { tokenUsageUnavailable: true } : {}),
  };
  beginReviewerPass(rootDir, {
    repo,
    prNumber,
    attemptNumber,
    reviewerClass: record.workerClass || 'codex',
    reviewerModel: record.workerClass || 'codex',
    passKind: 'closer',
    workerRunId,
    workspacePath: record.workspacePath || null,
    startedAt,
    metadata,
  });
  return completeReviewerPass(rootDir, {
    repo,
    prNumber,
    attemptNumber,
    passKind: 'closer',
    status: closerReviewerPassStatusForDispatchStatus(status, { merged }),
    endedAt,
    workerRunId,
    tokenUsage: usage || null,
    tokenSource: usage?.source || null,
    metadata,
  });
}

function normalizeCloserAttemptNumber(record) {
  const parsed = Number(record?.retryCount);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return 1;
}

/**
 * Substitute `<<PLACEHOLDER>>` markers in the template body.
 *
 * Pure string substitution — no escaping logic (the template author
 * controls the markup). The substituted values come from validated
 * inputs (PR number is numeric, reviewedSha is a Git SHA, etc.) so
 * the surface area for injection is bounded.
 *
 * @param {string} body
 * @param {Object<string, string|number>} substitutions
 * @returns {string}
 */
export function substituteTemplate(body, substitutions) {
  let out = body;
  for (const [key, value] of Object.entries(substitutions)) {
    const placeholder = new RegExp(`<<${key}>>`, 'g');
    out = out.replace(placeholder, String(value));
  }
  return out;
}

/**
 * Compose the hammer worker prompt body from the substitutions the
 * dispatch site provides. Exported for the golden-snapshot test.
 *
 * @param {Object} args
 * @param {string} args.prUrl
 * @param {string} args.repo            — owner/name
 * @param {number} args.prNumber
 * @param {string} args.reviewedSha
 * @param {string=} args.targetRemediationSha
 * @param {string} args.riskClass
 * @param {string} args.mergeMethod     — 'squash' | 'merge'
 * @param {string} args.requiredGateContext
 * @param {string} args.auditPath       — absolute path inside HQ_ROOT, used only inside the closer
 * @param {string} args.hqRoot          — HQ root path (closer passes to `ama-audit append --hq-root`)
 * @param {string} args.rootDir         — adversarial-review checkout root for ama-check ledger probes
 * @param {string} args.hqOwnerUser     — HQ owner user required for direct audit writes
 * @param {string} args.reviewedBy
 * @param {string} args.reviewer
 * @param {string} args.dispatchedAt    — ISO 8601 UTC
 * @param {string} args.amaTrailers     — provenance trailer block passed to `gh pr merge`
 * @param {string} args.templateBody    — raw template content
 * @returns {string}
 */
export function composeCloserPrompt({
  prUrl,
  repo,
  prNumber,
  reviewedSha,
  targetRemediationSha = reviewedSha,
  riskClass,
  mergeMethod,
  requiredGateContext,
  auditPath,
  hqRoot,
  rootDir = SUBMODULE_ROOT,
  hqOwnerUser,
  reviewedBy,
  reviewer,
  dispatchedAt,
  amaTrailers,
  templateBody,
  reviewCycleExhausted = false,
}) {
  return substituteTemplate(templateBody, {
    PR_URL: prUrl,
    REPO: repo,
    PR_NUMBER: prNumber,
    REVIEWED_SHA: reviewedSha,
    TARGET_REMEDIATION_SHA: targetRemediationSha || reviewedSha,
    RISK_CLASS: riskClass,
    MERGE_METHOD: mergeMethod,
    REQUIRED_GATE_CONTEXT: requiredGateContext,
    AUDIT_PATH: auditPath,
    HQ_ROOT: hqRoot,
    ROOT_DIR: rootDir,
    HQ_OWNER: hqOwnerUser,
    REVIEWED_BY: reviewedBy,
    REVIEWER: reviewer,
    DISPATCHED_AT: dispatchedAt,
    AMA_TRAILERS: amaTrailers,
    // Dispatch-time final-hammer observation forwarded only as audit context;
    // ama-check recomputes the durable ledger state before applying waivers.
    REVIEW_CYCLE_EXHAUSTED: reviewCycleExhausted === true ? 'true' : 'false',
  });
}

/**
 * Watcher's settled-success hook calls this BEFORE its existing
 * merge-agent dispatch. Returns `{ dispatched: true }` when AMA owns
 * the close; the caller skips merge-agent on that tick. Returns
 * `{ dispatched: false }` with a structured reason otherwise; the
 * caller falls through to the existing merge-agent dispatch path.
 *
 * @param {Object} args
 * @param {Object} args.reviewState
 * @param {Object} args.prMetadata
 * @param {Object} args.cfg              — resolved AMA cfg subtree (camelCase)
 * @param {Object=} args.options         — passed to the eligibility predicate
 * @param {Object} args.dispatchContext  — operator-controlled values
 * @param {string} args.dispatchContext.repo           owner/name (e.g. `acme/myrepo`)
 * @param {string} args.dispatchContext.prUrl          PR URL (e.g. `https://github.com/acme/myrepo/pull/123`)
 * @param {string} args.dispatchContext.reviewedSha    head SHA the reviewer actually reviewed
 * @param {string=} args.dispatchContext.targetRemediationSha current PR head targeted by HAM remediation
 * @param {string=} args.dispatchContext.dispatchRecordHeadSha commit SHA used for the dispatch record key
 * @param {string=} args.dispatchContext.dispatchReason reason for non-standard dispatch routing
 * @param {string} args.dispatchContext.riskClass      resolved risk class
 * @param {string} args.dispatchContext.requiredGateContext
 * @param {string} args.dispatchContext.reviewedBy
 * @param {string} args.dispatchContext.parentSession
 * @param {string=} args.dispatchContext.hqProject
 * @param {string=} args.dispatchContext.hqPath
 * @param {string=} args.dispatchContext.hqRoot
 * @param {string=} args.dispatchContext.templatePath
 * @param {string=} args.dispatchContext.dispatchedAt  ISO 8601 UTC (caller-provided to keep the function deterministic for tests)
 * @param {Object=} args.execFileImpl    — DI for tests
 * @param {Object=} args.processKillImpl  — DI for tests
 * @param {Object=} args.readTemplateImpl — DI for tests
 * @param {Object=} args.writeFileImpl   — DI for tests
 * @returns {Promise<DispatchResult>}
 */
export async function maybeDispatchAmaCloser({
  reviewState,
  prMetadata,
  cfg,
  options,
  dispatchContext,
  execFileImpl = execFileAsync,
  processKillImpl = process.kill,
  readTemplateImpl = null,
  writeFileImpl = null,
  readBuildCompletionProducerEvidenceImpl = readBuildCompletionProducerEvidence,
  readBuildCompletionSignalForPrImpl = readBuildCompletionSignalForPr,
  resolveCloserDispatchHarnessImpl = resolveCloserDispatchHarness,
  deliverAlertImpl = deliverAlert,
  logger = console,
}) {
  // The master gate. With no operator config, this is `false` per
  // AMA-01 schema defaults and the entire path is a no-op.
  if (!cfg?.enabled) {
    return noAmaDispatch({
      dispatched: false,
      reason: 'ama-disabled',
    });
  }

  const prNumber = Number(prMetadata?.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'invalid-pr-number',
    });
  }

  // The eligibility predicate is the second gate.
  const verdict = isEligibleForAmaClosure(reviewState, prMetadata, cfg, options);
  let forceHammerTerminalRemediationPrompt = false;
  let forceHammerWorkerClass = false;
  const eligibleHammerRouteReasons = verdict.eligible ? hammerRouteReasonsFromTrace(verdict) : [];
  if (!verdict.eligible || eligibleHammerRouteReasons.length > 0) {
    // MSM-04: the standalone AMA closer is gone. The only agent dispatch left
    // on this surface is the HAM terminal-remediation worker. Fully clean PRs
    // are handled by the daemon path before this function is called; dirty,
    // conflicted/behind, or red-CI PRs get exactly one hammer under the existing
    // dispatch lease/idempotency machinery. Structural hard-stops still block.
    const workerClassForMiss = String(cfg?.workerClass || 'hammer');
    const reviewCycleExhausted =
      reviewState?.reviewCycleExhausted === true ||
      verdict?.trace?.finalHammer?.active === true;
    const routeReasons = verdict.eligible ? eligibleHammerRouteReasons : verdict.reasons;
    if (isHammerRouteStructurallyBlocked(routeReasons)) {
      return noAmaDispatch({
        dispatched: false,
        skipMergeAgent: true,
        reason: 'not-eligible',
        reasons: routeReasons,
      });
    }
    const autoHammer =
      (workerClassForMiss === 'hammer' || reviewCycleExhausted)
      && (
        eligibleHammerRouteReasons.length > 0 ||
        routeReasons.some((reason) => HAMMER_ROUTE_ACTION_REASONS.has(reason)) ||
        reviewCycleExhausted
      )
      && isHammerRemediableEligibilityMiss(routeReasons, {
        reviewCycleExhausted,
        allowStaleReviewHeadHammerResume:
          dispatchContext?.allowStaleReviewHeadHammerResume === true,
      });
    if (!autoHammer) {
      return noAmaDispatch({
        dispatched: false,
        skipMergeAgent: true,
        reason: 'not-eligible',
        reasons: routeReasons,
      });
    }
    forceHammerTerminalRemediationPrompt = true;
    logger.log?.(
      `[ama-closer] auto-hammer: dispatching terminal remediation for ineligible ` +
      `PR (reasons: ${(routeReasons || []).join(',')}) — hammer will remediate ` +
      `final findings/checks then re-validate the gate fail-closed`
    );
    // fall through to the dispatch below (hammer template, remediation mode)
    forceHammerWorkerClass = true;
  }

  // Compose the prompt body. Template loaded from disk via DI so
  // tests can pass a literal.
  const workerClass = forceHammerWorkerClass ? 'hammer' : String(cfg?.workerClass || 'hammer');
  // SPEC §1.1.1: the HAM terminal-remediation prompt is reserved for closures
  // that actually have findings to remediate. With `hammer` now the default
  // worker class, gating purely on `workerClass === 'hammer'` would route every
  // clean closure through the terminal-remediation mandate. Require both the
  // hammer worker class AND a closure that genuinely needs terminal remediation;
  // otherwise this route declines and lets the daemon clean path own the tick.
  // eligibility misses force the terminal prompt because that worker is being
  // launched to repair findings, mergeability, or CI before merge.
  const useHammerTerminalRemediationPrompt =
    workerClass === 'hammer' && (
      forceHammerTerminalRemediationPrompt ||
      amaClosureNeedsTerminalRemediation(verdict)
    );
  const currentHeadFinalHammerTerminalRemediation =
    useHammerTerminalRemediationPrompt &&
    workerClass === 'hammer' &&
    reviewState?.reviewCycleExhausted === true;
  const templatePath = dispatchContext.templatePath || HAMMER_TEMPLATE_PATH;
  const templateBody = readTemplateImpl
    ? readTemplateImpl(templatePath)
    : readFileSync(templatePath, 'utf8');

  const repo = dispatchContext.repo;
  const reviewedSha = dispatchContext.reviewedSha;
  const targetRemediationSha = dispatchContext.targetRemediationSha || reviewedSha;
  const dispatchRecordHeadSha = dispatchContext.dispatchRecordHeadSha || targetRemediationSha;
  const dispatchReason = dispatchContext.dispatchReason || null;
  const mergeMethod = String(cfg.mergeMethod || 'squash').toLowerCase();
  const rootDir = dispatchContext.rootDir || SUBMODULE_ROOT;

  const leaseIdentity = { repo, prNumber, headSha: reviewedSha };
  const hqRoot = dispatchContext.hqRoot || DEFAULT_HQ_ROOT;
  const promptDir = dispatchContext.promptDir || amaCloserPromptDir(rootDir);
  const ownerUser = dispatchContext.hqOwnerUser || resolveHqOwner(hqRoot);
  const auditPath = amaAuditFilePath(hqRoot, repo, prNumber, reviewedSha);
  const auditRef = amaAuditTraceRef(repo, prNumber, reviewedSha);
  const bootstrapEligibilityReasons = buildBootstrapEligibilityReasons({
    reviewState,
    prMetadata,
    verdict,
    dispatchContext,
  });
  const amaTrailers = composeAmaTrailers({
    workerClass,
    reviewerFamily: dispatchContext.reviewedBy,
    riskClass: dispatchContext.riskClass,
    eligibilityReason: summarizeEligibilityReason(bootstrapEligibilityReasons),
    auditRef,
    closedBy: undefined,
  });
  const prompt = composeCloserPrompt({
    prUrl: dispatchContext.prUrl,
    repo,
    prNumber,
    reviewedSha,
    targetRemediationSha,
    riskClass: dispatchContext.riskClass,
    mergeMethod,
    requiredGateContext: dispatchContext.requiredGateContext,
    auditPath,
    hqRoot,
    rootDir,
    hqOwnerUser: ownerUser || 'unknown',
    reviewedBy: dispatchContext.reviewedBy,
    reviewer: dispatchContext.reviewer,
    dispatchedAt: dispatchContext.dispatchedAt,
    amaTrailers,
    templateBody,
    // Forward the dispatch-time final-hammer observation only as context; the
    // closer's ama-check invocation recomputes exhaustion from the current
    // follow-up ledger before it honors any waiver.
    reviewCycleExhausted: reviewState?.reviewCycleExhausted === true,
  });

  const dispatchIdentity = { repo, prNumber, headSha: dispatchRecordHeadSha };
  const auditIdentity = { repo, prNumber, headSha: reviewedSha };
  const hqPath = dispatchContext.hqPath || process.env.HQ_BIN || DEFAULT_HQ_PATH;
  const hqProject = dispatchContext.hqProject || DEFAULT_PROJECT;
  const existingRecord = readAmaCloserDispatchRecord(rootDir, dispatchIdentity);
  const existingLeaseBeforeDispatch = readAmaCloserLease(rootDir, leaseIdentity);
  const auditTerminalOutcome = readAmaAuditTerminalOutcome(hqRoot, auditIdentity);
  if (isReclaimableDispatchedAmaCloserLease(existingLeaseBeforeDispatch, {
    now: dispatchContext.dispatchedAt,
  })) {
    const terminalizedLease = {
      ...existingLeaseBeforeDispatch,
      status: AMA_CLOSER_LEASE_STATUS.TERMINAL,
      terminalOutcome: 'failed-without-merge',
      completedAt: dispatchContext.dispatchedAt || existingLeaseBeforeDispatch?.completedAt || null,
      updatedAt: dispatchContext.dispatchedAt || existingLeaseBeforeDispatch?.updatedAt || null,
    };
    finalizeAmaCloserLeaseBestEffort({
      rootDir,
      leaseIdentity,
      terminalOutcome: 'failed-without-merge',
      now: dispatchContext.dispatchedAt,
      logger,
      repo,
      prNumber,
    });
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'stale-dispatched-lease-terminalized',
      existingLease: terminalizedLease,
    });
  }
  const mergedSignal = readMergedBuildCompletionSignal({
    repo,
    prNumber,
    headSha: reviewedSha,
    hqRoot,
    rootDir,
    env: process.env,
    readBuildCompletionProducerEvidenceImpl,
    readBuildCompletionSignalForPrImpl,
  });
  if (mergedSignal?.ok) {
    const hammerCleanup = await cleanupHammerCloserWorker({
      prNumber,
      workerClass,
      existingRecord,
      hqPath,
      hqRoot,
      execFileImpl,
      logger,
      reason: 'merged-signal-present',
    });
    assertHammerCleanupSucceeded(hammerCleanup);
    if (existingRecord?.launchRequestId || existingRecord?.dispatchId) {
      await recordAmaCloserReviewerPassTokens({
        rootDir,
        hqRoot,
        repo,
        prNumber,
        record: existingRecord,
        status: existingRecord.lastObservedStatus || 'succeeded',
        merged: true,
        observedAt: dispatchContext.dispatchedAt,
        ledgerTarget: dispatchContext.ledgerTarget || null,
        ledgerDbPath: dispatchContext.ledgerDbPath || null,
        env: process.env,
        pollDelaysMs: dispatchContext.closerTokenRollupPollDelaysMs || undefined,
        logger,
      });
    }
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'merged-signal-present',
      workerClass: existingRecord?.workerClass || workerClass,
      dispatchId: existingRecord?.dispatchId || existingRecord?.launchRequestId || null,
      launchRequestId: existingRecord?.launchRequestId || null,
      promptPath: existingRecord?.promptPath || null,
      mergedSignal: mergedSignal.row,
      mergedSignalHeadShaMatchesReviewed: mergedSignal.headShaMatchesReviewed,
      mergedSignalProducerHeadSha: mergedSignal.producerHeadSha,
      ...(hammerCleanup ? { hammerCleanup } : {}),
    });
  }
  const mergedSignalUnknown = isUnknownMergedSignal(mergedSignal);
  const existingRecordIsReclaimableInterruption = isInterruptedInFlightAmaCloserDispatch(
    existingRecord,
    existingLeaseBeforeDispatch,
    { now: dispatchContext.dispatchedAt, processKillImpl },
  );
  const existingRecordHasLivePendingInterruption = hasInterruptedInFlightAmaCloserDispatchShape(existingRecord)
    && existingLeaseBeforeDispatch?.status === AMA_CLOSER_LEASE_STATUS.PENDING
    && !existingRecordIsReclaimableInterruption;
  const existingRecordIsBranchHolderBlocked = isProvisionBranchHolderBlocked(existingRecord?.lastError || '');
  const existingBranchHolderBlockCount = Number(existingRecord?.branchHolderBlockCount || 0);
  let existingDispatchStatus = null;
  if (existingRecord?.launchRequestId) {
    let releaseUnprovenTerminalHold = false;
    let releaseUnprovenTerminalHoldError = null;
    const statusProbe = await probeAmaCloserDispatchStatus({
      hqPath,
      launchRequestId: existingRecord.launchRequestId,
      asOwner: ownerUser,
      execFileImpl,
      env: process.env,
    });
    const status = statusProbe?.status || null;
    existingDispatchStatus = status;
    if (AMA_CLOSER_ACTIVE_STATUSES.has(status) || AMA_CLOSER_TERMINAL_HOLD_STATUSES.has(status)) {
      if (
        currentHeadFinalHammerTerminalRemediation &&
        mergedSignalUnknown &&
        AMA_CLOSER_TERMINAL_HOLD_STATUSES.has(status)
      ) {
        const reason = 'current-head-hammer-already-ran-needs-operator';
        // The hammer's final terminal remediation ran but produced NO merged
        // signal (mergedSignalUnknown). Record 'deferred' — NOT 'succeeded':
        // stamping a permanent terminal 'succeeded' with no merge falsifies the
        // §4.4 audit trail (the PR looks closed-successful while it is still
        // open, parked for the operator) and hides genuinely-stuck PRs from
        // review-pipeline-health / recovery-reaper, both of which skip any lease
        // whose terminalOutcome is non-null. The needs-operator early-return
        // below is unchanged, so this is honest bookkeeping only and does not
        // alter dispatch/runaway behavior. Real-merge success is still recorded
        // 'succeeded' via the mergedSignal.ok path above.
        finalizeAmaCloserLeaseBestEffort({
          rootDir,
          leaseIdentity,
          terminalOutcome: 'deferred',
          now: dispatchContext.dispatchedAt,
          logger,
          repo,
          prNumber,
        });
        logger?.error?.(JSON.stringify({
          event: 'ama_closer.current_head_hammer_stuck',
          repo,
          prNumber,
          headSha: reviewedSha,
          reason,
          launchRequestId: existingRecord.launchRequestId || null,
          dispatchId: existingRecord.dispatchId || null,
          status,
          message:
            'Final HAM terminal remediation already completed for the current head, but no merged signal is present; refusing same-head re-dispatch',
        }));
        updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
          ...(current || existingRecord),
          lastObservedStatus: status,
          lastObservedAt: dispatchContext.dispatchedAt,
          lastError: reason,
        }));
        return noAmaDispatch({
          dispatched: false,
          skipMergeAgent: true,
          reason,
          workerClass: existingRecord?.workerClass || workerClass,
          dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
          launchRequestId: existingRecord.launchRequestId || null,
          promptPath: existingRecord.promptPath || null,
          needsOperator: true,
        });
      }
      if (
        mergedSignalUnknown
        && (auditTerminalOutcome === 'succeeded' || AMA_CLOSER_TERMINAL_HOLD_STATUSES.has(status))
      ) {
        updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
          ...(current || existingRecord),
          lastObservedStatus: status,
          lastObservedAt: dispatchContext.dispatchedAt,
          lastError: `merged-signal-read-${mergedSignal.reason || 'unknown'}`,
        }));
        return retainExistingAmaCloserDispatch(existingRecord, workerClass, status);
      }
      if (auditTerminalOutcome === 'succeeded') {
        existingDispatchStatus = 'unverified-terminal-success';
        releaseUnprovenTerminalHold = true;
        releaseUnprovenTerminalHoldError = 'audit-succeeded-without-merged-signal';
        finalizeAmaCloserLeaseBestEffort({
          rootDir,
          leaseIdentity,
          terminalOutcome: 'succeeded',
          now: dispatchContext.dispatchedAt,
          logger,
          repo,
          prNumber,
        });
      } else if (
        auditTerminalOutcome
        && auditTerminalOutcome !== 'succeeded'
        && !AMA_CLOSER_ACTIVE_STATUSES.has(status)
      ) {
        existingDispatchStatus = 'failed';
        releaseUnprovenTerminalHold = true;
        releaseUnprovenTerminalHoldError = statusProbe?.error || null;
        finalizeAmaCloserLeaseBestEffort({
          rootDir,
          leaseIdentity,
          terminalOutcome: auditTerminalOutcome,
          now: dispatchContext.dispatchedAt,
          logger,
          repo,
          prNumber,
        });
      } else if (AMA_CLOSER_TERMINAL_HOLD_STATUSES.has(status)) {
        existingDispatchStatus = 'unverified-terminal-success';
        releaseUnprovenTerminalHold = true;
        releaseUnprovenTerminalHoldError = 'terminal-success-status-without-audit-or-merged-signal';
        finalizeAmaCloserLeaseBestEffort({
          rootDir,
          leaseIdentity,
          terminalOutcome: 'succeeded',
          now: dispatchContext.dispatchedAt,
          logger,
          repo,
          prNumber,
        });
      } else {
        updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
          ...(current || existingRecord),
          lastObservedStatus: status,
          lastObservedAt: dispatchContext.dispatchedAt,
          lastError: statusProbe?.error || null,
        }));
        return {
          dispatched: false,
          skipMergeAgent: true,
          reason: `existing-dispatch-${status}`,
          workerClass: existingRecord.workerClass || workerClass,
          dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
          launchRequestId: existingRecord.launchRequestId || null,
          promptPath: existingRecord.promptPath || null,
        };
      }
    }
    if (releaseUnprovenTerminalHold) {
      const tokenRecord = {
        ...existingRecord,
        lastObservedStatus: existingDispatchStatus || status,
        lastObservedAt: dispatchContext.dispatchedAt,
      };
      await recordAmaCloserReviewerPassTokens({
        rootDir,
        hqRoot,
        repo,
        prNumber,
        record: tokenRecord,
        status: existingDispatchStatus || status,
        merged: auditTerminalOutcome === 'succeeded',
        observedAt: dispatchContext.dispatchedAt,
        ledgerTarget: dispatchContext.ledgerTarget || null,
        ledgerDbPath: dispatchContext.ledgerDbPath || null,
        env: process.env,
        pollDelaysMs: dispatchContext.closerTokenRollupPollDelaysMs || undefined,
        logger,
      });
      updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
        ...(current || existingRecord),
        lastObservedStatus: status,
        lastObservedAt: dispatchContext.dispatchedAt,
        lastError: releaseUnprovenTerminalHoldError,
      }));
    }
    if (status === 'unknown') {
      updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
        ...(current || existingRecord),
        lastObservedStatus: status,
        lastObservedAt: dispatchContext.dispatchedAt,
        lastError: statusProbe?.error || null,
      }));
      return noAmaDispatch({
        dispatched: false,
        skipMergeAgent: true,
        reason: 'dispatch-status-unknown',
        workerClass: existingRecord.workerClass || workerClass,
        dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
        launchRequestId: existingRecord.launchRequestId || null,
        promptPath: existingRecord.promptPath || null,
      });
    }
    if (AMA_CLOSER_RETRYABLE_STATUSES.has(status)) {
      finalizeAmaCloserLeaseBestEffort({
        rootDir,
        leaseIdentity,
        terminalOutcome: 'failed-without-merge',
        now: dispatchContext.dispatchedAt,
        logger,
        repo,
        prNumber,
      });
      const hammerCleanup = await cleanupHammerCloserWorker({
        prNumber,
        workerClass,
        existingRecord,
        hqPath,
        hqRoot,
        execFileImpl,
        logger,
        reason: `terminal-status-${status}`,
      });
      assertHammerCleanupSucceeded(hammerCleanup);
      await recordAmaCloserReviewerPassTokens({
        rootDir,
        hqRoot,
        repo,
        prNumber,
        record: {
          ...existingRecord,
          lastObservedStatus: status,
          lastObservedAt: dispatchContext.dispatchedAt,
        },
        status,
        merged: false,
        observedAt: dispatchContext.dispatchedAt,
        ledgerTarget: dispatchContext.ledgerTarget || null,
        ledgerDbPath: dispatchContext.ledgerDbPath || null,
        env: process.env,
        pollDelaysMs: dispatchContext.closerTokenRollupPollDelaysMs || undefined,
        logger,
      });
    }
    if (!releaseUnprovenTerminalHold && !AMA_CLOSER_RETRYABLE_STATUSES.has(status)) {
      return noAmaDispatch({ dispatched: false, reason: `dispatch-status-${status || 'unknown'}` });
    }
  } else if (existingRecordHasLivePendingInterruption) {
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'lease-held',
      existingLease: existingLeaseBeforeDispatch,
    });
  } else if (
    existingRecord
    && Number(existingRecord.retryCount || 0) >= AMA_CLOSER_REDISPATCH_BOUND
    && !existingRecordIsReclaimableInterruption
    && !existingRecordIsBranchHolderBlocked
  ) {
    // Genuine completed failures are bounded; an interrupted in-flight dispatch
    // (watcher SIGTERM'd mid-launch, e.g. a deploy bounce) is reclaimed below
    // only after the stale `pending` lease it left behind proves the owner died
    // or outlived the full hq dispatch retry loop.
    return noAmaDispatch({ dispatched: false, reason: 'dispatch-retry-exhausted' });
  } else if (
    existingRecordIsBranchHolderBlocked
    && existingBranchHolderBlockCount >= AMA_CLOSER_BRANCH_HOLDER_BLOCK_BOUND
  ) {
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'dispatch-branch-holder-block-exhausted',
      workerClass: existingRecord.workerClass || workerClass,
      dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
      launchRequestId: existingRecord.launchRequestId || null,
      promptPath: existingRecord.promptPath || null,
    });
  }

  if (verdict.eligible && eligibleHammerRouteReasons.length === 0) {
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'daemon-clean-route',
    });
  }

  assertAmaAuditOwner({
    hqRoot,
    ownerUser,
    currentUser: dispatchContext.currentUser,
  });

  // ── Hammer retry cap (per-PR, robust across head churn) ────────────────────
  // The per-head redispatch bound above resets whenever a hammer moves the head,
  // so it cannot stop the re-hammer loop that burned the weekly Codex quota on
  // 2026-07-05 (189 hammer dispatches; #3116 ×10, #3120 ×7). This per-PR ledger —
  // anchored to the STABLE reviewed-head job key, not the churning PR head —
  // bounds hammer dispatch to ONE retry (2 total) across every head a hammer
  // authors, then fails loud via a GBI operator alert and suppresses further
  // dispatch. Composes with MSM-01 (hammer-merges-under-lease): this is the
  // safety cap, not a replacement, and it only bounds the re-dispatch count.
  if (workerClass === 'hammer') {
    const hammerCapIdentity = { repo, prNumber };
    const hammerRetryLedger = readHammerRetryCapLedger(rootDir, hammerCapIdentity);
    const hammerLifetimeDispatchCeiling = normalizeHammerLifetimeDispatchCeiling(
      cfg?.hammerLifetimeDispatchCeiling,
    );
    // The per-PR counter increments only on the CONFIRMED-launch path below (not
    // pre-exec like the per-head record), so an interrupted-in-flight dispatch
    // never bumped it — there is no phantom increment to reclaim here. A deploy
    // bounce mid-launch simply never counted, which is the correct fail-safe.
    const hammerRetryCapDecision = evaluateHammerRetryCap(hammerRetryLedger, {
      jobKey: reviewedSha,
      headSha: targetRemediationSha,
      lifetimeDispatchCeiling: hammerLifetimeDispatchCeiling,
    });
    if (hammerRetryCapDecision.capExhausted) {
      return await suppressHammerRetryCapExhaustion({
        rootDir,
        identity: hammerCapIdentity,
        repo,
        prNumber,
        jobKey: reviewedSha,
        headSha: targetRemediationSha,
        attemptCount: hammerRetryCapDecision.priorAttemptCount,
        lifetime: hammerRetryCapDecision.lifetimeCapExhausted,
        workerClass,
        existingRecord,
        alertAlreadyEmitted: hammerRetryCapDecision.alertAlreadyEmitted,
        deliverAlertImpl,
        logger,
        now: dispatchContext.dispatchedAt,
      });
    }
  }
  writeAmaAuditEntry({
    hqRoot,
    repo,
    prNumber,
    headSha: reviewedSha,
    now: dispatchContext.dispatchedAt,
    attempt: {
      outcome: 'in_progress',
      reviewedBy: dispatchContext.reviewedBy || null,
      requiredGateContext: dispatchContext.requiredGateContext || null,
      eligibilityTrace: verdict.trace,
      operatorApprovedEvidence: reviewState.operatorApprovedEvidence || null,
      adversarialMergeRequestedEvidence: options?.adversarialMergeRequested || null,
    },
    metadata: {
      reviewedBy: dispatchContext.reviewedBy || null,
      reviewSha: reviewedSha,
      riskClass: dispatchContext.riskClass || null,
      requiredGateContexts: dispatchContext.requiredGateContext
        ? [dispatchContext.requiredGateContext]
        : [],
      eligibilityReasons: bootstrapEligibilityReasons,
      mergeMethod,
      reconciliation: {
        needsRepair: false,
        lastVerifiedAt: dispatchContext.dispatchedAt || null,
      },
      operatorApprovedEvidence: reviewState.operatorApprovedEvidence || null,
      adversarialMergeRequestedEvidence: options?.adversarialMergeRequested || null,
    },
  });

  // Persist the prompt under watcher-owned repo state and pass that path
  // to `hq dispatch --prompt`. This avoids cross-user writes into HQ_ROOT.
  const promptPath = join(
    promptDir,
    `${repo.replace('/', '-')}-pr-${prNumber}-${reviewedSha}.md`,
  );
  if (writeFileImpl) {
    writeFileImpl(promptDir, promptPath, prompt);
  } else {
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(promptPath, prompt, { encoding: 'utf8' });
  }

  // An interrupted in-flight dispatch already bumped retryCount before it was
  // killed without completing an attempt. Roll that phantom increment back so
  // the redispatch bound reflects only genuine completed failures and does not
  // inflate across repeated deploy-bounce interruptions.
  const priorRetryCount = existingRecordIsReclaimableInterruption
    ? Math.max(0, Number(existingRecord?.retryCount || 1) - 1)
    : Number(existingRecord?.retryCount || 0);

  // HHR harness-fallback: resolve the PHYSICAL harness the closer runs on. The
  // LOGICAL `workerClass` above still drives the prompt (terminal remediation),
  // trailers, and merge-under-lease behavior; only `--worker-class` swaps to an
  // available harness when the configured harness's provider is quota-grounded
  // (`hq fleet quota status`). This is placed after every early-return gate so
  // the fleet-quota read + audit only run when we are committed to a launch. It
  // auto-reverts to the primary the moment the provider recovers to `ok`.
  let dispatchWorkerClass = workerClass;
  let harnessFallback = null;
  try {
    harnessFallback = await resolveCloserDispatchHarnessImpl({
      workerClass,
      fallbackWorkerClasses: Array.isArray(cfg?.workerClassFallback) ? cfg.workerClassFallback : [],
      hqPath,
      execFileImpl,
      env: process.env,
    });
  } catch (err) {
    // Fail-open: a resolver fault must never block the merge. Dispatch on the
    // configured primary exactly as the pre-HHR path did.
    harnessFallback = { workerClass, fellBack: false, reason: 'harness-fallback-resolver-error', error: String(err?.message || err) };
  }
  if (harnessFallback?.fellBack === true && harnessFallback.workerClass) {
    dispatchWorkerClass = harnessFallback.workerClass;
    logAmaCloserDispatchEvent(logger, 'ama_closer.harness_fallback', {
      repo,
      prNumber,
      provider: harnessFallback.provider,
      from: harnessFallback.from,
      to: harnessFallback.to,
      primaryState: harnessFallback.primaryState,
      fallbackProvider: harnessFallback.fallbackProvider || null,
    });
    await emitHarnessFallbackAlert({
      deliverAlertImpl,
      repo,
      prNumber,
      harness: harnessFallback,
      logger,
      env: process.env,
    });
  }

  // AOM-04: the orchestration switch is a deliberate no-op for merge-class
  // dispatch. Native and agentos both stay on `hq dispatch` because no bare
  // merge orchestration exists to fall back to.
  const mergeDispatchRoute = resolveMergeClassDispatchRoute({
    orchestrationMode: dispatchContext?.orchestrationMode ?? null,
    logger,
    repo,
    prNumber,
    workerClass,
    completionShape: 'decision-only',
  });
  if (mergeDispatchRoute !== 'hq-dispatch') {
    throw new Error(
      `[ama-closer] unsupported merge dispatch route=${JSON.stringify(mergeDispatchRoute)}`,
    );
  }
  writeAmaCloserDispatchRecord(rootDir, dispatchIdentity, {
    schemaVersion: AMA_CLOSER_DISPATCH_SCHEMA_VERSION,
    repo,
    prNumber,
    headSha: targetRemediationSha,
    reviewedSha,
    targetRemediationSha,
    dispatchReason,
    workerClass,
    dispatchWorkerClass,
    promptPath,
    promptDir,
    hqRoot,
    lastAttemptedAt: dispatchContext.dispatchedAt,
    dispatchedAt: null,
    dispatchId: existingRecord?.dispatchId || null,
    launchRequestId: existingRecord?.launchRequestId || null,
    retryCount: priorRetryCount + 1,
    branchHolderBlockCount: existingBranchHolderBlockCount,
    state: 'dispatching',
    lastObservedStatus: existingRecord?.lastObservedStatus || null,
    lastObservedAt: existingRecord?.lastObservedAt || null,
    lastError: null,
  });

  // AMA-07 — acquire the duplicate-dispatch lease immediately before
  // the hq launch, after every watcher-local preflight that can fail
  // without creating a live closer. This keeps transient local write
  // failures from leaving a permanent `pending` lease behind.
  let leaseResult = acquireAmaCloserLease({
    rootDir,
    ...leaseIdentity,
    watcherPid: typeof process !== 'undefined' ? process.pid : null,
    now: dispatchContext.dispatchedAt,
  });
  if (!leaseResult.acquired) {
    const existingLease = leaseResult.existingLease || readAmaCloserLease(rootDir, leaseIdentity);
    if (auditTerminalOutcome && auditTerminalOutcome !== 'succeeded') {
      deleteAmaCloserLease(rootDir, leaseIdentity);
      leaseResult = acquireAmaCloserLease({
        rootDir,
        ...leaseIdentity,
        watcherPid: typeof process !== 'undefined' ? process.pid : null,
        now: dispatchContext.dispatchedAt,
      });
    } else if (
      AMA_CLOSER_RETRYABLE_STATUSES.has(existingDispatchStatus || '')
      || (
        !existingRecord?.launchRequestId
        && isReclaimablePendingAmaCloserLease(existingLease, {
          now: dispatchContext.dispatchedAt,
          processKillImpl,
        })
      )
    ) {
      deleteAmaCloserLease(rootDir, leaseIdentity);
      leaseResult = acquireAmaCloserLease({
        rootDir,
        ...leaseIdentity,
        watcherPid: typeof process !== 'undefined' ? process.pid : null,
        now: dispatchContext.dispatchedAt,
      });
    }
  }
  if (!leaseResult.acquired) {
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'lease-held',
      existingLease: leaseResult.existingLease,
    });
  }

  // `hq dispatch` args mirror the existing merge-agent dispatch (see
  // src/follow-up-merge-agent.mjs around line 3866). Differences:
  //
  //   - `--worker-class` reads from cfg (default `hammer`); merge-agent
  //     uses the `merge-agent` resolver. HHR may swap the PHYSICAL harness
  //     (`dispatchWorkerClass`) to a fallback when the configured provider is
  //     quota-grounded; the logical `workerClass` still drives the prompt/audit.
  //   - `--task-kind merge` matches merge-agent.
  //   - `--completion-shape decision-only` because the hammer worker
  //     writes the audit JSON artifact; it does NOT open a PR. This
  //     prevents the dispatcher from injecting the default `pr`
  //     close-out (CLAUDE.md §"_apply_prompt_closeouts").
  //   - `--project adversarial-merge-authority` to keep audit + token
  //     accounting separate from the merge-agent stream.
  //   - `--ticket AMA-PR-<n>` so the launch is traceable per-PR.
  const repoBasename = repo.split('/')[1] || repo;
  const args = [
    'dispatch',
    '--worker-class', dispatchWorkerClass,
    '--task-kind', 'merge',
    '--completion-shape', 'decision-only',
    '--project', hqProject,
    '--repo', repoBasename,
    '--pr', String(prNumber),
    '--ticket', `AMA-PR-${prNumber}`,
    '--parent-session', dispatchContext.parentSession,
    '--prompt', promptPath,
    '--root', hqRoot,
  ];
  if (
    repoBasename !== AGENT_OS_TOOLING_REPO
    && repoBasename !== ADVERSARIAL_REVIEW_REPO
  ) {
    args.push('--additional-repo', AGENT_OS_TOOLING_REPO);
  }

  let execResult;
  let transientRetryIndex = 0;
  let samePrHammerHolderRetryUsed = false;
  for (;;) {
    try {
      execResult = await execFileImpl(hqPath, args, {
        env: process.env,
        maxBuffer: 5 * 1024 * 1024,
        // CFG-knobbed (roles.adversarial.merge_authority.dispatch_timeout_ms,
        // default 300s). The old hardcoded 90s was below the merge-worker
        // provision time (~57s baseline, slower under contention), so the
        // watcher SIGTERM'd healthy dispatches before they returned an lrq ->
        // dispatch-failed -> the hammer never closed.
        timeout: Number(cfg?.dispatchTimeoutMs) > 0 ? Number(cfg.dispatchTimeoutMs) : 300_000,
        killSignal: 'SIGTERM',
      });
      break;
    } catch (err) {
      if (isTransientHqDispatchError(err) && transientRetryIndex < AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS.length) {
        const delayMs = Number(AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS[transientRetryIndex]) || 0;
        transientRetryIndex += 1;
        await sleep(delayMs);
        continue;
      }
      const parsedFailure = normalizeDispatchIdentifiers(parseAmaCloserDispatchOutput(err?.stdout || ''));
      const ambiguousLaunch = Boolean(parsedFailure.launchRequestId || parsedFailure.dispatchId);
      const branchHolderBlocked = !ambiguousLaunch && isProvisionBranchHolderBlocked(err);
      const dispatchError = String(err?.stderr || err?.message || err);
      if (branchHolderBlocked && workerClass === 'hammer' && !samePrHammerHolderRetryUsed) {
        samePrHammerHolderRetryUsed = true;
        const samePrTeardown = await teardownSamePrHammerHolder({
          err,
          prNumber,
          hqPath,
          hqRoot,
          execFileImpl,
          logger,
        });
        if (samePrTeardown.ok) {
          continue;
        }
      }
      // A throttle / OAuth-broker outage / host-offline window is TRANSIENT: the
      // dispatch did not fail on its merits, GitHub or the broker was merely
      // unavailable. Treat it like a branch-holder block for budget purposes —
      // do NOT decrement the persisted redispatch budget toward
      // `dispatch-retry-exhausted`. Otherwise a transient rate-limit storm
      // permanently grounds the closer for a PR even after the limit resets,
      // which is exactly the cascade observed in the macOS-upgrade incident.
      const transientFailure = !ambiguousLaunch
        && !branchHolderBlocked
        && isTransientHqDispatchError(err);
      const budgetPreservingFailure = branchHolderBlocked || transientFailure;
      const updatedDispatchRecord = updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => {
        const branchHolderBlockCount = branchHolderBlocked
          ? Number(current?.branchHolderBlockCount || existingBranchHolderBlockCount) + 1
          : Number(current?.branchHolderBlockCount || existingBranchHolderBlockCount);
        return {
          ...(current || {}),
          schemaVersion: AMA_CLOSER_DISPATCH_SCHEMA_VERSION,
          repo,
          prNumber,
          headSha: targetRemediationSha,
          reviewedSha,
          targetRemediationSha,
          dispatchReason,
          workerClass,
          dispatchWorkerClass,
          promptPath,
          promptDir,
          hqRoot,
          lastAttemptedAt: dispatchContext.dispatchedAt,
          dispatchedAt: ambiguousLaunch ? dispatchContext.dispatchedAt : null,
          dispatchId: parsedFailure.dispatchId,
          launchRequestId: parsedFailure.launchRequestId,
          retryCount: budgetPreservingFailure
            ? priorRetryCount
            : Number(current?.retryCount || priorRetryCount + 1),
          branchHolderBlockCount,
          state: ambiguousLaunch ? 'dispatched' : (
            branchHolderBlocked && branchHolderBlockCount >= AMA_CLOSER_BRANCH_HOLDER_BLOCK_BOUND
              ? 'dispatch-branch-holder-block-exhausted'
              : (branchHolderBlocked
                ? 'dispatch-blocked-branch-holder'
                : (transientFailure ? 'dispatch-deferred-transient' : 'dispatch-failed'))
          ),
          lastObservedStatus: ambiguousLaunch ? 'unknown' : (branchHolderBlocked ? 'blocked' : null),
          lastObservedAt: ambiguousLaunch || branchHolderBlocked ? dispatchContext.dispatchedAt : null,
          lastFailureTransient: transientFailure,
          lastError: dispatchError,
        };
      });
      const branchHolderBlockExhausted = branchHolderBlocked
        && Number(updatedDispatchRecord?.branchHolderBlockCount || 0) >= AMA_CLOSER_BRANCH_HOLDER_BLOCK_BOUND;
      let releasedPendingLease = false;
      let releasePendingLeaseError = null;
      if (!ambiguousLaunch) {
        try {
          deleteAmaCloserLease(rootDir, leaseIdentity);
          releasedPendingLease = true;
          logger?.warn?.(JSON.stringify({
            event: 'ama_closer.pending_lease_released_after_dispatch_refusal',
            repo,
            prNumber,
            headSha: reviewedSha,
            reason: transientFailure ? 'dispatch-deferred-transient' : (
              branchHolderBlocked ? 'dispatch-branch-holder-blocked' : 'dispatch-failed'
            ),
            error: dispatchError,
          }));
        } catch (releaseErr) {
          releasePendingLeaseError = String(releaseErr?.message || releaseErr);
          logger?.error?.(JSON.stringify({
            event: 'ama_closer.pending_lease_release_failed_after_dispatch_refusal',
            repo,
            prNumber,
            headSha: reviewedSha,
            reason: transientFailure ? 'dispatch-deferred-transient' : (
              branchHolderBlocked ? 'dispatch-branch-holder-blocked' : 'dispatch-failed'
            ),
            error: releasePendingLeaseError,
          }));
        }
      }
      return noAmaDispatch({
        dispatched: false,
        // Transient failures keep the merge-agent fallback suppressed so the
        // closer (not merge-agent) re-dispatches once the throttle/broker
        // clears, since the budget was preserved above and re-dispatch is
        // guaranteed to be retry-eligible on the next tick.
        skipMergeAgent: branchHolderBlocked || ambiguousLaunch || transientFailure,
        reason: ambiguousLaunch ? 'dispatch-response-ambiguous' : (
          branchHolderBlocked ? (
            branchHolderBlockExhausted
              ? 'dispatch-branch-holder-block-exhausted'
              : 'dispatch-branch-holder-blocked'
          ) : (
            transientFailure ? 'dispatch-deferred-transient' : 'dispatch-failed'
          )
        ),
        error: String(err?.stderr || err?.message || err),
        workerClass,
        ...(dispatchWorkerClass !== workerClass ? { dispatchWorkerClass } : {}),
        dispatchId: parsedFailure.dispatchId || null,
        launchRequestId: parsedFailure.launchRequestId || null,
        promptPath,
        releasedPendingLease,
        ...(releasePendingLeaseError ? { releasePendingLeaseError } : {}),
      });
    }
  }

  const parsed = normalizeDispatchIdentifiers(parseAmaCloserDispatchOutput(execResult?.stdout || ''));
  updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
    ...(current || {}),
    schemaVersion: AMA_CLOSER_DISPATCH_SCHEMA_VERSION,
    repo,
    prNumber,
    headSha: targetRemediationSha,
    reviewedSha,
    targetRemediationSha,
    dispatchReason,
    workerClass,
    dispatchWorkerClass,
    promptPath,
    promptDir,
    hqRoot,
    lastAttemptedAt: dispatchContext.dispatchedAt,
    dispatchedAt: dispatchContext.dispatchedAt,
    dispatchId: parsed.dispatchId,
    launchRequestId: parsed.launchRequestId,
    retryCount: Number(current?.retryCount || priorRetryCount + 1),
    branchHolderBlockCount: 0,
    state: 'dispatched',
    lastObservedStatus: 'starting',
    lastObservedAt: dispatchContext.dispatchedAt,
    lastError: null,
  }));

  // AMA-07 — promote the lease from `pending` to `dispatched` now
  // that hq accepted the launch request. Failure here is best-effort:
  // log via the result but do NOT undo the dispatch (the hammer worker
  // is already running). The next watcher tick will reconcile.
  let leaseUpdateError = null;
  try {
    updateAmaCloserLease({
      rootDir,
      ...leaseIdentity,
      status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
      lrqId: parsed.launchRequestId || parsed.dispatchId || 'unknown',
      now: dispatchContext.dispatchedAt,
    });
  } catch (err) {
    leaseUpdateError = String(err?.message || err);
  }

  // Count this genuine hammer launch against the per-PR retry cap ledger. Keyed on
  // the stable reviewed-head job key so the count accumulates across the head
  // churn a hammer causes (the per-head dispatch record resets on every head move;
  // this does not). Placed on the confirmed-launch path only: lease-held /
  // dispatch-failed / merged-signal / interrupted-mid-launch returns never reach
  // here, so only real hammer workers that then fail to close accumulate toward
  // the cap.
  if (workerClass === 'hammer') {
    try {
      recordHammerRetryDispatch(rootDir, { repo, prNumber }, {
        jobKey: reviewedSha,
        headSha: targetRemediationSha,
        lifetimeDispatchCeiling: normalizeHammerLifetimeDispatchCeiling(
          cfg?.hammerLifetimeDispatchCeiling,
        ),
        now: dispatchContext.dispatchedAt,
      });
    } catch (capErr) {
      // Best-effort: a ledger write failure must never undo a live dispatch.
      logger?.error?.(JSON.stringify({
        event: 'ama_closer.hammer_retry_cap_record_failed',
        repo,
        prNumber,
        error: capErr?.message || String(capErr),
      }));
    }
  }

  return {
    dispatched: true,
    workerClass,
    ...(dispatchWorkerClass !== workerClass ? { dispatchWorkerClass } : {}),
    ...(harnessFallback?.fellBack === true
      ? {
          harnessFallback: {
            provider: harnessFallback.provider,
            from: harnessFallback.from,
            to: harnessFallback.to,
            primaryState: harnessFallback.primaryState,
            fallbackProvider: harnessFallback.fallbackProvider || null,
          },
        }
      : {}),
    dispatchId: parsed.dispatchId || parsed.launchRequestId || null,
    launchRequestId: parsed.launchRequestId || null,
    promptPath,
    eligibilityReasons: verdict.trace,
    leasePath: leaseResult.leasePath,
    ...(leaseUpdateError ? { leaseUpdateError } : {}),
  };
}
